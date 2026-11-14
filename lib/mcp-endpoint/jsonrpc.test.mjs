import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { defineTool, dispatch, headerVersion, httpReply, negotiateVersion, parseBody, validateArgs } = await jiti.import("./jsonrpc.ts");

const call = { signal: new AbortController().signal, linkBase: "http://127.0.0.1:1" };

function server(tools = []) {
  return { name: "pi-web", title: "pi-web", version: "9.9.9", instructions: "Use the tools.", tools };
}

const echo = defineTool({
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

const boom = defineTool({
  name: "boom",
  title: "Boom",
  description: "Throws.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {},
  run: async () => { throw new Error("kaput"); },
});

const request = (method, params, id = 1) => ({ kind: "request", id, method, params });

test("parseBody classifies requests, notifications, responses, batches and junk", () => {
  assert.deepEqual(parseBody('{"jsonrpc":"2.0","id":7,"method":"ping"}'), {
    ok: true, batch: false, messages: [{ kind: "request", id: 7, method: "ping", params: undefined }],
  });
  assert.deepEqual(parseBody('{"jsonrpc":"2.0","method":"notifications/initialized"}').messages, [
    { kind: "notification", method: "notifications/initialized", params: undefined },
  ]);
  assert.deepEqual(parseBody('{"jsonrpc":"2.0","id":3,"result":{}}').messages, [{ kind: "response" }]);
  const batch = parseBody('[{"jsonrpc":"2.0","id":"a","method":"ping"},{"jsonrpc":"2.0","method":"x"},5]');
  assert.equal(batch.batch, true);
  assert.deepEqual(batch.messages.map((m) => m.kind), ["request", "notification", "invalid"]);
  assert.equal(parseBody("{nope").error.error.code, -32700, "invalid JSON is a parse error");
  assert.equal(parseBody("[]").error.error.code, -32600, "an empty batch is an invalid request");
  assert.equal(parseBody("42").error.error.code, -32600, "a non-object is an invalid request");
  assert.equal(parseBody('{"id":null,"method":"ping"}').ok, false, "a null id is no request");
});

test("negotiateVersion echoes a known revision and offers the newest otherwise", () => {
  assert.equal(negotiateVersion("2025-03-26"), "2025-03-26");
  assert.equal(negotiateVersion("2025-06-18"), "2025-06-18");
  assert.equal(negotiateVersion("2026-07-28"), "2025-11-25");
  assert.equal(negotiateVersion(undefined), "2025-11-25");
});

test("headerVersion: absent is 2025-03-26, unknown is refused with the id echoed, initialize is exempt", () => {
  const ping = [request("ping", undefined, 9)];
  assert.deepEqual(headerVersion(null, ping), { ok: true, version: "2025-03-26" });
  assert.deepEqual(headerVersion("2025-06-18", ping), { ok: true, version: "2025-06-18" });
  const refused = headerVersion("2026-07-28", [request("server/discover", {}, 4)]);
  assert.equal(refused.ok, false);
  assert.equal(refused.response.id, 4, "the request id is echoed");
  assert.match(refused.response.error.message, /2025-11-25, 2025-06-18, 2025-03-26/);
  assert.equal(headerVersion("2026-07-28", [request("initialize", {})]).ok, true, "initialize negotiates in params");
});

test("httpReply: 202 without requests, one object for a message, an array for a batch", () => {
  const one = { jsonrpc: "2.0", id: 1, result: {} };
  assert.deepEqual(httpReply({ batch: false }, [null]), { status: 202 });
  assert.deepEqual(httpReply({ batch: false }, [one]), { status: 200, body: one });
  assert.deepEqual(httpReply({ batch: true }, [null, one]), { status: 200, body: [one] });
});

test("validateArgs applies defaults and names what each argument must be", () => {
  const { inputSchema } = echo;
  assert.deepEqual(validateArgs(inputSchema, { text: "hi" }), { ok: true, value: { text: "hi", times: 1 } });
  assert.deepEqual(validateArgs(inputSchema, { text: "hi", answer: 2 }).value.answer, 2);
  const cases = [
    [undefined, /text is required/],
    [[], /must be an object/],
    [{ text: "  " }, /text must not be empty/],
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

test("dispatch answers initialize, ping, tools/list and tools/call", async () => {
  const s = server([echo, boom]);
  const context = { batch: false, call };
  const init = await dispatch(s, request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }), context);
  assert.deepEqual(init.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "pi-web", title: "pi-web", version: "9.9.9" },
    instructions: "Use the tools.",
  });
  assert.equal((await dispatch(s, request("initialize", {}), { batch: true, call })).error.code, -32600, "initialize may not be batched");
  assert.deepEqual((await dispatch(s, request("ping"), context)).result, {});

  const listed = (await dispatch(s, request("tools/list"), context)).result.tools;
  assert.deepEqual(listed.map((t) => t.name), ["echo", "boom"]);
  assert.deepEqual(listed[0].inputSchema, echo.inputSchema, "the schema is published verbatim");
  assert.equal("run" in listed[0], false);

  const ok = await dispatch(s, request("tools/call", { name: "echo", arguments: { text: "hi" } }), context);
  assert.deepEqual(ok.result, { content: [{ type: "text", text: '{"text":"hi","times":1}' }], isError: false });
  const invalid = await dispatch(s, request("tools/call", { name: "echo", arguments: { text: 1 } }), context);
  assert.equal(invalid.result.isError, true, "bad arguments are a tool error the model sees");
  assert.match(invalid.result.content[0].text, /^echo: text must be a string/);
  const unknown = await dispatch(s, request("tools/call", { name: "nope" }), context);
  assert.equal(unknown.error.code, -32602);

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const thrown = await dispatch(s, request("tools/call", { name: "boom" }), context);
    assert.deepEqual(thrown.result, { content: [{ type: "text", text: "pi-web failed: kaput" }], isError: true });
  } finally {
    console.error = original;
  }
  assert.match(logged.join("\n"), /boom failed/, "a throwing tool is logged");
});

test("dispatch: notifications and responses get nothing, unknown methods -32601, junk -32600", async () => {
  const context = { batch: false, call };
  assert.equal(await dispatch(server(), { kind: "notification", method: "notifications/initialized" }, context), null);
  assert.equal(await dispatch(server(), { kind: "notification", method: "notifications/cancelled", params: { requestId: 1 } }, context), null);
  assert.equal(await dispatch(server(), { kind: "response" }, context), null);
  assert.equal((await dispatch(server(), request("resources/list"), context)).error.code, -32601);
  assert.equal((await dispatch(server(), request("toString"), context)).error.code, -32601, "no prototype lookups");
  assert.equal((await dispatch(server(), { kind: "invalid", id: 3 }, context)).error.code, -32600);
});
