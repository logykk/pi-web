import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { canonicalDirectory, createDesk, DeskError, parseSessionRef, SEND_ACCEPT_MS, WORKTREE_MS } = await jiti.import("./desk.ts");
const { createLedger } = await jiti.import("./session-ledger.ts");
const { dialogDigest } = await jiti.import("./transcript.ts");

const ID = "s-1";
const T0 = Date.parse("2026-11-14T10:00:00Z");
const NEVER = new AbortController().signal;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const OTHER = { kind: "other" };

function fakeTranscript(cwd = "/work/project") {
  const entries = [];
  let leafId = null;
  const transcript = {
    getLeafId: () => leafId,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    getEntries: () => entries,
    getSessionName: () => undefined,
    getCwd: () => cwd,
    add(role, content, extra = {}) {
      const entry = { type: "message", id: `e${entries.length + 1}`, parentId: leafId, timestamp: new Date(Date.now()).toISOString(), message: { role, content, ...extra } };
      entries.push(entry);
      leafId = entry.id;
      return entry.id;
    },
    reply(text) {
      return transcript.add("assistant", [{ type: "text", text }], { provider: "p", model: "m" });
    },
    custom(customType, content, display) {
      return transcript.entry({ type: "custom_message", customType, content, display });
    },
    entry(fields) {
      const entry = { id: `e${entries.length + 1}`, parentId: leafId, timestamp: new Date(Date.now()).toISOString(), ...fields };
      entries.push(entry);
      leafId = entry.id;
      return entry.id;
    },
  };
  return transcript;
}

function convert(entries) {
  const kept = entries.filter((entry) => entry.type === "message" || entry.type === "custom_message");
  return {
    messages: kept.map((entry) => entry.type === "custom_message"
      ? { role: "custom", customType: entry.customType, content: entry.content, display: entry.display }
      : entry.message),
    entryIds: kept.map((entry) => entry.id),
  };
}

function fakeLive(transcript, id = ID) {
  const listeners = new Set();
  const live = {
    id, alive: true, running: false, dialogs: [], tools: [], replay: [], queue: { steering: [], followUp: [] }, answers: [], aborts: 0,
    abortResult: { steering: [], followUp: [] },
    listenerCount: () => listeners.size,
    emit(event) { for (const listener of [...listeners]) listener(event); },
    promptImpl: async (text, behavior) => {
      if (live.running) live.queue[behavior === "steer" ? "steering" : "followUp"].push(text);
      else {
        live.running = true;
        transcript.add("user", text);
        live.emit(OTHER);
      }
      return { parked: false };
    },
    isAlive: () => live.alive,
    isRunning: () => live.running,
    onEvent(listener) {
      listeners.add(listener);
      for (const event of live.replay) listener(event);
      return () => listeners.delete(listener);
    },
    openDialogs: () => live.dialogs,
    runningTools: () => live.tools,
    prompt: (text, behavior) => live.promptImpl(text, behavior),
    async abort() {
      live.aborts += 1;
      live.running = false;
      return live.abortResult;
    },
    async answer(response) { live.answers.push(response); },
    queued: () => live.queue,
    transcript: () => transcript,
    model: () => "p/m",
    thinkingLevel: () => "off",
    finish(text) {
      transcript.reply(text);
      live.running = false;
      live.emit(OTHER);
    },
  };
  return live;
}

function fakePorts(transcript) {
  const ports = {
    lives: new Map(),
    files: new Map([[ID, transcript]]),
    holds: [],
    created: [],
    subagents: false,
    worktree: () => new Promise(() => {}),
    live: (id) => (ports.lives.get(id)?.alive ? ports.lives.get(id) : null),
    open: async (id) => ports.live(id),
    create: async (cwd, options) => {
      ports.created.push({ cwd, options });
      const fresh = fakeTranscript(cwd);
      const live = fakeLive(fresh, "new-1");
      ports.lives.set("new-1", live);
      return live;
    },
    saved: async (id) => ports.files.get(id) ?? null,
    toMessages: (entries) => convert(entries),
    page: (source) => ({ ...convert(source.getEntries()), hasMore: false, oldestEntryId: source.getEntries()[0]?.id ?? null }),
    listSessions: async () => [],
    subagentsActive: () => ports.subagents,
    project: async () => ({ branch: "main", isWorktree: false }),
    untrusted: () => false,
    hold: (id) => ports.holds.push(id),
    addWorktree: (dir, branch) => ports.worktree(dir, branch),
  };
  return ports;
}

