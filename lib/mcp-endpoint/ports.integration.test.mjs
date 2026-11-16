import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-mcp-endpoint-ports-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Read once when rpc-manager loads: a short idle timeout lets the hold test watch a real reap.
process.env.PI_WEB_IDLE_TIMEOUT_MS = "800";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("../rpc-manager.ts");
const { listRegisteredSessionLivenessProviders } = await jiti.import("../session-liveness.ts");
const { HOLD_MS, piWebPorts } = await jiti.import("./ports.ts");
test.after(() => rm(agentDir, { recursive: true, force: true }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function until(check, what, ms = 5_000) {
  for (const end = Date.now() + ms; !check();) {
    if (Date.now() > end) assert.fail(`timed out: ${what}`);
    await tick();
  }
}

async function setup(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-mcp-endpoint-ports-cwd-"));
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
  const faux = fauxProvider({ models: [{ id: "faux-mcp-ports" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories: [extension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel("faux-mcp-ports"), sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader });
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[wrapper.sessionId, wrapper]]);
  t.after(() => {
    globalThis.__piSessions = previous;
    return wrapper.destroy();
  });
  const userTexts = () => session.messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : m.content[0]?.text));
  const settle = () => until(() => !wrapper.isRunning() && session.isIdle, "the session settles");
  return { ports: piWebPorts(), id: wrapper.sessionId, wrapper, faux, gate, userTexts, settle };
}

test("a prompt with streamingBehavior starts a run on an idle session and queues during one, never 'already processing'", async (t) => {
  const { ports, id, faux, gate, userTexts, settle } = await setup(t);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("first done")]),
    fauxAssistantMessage([fauxText("second done")]),
  ]);
  const live = ports.live(id);
  assert.deepEqual(await live.prompt("start", "followUp"), { parked: false });
  await until(() => gate.started, "the tool runs");
  assert.equal(live.isRunning(), true);
  assert.deepEqual(await live.prompt("queued behind the run", "followUp"), { parked: false });
  assert.deepEqual(live.queued(), { steering: [], followUp: ["queued behind the run"] });
  gate.release();
  await settle();
  assert.deepEqual(userTexts(), ["start", "queued behind the run"]);
  assert.equal(live.transcript().getEntries().filter((entry) => entry.message?.role === "user").length, 2, "the transcript is the live SessionManager");
  assert.match(live.model(), /\/faux-mcp-ports$/);
});

test("abort returns every queued text, whoever queued it", async (t) => {
  const { ports, id, faux, gate, settle } = await setup(t);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("reply")])]);
  const live = ports.live(id);
  await live.prompt("start", "followUp");
  await until(() => gate.started, "the tool runs");
  await live.prompt("s1", "steer");
  await live.prompt("f1", "followUp");
  assert.deepEqual(await live.abort(), { steering: ["s1"], followUp: ["f1"] });
  await settle();
  assert.deepEqual(await live.abort(), { steering: [], followUp: [] }, "nothing queued is an empty answer");
});

test("openDialogs lists an open dialog until an answer resolves it", async (t) => {
  const { ports, id, wrapper } = await setup(t);
  const pending = wrapper.createExtensionUiContext().confirm("Apply the migration?", "It drops a column.");
  const live = ports.live(id);
  const [request, ...rest] = live.openDialogs();
  assert.deepEqual({ method: request.method, title: request.title, message: request.message, rest }, { method: "confirm", title: "Apply the migration?", message: "It drops a column.", rest: [] });
  await live.answer({ type: "extension_ui_response", id: request.id, confirmed: true });
  assert.equal(await pending, true);
  assert.deepEqual(live.openDialogs(), []);
});

test("runningTools lists the tool a run is in, with how long it has run, until it ends", async (t) => {
  const { ports, id, faux, gate, settle } = await setup(t);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])]);
  const live = ports.live(id);
  assert.deepEqual(live.runningTools(), []);
  await live.prompt("start", "followUp");
  await until(() => gate.started, "the tool runs");
  const [tool, ...rest] = live.runningTools();
  assert.deepEqual({ toolName: tool.toolName, args: tool.args, rest }, { toolName: "wait", args: {}, rest: [] });
  assert.equal(typeof tool.elapsedMs, "number");
  gate.release();
  await settle();
  assert.deepEqual(live.runningTools(), []);
});

test("toMessages converts exactly the slice it is given; page reads the tail", async (t) => {
  const { ports, id, faux, settle } = await setup(t);
  faux.setResponses([fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
  const live = ports.live(id);
  await live.prompt("first", "followUp");
  await settle();
  await live.prompt("second", "followUp");
  await settle();
  const messages = live.transcript().getEntries().filter((entry) => entry.type === "message" && entry.message.role !== "system");
  const slice = messages.slice(-2);
  const converted = ports.toMessages(slice, id);
  assert.deepEqual(converted.entryIds, slice.map((entry) => entry.id));
  assert.deepEqual(converted.messages.map((m) => m.role), ["user", "assistant"]);
  const page = ports.page(live.transcript(), id, null, 1, false);
  assert.deepEqual(page.messages.map((m) => m.role), ["assistant"]);
  assert.equal(page.hasMore, true);
});

test("a hold keeps a session past its idle timeout, and an expired hold lets it go", async (t) => {
  const { ports, id, wrapper, faux, settle } = await setup(t);
  faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
  await ports.live(id).prompt("hello", "followUp");
  await settle();
  ports.hold(id);
  assert.ok(listRegisteredSessionLivenessProviders().some((provider) => provider.name === "pi-web-mcp-endpoint" && provider.sessionId === id));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(wrapper.isAlive(), true, "held past two idle timeouts");

  const realNow = Date.now;
  t.mock.method(Date, "now", () => realNow() + HOLD_MS);
  await until(() => !wrapper.isAlive(), "the idle timer reaps it once the hold expires", 3_000);
  assert.equal(ports.live(id), null);
  ports.hold("another-session");
  assert.equal(listRegisteredSessionLivenessProviders().some((provider) => provider.sessionId === id), false, "the next hold sweeps the expired one");
});
