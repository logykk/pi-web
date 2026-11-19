import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { agentTerminalIds, createTerminalDesk, createTerminalDeskMemory } = await jiti.import("./terminal-desk.ts");
const { HOLD_MS, ToolError } = await jiti.import("./desk.ts");
const { decodeTerminalCursor } = await jiti.import("./terminal-stream.ts");

const T0 = Date.parse("2026-11-18T10:00:00Z");
const DIR = "/work/project";
const PROMPT = "\x1b[?2004h$ ";
const ENTER = "\r\n\x1b[?2004l\r";
const NEVER = new AbortController().signal;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const hex = (n) => n.toString(16).padStart(8, "0").repeat(4);
const cursorAt = (id, offset) => ({ tag: id.slice(0, 8), offset });

/** In-memory terminals behind the TerminalPorts interface: backlogs, listeners, writes. */
function fakePorts() {
  let next = 1;
  const ports = {
    records: new Map(),
    writes: [],
    starts: [],
    links: new Map(),
    add(cwd, { browsers = 0, output = PROMPT, foreground = { kind: "shell" } } = {}) {
      const id = hex(next++);
      ports.records.set(id, { cwd, backlog: "", offset: 0, exitCode: null, listeners: new Set(), browsers, foreground, cols: 80, rows: 24 });
      ports.output(id, output);
      return id;
    },
    output(id, data) {
      const record = ports.records.get(id);
      record.backlog = (record.backlog + data).slice(-131_072);
      record.offset += data.length;
      for (const listener of [...record.listeners]) listener({ kind: "output" });
    },
    exit(id, code) {
      const record = ports.records.get(id);
      record.exitCode = code;
      for (const listener of [...record.listeners]) listener({ kind: "ended", end: { kind: "exited", code } });
    },
    terminals: () => [...ports.records.keys()].map((id) => ports.terminal(id)),
    terminal(id) {
      const record = ports.records.get(id);
      if (!record) return null;
      return {
        id, cwd: record.cwd, pid: 1, cols: record.cols, rows: record.rows, offset: record.offset, backlog: record.backlog,
        state: record.exitCode === null ? { kind: "running" } : { kind: "exited", code: record.exitCode },
        listeners: record.listeners.size + record.browsers,
      };
    },
    realpath: async (cwd) => ports.links.get(cwd) ?? cwd,
    start(cwd) {
      ports.starts.push(cwd);
      return ports.add(cwd);
    },
    hold(id, listener) {
      const record = ports.records.get(id);
      if (!record) return null;
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
    write(id, data) {
      const record = ports.records.get(id);
      if (!record || record.exitCode !== null) return false;
      ports.writes.push({ id, data });
      return true;
    },
    close(id) {
      const record = ports.records.get(id);
      if (!record) return false;
      ports.records.delete(id);
      for (const listener of [...record.listeners]) listener({ kind: "ended", end: { kind: "closed" } });
      record.listeners.clear();
      return true;
    },
    foreground: (id) => ports.records.get(id)?.foreground ?? { kind: "unknown" },
    directory: async (path) => ({ kind: "directory", path }),
  };
  return ports;
}

/**
 * Stands in for the xterm render (terminal-render.test.mjs tests the real one): the lines from the
 * start of the cursor's line to `to`, CSI stripped, the cursor's line dropped when unchanged.
 */
function fakeRender() {
  const spans = [];
  const render = async (window, from, to) => {
    spans.push({ from, to });
    const base = window.offset - window.backlog.length;
    const lineStart = window.backlog.lastIndexOf("\n", from - base - 1) + 1;
    const lines = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "").split("\r\n");
    const shown = lines(window.backlog.slice(lineStart, to - base));
    if (shown[0] === lines(window.backlog.slice(lineStart, from - base))[0]) shown.shift();
    if (shown.at(-1) === "") shown.pop();
    return { lines: shown, screen: null, trimmed: false };
  };
  return { render, spans };
}

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const ports = fakePorts();
  const { render, spans } = fakeRender();
  const desk = createTerminalDesk(ports, render, createTerminalDeskMemory());
  return { ports, desk, spans };
}

/** Advances mocked time in ticks until the promise settles. */
async function settle(t, promise, stepMs = 50, maxMs = 60_000) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let spent = 0; !done && spent <= maxMs; spent += stepMs) {
    await flush();
    t.mock.timers.tick(stepMs);
  }
  await flush();
  return promise;
}