function setup(t, { loaded = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const transcript = fakeTranscript();
  transcript.add("user", "Seeded question");
  transcript.reply("Seeded answer");
  t.mock.timers.tick(1);
  const live = fakeLive(transcript);
  const ports = fakePorts(transcript);
  if (loaded) ports.lives.set(ID, live);
  const ledger = createLedger();
  const desk = createDesk(ports, ledger);
  const cursorNow = () => ({ entryId: transcript.getLeafId(), dialogs: "0", at: Date.now() });
  const advance = async (ms, step = 50) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await flush();
      t.mock.timers.tick(step);
    }
    await flush();
  };
  return { transcript, live, ports, ledger, desk, cursorNow, advance };
}

function track(promise) {
  const state = { done: false };
  promise.then(() => { state.done = true; }, () => { state.done = true; });
  return state;
}

const texts = (result) => result.delta.messages.map((message, index) => {
  const text = typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("");
  return `[${result.delta.authors[index]}] ${text}`;
});

test("a send while anyone's run is going is queued, and its cursor is the leaf before it", async (t) => {
  const { desk, live, ports, transcript } = setup(t);
  live.running = true;
  const before = transcript.getLeafId();
  const result = await desk.send(ID, "also add a test", { steer: false, cursor: null }, NEVER);
  assert.deepEqual(result.send.outcome, { state: "accepted", disposition: "queued", at: Date.now() });
  assert.equal(result.cursor.entryId, before);
  assert.equal(result.cursor.dialogs, "0", "the agent was shown no dialog");
  assert.deepEqual(result.status.queued.followUp, ["also add a test"]);
  assert.deepEqual(ports.holds, [ID], "sending holds the session");

  const steered = await desk.send(ID, "now", { steer: true, cursor: result.cursor }, NEVER);
  assert.equal(steered.send.delivery, "steer");
  assert.deepEqual(live.queue.steering, ["now"]);
  assert.equal(steered.cursor, result.cursor, "a passed cursor comes back unchanged");
});

test("a send pi has not taken after 15 s is reported on its way, and a late refusal is news for the next wait", async (t) => {
  const { desk, live, advance } = setup(t);
  let refuse;
  live.promptImpl = () => new Promise((_, reject) => { refuse = reject; });
  const sending = desk.send(ID, "hello", { steer: false, cursor: null }, NEVER);
  await advance(SEND_ACCEPT_MS);
  const result = await sending;
  assert.deepEqual([result.send.outcome.state, result.send.repliedWhileSending], ["sending", true]);
  assert.equal(result.status.sendsInFlight, 1);

  await advance(1_000);
  const refusedAt = Date.now();
  refuse(new Error("No API key found for p"));
  await flush();
  const waited = await desk.wait(ID, result.cursor, 0, NEVER);
  assert.equal(waited.reason, "now");
  assert.deepEqual(waited.news.map((send) => send.outcome), [{ state: "refused", reason: "No API key found for p", at: refusedAt }]);
  const again = await desk.wait(ID, waited.cursor, 0, NEVER);
  assert.deepEqual(again.news, [], "news is reported once per cursor");
});

test("a wait does not end in the gap between a settled run and the deferred one that follows", async (t) => {
  const { desk, live, transcript, advance, cursorNow } = setup(t);
  live.running = true;
  const waiting = desk.wait(ID, cursorNow(), 45_000, NEVER);
  const state = track(waiting);
  await flush();
  live.finish("first run done");
  await advance(300);
  live.running = true;
  transcript.add("user", "queued follow-up");
  live.emit(OTHER);
  await advance(2_000);
  assert.equal(state.done, false, "agent_settled followed by a new agent_start is not rest");
  live.finish("second run done");
  await advance(550);
  assert.equal(state.done, false, "rest needs the full quiet period");
  await advance(100);
  const result = await waiting;
  assert.equal(result.reason, "settled");
  assert.deepEqual(texts(result), ["[pi] first run done", "[person] queued follow-up", "[pi] second run done"]);
  assert.equal(result.cursor.entryId, transcript.getLeafId());
  assert.equal(live.listenerCount(), 0, "the wait unsubscribes");
});

