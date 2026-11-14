import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  authorOf, branchSince, BUDGETS, decodeCursor, dialogDigest, encodeCursor, isVisibleEntry, matchLandings, renderMessages,
} = await jiti.import("./transcript.ts");

const T0 = Date.parse("2026-11-14T10:00:00Z");

/** A session tree from [id, parentId, kind] rows; the leaf is the last row unless given. */
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

test("isVisibleEntry: what the chat renders", () => {
  const cases = [
    [{ type: "message", message: { role: "user" } }, true],
    [{ type: "message", message: { role: "toolResult" } }, true],
    [{ type: "message", message: { role: "system" } }, false],
    [{ type: "compaction" }, true],
    [{ type: "branch_summary", summary: "s" }, true],
    [{ type: "branch_summary", summary: "" }, false],
    [{ type: "custom_message", display: true }, true],
    [{ type: "custom_message", display: false }, false],
    [{ type: "session_info" }, false],
    [{ type: "model_change" }, false],
    [{ type: "custom" }, false],
  ];
  for (const [entry, visible] of cases) assert.equal(isVisibleEntry(entry), visible, JSON.stringify(entry));
});

test("branchSince on a linear branch: everything after the cursor, capped to the newest", () => {
  const linear = tree([["a", null], ["b", "a", "assistant"], ["c", "b", "user"], ["d", "c", "assistant"]]);
  assert.deepEqual({ ...branchSince(linear, "b", 10), entries: ids(branchSince(linear, "b", 10)) },
    { kind: "since", leafId: "d", entries: ["c", "d"], visible: 2, omitted: 0 });
  assert.deepEqual(ids(branchSince(linear, null, 10)), ["a", "b", "c", "d"], "a null cursor: the whole branch");
  const capped = branchSince(linear, null, 3);
  assert.deepEqual([ids(capped), capped.omitted, capped.visible], [["b", "c", "d"], 1, 4]);
  const none = branchSince(linear, "d", 10);
  assert.deepEqual([none.kind, none.entries.length, none.visible], ["since", 0, 0]);
});

test("branchSince counts only entries that render as visible", () => {
  const titled = tree([["a", null], ["b", "a", "assistant"], ["i", "b", "info"], ["m", "i", "model"], ["s", "m", "system"]]);
  const delta = branchSince(titled, "b", 10);
  assert.deepEqual([delta.kind, ids(delta), delta.visible], ["since", ["i", "m", "s"], 0]);
});

test("branchSince on a moved branch reports from the fork point", () => {
  const rows = [["a", null], ["b", "a", "assistant"], ["c", "b"], ["d", "c", "assistant"], ["c2", "b"], ["d2", "c2", "assistant"]];
  const edited = branchSince(tree(rows, "d2"), "d", 10);
  assert.deepEqual([edited.kind, ids(edited), edited.visible], ["moved", ["c2", "d2"], 2]);
  const back = branchSince(tree(rows, "b"), "d", 10);
  assert.deepEqual([back.kind, back.entries.length], ["moved", 0], "the leaf moved back to an ancestor of the cursor");
});

test("branchSince with a cursor from elsewhere: unknown, the newest entries", () => {
  const delta = branchSince(tree([["a", null], ["b", "a"], ["c", "b"]]), "zzz", 2);
  assert.deepEqual([delta.kind, ids(delta), delta.omitted], ["unknown", ["b", "c"], 1]);
});

test("authorOf: agent when a send landed there, person after the ledger began, user before", () => {
  const user = { role: "user", content: "hi" };
  const since = T0;
  const landed = new Set(["e1"]);
  assert.equal(authorOf(user, { id: "e1", type: "message", time: T0 + 5 }, landed, since), "agent");
  assert.equal(authorOf(user, { id: "e2", type: "message", time: T0 }, landed, since), "person");
  assert.equal(authorOf(user, { id: "e3", type: "message", time: T0 - 1 }, landed, since), "user");
  assert.equal(authorOf(user, { id: "e4", type: "branch_summary", time: T0 }, landed, since), "summary");
  assert.equal(authorOf({ role: "assistant", content: [] }, { id: "e5", type: "message", time: T0 }, landed, since), "pi");
  assert.equal(authorOf({ role: "toolResult", toolCallId: "x", content: [] }, { id: "e6", type: "message", time: T0 }, landed, since), "pi");
  assert.equal(authorOf({ role: "bashExecution", command: "ls", output: "" }, { id: "e7", type: "message", time: T0 }, landed, since), "shell");
  assert.equal(authorOf({ role: "custom", customType: "x", content: "", display: true }, { id: "e8", type: "custom_message", time: T0 }, landed, since), "extension");
  assert.equal(authorOf({ role: "custom", customType: "compaction", content: "", display: true }, { id: "e9", type: "compaction", time: T0 }, landed, since), "summary");
});

