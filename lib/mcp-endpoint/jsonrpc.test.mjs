import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { endpointTool, handleMcpBody, validateArgs } = await jiti.import("./jsonrpc.ts");

const call = { signal: new AbortController().signal, linkBase: "http://127.0.0.1:1" };

class Refusal extends Error {}

function server(tools = []) {
  return { name: "pi-web", title: "pi-web", version: "9.9.9", instructions: "Use the tools.", tools, isToolError: (error) => error instanceof Refusal };
}

const echo = endpointTool({
  name: "echo",
  title: "Echo",
  description: "Echoes.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      times: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      loud: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b"] },
      answer: { type: ["string", "number", "boolean"] },
    },
    required: ["text"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  run: async (args) => ({ text: JSON.stringify(args) }),
});

const throwing = (name, error) => endpointTool({
  name,
  title: name,
  description: "Throws.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {},
  run: async () => { throw error; },
});
const boom = throwing("boom", new Error("kaput"));
const refuse = throwing("refuse", new Refusal("No pi session x."));

const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const post = (s, body, versionHeader = null) => handleMcpBody(s, typeof body === "string" ? body : JSON.stringify(body), versionHeader, call);

test("a body is one message or a batch; one with nothing to answer gets 202; junk is a 400", async () => {
  const s = server();
  assert.deepEqual(await post(s, '{"jsonrpc":"2.0","id":7,"method":"ping"}'), { status: 200, body: { jsonrpc: "2.0", id: 7, result: {} } });
  assert.deepEqual(await post(s, '{"jsonrpc":"2.0","method":"notifications/initialized"}'), { status: 202 });
  assert.deepEqual(await post(s, '{"jsonrpc":"2.0","id":3,"result":{}}'), { status: 202 }, "a client's response needs no answer");
  const batch = await post(s, '[{"jsonrpc":"2.0","id":"a","method":"ping"},{"jsonrpc":"2.0","method":"x"},5]');
  assert.deepEqual(batch, {
    status: 200,
    body: [{ jsonrpc: "2.0", id: "a", result: {} }, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Not a JSON-RPC 2.0 message." } }],
  });
  const refused = async (body) => {
    const reply = await post(s, body);
    assert.equal(reply.status, 400, body);
    return reply.body.error.code;
  };
  assert.equal(await refused("{nope"), -32700, "invalid JSON is a parse error");
  assert.equal(await refused("[]"), -32600, "an empty batch is an invalid request");
  assert.equal(await refused("42"), -32600, "a non-object is an invalid request");
  assert.equal(await refused('{"jsonrpc":"2.0","id":null,"method":"ping"}'), -32600, "a null id is no request");
  assert.equal((await post(s, '{"jsonrpc":"2.0","id":3}')).body.id, 3, "an invalid message's id is echoed");
});

test("a message whose jsonrpc member is not \"2.0\" is invalid, as its error says", async () => {
  const s = server();
  const invalid = (id) => ({ jsonrpc: "2.0", id, error: { code: -32600, message: "Not a JSON-RPC 2.0 message." } });
  assert.deepEqual(await post(s, '{"id":1,"method":"ping"}'), { status: 400, body: invalid(1) });
  assert.deepEqual(await post(s, '{"jsonrpc":"1.0","id":1,"method":"ping"}'), { status: 400, body: invalid(1) });
  assert.deepEqual(await post(s, '[{"id":2,"method":"ping"},{"method":"notifications/initialized"}]'), { status: 200, body: [invalid(2), invalid(null)] });
});

test("the version header: none or a known one is served, an unknown one is a 400 with the id echoed, except for initialize", async () => {
  const s = server();
  assert.equal((await post(s, rpc("ping", undefined, 9))).status, 200);
  assert.equal((await post(s, rpc("ping", undefined, 9), " 2025-06-18 ")).status, 200);
  const refused = await post(s, rpc("server/discover", {}, 4), "2026-07-28");
  assert.equal(refused.status, 400);
  assert.equal(refused.body.id, 4, "the request id is echoed");
  assert.match(refused.body.error.message, /2025-11-25, 2025-06-18, 2025-03-26/);
  const init = await post(s, rpc("initialize", { protocolVersion: "2025-06-18" }), "2026-07-28");
  assert.equal(init.body.result.protocolVersion, "2025-06-18", "initialize negotiates in params");
});

test("initialize echoes a known revision and offers the newest otherwise", async () => {
  const negotiated = async (protocolVersion) => (await post(server(), rpc("initialize", { protocolVersion }))).body.result.protocolVersion;
  assert.equal(await negotiated("2025-03-26"), "2025-03-26");
  assert.equal(await negotiated("2025-06-18"), "2025-06-18");
  assert.equal(await negotiated("2026-07-28"), "2025-11-25");
  assert.equal(await negotiated(undefined), "2025-11-25");
});

test("validateArgs applies defaults and names what each argument must be", () => {
  const { inputSchema } = echo;
  assert.deepEqual(validateArgs(inputSchema, { text: "hi" }), { ok: true, value: { text: "hi", times: 1 } });
  assert.deepEqual(validateArgs(inputSchema, { text: "hi", answer: 2 }).value.answer, 2);
  assert.equal(validateArgs(inputSchema, { text: " " }).ok, true, "minLength counts characters, as tools/list publishes it");
  const cases = [
    [undefined, /text is required/],
    [[], /must be an object/],
    [{ text: "" }, /text must not be empty/],
    [{ text: 3 }, /text must be a string, not integer/],
    [{ text: "a", times: 4 }, /times must be at most 3/],
    [{ text: "a", times: 0 }, /times must be at least 1/],
    [{ text: "a", times: 1.5 }, /times must be an integer/],
    [{ text: "a", loud: "yes" }, /loud must be true or false/],
    [{ text: "a", mode: "c" }, /mode must be one of a, b/],
    [{ text: "a", answer: null }, /answer must be a string or number or boolean, not null/],
    [{ text: "a", extra: 1 }, /Unknown argument extra/],
  ];
  for (const [args, message] of cases) {
    const result = validateArgs(inputSchema, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.match(result.error, message);
  }
});

test("initialize, ping, tools/list and tools/call", async () => {
  const s = server([echo, boom, refuse]);
  const answer = async (method, params) => (await post(s, rpc(method, params))).body;
  assert.deepEqual((await answer("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "pi-web", title: "pi-web", version: "9.9.9" },
    instructions: "Use the tools.",
  });
  assert.equal((await post(s, [rpc("initialize", {})])).body[0].error.code, -32600, "initialize may not be batched");
  assert.deepEqual((await answer("ping")).result, {});

  const listed = (await answer("tools/list")).result.tools;
  assert.deepEqual(listed.map((t) => t.name), ["echo", "boom", "refuse"]);
  assert.deepEqual(listed[0].inputSchema, echo.inputSchema, "the schema is published verbatim");
  assert.equal("run" in listed[0], false);

  const ok = await answer("tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.deepEqual(ok.result, { content: [{ type: "text", text: '{"text":"hi","times":1}' }], isError: false });
  const invalid = await answer("tools/call", { name: "echo", arguments: { text: 1 } });
  assert.equal(invalid.result.isError, true, "bad arguments are a tool error the model sees");
  assert.match(invalid.result.content[0].text, /^echo: text must be a string/);
  assert.equal((await answer("tools/call", { name: "nope" })).error.code, -32602);

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const refused = await answer("tools/call", { name: "refuse" });
    assert.deepEqual(refused.result, { content: [{ type: "text", text: "No pi session x." }], isError: true }, "a tool error is the model's to read");
    assert.deepEqual(logged, [], "and is no failure of pi-web's");
    const thrown = await answer("tools/call", { name: "boom" });
    assert.deepEqual(thrown.result, { content: [{ type: "text", text: "pi-web failed: kaput" }], isError: true });
  } finally {
    console.error = original;
  }
  assert.match(logged.join("\n"), /boom failed/, "any other throw is logged");
});

test("unknown methods are -32601, never a prototype lookup; notifications are not answered", async () => {
  const s = server();
  assert.equal((await post(s, rpc("resources/list"))).body.error.code, -32601);
  assert.equal((await post(s, rpc("toString"))).body.error.code, -32601, "no prototype lookups");
  assert.deepEqual(await post(s, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }), { status: 202 });
});
