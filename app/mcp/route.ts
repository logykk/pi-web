import { handleMcpBody, rpcError, RPC } from "@/lib/mcp-endpoint/jsonrpc";
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

  const call = { signal: AbortSignal.any([request.signal, shutdownSignal()]), linkBase: linkBaseFor(request) };
  const reply = await handleMcpBody(mcpServer(), text, request.headers.get("mcp-protocol-version"), call);
  return reply.status === 202 ? new Response(null, { status: 202 }) : jsonResponse(reply.status, reply.body);
}

export async function GET(request: Request): Promise<Response> {
  return guardMcpRequest(request)
    ?? jsonResponse(405, rpcError(null, RPC.serverError, "This server opens no event stream. Use POST."), { Allow: "POST" });
}

export async function DELETE(request: Request): Promise<Response> {
  return guardMcpRequest(request)
    ?? jsonResponse(405, rpcError(null, RPC.serverError, "This server keeps no MCP sessions."), { Allow: "POST" });
}
