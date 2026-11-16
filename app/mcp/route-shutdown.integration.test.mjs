import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { withEnv } from "../../lib/mcp-endpoint/test-env.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { POST } = await jiti.import("./route.ts");

const TOKEN = "shutdown-test-token-0123456789abcdef";

test("pi-web stopping ends a pending pi_wait at once", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-mcp-endpoint-shutdown-"));
  await mkdir(join(agentDir, "sessions", "s"), { recursive: true });
  const stamp = new Date().toISOString();
  const lines = [
    { type: "session", version: 3, id: "mcp-shutdown", timestamp: stamp, cwd: agentDir },
    { type: "message", id: "u1", parentId: null, timestamp: stamp, message: { role: "user", content: "hi" } },
  ];
  await writeFile(join(agentDir, "sessions", "s", `${stamp.replace(/[:.]/g, "-")}_mcp-shutdown.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  withEnv(t, { PI_CODING_AGENT_DIR: agentDir, PI_WEB_MCP_TOKEN: TOKEN });
  t.after(() => rm(agentDir, { recursive: true, force: true }));

  const started = Date.now();
  const pending = POST(new Request("http://127.0.0.1:30999/mcp", {
    method: "POST",
    headers: { host: "127.0.0.1:30999", "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pi_wait", arguments: { session: "mcp-shutdown", cursor: "u1~0~1", timeout_s: 50 } } }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.emit("SIGTERM");
  const response = await pending;
  assert.ok(Date.now() - started < 1_500, `answered ${Date.now() - started} ms after the call, not after its 50 s`);
  const body = await response.json();
  assert.match(body.result.content[0].text, /^The wait ended early \(cancelled, or pi-web is stopping\)/);
});
