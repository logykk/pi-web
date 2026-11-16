import { createHash, timingSafeEqual } from "node:crypto";
import { isApiRequestAllowed } from "../request-security";
import { processGlobal } from "./process-global";

export const MCP_TOKEN_ENV = "PI_WEB_MCP_TOKEN";
export const MIN_TOKEN_LENGTH = 32;
export const MAX_BODY_BYTES = 1024 * 1024;
export const LINK_BASE_ENV = "PI_WEB_MCP_LINK_BASE";

export type TokenConfig =
  | { readonly kind: "disabled"; readonly why: "unset" | "too-short" }
  | { readonly kind: "enabled"; readonly digest: Buffer };

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

export function readTokenConfig(env: NodeJS.ProcessEnv = process.env): TokenConfig {
  const token = env[MCP_TOKEN_ENV]?.trim() ?? "";
  if (!token) return { kind: "disabled", why: "unset" };
  if (token.length < MIN_TOKEN_LENGTH) {
    processGlobal("short-token-warned", () => {
      console.warn(`[pi-web] ${MCP_TOKEN_ENV} is shorter than ${MIN_TOKEN_LENGTH} characters, so /mcp stays off.`);
      return true;
    });
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

export function guardMcpRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Response | null {
  const config = readTokenConfig(env);
  if (config.kind === "disabled") {
    // Not 401, which sends some MCP clients into OAuth discovery for a server that has none.
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

/** Never `request.url`: under `next start` it can carry the bind address, which a remote person cannot open. */
export function linkBaseFor(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[LINK_BASE_ENV]?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const proto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase();
  const scheme = proto === "https" || proto === "http" ? proto : "http";
  return `${scheme}://${request.headers.get("host") ?? "localhost"}`;
}

/**
 * `next start` answers SIGTERM with server.close(), which waits for every open request without a
 * timeout, and `pi-web stop` waits 10 s. Registered once per process. instrumentation-node.ts
 * already listens to both signals, so this listener does not change whether a signal ends the process.
 */
export function shutdownSignal(): AbortSignal {
  return processGlobal("shutdown", () => {
    const controller = new AbortController();
    const stop = () => controller.abort(new Error("pi-web is stopping"));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return controller;
  }).signal;
}