test("subagents that will report back keep a wait from settling", async (t) => {
  const { desk, ports, transcript, advance, cursorNow } = setup(t);
  const cursor = cursorNow();
  transcript.reply("a subagent reported");
  ports.subagents = true;
  const waiting = desk.wait(ID, cursor, 45_000, NEVER);
  const state = track(waiting);
  await advance(5_000);
  assert.equal(state.done, false);
  ports.subagents = false;
  await advance(2_000);
  assert.equal((await waiting).reason, "settled");
});

test("a wait follows the wrapper that replaces the one it watched", async (t) => {
  const { desk, live, ports, transcript, advance, cursorNow } = setup(t);
  live.running = true;
  const waiting = desk.wait(ID, cursorNow(), 45_000, NEVER);
  await flush();
  live.alive = false;
  live.emit({ kind: "ended" });
  assert.equal(live.listenerCount(), 0, "shutdown detaches at once");
  const replacement = fakeLive(transcript);
  replacement.running = true;
  ports.lives.set(ID, replacement);
  await advance(1_000);
  assert.equal(replacement.listenerCount(), 1, "the next check attaches to the replacement");
  replacement.finish("after the fork");
  await advance(700);
  const result = await waiting;
  assert.equal(result.reason, "settled");
  assert.deepEqual(texts(result), ["[pi] after the fork"]);
});

test("a wrapper an extension shut down (ended in the replay) is not watched", async (t) => {
  const { desk, live, advance, cursorNow } = setup(t);
  live.replay = [{ kind: "ended" }];
  const waiting = desk.wait(ID, cursorNow(), 2_000, NEVER);
  await advance(2_000);
  const result = await waiting;
  assert.equal(result.reason, "timeout");
  assert.equal(live.listenerCount(), 0);
});

test("a wait on an unloaded session never starts it, and attaches once the person's page does", async (t) => {
  const { desk, live, ports, advance, cursorNow } = setup(t, { loaded: false });
  let opened = 0;
  ports.open = async () => { opened += 1; return null; };
  const waiting = desk.wait(ID, cursorNow(), 45_000, NEVER);
  await advance(1_500);
  live.running = true;
  ports.lives.set(ID, live);
  await advance(1_000);
  assert.equal(live.listenerCount(), 1);
  live.finish("answered for the person");
  await advance(700);
  assert.deepEqual(texts(await waiting), ["[pi] answered for the person"]);
  assert.equal(opened, 0);
});

test("pi's and extensions' errors during a wait reach the agent as notices", async (t) => {
  const { desk, live, advance, cursorNow } = setup(t);
  live.running = true;
  const waiting = desk.wait(ID, cursorNow(), 3_000, NEVER);
  await flush();
  live.emit({ kind: "prompt-error", message: "No API key found for p" });
  live.emit({ kind: "extension-error", extensionPath: "/ext/guard.ts", error: "boom" });
  await advance(3_000);
  assert.deepEqual((await waiting).notices, ["pi reported an error: No API key found for p", "Extension /ext/guard.ts failed: boom"]);
});

test("a timeout carries the progress so far and a cursor past it", async (t) => {
  const { desk, live, transcript, advance, cursorNow } = setup(t);
  live.running = true;
  const waiting = desk.wait(ID, cursorNow(), 5_000, NEVER);
  await advance(1_000);
  transcript.add("user", "typed in pi-web");
  live.emit(OTHER);
  await advance(4_000);
  const result = await waiting;
  assert.deepEqual([result.reason, result.waitedMs], ["timeout", 5_000]);
  assert.deepEqual(texts(result), ["[person] typed in pi-web"]);
  assert.equal(result.cursor.entryId, transcript.getLeafId());
  assert.equal(result.status.running, true);
});

test("an idle session with nothing new waits for the person until the deadline", async (t) => {
  const { desk, advance, cursorNow } = setup(t);
  const waiting = desk.wait(ID, cursorNow(), 3_000, NEVER);
  await advance(3_000);
  const result = await waiting;
  assert.deepEqual([result.reason, result.delta.messages.length], ["timeout", 0]);
});

