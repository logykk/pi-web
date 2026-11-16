import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { authorOf, branchSince, decodeCursor, dialogDigest, encodeCursor } = await jiti.import("./transcript.ts");

const T0 = Date.parse("2026-11-14T10:00:00Z");

function tree(rows, leafId = rows.at(-1)?.[0] ?? null) {
  const entries = new Map(rows.map(([id, parentId, kind = "user"], index) => {
    const timestamp = new Date(T0 + index * 1000).toISOString();
    const base = { id, parentId, timestamp };
    if (kind === "info") return [id, { ...base, type: "session_info", name: "t" }];
    if (kind === "model") return [id, { ...base, type: "model_change" }];
    if (kind === "system") return [id, { ...base, type: "message", message: { role: "system" } }];
    return [id, { ...base, type: "message", message: { role: kind } }];
  }));
  return { getLeafId: () => leafId, getEntry: (id) => entries.get(id) };
}

const ids = (delta) => delta.entries.map((entry) => entry.id);

test("a cursor round-trips, and anything else decodes to null", () => {
  for (const cursor of [{ entryId: "5e1d77a0", dialogs: "0", at: T0 }, { entryId: null, dialogs: "a1b2c3d4", at: 1 }]) {
    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  }
  assert.equal(encodeCursor({ entryId: "abc", dialogs: "0", at: 35 }), "abc~0~z");
  for (const junk of ["", "abc", "a~0", "a~0~z~1", "a b~0~z", "a~XYZ~z", "a~0~Z!", `${"x".repeat(65)}~0~1`]) {
    assert.equal(decodeCursor(junk), null, junk);
  }
});

test("dialogDigest: 0 for none, order-independent otherwise", () => {
  assert.equal(dialogDigest([]), "0");
  assert.equal(dialogDigest(["a", "b"]), dialogDigest(["b", "a"]));
  assert.notEqual(dialogDigest(["a"]), dialogDigest(["a", "b"]));
  assert.match(dialogDigest(["a"]), /^[0-9a-f]{8}$/);
});

test("branchSince on a linear branch: everything after the cursor, capped to the newest", () => {
  const linear = tree([["a", null], ["b", "a", "assistant"], ["c", "b", "user"], ["d", "c", "assistant"]]);
  assert.deepEqual({ ...branchSince(linear, "b", 10), entries: ids(branchSince(linear, "b", 10)) },
    { kind: "since", leafId: "d", entries: ["c", "d"], omitted: 0 });
  assert.deepEqual(ids(branchSince(linear, null, 10)), ["a", "b", "c", "d"], "a null cursor: the whole branch");
  const capped = branchSince(linear, null, 3);
  assert.deepEqual([ids(capped), capped.omitted], [["b", "c", "d"], 1]);
  const none = branchSince(linear, "d", 10);
  assert.deepEqual([none.kind, none.entries.length], ["since", 0]);
});

test("branchSince on a moved branch reports from the fork point", () => {
  const rows = [["a", null], ["b", "a", "assistant"], ["c", "b"], ["d", "c", "assistant"], ["c2", "b"], ["d2", "c2", "assistant"]];
  const edited = branchSince(tree(rows, "d2"), "d", 10);
  assert.deepEqual([edited.kind, ids(edited)], ["moved", ["c2", "d2"]]);
  const back = branchSince(tree(rows, "b"), "d", 10);
  assert.deepEqual([back.kind, back.entries.length], ["moved", 0], "the leaf moved back to an ancestor of the cursor");
});

test("branchSince with a cursor from elsewhere: unknown, the newest entries", () => {
  const delta = branchSince(tree([["a", null], ["b", "a"], ["c", "b"]]), "zzz", 2);
  assert.deepEqual([delta.kind, ids(delta), delta.omitted], ["unknown", ["b", "c"], 1]);
});

test("authorOf: a user message is whoever the ledger says, a summary entry is a summary, the rest are labeled by role", () => {
  const person = () => "person";
  assert.equal(authorOf({ role: "user", content: "hi" }, "message", () => "agent"), "agent");
  assert.equal(authorOf({ role: "user", content: "hi" }, "message", person), "person");
  assert.equal(authorOf({ role: "user", content: "s" }, "branch_summary", person), "summary");
  assert.equal(authorOf({ role: "custom", customType: "compaction", content: "", display: true }, "compaction", person), "summary");
  assert.equal(authorOf({ role: "assistant", content: [] }, "message", person), "by-role");
  assert.equal(authorOf({ role: "toolResult", toolCallId: "x", content: [] }, "message", person), "by-role");
  assert.equal(authorOf({ role: "bashExecution", command: "ls", output: "" }, "message", person), "by-role");
  assert.equal(authorOf({ role: "custom", customType: "x", content: "", display: true }, "custom_message", person), "by-role");
});