test("matchLandings pairs each send with one entry of the same text, not before it was sent", () => {
  const sends = [{ id: "s1", text: "go", sentAt: T0 }, { id: "s2", text: "go", sentAt: T0 + 10_000 }, { id: "s3", text: "/plan x", sentAt: T0 }];
  const entries = [
    { entryId: "old", text: "go", time: T0 - 60_000 },
    { entryId: "e1", text: " go ", time: T0 - 1_000 },
    { entryId: "e2", text: "go", time: T0 + 11_000 },
    { entryId: "e3", text: "Plan the work for x", time: T0 + 1 },
  ];
  assert.deepEqual(matchLandings(sends, entries), [{ sendId: "s1", entryId: "e1" }, { sendId: "s2", entryId: "e2" }]);
  assert.deepEqual(matchLandings(sends.slice(0, 2), entries.slice(1, 2)), [{ sendId: "s1", entryId: "e1" }], "an entry pairs once");
});

const assistant = (content, extra = {}) => ({ role: "assistant", content, provider: "p", model: "m", ...extra });
const call = (id, name, input) => ({ type: "toolCall", toolCallId: id, toolName: name, input });
const result = (id, text, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], ...extra });

test("renderMessages labels authors, pairs tool calls with results and flags stopped and failed replies", () => {
  const messages = [
    { role: "user", content: "Run the tests" },
    assistant([{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Running them." }, call("t1", "bash", { command: "npm test" }), call("t2", "read", { path: "a" })]),
    result("t1", "14 passed\nall green\ndone"),
    result("t9", "late", { toolName: "grep", isError: true }),
    assistant([{ type: "text", text: "Half" }], { stopReason: "aborted" }),
    assistant([], { stopReason: "error", errorMessage: "rate\nlimited" }),
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 },
    { role: "custom", customType: "note", content: "hello", display: true },
  ];
  const authors = ["agent", "pi", "pi", "pi", "pi", "pi", "shell", "extension"];
  assert.deepEqual(renderMessages(messages, authors, BUDGETS.report, { endsAtNewest: true }), [
    "[agent] Run the tests",
    '[pi] Running them.\n  - bash {"command":"npm test"} -> ok: 14 passed (+2 lines)\n  - read {"path":"a"} -> running',
    "  - result of grep -> error: late",
    "[pi] Half (stopped)",
    "[pi] (error: rate limited)",
    "[shell] $ ls -> exit 0: a (+1 lines)",
    "[extension note] hello",
  ]);
  const older = renderMessages(messages.slice(0, 2), authors, BUDGETS.report, { endsAtNewest: false });
  assert.match(older[1], /read \{"path":"a"\} -> no result$/, "a call without a result in an older page is not running");
});

test("renderMessages clips to the budget and says how many older messages it left out", () => {
  const budget = { ...BUDGETS.report, total: 59, userText: 20 };
  const messages = [1, 2, 3].map((n) => ({ role: "user", content: `message number ${n} ${"x".repeat(30)}` }));
  const rendered = renderMessages(messages, ["person", "person", "person"], budget, { endsAtNewest: true });
  assert.deepEqual(rendered, ["(2 earlier messages not shown here; pi_read shows them.)", "[person] message number 3 xx…"]);
  const read = renderMessages([assistant([call("t1", "bash", {})]), result("t1", "l1\nl2")], ["pi", "pi"], BUDGETS.read, { endsAtNewest: true });
  assert.deepEqual(read, ["[pi]\n  - bash {} -> ok: l1\n      l2"], "pi_read shows the result itself; a reply of tool calls only still reads as pi's");
});
