import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { withEnv } from "./test-env.mjs";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { guardMcpRequest, linkBaseFor, readBoundedBody, shutdownSignal } = await jiti.import("./http.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await jiti.import("../auth-throttle.ts");

const TOKEN = "t".repeat(40);
const env = { PI_WEB_MCP_TOKEN: TOKEN };

function mcpRequest(headers = {}, init = {}) {
  return new Request("http://127.0.0.1:30140/mcp", { method: "POST", headers: { host: "127.0.0.1:30140", ...headers }, ...init });
}

test("an unset or short token turns the endpoint off for every request", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const off of [{}, { PI_WEB_MCP_TOKEN: "  " }, { PI_WEB_MCP_TOKEN: "short" }]) {
      const { response } = guardMcpRequest(mcpRequest({ authorization: `Bearer ${off.PI_WEB_MCP_TOKEN ?? ""}` }), off);
      assert.equal(response?.status, 404, JSON.stringify(off));
      assert.match((await response.json()).error, /PI_WEB_MCP_TOKEN/);
    }
    const guarded = (token) => guardMcpRequest(mcpRequest({ authorization: `Bearer ${token}` }), { PI_WEB_MCP_TOKEN: ` ${token} ` });
    assert.equal(guarded("x".repeat(31)).response?.status, 404, "31 characters are too few");
    assert.equal(guarded("x".repeat(32)).kind, "allowed", "32 are enough, trimmed");
  } finally {
    console.warn = warn;
  }
});

test("a missing or foreign Host or a cross-site browser request is refused before the token is read", () => {
  const hostless = new Request("http://127.0.0.1:30140/mcp", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(guardMcpRequest(hostless, env).response?.status, 403);
  assert.equal(guardMcpRequest(mcpRequest({ host: "evil.example", authorization: `Bearer ${TOKEN}` }), env).response?.status, 403);
  assert.equal(guardMcpRequest(mcpRequest({ origin: "https://evil.example", authorization: `Bearer ${TOKEN}` }), env).response?.status, 403);
  assert.equal(guardMcpRequest(mcpRequest({ "sec-fetch-site": "cross-site", authorization: `Bearer ${TOKEN}` }), env).response?.status, 403);
});

test("a tunnel hostname passes once PI_WEB_ALLOWED_HOSTS lists it", (t) => {
  withEnv(t, { PI_WEB_ALLOWED_HOSTS: undefined });
  const remote = () => mcpRequest({ host: "pi.example.net", "x-forwarded-proto": "https", authorization: `Bearer ${TOKEN}` });
  assert.equal(guardMcpRequest(remote(), env).response?.status, 403);
  process.env.PI_WEB_ALLOWED_HOSTS = "pi.example.net";
  assert.deepEqual(guardMcpRequest(remote(), env), { kind: "allowed", host: "pi.example.net" });
});

test("a missing, wrong, Basic or malformed bearer gets 401 with WWW-Authenticate, and never feeds the login throttle", () => {
  for (const authorization of [undefined, "Bearer wrong", `Basic ${Buffer.from(`pi:${TOKEN}`).toString("base64")}`, `Bearer ${TOKEN} extra`, `Bearer${TOKEN}`]) {
    const { response } = guardMcpRequest(mcpRequest(authorization ? { authorization } : {}), env);
    assert.equal(response?.status, 401, String(authorization));
    assert.match(response.headers.get("www-authenticate"), /^Bearer /);
  }
  for (let i = 0; i < 50; i += 1) guardMcpRequest(mcpRequest({ authorization: `Bearer guess-${i}` }), env);
  assert.equal(getAuthRetryAfterMs(), 0, "50 wrong tokens leave the web login unthrottled");
  recordAuthFailure();
  assert.ok(getAuthRetryAfterMs() > 0, "one wrong web password is seen by the same check");
  recordAuthSuccess();
  assert.deepEqual(guardMcpRequest(mcpRequest({ authorization: `Bearer ${TOKEN}` }), env), { kind: "allowed", host: "127.0.0.1:30140" });
  assert.equal(guardMcpRequest(mcpRequest({ authorization: `bearer   ${TOKEN}` }), env).kind, "allowed", "the scheme is case-insensitive");
});

test("readBoundedBody reads up to the bound and refuses past it, whatever Content-Length says", async () => {
  assert.equal(await readBoundedBody(mcpRequest({}, { body: "héllo" }), 100), "héllo");
  assert.equal(await readBoundedBody(mcpRequest({ "content-length": "1000" }, { body: "x" }), 100), null);
  const lying = new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { "content-length": "5" },
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(80)); c.enqueue(new Uint8Array(80)); c.close(); } }),
    duplex: "half",
  });
  assert.equal(await readBoundedBody(lying, 100), null);
});

test("linkBaseFor: the override, else the Host with the forwarded scheme", () => {
  assert.equal(linkBaseFor("127.0.0.1:30140", null, {}), "http://127.0.0.1:30140");
  assert.equal(linkBaseFor("pi.example.net", "https, http", {}), "https://pi.example.net");
  assert.equal(linkBaseFor("127.0.0.1:30140", null, { PI_WEB_MCP_LINK_BASE: "https://pi.example.net/" }), "https://pi.example.net");
});

test("shutdownSignal is one signal per process, across module reloads", async () => {
  const fresh = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const again = await fresh.import("./http.ts");
  assert.equal(again.shutdownSignal(), shutdownSignal());
  assert.equal(shutdownSignal().aborted, false);
});