test("a dialog the agent has not seen ends the wait; once shown, the next wait leaves it to the person", async (t) => {
  const { desk, live, advance, cursorNow } = setup(t);
  live.running = true;
  const waiting = desk.wait(ID, cursorNow(), 45_000, NEVER);
  await flush();
  const request = { type: "extension_ui_request", id: "d1", method: "confirm", title: "Apply the migration?", message: "It drops a column." };
  live.dialogs = [request];
  live.emit(OTHER);
  const result = await waiting;
  assert.equal(result.reason, "dialog");
  assert.deepEqual(result.status.dialogs, [{ id: "d1", kind: "confirm", title: "Apply the migration?", message: "It drops a column." }]);
  assert.equal(result.cursor.dialogs, dialogDigest(["d1"]));

  const next = desk.wait(ID, result.cursor, 2_000, NEVER);
  await advance(2_000);
  assert.equal((await next).reason, "timeout");
  assert.equal((await desk.wait(ID, { ...result.cursor, dialogs: "0" }, 0, NEVER)).reason, "dialog", "a cursor that saw no dialog gets it again");
});

test("the agent's own message reads [agent] once it lands, and a withdrawn one is news", async (t) => {
  const { desk, live, advance } = setup(t);
  const sent = await desk.send(ID, "please refactor", { steer: false, cursor: null }, NEVER);
  assert.equal(sent.send.outcome.disposition, "started");
  assert.deepEqual((await desk.read(ID, { messages: 12 })).page.authors, ["user", "pi", "agent"], "pi_read labels it too");
  live.finish("refactored");
  const first = desk.wait(ID, sent.cursor, 45_000, NEVER);
  await advance(700);
  const waited = await first;
  assert.deepEqual(texts(waited), ["[agent] please refactor", "[pi] refactored"]);

  live.running = true;
  const queued = await desk.send(ID, "then add docs", { steer: false, cursor: waited.cursor }, NEVER);
  assert.equal(queued.send.outcome.disposition, "queued");
  live.queue.followUp = [];
  live.running = false;
  live.emit(OTHER);
  const waiting = desk.wait(ID, queued.cursor, 45_000, NEVER);
  await advance(4_000);
  const result = await waiting;
  assert.equal(result.reason, "settled");
  assert.deepEqual(result.news.map((send) => send.text), ["then add docs"], "Recall in pi-web took it out of pi's queue");
});

test("stop on an idle session sends nothing; on a run it labels what it withdrew", async (t) => {
  const { desk, live } = setup(t);
  const idle = await desk.stop(ID);
  assert.deepEqual([idle.kind, live.aborts], ["idle", 0]);

  live.running = true;
  await desk.send(ID, "agent follow-up", { steer: false, cursor: null }, NEVER);
  live.abortResult = { steering: ["person steer"], followUp: ["agent follow-up"] };
  const stopped = await desk.stop(ID);
  assert.equal(live.aborts, 1);
  assert.deepEqual(stopped.withdrawn, [{ text: "person steer", author: "person" }, { text: "agent follow-up", author: "agent" }]);
  assert.equal(stopped.status.running, false);
});

test("a send found missing is never the agent's again: the person queueing the same text and stopping withdraws the person's", async (t) => {
  const { desk, live, advance } = setup(t);
  live.running = true;
  const queued = await desk.send(ID, "run tests", { steer: false, cursor: null }, NEVER);
  live.queue.followUp = [];
  live.running = false;
  live.emit(OTHER);
  const waiting = desk.wait(ID, queued.cursor, 45_000, NEVER);
  await advance(4_000);
  assert.deepEqual((await waiting).news.map((send) => send.text), ["run tests"], "Recall in pi-web took it out of pi's queue");

  live.running = true;
  live.queue.followUp = ["run tests"];
  live.abortResult = { steering: [], followUp: ["run tests"] };
  const stopped = await desk.stop(ID);
  assert.deepEqual(stopped.withdrawn, [{ text: "run tests", author: "person" }]);
});

test("stop waits for the agent's own send on its way rather than aborting nothing", async (t) => {
  const { desk, live, advance } = setup(t);
  let accept;
  live.promptImpl = () => new Promise((resolve) => { accept = resolve; });
  const sending = desk.send(ID, "go", { steer: false, cursor: null }, NEVER);
  await advance(SEND_ACCEPT_MS);
  await sending;
  const stopping = desk.stop(ID);
  await advance(1_000);
  live.running = true;
  accept({ parked: false });
  await advance(200);
  const stopped = await stopping;
  assert.deepEqual([stopped.kind, live.aborts], ["stopped", 1]);
});

