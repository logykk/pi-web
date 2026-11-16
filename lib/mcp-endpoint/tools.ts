import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import packageJson from "../../package.json";
import { TOOL_PRESET_VALUES } from "../tool-presets";
import { createDesk, createDeskMemory, DeskError, parseSessionRef, WAIT_DEFAULT_MS, WAIT_MAX_MS, type Desk, type SessionId } from "./desk";
import { endpointTool, type EndpointServer, type ToolSpec } from "./jsonrpc";
import { piWebPorts } from "./ports";
import { processGlobal } from "./process-global";
import {
  renderAnswer, renderNewSession, renderRead, renderSend, renderSessionList, renderStop, renderWait, renderWorktree,
} from "./replies";
import { decodeCursor, type Cursor } from "./transcript";

const SESSION = { type: "string", minLength: 1, description: "The session id, or the pi-web link the person has open (…/?session=<id>)." } as const;
const CURSOR = { type: "string", minLength: 1, description: "The `cursor:` line of the newest reply about this session." } as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const INSTRUCTIONS = [
  "These tools work in pi sessions of a pi-web server. A person may be using the same session in pi-web's browser UI at the same time: both of you send messages, both see everything.",
  "Find a session with pi_sessions (or take the pi-web link the person gives you), or start one with pi_new_session (pi_new_worktree first for a fresh branch).",
  `Join a session with pi_read. Send with pi_send: it returns once pi has taken the message, queued behind any run in progress, the person's included. Then call pi_wait until it says pi is at rest; each wait lasts at most ${WAIT_MAX_MS / 1000} s, so call it again while pi is working.`,
  "Every reply about a session ends with `cursor: …`. Always pass the newest cursor to pi_wait (and pi_send). If a call fails or its reply is lost, repeat it with the same cursor: nothing moved.",
  "User messages are labeled [agent] (sent through these tools), [person] (typed in pi-web) or [user] (unknown, from before pi-web last restarted). pi's replies are [pi].",
  "pi_stop stops pi for the person too. When an extension asks a question, the reply shows it with the pi_answer call that answers it; the person sees the same question and the first answer counts.",
].join("\n\n");

