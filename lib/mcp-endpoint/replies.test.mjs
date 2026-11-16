import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { BUDGETS, renderMessages } = await jiti.import("./replies.ts");

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
  const authors = ["agent", null, null, null, null, null, null, null];
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
  const read = renderMessages([assistant([call("t1", "bash", {})]), result("t1", "l1\nl2")], [null, null], BUDGETS.read, { endsAtNewest: true });
  assert.deepEqual(read, ["[pi]\n  - bash {} -> ok: l1\n      l2"], "pi_read shows the result itself; a reply of tool calls only still reads as pi's");
});