test("open starts a 120x40-style shell in a folder with no terminal, and joins it next time", async (t) => {
  const { ports, desk } = setup(t);
  const started = await desk.open(DIR);
  assert.equal(started.joined, false);
  assert.deepEqual(ports.starts, [DIR]);
  assert.equal(started.terminal.agentStarted, true);
  assert.equal(started.terminal.shownInPiWeb, false);
  assert.equal(started.cursor, ports.terminal(started.terminal.id).offset);
  const again = await desk.open(DIR);
  assert.equal(again.joined, true);
  assert.equal(again.terminal.id, started.terminal.id);
  assert.deepEqual(ports.starts, [DIR]);
});

test("open joins a pi-web tab's terminal first, then the one an agent touched last, then the newest; by real path; never an exited one", async (t) => {
  const { ports, desk } = setup(t);
  const old = ports.add(DIR);
  const touched = ports.add(DIR);
  const newest = ports.add("/link/to/project");
  ports.links.set("/link/to/project", DIR);
  const exited = ports.add(DIR);
  ports.exit(exited, 0);
  assert.equal((await desk.open(DIR)).terminal.id, newest);
  t.mock.timers.tick(1_000);
  await desk.wait(touched, cursorAt(touched, ports.terminal(touched).offset), 0, NEVER);
  assert.equal((await desk.open(DIR)).terminal.id, touched);
  ports.records.get(old).browsers = 1;
  const shown = await desk.open(DIR);
  assert.equal(shown.terminal.id, old);
  assert.equal(shown.terminal.shownInPiWeb, true);
  assert.deepEqual(ports.starts, []);
});

test("send types keys, then text, then Enter in one write, and waits from the offset before it until the shell reads again", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal, cursor } = await desk.open(DIR);
  const sending = desk.send(terminal.id, { text: "ls", enter: true }, cursorAt(terminal.id, cursor), 45_000, NEVER);
  await flush();
  assert.deepEqual(ports.writes, [{ id: terminal.id, data: "ls\r" }]);
  ports.output(terminal.id, `ls${ENTER}a.txt\r\n${PROMPT}`);
  const result = await settle(t, sending);
  assert.equal(result.kind, "typed");
  assert.equal(result.shown, '"ls" enter');
  assert.equal(result.wait.reason, "ready");
  assert.deepEqual(result.wait.page.lines, ["$ ls", "a.txt", "$ "]);
  assert.deepEqual(result.wait.typed.map((input) => input.shown), ['"ls" enter']);
  assert.equal(result.wait.cursor, ports.terminal(terminal.id).offset);
});

test("the send guard: text with a cursor is refused when the terminal printed since it (changed) or the agent typed at it (already-typed); a retried send types once", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal, cursor } = await desk.open(DIR);
  const at = cursorAt(terminal.id, cursor);
  const first = await settle(t, (async () => {
    const sending = desk.send(terminal.id, { text: "make", enter: true }, at, 45_000, NEVER);
    await flush();
    ports.output(terminal.id, `make${ENTER}done\r\n${PROMPT}`);
    return sending;
  })());
  assert.equal(first.kind, "typed");
  const retried = await desk.send(terminal.id, { text: "make", enter: true }, at, 45_000, NEVER);
  assert.equal(retried.kind, "refused");
  assert.equal(retried.reason, "already-typed");
  assert.deepEqual(retried.page.lines, ["$ make", "done", "$ "]);
  assert.equal(ports.writes.length, 1);

  const later = cursorAt(terminal.id, ports.terminal(terminal.id).offset);
  ports.output(terminal.id, "git sta");
  const changed = await desk.send(terminal.id, { text: "ls", enter: true }, later, 45_000, NEVER);
  assert.equal(changed.reason, "changed");
  assert.deepEqual(changed.page.lines, ["$ git sta"]);
  assert.equal(changed.cursor, ports.terminal(terminal.id).offset);
  assert.equal(ports.writes.length, 1);
});

test("keys are never refused, with any cursor; without a cursor text is typed after whatever the person left", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal, cursor } = await desk.open(DIR);
  ports.output(terminal.id, `sleep 30${ENTER}`);
  const stale = cursorAt(terminal.id, cursor);
  const pressing = desk.send(terminal.id, { keys: "ctrl+c", enter: false }, stale, 45_000, NEVER);
  await flush();
  ports.output(terminal.id, `^C\r\n${PROMPT}`);
  const pressed = await settle(t, pressing);
  assert.equal(pressed.kind, "typed");
  assert.equal(pressed.wait.reason, "ready");
  // The page starts at the agent's cursor: what came before its keys is not skipped.
  assert.deepEqual(pressed.wait.page.lines, ["$ sleep 30", "^C", "$ "]);
  ports.output(terminal.id, "git sta");
  const appended = desk.send(terminal.id, { text: "ls", enter: false }, null, 0, NEVER);
  assert.equal((await settle(t, appended)).kind, "typed");
  assert.deepEqual(ports.writes.map((write) => write.data), ["\x03", "ls"]);
});

