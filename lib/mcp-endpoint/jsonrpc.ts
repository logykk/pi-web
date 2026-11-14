// The slice of MCP this endpoint speaks, hand-written: JSON-RPC 2.0 parsing, protocol version
// negotiation, `initialize`, `ping`, `tools/list`, `tools/call`, and the tool-definition plumbing
// (a JSON Schema subset that is both what `tools/list` publishes and what `tools/call` enforces).
// Knows nothing about pi.
//
// Deliberately absent: Mcp-Session-Id, SSE, resumability, server->client requests, progress,
// resources, prompts, logging, completions. Each tool call is bounded well under any proxy
// timeout instead (desk.ts).

/** Newest first. initialize echoes a requested one it knows, else offers the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
/** The spec: a request without MCP-Protocol-Version is 2025-03-26. */
export const HEADERLESS_VERSION: ProtocolVersion = "2025-03-26";

function isProtocolVersion(value: unknown): value is ProtocolVersion {
  return (PROTOCOL_VERSIONS as readonly unknown[]).includes(value);
}

export function negotiateVersion(requested: unknown): ProtocolVersion {
  return isProtocolVersion(requested) ? requested : PROTOCOL_VERSIONS[0];
}

export type JsonRpcId = string | number;

/** A client message, parsed. Wire objects never travel past this module. */
export type ClientMessage =
  | { readonly kind: "request"; readonly id: JsonRpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  /** A reply to a server request. This server sends none, so it is accepted and dropped. */
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: JsonRpcId | null };

export interface JsonRpcError { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: string } }
export interface JsonRpcResult { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
export type JsonRpcResponse = JsonRpcError | JsonRpcResult;

export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export type ParsedBody =
  | { readonly ok: true; readonly batch: boolean; readonly messages: readonly ClientMessage[] }
  | { readonly ok: false; readonly error: JsonRpcError };

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function classify(value: unknown): ClientMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "invalid", id: null };
  const message = value as Record<string, unknown>;
  const hasId = Object.hasOwn(message, "id");
  if (typeof message.method === "string") {
    if (!hasId) return { kind: "notification", method: message.method, params: message.params };
    if (isRpcId(message.id)) return { kind: "request", id: message.id, method: message.method, params: message.params };
    return { kind: "invalid", id: null };
  }
  if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) return { kind: "response" };
  return { kind: "invalid", id: isRpcId(message.id) ? message.id : null };
}

/**
 * One message or a batch. 2025-03-26 clients may batch, and that revision says a server MUST
 * accept batches; later revisions dropped batching, so accepting it costs nothing.
 * Invalid JSON -> -32700; an empty batch or a single non-message -> -32600 (both HTTP 400).
 */
export function parseBody(text: string): ParsedBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: rpcError(null, RPC.parse, "The body is not valid JSON.") };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: false, error: rpcError(null, RPC.invalidRequest, "An empty batch is not a request.") };
    return { ok: true, batch: true, messages: value.map(classify) };
  }
  const message = classify(value);
  if (message.kind === "invalid") return { ok: false, error: rpcError(message.id, RPC.invalidRequest, "Not a JSON-RPC 2.0 message.") };
  return { ok: true, batch: false, messages: [message] };
}

/**
 * The MCP-Protocol-Version header. Absent: HEADERLESS_VERSION. A body of `initialize` requests
 * only is exempt (its version is negotiated in params). Unsupported: HTTP 400 with a JSON-RPC
 * error echoing the request id, naming the versions this server speaks.
 */
export function headerVersion(
  header: string | null,
  messages: readonly ClientMessage[],
): { ok: true; version: ProtocolVersion } | { ok: false; response: JsonRpcError } {
  if (header === null) return { ok: true, version: HEADERLESS_VERSION };
  const value = header.trim();
  if (isProtocolVersion(value)) return { ok: true, version: value };
  if (messages.every((message) => message.kind === "request" && message.method === "initialize")) {
    return { ok: true, version: HEADERLESS_VERSION };
  }
  const single = messages.length === 1 && messages[0].kind === "request" ? messages[0].id : null;
  return {
    ok: false,
    response: rpcError(single, RPC.invalidRequest, `Unsupported MCP-Protocol-Version: ${value}. This server speaks ${PROTOCOL_VERSIONS.join(", ")}.`),
  };
}

