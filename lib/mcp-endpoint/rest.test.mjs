import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { recheckIn, SETTLE_MS, stepRest, TICK_MS } = await jiti.import("./rest.ts");

const quiet = {
  now: 1_000, deadline: 50_000, aborted: false, running: false, subagentsActive: false, sendsInFlight: 0,
  hasNews: true, dialogs: "0", dialogCount: 0, shownDialogs: "0",
};
const watching = { kind: "watching" };
const settling = (since) => ({ kind: "settling", since });
const done = (reason) => ({ kind: "done", reason });

test("stepRest: the table", () => {
  const rows = [
    ["busy keeps watching", watching, { running: true }, watching],
    ["idle with news starts settling", watching, {}, settling(1_000)],
    ["settling holds until the quiet period passes", settling(1_000), { now: 1_000 + SETTLE_MS - 1 }, settling(1_000)],
    ["settled after the quiet period", settling(1_000), { now: 1_000 + SETTLE_MS }, done("settled")],
    ["a new run during settling drops back to watching", settling(1_000), { now: 1_200, running: true }, watching],
    ["active subagents count as busy", watching, { subagentsActive: true }, watching],
    ["the agent's own send in flight counts as busy", settling(1_000), { now: 1_000 + SETTLE_MS, sendsInFlight: 1 }, watching],
    ["idle with nothing new waits for the person", watching, { hasNews: false }, watching],
    ["an unseen dialog ends the wait", watching, { running: true, dialogs: "abcd1234", dialogCount: 1 }, done("dialog")],
    ["a dialog already shown does not", watching, { running: true, dialogs: "abcd1234", dialogCount: 1, shownDialogs: "abcd1234" }, watching],
    ["no dialogs is never a dialog", watching, { dialogs: "0", dialogCount: 0, shownDialogs: "abcd1234", running: true }, watching],
    ["the deadline while busy times out", watching, { now: 50_000, running: true }, done("timeout")],
    ["the deadline during settling times out", settling(49_900), { now: 50_000 }, done("timeout")],
    ["settling finished exactly at the deadline is settled", settling(49_000), { now: 50_000 }, done("settled")],
    ["abort ends it", watching, { aborted: true, running: true }, done("aborted")],
    ["done stays done", done("dialog"), { running: true }, done("dialog")],
  ];
  for (const [name, phase, changes, expected] of rows) {
    assert.deepEqual(stepRest(phase, { ...quiet, ...changes }), expected, name);
  }
});

test("recheckIn: the settle end, the deadline or a tick, whichever comes first, never negative", () => {
  assert.equal(recheckIn(watching, { now: 0, deadline: 50_000 }), TICK_MS);
  assert.equal(recheckIn(settling(0), { now: 100, deadline: 50_000 }), SETTLE_MS - 100);
  assert.equal(recheckIn(watching, { now: 49_700, deadline: 50_000 }), 300);
  assert.equal(recheckIn(watching, { now: 60_000, deadline: 50_000 }), 0);
});