function createTools(desk: Desk): ToolSpec[] {
  return [
    endpointTool({
      name: "pi_sessions",
      title: "List pi sessions",
      description: "List pi sessions on this pi-web, newest first: id, state (working, waiting for an answer, idle), title, folder and git branch. Subagent and side-chat sessions are left out. Use it to find the session the person has open.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", minLength: 1, description: "Only sessions in this folder or below it." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (filter) => renderSessionList(await desk.sessions(filter)),
    }),

    endpointTool({
      name: "pi_read",
      title: "Read a pi session",
      description: "Read a session's latest messages (or older ones with before), its state and any open extension question, without starting or changing it. Use it to join a session: the reply ends with the cursor for pi_wait and pi_send. Tool output is longer here than in pi_wait replies.",
      inputSchema: {
        type: "object",
        properties: {
          session: SESSION,
          messages: { type: "integer", minimum: 1, maximum: 100, default: 12, description: "How many user and pi messages to show." },
          before: { type: "string", minLength: 1, description: "The entry id from an earlier pi_read's `older:` line: the messages before it." },
        },
        required: ["session"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ session, ...page }, call) => renderRead(await desk.read(sessionId(session), page), call.linkBase),
    }),

    endpointTool({
      name: "pi_send",
      title: "Send a message to pi",
      description: "Send a message to pi in a session, as pi-web's composer does. Returns as soon as pi has taken it. If pi is busy with anyone's run, the message is queued and goes in when that run would stop; steer: true delivers it at pi's next step instead. Then call pi_wait with the cursor. If this call fails, check with pi_read before sending again: the message may have gone through.",
      inputSchema: {
        type: "object",
        properties: {
          session: SESSION,
          message: { type: "string", minLength: 1 },
          steer: { type: "boolean", default: false, description: "Deliver into the current run at its next step, not after it." },
          cursor: { ...CURSOR, description: "Your newest cursor for this session, so the next pi_wait also shows what came before your message." },
        },
        required: ["session", "message"],
        additionalProperties: false,
      },
      annotations: { openWorldHint: false },
      run: async ({ session, message, steer, cursor }, call) => {
        const id = sessionId(session);
        return renderSend(id, await desk.send(id, message, { steer, cursor: cursor === undefined ? null : requiredCursor(cursor) }, call.signal));
      },
    }),

    endpointTool({
      name: "pi_wait",
      title: "Wait for pi",
      description: `Wait until pi in a session is at rest (its run and anything queued are done), an extension asks a question you have not been shown, or timeout_s passes; then report everything new since cursor, the person's messages included. On an idle session it waits for the person to do something. timeout_s 0 reports at once. Each wait lasts at most ${WAIT_MAX_MS / 1000} s; call again with the new cursor while pi works.`,
      inputSchema: {
        type: "object",
        properties: {
          session: SESSION,
          cursor: CURSOR,
          timeout_s: { type: "integer", minimum: 0, maximum: WAIT_MAX_MS / 1000, default: WAIT_DEFAULT_MS / 1000 },
        },
        required: ["session", "cursor"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ session, cursor, timeout_s }, call) => {
        const id = sessionId(session);
        return renderWait(id, await desk.wait(id, requiredCursor(cursor), timeout_s * 1000, call.signal));
      },
    }),

    endpointTool({
      name: "pi_answer",
      title: "Answer an extension's question",
      description: "Answer the question an extension asks (a dialog id from a reply): a choice takes the option's text or 1-based number, a yes/no question true or false, a text box a string; or cancel: true. The person sees the same question in pi-web and the first answer counts. Returns at once; call pi_wait to follow pi.",
      inputSchema: {
        type: "object",
        properties: {
          session: SESSION,
          dialog: { type: "string", minLength: 1 },
          answer: { type: ["string", "number", "boolean"] },
          cancel: { type: "boolean" },
        },
        required: ["session", "dialog"],
        additionalProperties: false,
      },
      annotations: { openWorldHint: false },
      run: async ({ session, dialog, answer, cancel }) => {
        if ((answer !== undefined) === (cancel === true)) return { text: "Pass answer, or cancel: true; not both and not neither.", isError: true };
        return renderAnswer(dialog, await desk.answer(sessionId(session), dialog, answer !== undefined ? { value: answer } : { cancel: true }));
      },
    }),

    endpointTool({
      name: "pi_stop",
      title: "Stop pi",
      description: "Stop pi in a session for everyone, as Stop in pi-web does: ends the current run whoever started it, dismisses open questions and withdraws every queued message, the person's included. The reply lists what it withdrew; it does not go back to the person's composer. Does nothing when pi is idle.",
      inputSchema: { type: "object", properties: { session: SESSION }, required: ["session"], additionalProperties: false },
      annotations: { destructiveHint: true, openWorldHint: false },
      run: async ({ session }) => renderStop(await desk.stop(sessionId(session))),
    }),

    endpointTool({
      name: "pi_new_session",
      title: "Start a pi session",
      description: "Start a new pi session in a folder on pi-web's machine and send it a first message. Returns once pi has taken the message, with the session id, a pi-web link to give the person, and a cursor for pi_wait.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", minLength: 1, description: "Absolute path (or ~/…) of an existing folder on pi-web's machine." },
          message: { type: "string", minLength: 1, description: "The first message to pi." },
          model: { type: "string", minLength: 1, description: "provider/modelId. Default: pi's default model." },
          thinking: { type: "string", enum: THINKING, description: "Reasoning level. Default: pi's default." },
          tools: {
            type: "string",
            enum: TOOL_PRESET_VALUES,
            default: "configured",
            description: "pi's tools: configured (pi's settings, as pi-web's default), none (chat only), read-only, default (read, bash, edit, write) or full.",
          },
        },
        required: ["cwd", "message"],
        additionalProperties: false,
      },
      annotations: { openWorldHint: false },
      run: async (request, call) => renderNewSession(await desk.newSession(request, call.signal), call.linkBase),
    }),

    endpointTool({
      name: "pi_new_worktree",
      title: "Create a git worktree",
      description: "Create a git worktree for a branch of the repository that contains project, at <repo>-worktrees/<branch>. Checks the branch out if it exists, else creates it from the main checkout's HEAD (or an already-fetched origin/<branch>); nothing is fetched. Safe to repeat: an existing worktree of the branch is returned. Start pi there with pi_new_session.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", minLength: 1, description: "A folder inside the repository (its root, or a session's cwd)." },
          branch: { type: "string", minLength: 1 },
        },
        required: ["project", "branch"],
        additionalProperties: false,
      },
      annotations: { idempotentHint: true, openWorldHint: false },
      run: async (request, call) => renderWorktree(await desk.newWorktree(request, call.signal)),
    }),
  ];
}

export function serverFor(desk: Desk): EndpointServer {
  return {
    name: "pi-web",
    title: "pi-web",
    version: packageJson.version,
    instructions: INSTRUCTIONS,
    tools: createTools(desk),
    isToolError: (error) => error instanceof DeskError,
  };
}

let server: EndpointServer | null = null;

export function mcpServer(): EndpointServer {
  server ??= serverFor(createDesk(piWebPorts(), processGlobal("desk-memory", createDeskMemory)));
  return server;
}

function sessionId(ref: string): SessionId {
  const id = parseSessionRef(ref);
  if (!id) throw new DeskError(`${JSON.stringify(ref)} is not a pi session id or a pi-web link with ?session=<id>. pi_sessions lists the sessions.`);
  return id;
}

function requiredCursor(text: string): Cursor {
  const cursor = decodeCursor(text);
  if (!cursor) throw new DeskError("That cursor did not come from this server. Call pi_read to get a fresh one.");
  return cursor;
}
