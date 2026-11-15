import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// Fork only. Another client (an MCP agent, another tab) starts a run just before
// this page sends: pi refuses the page's plain prompt with "Agent is already
// processing". The page queues the same text as a follow-up instead of failing.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { clearDraft, getDraft } = await jiti.import("@/lib/draft-store");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const ALREADY_PROCESSING = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

async function sendIntoAnotherClientsRun({ followUp }) {
  const prompts = [];
  const sources = [];
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) { this.readyState = 1; this.onmessage?.({ data: JSON.stringify(event) }); }
  };
  // The page loads an idle session; the other client's run starts just before its prompt lands.
  let running = false;
  const state = () => json({ running, state: { isStreaming: running, isPromptRunning: running } });
  globalThis.fetch = async (requestUrl, init = {}) => {
    const url = requestUrl.replace("?systemPrompt=0", "");
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith("/api/sessions/A?")) {
      return json({ sessionId: "A", filePath: "/A.jsonl", leafId: null, tree: [], treeFormat: "summary", snapshotRevision: "r", context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false } });
    }
    if (url === "/api/sessions/A/state") return state();
    if (url === "/api/agent/A" && init.body) {
      const command = JSON.parse(init.body);
      if (command.type !== "prompt") return json({ success: true, data: null });
      prompts.push(command);
      if (!command.streamingBehavior) {
        running = true;
        return json({ error: ALREADY_PROCESSING, code: "prompt_rejected", accepted: false }, 500);
      }
      return followUp();
    }
    if (url === "/api/agent/A") return state();
    return json({});
  };
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  const hook = renderHook(useAgentSession, { session: { id: "A", cwd: "/project", path: "/A.jsonl", name: "A" }, newSessionCwd: null, newSessionDraftKey: null, t: (key) => key });
  try {
    await settle();
    hook.flush();
    for (const source of sources) if (source.readyState === 0) source.emit({ type: "connected", sessionId: "A", isStreaming: false });
    await settle();
    hook.flush();
    await hook.result.handleSend("person text");
    await settle();
    hook.flush();
    return {
      prompts,
      errors,
      notices: hook.result.notices.map(({ type, message }) => [type, message]),
      draft: getDraft("A")?.value ?? "",
      bubble: hook.result.messages.some((message) => message.role === "user" && message.content === "person text"),
    };
  } finally {
    console.error = originalError;
    hook.unmount();
    for (const source of sources) source.close();
    clearDraft("A");
    deleteSessionViewSnapshot("A");
  }
}

test("a send that loses the race to another client's run is queued as a follow-up, not refused", async () => {
  const result = await sendIntoAnotherClientsRun({ followUp: () => json({ success: true, data: null }) });
  assert.deepEqual(result.prompts.map(({ message, streamingBehavior }) => [message, streamingBehavior ?? null]),
    [["person text", null], ["person text", "followUp"]], "the refused plain prompt is resent once, as a follow-up");
  assert.deepEqual(result.notices, [], "the person sees no error");
  assert.equal(result.draft, "", "the text does not come back to the composer");
  assert.equal(result.bubble, false, "the queue row, not a bubble, shows the queued text");
  assert.deepEqual(result.errors, [], "a race the page handled logs no error");
});

test("when the follow-up is refused too, the person gets the original refusal and the text back", async () => {
  const result = await sendIntoAnotherClientsRun({ followUp: () => json({ error: "The session's folder is gone", code: "prompt_rejected", accepted: false }, 500) });
  assert.equal(result.prompts.length, 2, "one retry, no more");
  assert.deepEqual(result.notices, [["error", ALREADY_PROCESSING]]);
  assert.equal(result.draft, "person text");
});
