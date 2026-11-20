import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { withEnv } from "../../lib/mcp-endpoint/test-env.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { DELETE, GET, POST } = await jiti.import("./route.ts");
const { MAX_BODY_BYTES } = await jiti.import("../../lib/mcp-endpoint/http.ts");
const { invalidateSessionListCache } = await jiti.import("../../lib/session-reader.ts");
const { getRpcSession } = await jiti.import("../../lib/rpc-manager.ts");

const TOKEN = "route-test-token-0123456789abcdef0123";
const BASE = "http://127.0.0.1:30999/mcp";
let agentDir;

before(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pi-web-mcp-endpoint-route-"));
  const project = join(agentDir, "project");
  await mkdir(project);
  await mkdir(join(agentDir, "sessions", "seeded"), { recursive: true });
  const stamp = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    { type: "session", version: 3, id: "mcp-route-seeded", timestamp: stamp, cwd: project },
    { type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: "Seeded question for the MCP route" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: stamp, message: { role: "assistant", content: [{ type: "text", text: "Seeded answer." }], provider: "p", model: "m" } },
  ];
  await writeFile(join(agentDir, "sessions", "seeded", `${stamp.replace(/[:.]/g, "-")}_mcp-route-seeded.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
});

after(async () => {
  invalidateSessionListCache();
  await rm(agentDir, { recursive: true, force: true });
});

function endpointOn(t) {
  withEnv(t, { PI_WEB_MCP_TOKEN: TOKEN, PI_CODING_AGENT_DIR: agentDir });
  invalidateSessionListCache();
}

function mcp(body, { token = TOKEN, headers = {}, method = "POST" } = {}) {
  return new Request(BASE, {
    method,
    headers: {
      host: "127.0.0.1:30999",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const callTool = async (name, args, id = 1) => (await (await POST(mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }))).json()).result;

test("with no token configured, /mcp answers 404 to every method", async (t) => {
  withEnv(t, { PI_WEB_MCP_TOKEN: undefined });
  assert.equal((await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }))).status, 404);
  assert.equal((await GET(mcp(null, { method: "GET" }))).status, 404);
  assert.equal((await DELETE(mcp(null, { method: "DELETE" }))).status, 404);
});

test("a wrong or missing bearer is 401 with WWW-Authenticate, before any method's own answer", async (t) => {
  endpointOn(t);
  const wrong = await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "wrong-token" }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate"), /^Bearer realm="pi-web"/);
  assert.equal((await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null }))).status, 401);
  assert.equal((await GET(mcp(null, { method: "GET", token: "wrong" }))).status, 401, "the guard runs before 405");
});

test("GET and DELETE answer 405 with Allow: POST", async (t) => {
  endpointOn(t);
  const get = await GET(mcp(null, { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await get.json()).error.code, -32000);
  assert.equal((await DELETE(mcp(null, { method: "DELETE" }))).status, 405);
});

test("a POST body must be JSON and within the bound: 415, 413, and 400 for junk", async (t) => {
  endpointOn(t);
  assert.equal((await POST(mcp("ping", { headers: { "content-type": "text/plain" } }))).status, 415);
  assert.equal((await POST(mcp(`"${"x".repeat(MAX_BODY_BYTES)}"`))).status, 413);
  const junk = await POST(mcp("{oops"));
  assert.equal(junk.status, 400);
  assert.equal((await junk.json()).error.code, -32700);
});

test("a probe under an unknown MCP-Protocol-Version is a 400, the client's signal to fall back; without the header it is -32601", async (t) => {
  endpointOn(t);
  const discover = await POST(mcp({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }, { headers: { "mcp-protocol-version": "2026-07-28" } }));
  assert.equal(discover.status, 400);
  assert.equal((await discover.json()).id, 0);
  const plain = await POST(mcp({ jsonrpc: "2.0", id: 0, method: "server/discover" }));
  assert.equal(plain.status, 200);
  assert.equal((await plain.json()).error.code, -32601);
});

test("initialize negotiates in its params, answers application/json and opens no MCP session", async (t) => {
  endpointOn(t);
  const init = await POST(mcp(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { headers: { "mcp-protocol-version": "2026-07-28" } },
  ));
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "application/json");
  assert.equal(init.headers.get("mcp-session-id"), null, "no MCP sessions");
  const body = await init.json();
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.equal(body.result.serverInfo.name, "pi-web");
  assert.match(body.result.instructions, /pi_sessions/);
});

test("a notification alone gets 202 and no body; a batch gets an array of its answers", async (t) => {
  endpointOn(t);
  const notified = await POST(mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers: { "mcp-protocol-version": "2025-06-18" } }));
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), "");
  const batch = await POST(mcp([{ jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
  assert.deepEqual(await batch.json(), [{ jsonrpc: "2.0", id: 2, result: {} }]);
});

test("tools/list lists the fourteen tools", async (t) => {
  endpointOn(t);
  const listed = await (await POST(mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { headers: { "mcp-protocol-version": "2025-11-25" } }))).json();
  assert.equal(listed.result.tools.length, 14);
});

test("pi_sessions lists the saved session; a folder that does not exist is an error the model reads", async (t) => {
  endpointOn(t);
  const sessions = await callTool("pi_sessions", {});
  assert.equal(sessions.isError, false);
  assert.match(sessions.content[0].text, /mcp-route-seeded \[idle\] "Seeded question for the MCP route" in /);
  const filtered = await callTool("pi_sessions", { cwd: join(agentDir, "nowhere") });
  assert.equal(filtered.isError, true);
  assert.match(filtered.content[0].text, /does not exist/);
});

test("pi_read reads a saved session by its pi-web link, links on the request's Host, and starts no session", async (t) => {
  endpointOn(t);
  const text = (await callTool("pi_read", { session: "http://127.0.0.1:30999/?session=mcp-route-seeded" })).content[0].text;
  assert.match(text, /^Session mcp-route-seeded "Seeded question for the MCP route" in /);
  assert.match(text, /pi-web link: http:\/\/127\.0\.0\.1:30999\/\?session=mcp-route-seeded\n/, "links use the request's Host");
  assert.match(text, /\npi is idle \(the session is not loaded\)\.\n/);
  assert.match(text, /\n\[user\] Seeded question for the MCP route\n\[pi\] Seeded answer\.\n/);
  assert.match(text, /\ncursor: a1~0~[0-9a-z]+$/);
  assert.equal(getRpcSession("mcp-route-seeded"), undefined, "reading starts no session");
});
