import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-agent-busy-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
const { sendAgentCommand } = await jiti.import("./agent-client.ts");
const { isAgentBusyRefusal } = await jiti.import("./agent-busy-refusal.ts");
test.after(() => rm(agentDir, { recursive: true, force: true }));

async function until(check, what, ms = 5_000) {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("pi refuses the page's plain prompt during another client's run, and the page reads it as that race", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-agent-busy-cwd-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const gate = { started: false, release: () => {} };
  const extension = (pi) => {
    pi.registerTool({
      name: "wait", label: "wait", description: "waits", parameters: { type: "object", properties: {} },
      async execute(_id, _p, signal) {
        gate.started = true;
        await new Promise((resolve) => {
          gate.release = resolve;
          signal?.addEventListener("abort", resolve, { once: true });
        });
        return { content: [{ type: "text", text: "waited" }], details: undefined };
      },
    });
  };
  const faux = fauxProvider({ models: [{ id: "faux-agent-busy" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel("faux-agent-busy"), sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const previousSessions = globalThis.__piSessions;
  const previousFetch = globalThis.fetch;
  globalThis.__piSessions = new Map([[wrapper.sessionId, wrapper]]);
  globalThis.fetch = (url, init) => POST(new Request(new URL(url, "http://localhost"), init), { params: Promise.resolve({ id: wrapper.sessionId }) });
  t.after(() => {
    globalThis.__piSessions = previousSessions;
    globalThis.fetch = previousFetch;
    return wrapper.destroy();
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("agent done")]),
    fauxAssistantMessage([fauxText("person done")]),
  ]);

  await sendAgentCommand(wrapper.sessionId, { type: "prompt", message: "agent text", streamingBehavior: "followUp" });
  await until(() => gate.started, "the other client's run reaches its tool");
  const refusal = await sendAgentCommand(wrapper.sessionId, { type: "prompt", message: "person text" })
    .then(() => assert.fail("a plain prompt during a run was accepted"), (error) => error);
  assert.ok(isAgentBusyRefusal(refusal), `pi refused with "${refusal.message}", which the page does not read as the race`);

  await sendAgentCommand(wrapper.sessionId, { type: "prompt", message: "person text", streamingBehavior: "followUp" });
  gate.release();
  await until(() => !wrapper.isRunning() && session.isIdle, "the session settles");
  const userTexts = session.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content[0]?.text));
  assert.deepEqual(userTexts, ["agent text", "person text"], "the resent text runs once, after the other client's");
});