/** 202 with no body when nothing in it was a request; else one object, or an array for a batch. */
export function httpReply(
  parsed: { readonly batch: boolean },
  responses: readonly (JsonRpcResponse | null)[],
): { status: 202 } | { status: 200; body: JsonRpcResponse | JsonRpcResponse[] } {
  const answered = responses.filter((response): response is JsonRpcResponse => response !== null);
  if (answered.length === 0) return { status: 202 };
  return { status: 200, body: parsed.batch ? answered : answered[0] };
}

/** The JSON Schema subset tools may declare. validateArgs() enforces exactly these keywords. */
export type ArgSchema =
  | { readonly type: "string"; readonly minLength?: 1; readonly maxLength?: number; readonly enum?: readonly string[]; readonly default?: string; readonly description?: string }
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number; readonly default?: number; readonly description?: string }
  | { readonly type: "boolean"; readonly default?: boolean; readonly description?: string }
  | { readonly type: readonly ("string" | "number" | "boolean")[]; readonly description?: string };

export interface InputSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, ArgSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

type ValueOf<S extends ArgSchema> =
  S extends { enum: readonly (infer E)[] } ? E
  : S extends { type: "string" } ? string
  : S extends { type: "integer" } ? number
  : S extends { type: "boolean" } ? boolean
  : S extends { type: readonly (infer T)[] } ? (T extends "string" ? string : T extends "number" ? number : boolean)
  : never;
type RequiredKey<S extends InputSchema> = S["required"] extends readonly (infer R)[] ? R & keyof S["properties"] : never;
type DefaultedKey<S extends InputSchema> = { [K in keyof S["properties"]]: S["properties"][K] extends { default: unknown } ? K : never }[keyof S["properties"]];

/**
 * The arguments a tool's `run` receives, derived from its schema: required and defaulted
 * properties are present, the rest optional. A schema edit changes the type `run` compiles
 * against, so the published schema and the code that reads it cannot drift apart.
 */
export type ArgsOf<S extends InputSchema> =
  { readonly [K in RequiredKey<S> | DefaultedKey<S>]: ValueOf<S["properties"][K]> } &
  { readonly [K in Exclude<keyof S["properties"], RequiredKey<S> | DefaultedKey<S>>]?: ValueOf<S["properties"][K]> };

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** Per call: the abort signal (client gone or pi-web stopping) and the link base for this client. */
export interface CallContext {
  readonly signal: AbortSignal;
  readonly linkBase: string;
}

/** Text for the model. isError marks a failed operation (not a protocol error). */
export interface ToolText {
  readonly text: string;
  readonly isError?: boolean;
}

export interface ToolSpec<S extends InputSchema = InputSchema> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: S;
  readonly annotations: ToolAnnotations;
  run(args: ArgsOf<S>, call: CallContext): Promise<ToolText>;
}