test("a wait ends ready when a line went in and the shell reads again; the person's typing never ends it", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal, cursor } = await desk.open(DIR);
  const waiting = desk.wait(terminal.id, cursorAt(terminal.id, cursor), 45_000, NEVER);
  let settled = false;
  waiting.then(() => { settled = true; });
  ports.output(terminal.id, "git st");
  for (let i = 0; i < 40; i++) { await flush(); t.mock.timers.tick(250); }
  assert.equal(settled, false, "typing alone ended the wait");
  ports.output(terminal.id, `atus${ENTER}clean\r\n${PROMPT}`);
  const result = await settle(t, waiting);
  assert.equal(result.reason, "ready");
  assert.deepEqual(result.typed, []);
  assert.deepEqual(result.page.lines, ["$ git status", "clean", "$ "]);
});

test("each way a wait ends: paused, more, exited, closed with the folder's live terminals, timeout, aborted, now", async (t) => {
  const { ports, desk } = setup(t);
  const open = async (dir) => {
    const { terminal, cursor } = await desk.open(dir);
    return { id: terminal.id, at: cursorAt(terminal.id, cursor) };
  };

  const prompt = await open("/work/prompt");
  const pausing = desk.wait(prompt.id, prompt.at, 45_000, NEVER);
  ports.output(prompt.id, `apt upgrade${ENTER}Continue? [Y/n] `);
  assert.equal((await settle(t, pausing)).reason, "paused");

  const big = await open("/work/big");
  ports.output(big.id, `seq 1 5000${ENTER}${Array.from({ length: 5000 }, (_, i) => `${i + 1}\r\n`).join("")}`);
  const more = await desk.wait(big.id, big.at, 45_000, NEVER);
  assert.equal(more.reason, "more");
  assert.equal(more.page.more, true);
  assert.ok(more.cursor < ports.terminal(big.id).offset);
  const rest = await desk.wait(big.id, cursorAt(big.id, more.cursor), 45_000, NEVER);
  assert.equal(Number(rest.page.lines[0]), Number(more.page.lines.at(-1)) + 1);

  const exiting = await open("/work/exiting");
  const exitWait = desk.wait(exiting.id, exiting.at, 45_000, NEVER);
  await flush();
  ports.exit(exiting.id, 3);
  const exited = await settle(t, exitWait);
  assert.equal(exited.reason, "exited");
  assert.deepEqual(exited.terminal.state, { kind: "exited", code: 3 });

  const restarted = await open(DIR);
  const sibling = ports.add(DIR);
  const closeWait = desk.wait(restarted.id, restarted.at, 45_000, NEVER);
  await flush();
  ports.close(restarted.id);
  const replacement = ports.add(DIR, { browsers: 1 });
  const closed = await settle(t, closeWait);
  assert.equal(closed.reason, "closed");
  assert.deepEqual(closed.live.map((terminal) => terminal.id), [replacement, sibling]);

  const idle = await open("/work/idle");
  const timedOut = await settle(t, desk.wait(idle.id, idle.at, 5_000, NEVER));
  assert.equal(timedOut.reason, "timeout");
  assert.ok(timedOut.waitedMs >= 5_000);
  const controller = new AbortController();
  const aborting = desk.wait(idle.id, idle.at, 45_000, controller.signal);
  await flush();
  controller.abort();
  assert.equal((await settle(t, aborting)).reason, "aborted");
  assert.equal((await desk.wait(idle.id, idle.at, 0, NEVER)).reason, "now");
});

test("a hold keeps one listener while the agent calls, and lets go HOLD_MS after its last touch", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal } = await desk.open(DIR);
  const listeners = () => ports.records.get(terminal.id).listeners.size;
  assert.equal(listeners(), 1);
  await desk.read(terminal.id, null);
  t.mock.timers.tick(HOLD_MS - 1_000);
  assert.equal(listeners(), 1);
  await desk.wait(terminal.id, cursorAt(terminal.id, 0), 0, NEVER);
  t.mock.timers.tick(HOLD_MS - 1);
  assert.equal(listeners(), 1, "a wait re-armed the hold");
  t.mock.timers.tick(1);
  assert.equal(listeners(), 0);
  await desk.open(DIR);
  assert.equal(listeners(), 1);
});

