// What the MCP endpoint reads from an HTTP request before any MCP is parsed: whether it may be
// served at all (token configured, Host/Origin, bearer token), its bounded body, and the base of
// the pi-web links the tools hand out. Also the one shutdown signal every wait listens to.

import { createHash, timingSafeEqual } from "node:crypto";
import { isApiRequestAllowed } from "../request-security";

export const MCP_TOKEN_ENV = "PI_WEB_MCP_TOKEN";
/** `openssl rand -hex 32` gives 64 characters; 32 is the least the endpoint accepts. */
export const MIN_TOKEN_LENGTH = 32;
export const MAX_BODY_BYTES = 1024 * 1024;
export const LINK_BASE_ENV = "PI_WEB_MCP_LINK_BASE";

export type TokenConfig =
  | { readonly kind: "disabled"; readonly why: "unset" | "too-short" }
  | { readonly kind: "enabled"; readonly digest: Buffer };

const SHORT_TOKEN_WARNED = Symbol.for("pi-web.mcp-endpoint.short-token-warned");

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Read on every request, so tests can flip it; compared as digests, constant-time and length-independent. */
export function readTokenConfig(env: NodeJS.ProcessEnv = process.env): TokenConfig {
  const token = env[MCP_TOKEN_ENV]?.trim() ?? "";
  if (!token) return { kind: "disabled", why: "unset" };
  if (token.length < MIN_TOKEN_LENGTH) {
    const flags = globalThis as unknown as Record<symbol, boolean | undefined>;
    if (!flags[SHORT_TOKEN_WARNED]) {
      flags[SHORT_TOKEN_WARNED] = true;
      console.warn(`[pi-web] ${MCP_TOKEN_ENV} is shorter than ${MIN_TOKEN_LENGTH} characters, so /mcp stays off.`);
    }
    return { kind: "disabled", why: "too-short" };
  }
  return { kind: "enabled", digest: sha256(token) };
}

const BEARER = /^Bearer +(\S+) *$/i;

export function bearerMatches(authorization: string | null, digest: Buffer): boolean {
  const match = BEARER.exec(authorization ?? "");
  return match !== null && timingSafeEqual(sha256(match[1]), digest);
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * Null when the request may be served; otherwise the whole answer:
 *  1. No usable token -> 404 for every method: the endpoint is off. Not 401, which sends some
 *     MCP clients into OAuth discovery for a server that has none.
 *  2. Host or cross-site Origin refused, as proxy.ts refuses them for /api -> 403. CLI clients
 *     send no Origin; a tunnel hostname must be in PI_WEB_ALLOWED_HOSTS, as for the web UI.
 *  3. Bearer mismatch -> 401 with WWW-Authenticate.
 *
 * Never reads or feeds lib/auth-throttle.ts: that backoff is global and shared with the login
 * form, so a prober guessing tokens would lock the person out of the web UI. Guessing a 32+
 * character random token is not a threat a backoff needs to slow down.
 */
export function guardMcpRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Response | null {
  const config = readTokenConfig(env);
  if (config.kind === "disabled") {
    return jsonResponse(404, {
      error: `pi-web's MCP endpoint is off. Set ${MCP_TOKEN_ENV} (${MIN_TOKEN_LENGTH}+ characters) in pi-web's environment and restart it.`,
    });
  }
  if (!isApiRequestAllowed(request)) return jsonResponse(403, { error: "Untrusted MCP request" });
  if (!bearerMatches(request.headers.get("authorization"), config.digest)) {
    return jsonResponse(
      401,
      { error: `Send Authorization: Bearer <${MCP_TOKEN_ENV}>.` },
      { "WWW-Authenticate": 'Bearer realm="pi-web", error="invalid_token"' },
    );
  }
  return null;
}

/** The body as text, or null past `maxBytes` (a lying Content-Length included). */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Where a person opens a session: PI_WEB_MCP_LINK_BASE when set, else the request's own Host
 * with `x-forwarded-proto` (first value) or http. Never `request.url`: under `next start` it can
 * carry the bind address, which a remote person cannot open. guardMcpRequest() checked the Host.
 */
export function linkBaseFor(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[LINK_BASE_ENV]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const scheme = proto === "https" || proto === "http" ? proto : "http";
  return `${scheme}://${request.headers.get("host") ?? "localhost"}`;
}

const SHUTDOWN = Symbol.for("pi-web.mcp-endpoint.shutdown");

/**
 * Aborted once pi-web is told to stop. `next start` answers SIGTERM with server.close(), which
 * waits for every open request without a timeout, and `pi-web stop` waits 10 s: a 45 s wait must
 * end now. Registered once per process on globalThis, so hot reloads and route bundles share it.
 * instrumentation-node.ts already listens to both signals, so this listener does not change
 * whether a signal ends the process.
 */
export function shutdownSignal(): AbortSignal {
  const store = globalThis as unknown as Record<symbol, AbortController | undefined>;
  let controller = store[SHUTDOWN];
  if (!controller) {
    const created = new AbortController();
    controller = created;
    store[SHUTDOWN] = created;
    const stop = () => created.abort(new Error("pi-web is stopping"));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }
  return controller.signal;
}