/** Keeps the literal schema type so `run`'s args are checked against it. */
export function defineTool<const S extends InputSchema>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function checkArg(name: string, schema: ArgSchema, value: unknown): string | null {
  if (typeof schema.type === "object") {
    const ok = schema.type.some((type) => typeof value === type && (type !== "number" || Number.isFinite(value)));
    return ok ? null : `${name} must be a ${schema.type.join(" or ")}, not ${typeName(value)}.`;
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return `${name} must be a string, not ${typeName(value)}.`;
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) return `${name} must not be empty.`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${name} must be at most ${schema.maxLength} characters.`;
      if (schema.enum && !schema.enum.includes(value)) return `${name} must be one of ${schema.enum.join(", ")}.`;
      return null;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isInteger(value)) return `${name} must be an integer, not ${typeName(value)}.`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${name} must be at least ${schema.minimum}.`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${name} must be at most ${schema.maximum}.`;
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `${name} must be true or false, not ${typeName(value)}.`;
  }
}

/**
 * Applies defaults and checks: object shape, unknown keys (additionalProperties false), required,
 * type, enum, minLength/maxLength, minimum/maximum. Errors name the argument and what it must be.
 */
export function validateArgs<S extends InputSchema>(
  schema: S,
  args: unknown,
): { ok: true; value: ArgsOf<S> } | { ok: false; error: string } {
  const given = args === undefined || args === null ? {} : args;
  if (typeof given !== "object" || Array.isArray(given)) return { ok: false, error: "The arguments must be an object." };
  const input = given as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) errors.push(`Unknown argument ${key}. This tool takes ${Object.keys(schema.properties).join(", ")}.`);
  }
  const value: Record<string, unknown> = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    const raw = input[key];
    if (raw === undefined) {
      if ("default" in property && property.default !== undefined) value[key] = property.default;
      else if (schema.required?.includes(key)) errors.push(`${key} is required.`);
      continue;
    }
    const error = checkArg(key, property, raw);
    if (error) errors.push(error);
    else value[key] = raw;
  }
  return errors.length > 0 ? { ok: false, error: errors.join(" ") } : { ok: true, value: value as ArgsOf<S> };
}

export interface McpServerDefinition {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly instructions: string;
  readonly tools: readonly ToolSpec[];
}

function toolCallResult(text: ToolText) {
  return { content: [{ type: "text", text: text.text }], isError: text.isError === true };
}

async function callTool(server: McpServerDefinition, id: JsonRpcId, params: unknown, call: CallContext): Promise<JsonRpcResponse> {
  const { name, arguments: args } = (typeof params === "object" && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
  const tool = server.tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return rpcError(id, RPC.invalidParams, `Unknown tool ${JSON.stringify(name)}. Tools: ${server.tools.map((t) => t.name).join(", ")}.`);
  }
  const parsed = validateArgs(tool.inputSchema, args);
  if (!parsed.ok) return { jsonrpc: "2.0", id, result: toolCallResult({ text: `${tool.name}: ${parsed.error}`, isError: true }) };
  try {
    return { jsonrpc: "2.0", id, result: toolCallResult(await tool.run(parsed.value, call)) };
  } catch (error) {
    console.error(`[pi-web] MCP tool ${tool.name} failed:`, error instanceof Error ? error.stack ?? error.message : error);
    const message = error instanceof Error ? error.message : String(error);
    return { jsonrpc: "2.0", id, result: toolCallResult({ text: `pi-web failed: ${message}`, isError: true }) };
  }
}

type RequestHandler = (
  server: McpServerDefinition,
  request: Extract<ClientMessage, { kind: "request" }>,
  context: { readonly batch: boolean; readonly call: CallContext },
) => JsonRpcResponse | Promise<JsonRpcResponse>;

const REQUEST_HANDLERS: Readonly<Record<string, RequestHandler>> = {
  initialize: (server, request, { batch }) => {
    if (batch) return rpcError(request.id, RPC.invalidRequest, "initialize must not be part of a batch.");
    const params = (typeof request.params === "object" && request.params !== null ? request.params : {}) as { protocolVersion?: unknown };
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: negotiateVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, title: server.title, version: server.version },
        instructions: server.instructions,
      },
    };
  },
  ping: (_server, request) => ({ jsonrpc: "2.0", id: request.id, result: {} }),
  "tools/list": (server, request) => ({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      tools: server.tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
    },
  }),
  "tools/call": (server, request, { call }) => callTool(server, request.id, request.params, call),
};

/**
 * One client message -> its response, or null for anything that gets none (notifications,
 * responses). `notifications/cancelled` is ignored: with no MCP session its requestId names
 * nothing unambiguous across clients; a client that gives up drops the HTTP request, which
 * aborts call.signal instead.
 */
export async function dispatch(
  server: McpServerDefinition,
  message: ClientMessage,
  context: { readonly batch: boolean; readonly call: CallContext },
): Promise<JsonRpcResponse | null> {
  switch (message.kind) {
    case "notification":
    case "response":
      return null;
    case "invalid":
      return rpcError(message.id, RPC.invalidRequest, "Not a JSON-RPC 2.0 message.");
    case "request": {
      const handler = Object.hasOwn(REQUEST_HANDLERS, message.method) ? REQUEST_HANDLERS[message.method] : undefined;
      if (!handler) return rpcError(message.id, RPC.methodNotFound, `Method not found: ${message.method}`);
      return handler(server, message, context);
    }
  }
}
