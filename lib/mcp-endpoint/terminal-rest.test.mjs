import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { frontOf, stepTerminalWait, PAUSE_QUIET_MS, READY_QUIET_MS, TERMINAL_TICK_MS } = await jiti.import("./terminal-rest.ts");

const NOW = 100_000;
const quiet = (ms) => NOW - ms;
const base = {
  now: NOW, deadline: NOW + 30_000, aborted: false, end: null, news: "entered", overPage: false,
  lastActivityAt: quiet(0), front: "line-editor", endsInText: false, alternateScreen: false,
};

const RULES = [
  ["the call's signal aborted, before anything else", { aborted: true, end: { kind: "exited", code: 0 }, overPage: true }, "aborted"],
  ["the shell exited", { end: { kind: "exited", code: 2 }, overPage: true }, "exited"],
  ["the terminal was closed", { end: { kind: "closed" } }, "closed"],
  ["more news than a page, at once", { overPage: true, news: "typing", lastActivityAt: quiet(0) }, "more"],
  ["a line went in and the line editor is quiet 300 ms", { lastActivityAt: quiet(READY_QUIET_MS) }, "ready"],
  ["a line editor not quiet long enough", { lastActivityAt: quiet(READY_QUIET_MS - 1) }, null],
  ["a program quiet 2 s after a prompt that ends in text", { front: "program", endsInText: true, lastActivityAt: quiet(PAUSE_QUIET_MS) }, "paused"],
  ["a program quiet 2 s on a full screen", { front: "program", alternateScreen: true, lastActivityAt: quiet(PAUSE_QUIET_MS) }, "paused"],
  ["a program quiet 2 s with no front known", { front: "unknown", lastActivityAt: quiet(PAUSE_QUIET_MS) }, "paused"],
  ["a quiet program whose output ends in a line break keeps the wait (a silent build)", { front: "program", lastActivityAt: quiet(10_000) }, null],
  ["a program prompt quiet under 2 s", { front: "program", endsInText: true, lastActivityAt: quiet(PAUSE_QUIET_MS - 1) }, null],
  ["the person typing never ends a wait", { news: "typing", lastActivityAt: quiet(10_000), endsInText: true }, null],
  ["nothing new", { news: "none", lastActivityAt: quiet(10_000) }, null],
  ["the deadline", { news: "typing", now: NOW + 30_000 }, "timeout"],
  ["the deadline loses to a ready shell", { now: NOW + 30_000, lastActivityAt: quiet(READY_QUIET_MS) }, "ready"],
];

for (const [name, overrides, reason] of RULES) {
  test(`terminal wait: ${name}`, () => {
    const step = stepTerminalWait({ ...base, ...overrides });
    assert.deepEqual(step, reason ? { kind: "done", reason } : { kind: "watching", recheckInMs: TERMINAL_TICK_MS });
  });
}

test("a watching wait rechecks at the next tick, or at its deadline if sooner", () => {
  assert.deepEqual(stepTerminalWait({ ...base, news: "none", deadline: NOW + 100 }), { kind: "watching", recheckInMs: 100 });
});

test("the front: bracketed paste on is a line editor, off a program; a full screen is a program; else the foreground decides", () => {
  const modes = (bracketedPaste, alternateScreen = false) => ({ bracketedPaste, alternateScreen, applicationCursorKeys: false });
  const shell = { kind: "shell" };
  const program = { kind: "program", name: "sleep" };
  assert.equal(frontOf(modes("on"), program), "line-editor");
  assert.equal(frontOf(modes("off"), shell), "program");
  assert.equal(frontOf(modes("on", true), shell), "program");
  assert.equal(frontOf(modes("unknown"), shell), "line-editor");
  assert.equal(frontOf(modes("unknown"), program), "program");
  assert.equal(frontOf(modes("unknown"), { kind: "unknown" }), "unknown");
});