test("stop on an unloaded session waits for the agent's send that is loading it, then stops the run it started", async (t) => {
  const { desk, live, ports, advance } = setup(t, { loaded: false });
  let load;
  ports.open = () => new Promise((resolve) => {
    load = () => {
      ports.lives.set(ID, live);
      resolve(live);
    };
  });
  const sending = desk.send(ID, "go", { steer: false, cursor: null }, NEVER);
  await flush();
  const stopping = desk.stop(ID);
  await advance(1_000);
  load();
  await advance(200);
  const stopped = await stopping;
  assert.deepEqual([stopped.kind, live.aborts, live.running], ["stopped", 1, false]);
  assert.equal((await sending).send.outcome.state, "accepted");
});

test("a wait and a read at the same moment name the same running tool: the top-level call, not one it makes itself", async (t) => {
  const { desk, live, advance, cursorNow } = setup(t);
  live.running = true;
  live.tools = [{ toolCallId: "c1", toolName: "codemode", args: { code: "x" }, elapsedMs: 0 }];
  const waiting = desk.wait(ID, cursorNow(), 2_000, NEVER);
  await flush();
  live.emit(OTHER);
  await advance(2_000);
  const waited = await waiting;
  const read = await desk.read(ID, { messages: 1 });
  assert.match(read.status.activity, /^codemode `x` for /);
  assert.match(waited.status.activity, /^codemode `x` for /);
});

test("a message an extension keeps for the model alone never reaches the agent, and wakes no wait", async (t) => {
  const { desk, live, transcript, advance, cursorNow } = setup(t);
  const cursor = cursorNow();
  const quiet = desk.wait(ID, cursor, 2_000, NEVER);
  await flush();
  transcript.custom("ctx", "model-only context", false);
  live.emit(OTHER);
  await advance(2_000);
  assert.equal((await quiet).reason, "timeout");

  transcript.custom("note", "for everyone", true);
  transcript.reply("visible reply");
  assert.deepEqual(texts(await desk.wait(ID, cursor, 0, NEVER)), ["[extension] for everyone", "[pi] visible reply"]);
  const read = await desk.read(ID, { messages: 12 });
  assert.deepEqual(read.page.messages.map((message) => message.content), ["Seeded question", [{ type: "text", text: "Seeded answer" }], "for everyone", [{ type: "text", text: "visible reply" }]]);
});

test("a title written in the background wakes no wait", async (t) => {
  const { desk, live, transcript, advance, cursorNow } = setup(t);
  const waiting = desk.wait(ID, cursorNow(), 2_000, NEVER);
  await flush();
  transcript.entry({ type: "session_info", name: "Seeded question" });
  live.emit(OTHER);
  await advance(2_000);
  assert.deepEqual([(await waiting).reason, (await waiting).delta.messages], ["timeout", []]);
});

test("answers map to the dialog's kind; a closed dialog and a panel are refused plainly", async (t) => {
  const { desk, live } = setup(t);
  assert.deepEqual(await desk.answer(ID, "gone", { value: true }), { outcome: "closed" });
  live.running = true;
  live.dialogs = [
    { type: "extension_ui_request", id: "c", method: "select", title: "Pick", options: ["Yes", "No"] },
    { type: "extension_ui_request", id: "y", method: "confirm", title: "Sure?", message: "" },
    { type: "extension_ui_request", id: "x", method: "editor", title: "Notes", prefill: "a" },
    { type: "extension_ui_request", id: "p", method: "custom", lines: ["panel"] },
  ];
  assert.equal((await desk.answer(ID, "c", { value: 2 })).shown, "No");
  assert.equal((await desk.answer(ID, "c", { value: "yes" })).shown, "Yes");
  await desk.answer(ID, "y", { value: "no" });
  await desk.answer(ID, "x", { value: "written" });
  await desk.answer(ID, "x", { cancel: true });
  assert.deepEqual(live.answers, [
    { type: "extension_ui_response", id: "c", value: "No" },
    { type: "extension_ui_response", id: "c", value: "Yes" },
    { type: "extension_ui_response", id: "y", confirmed: false },
    { type: "extension_ui_response", id: "x", value: "written" },
    { type: "extension_ui_response", id: "x", cancelled: true },
  ]);
  for (const [dialog, value, message] of [["c", 3, /1\. Yes {2}2\. No/], ["y", "maybe", /true or false/], ["x", false, /takes text/], ["p", "a", /only the person/]]) {
    await assert.rejects(desk.answer(ID, dialog, { value }), (error) => error instanceof DeskError && message.test(error.message));
  }
  await assert.rejects(desk.answer("nope", "c", { value: 1 }), /No pi session nope/);
});

