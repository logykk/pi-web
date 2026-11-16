import { handleMcpBody, rpcError, RPC } from "@/lib/mcp-endpoint/jsonrpc";
import { guardMcpRequest, noStoreJson, linkBaseFor, MAX_BODY_BYTES, readBoundedBody, shutdownSignal } from "@/lib/mcp-endpoint/http";
import { mcpServer } from "@/lib/mcp-endpoint/tools";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = guardMcpRequest(request);
  if (guard.kind === "denied") return guard.response;
  if (!hasJsonContentType(request)) return noStoreJson(415, rpcError(null, RPC.invalidRequest, "Send Content-Type: application/json."));

  const text = await readBoundedBody(request, MAX_BODY_BYTES);
  if (text === null) return noStoreJson(413, rpcError(null, RPC.invalidRequest, `The body is larger than ${MAX_BODY_BYTES} bytes.`));

  const call = { signal: AbortSignal.any([request.signal, shutdownSignal()]), linkBase: linkBaseFor(guard.host, request.headers.get("x-forwarded-proto")) };
  const reply = await handleMcpBody(mcpServer(), text, request.headers.get("mcp-protocol-version"), call);
  return reply.status === 202 ? new Response(null, { status: 202 }) : noStoreJson(reply.status, reply.body);
}

export async function GET(request: Request): Promise<Response> {
  const guard = guardMcpRequest(request);
  if (guard.kind === "denied") return guard.response;
  return noStoreJson(405, rpcError(null, RPC.serverError, "This server opens no event stream. Use POST."), { Allow: "POST" });
}

export async function DELETE(request: Request): Promise<Response> {
  const guard = guardMcpRequest(request);
  if (guard.kind === "denied") return guard.response;
  return noStoreJson(405, rpcError(null, RPC.serverError, "This server keeps no MCP sessions."), { Allow: "POST" });
}