test("agentTerminalIds lists terminals an agent started or holds, newest touch first", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const key = Symbol.for("pi-web.mcp-endpoint.terminal-desk");
  const saved = globalThis[key];
  globalThis[key] = undefined;
  t.after(() => { globalThis[key] = saved; });
  const ports = fakePorts();
  const desk = createTerminalDesk(ports, fakeRender().render);
  const persons = ports.add("/elsewhere", { browsers: 1 });
  const mine = (await desk.open(DIR)).terminal.id;
  assert.deepEqual([...agentTerminalIds()], [mine]);
  t.mock.timers.tick(1_000);
  await desk.wait(persons, cursorAt(persons, 0), 0, NEVER);
  assert.deepEqual([...agentTerminalIds()], [persons, mine]);
});

test("a terminal that ended is remembered: who ended it, how, and the folder's live terminals; an unknown id is an error", async (t) => {
  const { ports, desk } = setup(t);
  const theirs = (await desk.open(DIR)).terminal.id;
  ports.close(theirs);
  const live = ports.add(DIR);
  t.mock.timers.tick(12_000);
  const gone = await desk.wait(theirs, cursorAt(theirs, 0), 45_000, NEVER);
  assert.deepEqual({ ...gone, live: gone.live.map((terminal) => terminal.id) }, {
    kind: "gone", id: theirs, ended: { cwd: DIR, at: T0, end: { kind: "closed" }, by: "elsewhere" }, agoMs: 12_000, live: [live],
  });
  assert.equal((await desk.read(theirs, null)).kind, "gone");
  assert.equal((await desk.send(theirs, { text: "ls", enter: true }, null, 0, NEVER)).kind, "gone");

  const mine = (await desk.open("/other")).terminal.id;
  assert.equal((await desk.close(mine)).kind, "closed");
  assert.equal((await desk.close(mine)).ended.by, "agent");

  await assert.rejects(desk.read(hex(999), null), (error) => error instanceof ToolError && /No terminal/.test(error.message));
});

test("cursors: another terminal's or one past the output reads as the latest view; one below the window counts what was lost", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal, cursor } = await desk.open(DIR);
  const other = ports.add(DIR);
  for (const foreign of [cursorAt(other, cursor), cursorAt(terminal.id, cursor + 10_000)]) {
    const result = await desk.wait(terminal.id, foreign, 45_000, NEVER);
    assert.deepEqual([result.reason, result.foreign, result.cursor], ["now", true, ports.terminal(terminal.id).offset]);
    const read = await desk.read(terminal.id, foreign);
    assert.deepEqual([read.kind, read.foreign], ["latest", true]);
  }
  const refused = await desk.send(terminal.id, { text: "ls", enter: true }, cursorAt(other, cursor), 0, NEVER);
  assert.equal(refused.reason, "foreign");

  ports.output(terminal.id, `${"x".repeat(200_000)}\r\nafter\r\n`);
  const lost = await desk.wait(terminal.id, cursorAt(terminal.id, cursor), 0, NEVER);
  const record = ports.terminal(terminal.id);
  const windowStart = record.offset - record.backlog.length + record.backlog.indexOf("\n") + 1;
  assert.equal(lost.page.lost, windowStart - cursor);
  assert.deepEqual(lost.page.lines, ["after"]);
  assert.equal(decodeTerminalCursor(`term~${terminal.id.slice(0, 8)}~${lost.cursor.toString(36)}`).offset, record.offset);
});

test("read: the latest lines with an earlier cursor, then the page before it; it holds nothing", async (t) => {
  const { ports, desk } = setup(t);
  const id = ports.add(DIR, { output: Array.from({ length: 9000 }, (_, i) => `line ${i}\r\n`).join("") });
  const latest = await desk.read(id, null);
  assert.equal(latest.kind, "latest");
  assert.equal(latest.page.lines.at(-1), "line 8999");
  assert.ok(latest.page.earlier > 0);
  const before = await desk.read(id, cursorAt(id, latest.page.earlier));
  assert.equal(before.kind, "before");
  assert.equal(Number(before.page.lines.at(-1).slice(5)) + 1, Number(latest.page.lines[0].slice(5)));
  assert.equal(ports.records.get(id).listeners.size, 0);
});

test("send refuses bad input and an exited shell before typing anything", async (t) => {
  const { ports, desk } = setup(t);
  const { terminal } = await desk.open(DIR);
  await assert.rejects(desk.send(terminal.id, { keys: "ctrl+c", text: "ls", enter: false }, null, 0, NEVER), (error) => error instanceof ToolError && /must come alone/.test(error.message));
  await assert.rejects(desk.send(terminal.id, { keys: "warp", enter: false }, null, 0, NEVER), /Unknown key "warp"/);
  ports.exit(terminal.id, 0);
  await assert.rejects(desk.send(terminal.id, { text: "ls", enter: true }, null, 0, NEVER), /exited with code 0; nothing was typed/);
  assert.deepEqual(ports.writes, []);
});
