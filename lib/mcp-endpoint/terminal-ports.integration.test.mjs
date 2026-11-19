import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { withEnv } from "./test-env.mjs";

const scratch = await mkdtemp(join(tmpdir(), "pi-web-terminal-ports-"));
process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { piWebTerminalPorts } = await jiti.import("./ports.ts");
const { getTerminalStats, killTerminal, subscribeTerminal, TERMINAL_RECONNECT_MS } = await jiti.import("../terminal-manager.ts");
const { getAllowedFileRoots, isExistingFilePathAllowed } = await jiti.import("../file-access.ts");
test.after(() => rm(scratch, { recursive: true, force: true }));

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function until(check, what, ms = 5_000) {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await tick();
  }
}

/** A real shell through terminal-manager, with a scratch HOME so no one's dotfiles run. */
async function setup(t) {
  const cwd = await realpath(await mkdtemp(join(scratch, "cwd-")));
  withEnv(t, { SHELL: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh", HOME: cwd });
  const ports = piWebTerminalPorts();
  const start = () => {
    const id = ports.start(cwd);
    t.after(() => killTerminal(id, true));
    return id;
  };
  return { ports, cwd, start };
}

test("start: a 32-hex id, a folder file access then allows, and a snapshot of TM's record", async (t) => {
  const { ports, cwd, start } = await setup(t);
  assert.equal(isExistingFilePathAllowed(cwd, await getAllowedFileRoots()), false);
  const id = start();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(isExistingFilePathAllowed(cwd, await getAllowedFileRoots()), true);

  let output = "";
  const stream = subscribeTerminal(id, (event) => { if (event.type === "output") output += event.data; });
  output = stream.output.data;
  ports.write(id, "echo snapshot-$((6*7))\r");
  await until(() => output.includes("snapshot-42"), "the echo");
  stream.unsubscribe();
  const snapshot = ports.terminal(id);
  assert.ok(Number.isInteger(snapshot.pid) && snapshot.pid > 0);
  assert.deepEqual({ ...snapshot, pid: 0 }, {
    id, cwd, pid: 0, cols: 120, rows: 40, offset: output.length, backlog: output, state: { kind: "running" }, listeners: 0,
  });
  assert.deepEqual(ports.terminals().map((terminal) => terminal.id), [id]);
  assert.equal(ports.terminal("0".repeat(32)), null);
});

test("a hold keeps the shell from cleanup, and releasing it arms TM's cleanup again", async (t) => {
  const { ports, start } = await setup(t);
  const id = start();
  const armed = (stats) => stats.nextCleanupAt !== null && Math.abs(stats.nextCleanupAt - Date.now() - TERMINAL_RECONNECT_MS) < 2_000;
  assert.equal(getTerminalStats().detached, 1);
  assert.ok(armed(getTerminalStats()));

  const signals = [];
  const release = ports.hold(id, (signal) => signals.push(signal));
  assert.deepEqual(getTerminalStats(), { count: 1, listeners: 1, detached: 0, exited: 0, nextCleanupAt: null });
  ports.write(id, "echo held\r");
  await until(() => signals.some((signal) => signal.kind === "output"), "an output signal");

  release();
  assert.equal(getTerminalStats().detached, 1);
  assert.ok(armed(getTerminalStats()));
  assert.equal(ports.hold("f".repeat(32), () => {}), null);
});

test("the hold hears the shell's exit code, and a close", async (t) => {
  const { ports, start } = await setup(t);
  const exiting = start();
  const exitSignals = [];
  ports.hold(exiting, (signal) => exitSignals.push(signal));
  ports.write(exiting, "exit 3\r");
  await until(() => exitSignals.some((signal) => signal.kind === "ended"), "the exit");
  assert.deepEqual(exitSignals.at(-1), { kind: "ended", end: { kind: "exited", code: 3 } });
  assert.deepEqual(ports.terminal(exiting).state, { kind: "exited", code: 3 });
  assert.equal(ports.write(exiting, "echo late\r"), false);

  const closing = start();
  const closeSignals = [];
  ports.hold(closing, (signal) => closeSignals.push(signal));
  assert.equal(ports.close(closing), true);
  assert.deepEqual(closeSignals, [{ kind: "ended", end: { kind: "closed" } }]);
  assert.equal(ports.terminal(closing), null);
});

test("Linux: the foreground names sleep and a pipeline's pager, and Ctrl+C through the PTY ends sleep 30", { skip: process.platform !== "linux" }, async (t) => {
  const { ports, start } = await setup(t);
  const id = start();
  ports.hold(id, () => {});
  const foreground = () => ports.foreground(id);
  await until(() => foreground().kind === "shell" && ports.terminal(id).offset > 0, "the shell starts");

  ports.write(id, "sleep 30\r");
  // Between bash's fork and its exec of sleep, the new foreground group is still named bash.
  await until(() => foreground().kind === "program" && foreground().name === "sleep", "sleep runs");
  assert.deepEqual(foreground(), { kind: "program", name: "sleep" });
  ports.write(id, "\x03");
  await until(() => foreground().kind === "shell", "Ctrl+C ends sleep 30", 3_000);

  ports.write(id, "seq 1 200 | less\r");
  await until(() => foreground().kind === "program" && foreground().name === "less", "less runs");
  ports.write(id, "q");
  await until(() => foreground().kind === "shell", "q quits less");
});
