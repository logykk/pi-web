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
  assert.deepEqual([l.get(a.id).landedEntryId, l.get(a.id).missingSince], ["e1", null]);
  const b = l.record("s1", "b", "followUp");
  l.markMissing(b.id, 5);
  l.markMissing(b.id, 9);
  assert.equal(l.get(b.id).missingSince, 5);
});

test("deliveryNews: late refusals and missing sends after the cursor's time, the same answer every time", () => {
  const sends = [
    { id: "early-refusal", repliedWhileSending: false, outcome: { state: "refused", reason: "x", at: 200 }, missingSince: null },
    { id: "late-refusal", repliedWhileSending: true, outcome: { state: "refused", reason: "x", at: 200 }, missingSince: null },
    { id: "missing", repliedWhileSending: false, outcome: { state: "accepted", disposition: "queued", at: 50 }, missingSince: 300 },
    { id: "fine", repliedWhileSending: true, outcome: { state: "accepted", disposition: "started", at: 250 }, missingSince: null },
  ];
  assert.deepEqual(deliveryNews(sends, 100).map((s) => s.id), ["late-refusal", "missing"]);
  assert.deepEqual(deliveryNews(sends, 100).map((s) => s.id), ["late-refusal", "missing"]);
  assert.deepEqual(deliveryNews(sends, 250).map((s) => s.id), ["missing"]);
  assert.deepEqual(deliveryNews(sends, 300), []);
});

test("reconcileFates: landed from the matches, missing only at rest, out of the queue and past 2 s", () => {
  const accepted = (id, text, sentAt, extra = {}) => ({
    id, text, sentAt, outcome: { state: "accepted", disposition: "queued", at: sentAt }, landedEntryId: null, missingSince: null, ...extra,
  });
  const sends = [
    accepted("lands", "a", 0),
    accepted("gone", "b", 0),
    accepted("queued", "c", 0),
    accepted("young", "d", 9_000),
    accepted("command", "/plan", 0),
    accepted("done", "e", 0, { landedEntryId: "e0" }),
    { ...accepted("parked", "f", 0), outcome: { state: "parked", at: 0 } },
    { ...accepted("refused", "g", 0), outcome: { state: "refused", reason: "x", at: 0 } },
  ];
  const observed = { landings: [{ sendId: "lands", entryId: "e1" }, { sendId: "done", entryId: "e9" }], queuedTexts: [" c "], atRest: true, now: 10_000 };
  assert.deepEqual(reconcileFates(sends, observed), { landed: [{ sendId: "lands", entryId: "e1" }], missing: ["gone"] });
  assert.deepEqual(reconcileFates(sends, { ...observed, atRest: false }).missing, [], "nothing is missing while pi works");
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
