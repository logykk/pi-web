import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createLedger, deliveryNews, ledger, reconcileFates, sendsInFlight } = await jiti.import("./session-ledger.ts");

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("a send settles once, and pi_send's early reply is remembered only while it is sending", () => {
  const c = clock();
  const l = createLedger(c.now);
  const send = l.record("s1", "hello", "followUp");
  assert.deepEqual([send.outcome, send.sentAt, l.since], [{ state: "sending" }, c.t, c.t]);
  assert.equal(sendsInFlight(l.forSession("s1")), 1);
  l.markRepliedWhileSending(send.id);
  l.settle(send.id, { state: "refused", reason: "nope", at: c.t + 5 });
  l.settle(send.id, { state: "accepted", disposition: "started", at: c.t + 6 });
  const settled = l.get(send.id);
  assert.deepEqual([settled.outcome.state, settled.repliedWhileSending], ["refused", true], "the first outcome wins");
  assert.equal(sendsInFlight(l.forSession("s1")), 0);

  const later = l.record("s1", "again", "steer");
  l.settle(later.id, { state: "accepted", disposition: "queued", at: c.t });
  l.markRepliedWhileSending(later.id);
  assert.equal(l.get(later.id).repliedWhileSending, false, "a settled send was not replied to while sending");
  assert.deepEqual(l.forSession("other"), []);
});

test("landed and missing are set once, and a landed send never goes missing", () => {
  const l = createLedger(clock().now);
  const a = l.record("s1", "a", "followUp");
  l.markLanded(a.id, "e1");
  l.markLanded(a.id, "e2");
  l.markMissing(a.id, 5);
  assert.deepEqual(l.get(a.id).placement, { kind: "landed", entryId: "e1" });
  const b = l.record("s1", "b", "followUp");
  l.markMissing(b.id, 5);
  l.markMissing(b.id, 9);
  assert.deepEqual(l.get(b.id).placement, { kind: "missing", since: 5 });
});

test("deliveryNews: late refusals and missing sends after the cursor's time, the same answer every time", () => {
  const sends = [
    { id: "early-refusal", repliedWhileSending: false, outcome: { state: "refused", reason: "x", at: 200 }, placement: { kind: "open" } },
    { id: "late-refusal", repliedWhileSending: true, outcome: { state: "refused", reason: "x", at: 200 }, placement: { kind: "open" } },
    { id: "missing", repliedWhileSending: false, outcome: { state: "accepted", disposition: "queued", at: 50 }, placement: { kind: "missing", since: 300 } },
    { id: "fine", repliedWhileSending: true, outcome: { state: "accepted", disposition: "started", at: 250 }, placement: { kind: "open" } },
  ];
  assert.deepEqual(deliveryNews(sends, 100).map((s) => s.id), ["late-refusal", "missing"]);
  assert.deepEqual(deliveryNews(sends, 100).map((s) => s.id), ["late-refusal", "missing"]);
  assert.deepEqual(deliveryNews(sends, 250).map((s) => s.id), ["missing"]);
  assert.deepEqual(deliveryNews(sends, 300), []);
});

test("reconcileFates: landed from the matches, missing only at rest, out of the queue and past 2 s", () => {
  const accepted = (id, text, sentAt, extra = {}) => ({
    id, text, sentAt, outcome: { state: "accepted", disposition: "queued", at: sentAt }, placement: { kind: "open" }, ...extra,
  });
  const sends = [
    accepted("lands", "a", 0),
    accepted("gone", "b", 0),
    accepted("queued", "c", 0),
    accepted("young", "d", 9_000),
    accepted("command", "/plan", 0),
    accepted("done", "e", 0, { placement: { kind: "landed", entryId: "e0" } }),
    { ...accepted("parked", "f", 0), outcome: { state: "parked", at: 0 } },
    { ...accepted("refused", "g", 0), outcome: { state: "refused", reason: "x", at: 0 } },
  ];
  const observed = { landings: [{ sendId: "lands", entryId: "e1" }, { sendId: "done", entryId: "e9" }], queuedTexts: [" c "], atRest: true, now: 10_000 };
  assert.deepEqual(reconcileFates(sends, observed), { landed: [{ sendId: "lands", entryId: "e1" }], missing: ["gone"] });
  assert.deepEqual(reconcileFates(sends, { ...observed, atRest: false }).missing, [], "nothing is missing while pi works");
});

const T = 1_000_000;
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
  const c = clock();
  const l = createLedger(c.now);
  const first = l.record("s1", "first", "followUp");
  c.t += 25 * 60 * 60_000;
  for (let i = 0; i < 205; i += 1) l.record("s1", `m${i}`, "followUp");
  const kept = l.forSession("s1");
  assert.equal(kept.length, 200);
  assert.equal(kept[0].text, "m5");
  assert.equal(l.get(first.id), undefined);
});

test("ledger() is one per process", async () => {
  const fresh = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  assert.equal((await fresh.import("./session-ledger.ts")).ledger(), ledger());
});
