import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { DELETE, GET, POST } = await jiti.import("./route.ts");
const { invalidateSessionListCache } = await jiti.import("../../lib/session-reader.ts");

const TOKEN = "route-test-token-0123456789abcdef0123";
const BASE = "http://127.0.0.1:30999/mcp";

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

async function withEnv(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("with no token configured, /mcp answers 404 to every method", async (t) => {
  await withEnv(t, { PI_WEB_MCP_TOKEN: undefined });
  assert.equal((await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }))).status, 404);
  assert.equal((await GET(mcp(null, { method: "GET" }))).status, 404);
  assert.equal((await DELETE(mcp(null, { method: "DELETE" }))).status, 404);
});

test("the wire: guard, methods, version header, initialize, batches, notifications and pi_sessions", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-mcp-endpoint-route-"));
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
  await withEnv(t, { PI_WEB_MCP_TOKEN: TOKEN, PI_CODING_AGENT_DIR: agentDir });
  invalidateSessionListCache();
  t.after(async () => {
    invalidateSessionListCache();
    await rm(agentDir, { recursive: true, force: true });
  });

  const get = await GET(mcp(null, { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await DELETE(mcp(null, { method: "DELETE" }))).status, 405);
  assert.equal((await GET(mcp(null, { method: "GET", token: "wrong" }))).status, 401, "the guard runs before 405");

  const wrong = await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: "wrong-token" }));
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate"), /^Bearer realm="pi-web"/);
  assert.equal((await POST(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null }))).status, 401);
  assert.equal((await POST(mcp("ping", { headers: { "content-type": "text/plain" } }))).status, 415);
  const junk = await POST(mcp("{oops"));
  assert.equal(junk.status, 400);
  assert.equal((await junk.json()).error.code, -32700);

  const discover = await POST(mcp({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }, { headers: { "mcp-protocol-version": "2026-07-28" } }));
  assert.equal(discover.status, 400, "a probe under an unknown revision is the client's fallback signal");
  assert.equal((await discover.json()).id, 0);
  const plainDiscover = await POST(mcp({ jsonrpc: "2.0", id: 0, method: "server/discover" }));
  assert.equal(plainDiscover.status, 200);
  assert.equal((await plainDiscover.json()).error.code, -32601);

  const init = await POST(mcp(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { headers: { "mcp-protocol-version": "2026-07-28" } },
  ));
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("content-type"), "application/json");
  assert.equal(init.headers.get("mcp-session-id"), null, "no MCP sessions");
  const initBody = await init.json();
  assert.equal(initBody.result.protocolVersion, "2025-06-18");
  assert.equal(initBody.result.serverInfo.name, "pi-web");
  assert.match(initBody.result.instructions, /pi_sessions/);

  const notified = await POST(mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, { headers: { "mcp-protocol-version": "2025-06-18" } }));
  assert.equal(notified.status, 202);
  assert.equal(await notified.text(), "");

  const batch = await POST(mcp([{ jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }]));
  assert.deepEqual(await batch.json(), [{ jsonrpc: "2.0", id: 2, result: {} }]);

  const listed = await (await POST(mcp({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { headers: { "mcp-protocol-version": "2025-11-25" } }))).json();
  assert.ok(listed.result.tools.some((tool) => tool.name === "pi_sessions"));

  const sessions = await (await POST(mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pi_sessions", arguments: {} } }))).json();
  assert.equal(sessions.result.isError, false);
  assert.match(sessions.result.content[0].text, /mcp-route-seeded \[idle\] "Seeded question for the MCP route" in /);
  const filtered = await (await POST(mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pi_sessions", arguments: { cwd: join(agentDir, "nowhere") } } }))).json();
  assert.equal(filtered.result.isError, true);
  assert.match(filtered.result.content[0].text, /does not exist/);
});
