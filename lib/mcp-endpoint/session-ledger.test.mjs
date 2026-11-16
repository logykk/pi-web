import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createLedger, ledger } = await jiti.import("./session-ledger.ts");

const T = 1_000_000;

function clock(start = T) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("a send settles once: the first outcome wins", () => {
  const l = createLedger(clock(T).now);
  const send = l.record("s1", "hello", "followUp");
  assert.deepEqual([send.outcome, send.placement, l.inFlight("s1")], [{ state: "sending" }, { kind: "open" }, 1]);
  l.settle(send.id, { state: "refused", reason: "nope", at: T + 5 });
  l.settle(send.id, { state: "accepted", disposition: "started", at: T + 6 });
  assert.deepEqual([l.markReplied(send.id).outcome.state, l.inFlight("s1"), l.inFlight("other")], ["refused", 0, 0]);
});

const accept = (l, send, at = T) => l.settle(send.id, { state: "accepted", disposition: "queued", at });
const entry = (entryId, text, time) => ({ entryId, text, time });

test("observe lands each open send on one user entry of its text, never one from before it was sent", () => {
  const c = clock(T);
  const l = createLedger(c.now);
  const first = l.record("s1", "go", "followUp");
  const command = l.record("s1", "/plan x", "followUp");
  [first, command].forEach((send) => accept(l, send));
  l.observe("s1", { userEntries: [entry("old", "go", T - 60_000), entry("e1", " go", T - 1_000), entry("e3", "Plan the work for x", T + 1)], queued: null, now: T + 2 });
  assert.equal(l.authorOf("s1", { id: "e1", time: T - 1_000 }), "agent", "2 s of clock skew is allowed");
  assert.equal(l.authorOf("s1", { id: "old", time: T - 60_000 }), "user");
  assert.equal(l.authorOf("s1", { id: "e3", time: T + 1 }), "person", "a command's output is no landing");
  c.t = T + 500;
  const second = l.record("s1", " go ", "followUp");
  accept(l, second, c.t);
  l.observe("s1", { userEntries: [entry("e1", "go", T - 1_000), entry("e2", "go", T + 11_000)], queued: null, now: T + 11_001 });
  assert.equal(l.authorOf("s1", { id: "e2", time: T + 11_000 }), "agent", "an entry another send landed on is taken");
  l.observe("s1", { userEntries: [], queued: [], now: T + 20_000 });
  assert.deepEqual(l.news("s1", 0), [], "a landed send never goes missing");
});

test("observe at rest: an accepted send out of the queue for over 2 s goes missing, and is news once per cursor", () => {
  const c = clock(T);
  const l = createLedger(c.now);
  const sends = ["gone", "queued", "/plan", "parked", "refused"].map((text) => l.record("s1", text, "followUp"));
  sends.slice(0, 3).forEach((send) => accept(l, send));
  l.settle(sends[3].id, { state: "parked", at: T });
  l.settle(sends[4].id, { state: "refused", reason: "x", at: T });
  c.t = T + 1_000;
  const young = l.record("s1", "young", "followUp");
  accept(l, young, c.t);
  l.observe("s1", { userEntries: [], queued: null, now: T + 2_500 });
  assert.deepEqual(l.news("s1", 0), [], "nothing goes missing while pi works");
  l.observe("s1", { userEntries: [], queued: [" queued "], now: T + 2_500 });
  assert.deepEqual(l.news("s1", 0).map((send) => send.text), ["gone"]);
  assert.deepEqual(l.news("s1", 0)[0].placement, { kind: "missing", since: T + 2_500 });
  assert.deepEqual(l.news("s1", T + 2_500), [], "a cursor from after the event has seen it");
  l.observe("s1", { userEntries: [entry("e1", "gone", T + 4_000)], queued: [], now: T + 4_000 });
  assert.equal(l.authorOf("s1", { id: "e1", time: T + 4_000 }), "person", "a missing send never lands");
});

test("news: a refusal pi_send already replied about, never one it reported itself", () => {
  const c = clock(T);
  const l = createLedger(c.now);
  const late = l.record("s1", "late", "followUp");
  assert.deepEqual([l.markReplied(late.id).outcome, l.inFlight("s1")], [{ state: "sending" }, 1]);
  l.settle(late.id, { state: "refused", reason: "No API key", at: T + 5 });
  const early = l.record("s1", "early", "followUp");
  l.settle(early.id, { state: "refused", reason: "x", at: T + 6 });
  assert.equal(l.markReplied(early.id).repliedWhileSending, false, "a settled send was not replied to while sending");
  assert.deepEqual([l.news("s1", T).map((send) => send.text), l.inFlight("s1")], [["late"], 0]);
});

test("withdraw: a text is the agent's while an accepted send of it is open, and that send goes missing", () => {
  const c = clock(T);
  const l = createLedger(c.now);
  const twice = [l.record("s1", "run tests", "followUp"), l.record("s1", "run tests", "followUp")];
  twice.forEach((send) => accept(l, send));
  const landed = l.record("s1", "landed", "followUp");
  accept(l, landed);
  l.observe("s1", { userEntries: [entry("e1", "landed", T)], queued: null, now: T });
  assert.deepEqual(l.withdraw("s1", ["run tests", "landed", "run tests", "run tests", "typed"], T + 1), ["agent", "person", "agent", "person", "person"]);
  assert.deepEqual(l.news("s1", T).map((send) => send.text), ["run tests", "run tests"]);
  assert.deepEqual(l.withdraw("s1", ["run tests"], T + 2), ["person"], "a missing send is never matched again");
});

test("the ledger keeps the newest 200 sends per session, none older than a day", () => {
  const c = clock(T);
  const l = createLedger(c.now);
  accept(l, l.record("s1", "first", "followUp"));
  c.t += 25 * 60 * 60_000;
  for (let i = 0; i < 205; i += 1) accept(l, l.record("s1", `m${i}`, "followUp"), c.t);
  assert.deepEqual(l.withdraw("s1", ["first", "m4", "m5", "m204"], c.t), ["person", "person", "agent", "agent"]);
});

test("ledger() is one per process", async () => {
  const fresh = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  assert.equal((await fresh.import("./session-ledger.ts")).ledger(), ledger());
});
