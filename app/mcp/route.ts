// pi-web's MCP endpoint (fork only): Streamable HTTP in JSON response mode, inside the server
// process that hosts pi. Every POST is answered with one plain `application/json` body, or 202
// for notifications only. No Mcp-Session-Id, no SSE, no GET stream: nothing here outlives a
// bounded tool call. proxy.ts does not match /mcp, so this route guards itself
// (lib/mcp-endpoint/http.ts), as app/api/web-auth/route.ts does. Notes: docs/agents/mcp-endpoint.md.

import { dispatch, headerVersion, httpReply, parseBody, rpcError, RPC } from "@/lib/mcp-endpoint/jsonrpc";
import { guardMcpRequest, jsonResponse, linkBaseFor, MAX_BODY_BYTES, readBoundedBody, shutdownSignal } from "@/lib/mcp-endpoint/http";
import { mcpServer } from "@/lib/mcp-endpoint/tools";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const denied = guardMcpRequest(request);
  if (denied) return denied;
  if (!hasJsonContentType(request)) return jsonResponse(415, rpcError(null, RPC.invalidRequest, "Send Content-Type: application/json."));

  const text = await readBoundedBody(request, MAX_BODY_BYTES);
  if (text === null) return jsonResponse(413, rpcError(null, RPC.invalidRequest, `The body is larger than ${MAX_BODY_BYTES} bytes.`));

  const parsed = parseBody(text);
  if (!parsed.ok) return jsonResponse(400, parsed.error);

  // Claude Code's first probe (`server/discover`) names a newer revision in this header; the 400
  // is its signal to fall back to the initialize handshake.
  const version = headerVersion(request.headers.get("mcp-protocol-version"), parsed.messages);
  if (!version.ok) return jsonResponse(400, version.response);

  const call = { signal: AbortSignal.any([request.signal, shutdownSignal()]), linkBase: linkBaseFor(request) };
  const server = mcpServer();
  const responses = await Promise.all(parsed.messages.map((message) => dispatch(server, message, { batch: parsed.batch, call })));
  const reply = httpReply(parsed, responses);
  return reply.status === 202 ? new Response(null, { status: 202 }) : jsonResponse(200, reply.body);
}

export async function GET(request: Request): Promise<Response> {
  return guardMcpRequest(request)
    ?? jsonResponse(405, rpcError(null, -32000, "This server opens no event stream. Use POST."), { Allow: "POST" });
}

export async function DELETE(request: Request): Promise<Response> {
  return guardMcpRequest(request)
    ?? jsonResponse(405, rpcError(null, -32000, "This server keeps no MCP sessions."), { Allow: "POST" });
}