test("read never starts a session and its cursor counts the dialogs it shows", async (t) => {
  const { desk, live, ports } = setup(t, { loaded: false });
  let opened = 0;
  ports.open = async () => { opened += 1; return live; };
  const read = await desk.read(ID, { messages: 12 });
  assert.equal(opened, 0);
  assert.deepEqual([read.session.title, read.session.branch, read.status.loaded], ["Seeded question", "main", false]);
  assert.deepEqual(read.page.authors, ["user", "pi"], "entries from before the ledger have unknown authors");
  assert.equal(read.cursor.entryId, "e2");
  await assert.rejects(desk.read(ID, { messages: 1, before: "zzz" }), /not an entry/);
  assert.equal((await desk.read(ID, { messages: 1, before: "e2" })).kind, "older", "an older page leaves the agent's cursor alone");
  await assert.rejects(desk.read("missing", { messages: 1 }), (error) => error.kind === "not-found");
});

test("a new session starts in the folder's realpath and takes its first message", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-desk-new-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await symlink(dir, `${dir}-link`);
  t.after(() => rm(`${dir}-link`, { force: true }));
  const { desk, ports } = setup(t);
  const result = await desk.newSession({ cwd: `${dir}-link/`, message: "Fix the 500", model: "anthropic/claude-x", thinking: "high", tools: "read-only" }, NEVER);
  assert.deepEqual(ports.created, [{ cwd: dir, options: { tools: "read-only", model: { provider: "anthropic", modelId: "claude-x" }, thinkingLevel: "high" } }]);
  assert.deepEqual([result.session.id, result.session.cwd, result.send.send.outcome.state], ["new-1", dir, "accepted"]);
  assert.deepEqual(ports.holds, ["new-1"]);
  await assert.rejects(desk.newSession({ cwd: dir, message: "x", model: "no-slash", tools: "configured" }, NEVER), /provider\/modelId/);
});

test("a worktree checkout past its bound answers creating; git's refusal is the agent's to read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-desk-wt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { desk, ports, advance } = setup(t);
  const creating = desk.newWorktree({ project: dir, branch: "feat/x" }, NEVER);
  await advance(WORKTREE_MS);
  assert.deepEqual(await creating, { kind: "creating", branch: "feat/x" });
  ports.worktree = async () => { throw new Error("fatal: not a git repository"); };
  await assert.rejects(desk.newWorktree({ project: dir, branch: "x" }, NEVER), /git could not create the worktree: fatal: not a git repository/);
  ports.worktree = async (cwd, branch) => ({ kind: "exists", path: `${cwd}-worktrees/${branch}`, branch });
  assert.equal((await desk.newWorktree({ project: dir, branch: "x" }, NEVER)).kind, "exists");
});

test("canonicalDirectory: ~ expanded, absolute only, existing folders by their realpath", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-desk-dir-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "file"), "x");
  await symlink(dir, join(dir, "self"));
  assert.equal(canonicalDirectory("~"), canonicalDirectory(homedir()));
  assert.equal(canonicalDirectory(`${join(dir, "file")}/../`), canonicalDirectory(dir), "dot segments resolve as path.resolve does");
  assert.equal(canonicalDirectory(join(dir, "self")), canonicalDirectory(dir));
  assert.throws(() => canonicalDirectory("relative/path"), /not an absolute path/);
  assert.throws(() => canonicalDirectory(join(dir, "nope")), /does not exist/);
  assert.throws(() => canonicalDirectory(join(dir, "file")), /is a file/);
});

test("parseSessionRef takes an id or a pi-web link", () => {
  assert.equal(parseSessionRef(" 019a7c2e-5b3d "), "019a7c2e-5b3d");
  assert.equal(parseSessionRef("https://pi.example.net/?session=verify-seeded-chat"), "verify-seeded-chat");
  assert.equal(parseSessionRef("?session=abc&x=1"), "abc");
  for (const bad of ["", "../etc", "a b", "https://pi.example.net/?session=", "-x"]) assert.equal(parseSessionRef(bad), null, bad);
});
