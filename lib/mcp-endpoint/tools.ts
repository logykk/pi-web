import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import packageJson from "../../package.json";
import { sessionDeepLink } from "../session-links";
import { TOOL_PRESET_VALUES } from "../tool-presets";
import {
  createDesk, createDeskMemory, DeskError, parseSessionRef, WAIT_DEFAULT_MS, WAIT_MAX_MS,
  type AnswerResult, type Desk, type Dialog, type NewSessionResult, type NewWorktreeResult, type ReadResult, type SendResult,
  type SessionHeading, type SessionId, type SessionStatus, type StopResult, type WaitResult,
} from "./desk";
import { defineTool, type CallContext, type McpServerDefinition, type ToolSpec, type ToolText } from "./jsonrpc";
import { piWebPorts, type SessionRow } from "./ports";
import { processGlobal } from "./process-global";
import type { SentMessage } from "./session-ledger";
import { BUDGETS, decodeCursor, encodeCursor, renderMessages, type Cursor } from "./transcript";

const SESSION = { type: "string", minLength: 1, description: "The session id, or the pi-web link the person has open (…/?session=<id>)." } as const;
const CURSOR = { type: "string", minLength: 1, description: "The `cursor:` line of the newest reply about this session." } as const;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

const INSTRUCTIONS = [
  "These tools work in pi sessions of a pi-web server. A person may be using the same session in pi-web's browser UI at the same time: both of you send messages, both see everything.",
  "Find a session with pi_sessions (or take the pi-web link the person gives you), or start one with pi_new_session (pi_new_worktree first for a fresh branch).",
  "Join a session with pi_read. Send with pi_send: it returns once pi has taken the message, queued behind any run in progress, the person's included. Then call pi_wait until it says pi is at rest; each wait lasts at most 50 s, so call it again while pi is working.",
  "Every reply about a session ends with `cursor: …`. Always pass the newest cursor to pi_wait (and pi_send). If a call fails or its reply is lost, repeat it with the same cursor: nothing moved.",
  "User messages are labeled [agent] (sent through these tools), [person] (typed in pi-web) or [user] (unknown, from before pi-web last restarted). pi's replies are [pi].",
  "pi_stop stops pi for the person too. When an extension asks a question, the reply shows it with the pi_answer call that answers it; the person sees the same question and the first answer counts.",
].join("\n\n");

function createTools(desk: Desk): ToolSpec[] {
  return [
    defineTool({
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
      run: async (args) => renderSessionList(await desk.sessions({ cwd: args.cwd, limit: args.limit })),
    }),

    defineTool({
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
      run: async (args, call) => {
        const id = sessionId(args.session);
        return renderRead(await desk.read(id, { messages: args.messages, ...(args.before !== undefined ? { before: args.before } : {}) }), call);
      },
    }),

    defineTool({
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
      run: async (args, call) => {
        const id = sessionId(args.session);
        const cursor = args.cursor === undefined ? null : requiredCursor(args.cursor);
        return renderSend(id, await desk.send(id, args.message, { steer: args.steer, cursor }, call.signal));
      },
    }),

    defineTool({
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
      run: async (args, call) => {
        const id = sessionId(args.session);
        return renderWait(id, await desk.wait(id, requiredCursor(args.cursor), args.timeout_s * 1000, call.signal));
      },
    }),

    defineTool({
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
      run: async (args) => {
        if ((args.answer !== undefined) === (args.cancel === true)) return { text: "Pass answer, or cancel: true; not both and not neither.", isError: true };
        const id = sessionId(args.session);
        return renderAnswer(args.dialog, await desk.answer(id, args.dialog, args.answer !== undefined ? { value: args.answer } : { cancel: true }));
      },
    }),

    defineTool({
      name: "pi_stop",
      title: "Stop pi",
      description: "Stop pi in a session for everyone, as Stop in pi-web does: ends the current run whoever started it, dismisses open questions and withdraws every queued message, the person's included. The reply lists what it withdrew; it does not go back to the person's composer. Does nothing when pi is idle.",
      inputSchema: { type: "object", properties: { session: SESSION }, required: ["session"], additionalProperties: false },
      annotations: { destructiveHint: true, openWorldHint: false },
      run: async (args) => renderStop(await desk.stop(sessionId(args.session))),
    }),

    defineTool({
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
      run: async (args, call) => renderNewSession(await desk.newSession(args, call.signal), call),
    }),

    defineTool({
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
      run: async (args, call) => renderWorktree(await desk.newWorktree(args, call.signal)),
    }),
  ];
}

export function serverFor(desk: Desk): McpServerDefinition {
  return {
    name: "pi-web",
    title: "pi-web",
    version: packageJson.version,
    instructions: INSTRUCTIONS,
    tools: createTools(desk),
    isToolError: (error) => error instanceof DeskError,
  };
}

let server: McpServerDefinition | null = null;

export function mcpServer(): McpServerDefinition {
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

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function cursorLine(cursor: Cursor): string {
  return `cursor: ${encodeCursor(cursor)}`;
}

function headingLine(session: SessionHeading): string {
  const title = session.title ? ` "${oneLine(session.title, 80)}"` : "";
  return `Session ${session.id}${title} in ${session.cwd}${session.branch ? ` (branch ${session.branch})` : ""}.`;
}

function statusLine(status: SessionStatus): string {
  const state = !status.loaded ? "pi is idle (the session is not loaded)."
    : status.running && status.dialogs.length > 0 ? "pi is waiting for an answer."
    : status.running ? (status.activity ? `pi is working: ${status.activity}.` : "pi is working.")
    : status.subagentsActive ? "pi is idle, but subagents are still running and will report back."
    : status.sendsInFlight > 0 ? "pi is idle; a message of yours is still on its way."
    : "pi is idle.";
  const queued = [
    status.queued.followUp.length ? plural(status.queued.followUp.length, "follow-up") : "",
    status.queued.steering.length ? plural(status.queued.steering.length, "steer") : "",
  ].filter(Boolean);
  return queued.length ? `${state} Queued: ${queued.join(", ")}.` : state;
}

function dialogLines(id: string, dialogs: readonly Dialog[]): string[] {
  return dialogs.flatMap((dialog) => {
    const call = (example: string, takes: string) =>
      `  Answer with pi_answer {"session":"${id}","dialog":"${dialog.id}","answer":${example}} (answer takes ${takes}), or "cancel":true instead of answer.`;
    switch (dialog.kind) {
      case "choice":
        return [
          `An extension asks (a choice), dialog ${dialog.id}: ${dialog.title}`,
          `  ${dialog.options.map((option, index) => `${index + 1}. ${option}`).join("  ")}`,
          call(JSON.stringify(dialog.options[0] ?? ""), "the option's text or its number"),
        ];
      case "confirm":
        return [`An extension asks (yes or no), dialog ${dialog.id}: ${dialog.title}`, `  ${oneLine(dialog.message, 500)}`, call("true", "true or false")];
      case "text":
        return [
          `An extension asks for ${dialog.multiline ? "a text" : "a line of text"}, dialog ${dialog.id}: ${dialog.title}`,
          ...(dialog.placeholder ? [`  (placeholder: ${dialog.placeholder})`] : []),
          ...(dialog.prefill ? [`  Prefilled with: ${oneLine(dialog.prefill, 500)}`] : []),
          call('"…"', "your text"),
        ];
      case "panel":
        return [`An extension shows a panel (dialog ${dialog.id}) that only the person can answer in pi-web:`, ...dialog.lines.slice(-20).map((line) => `  | ${line}`)];
    }
  });
}

function renderSessionList({ rows, total }: { rows: readonly SessionRow[]; total: number }): ToolText {
  if (total === 0) return { text: "No pi sessions match." };
  const STATE: Readonly<Record<SessionRow["state"], string>> = { working: "working", waiting: "waiting for an answer", idle: "idle" };
  const lines = [total > rows.length ? `${total} sessions; the newest ${rows.length}:` : `${plural(total, "session")}, newest first:`];
  for (const row of rows) {
    const where = row.branch ? `${row.cwd} (${row.isWorktree ? "worktree, " : ""}branch ${row.branch})` : row.cwd;
    lines.push(`- ${row.id} [${STATE[row.state]}] "${oneLine(row.title, 80)}" in ${where}, last active ${row.modified}`);
  }
  return { text: lines.join("\n") };
}

const READ_PAGE: Readonly<Record<ReadResult["kind"], { heading: string; empty: string }>> = {
  latest: { heading: "Latest messages:", empty: "No messages yet." },
  older: { heading: "Older messages:", empty: "No older messages." },
};

function renderRead(result: ReadResult, call: CallContext): ToolText {
  const { session, status, page } = result;
  const lines = [headingLine(session), `pi-web link: ${call.linkBase}/${sessionDeepLink(session.id)}`, statusLine(status)];
  if (page.messages.length === 0) lines.push(READ_PAGE[result.kind].empty);
  else lines.push(READ_PAGE[result.kind].heading, ...renderMessages(page.messages, page.authors, BUDGETS.read, { endsAtNewest: result.kind === "latest" }));
  if (page.hasMore && page.oldestEntryId) lines.push(`older: pi_read {"session":"${session.id}","before":"${page.oldestEntryId}"}`);
  lines.push(...dialogLines(session.id, status.dialogs));
  lines.push(result.kind === "latest" ? cursorLine(result.cursor) : "(An older page: keep using the cursor you have.)");
  return { text: lines.join("\n") };
}

function sendHeadline(send: SentMessage): string {
  const { outcome } = send;
  switch (outcome.state) {
    case "accepted":
      if (outcome.disposition === "started") return "pi started working on your message.";
      return send.delivery === "steer"
        ? "pi was busy (a run started in pi-web or by you), so your message is queued and goes in at pi's next step. The person sees it in pi-web's queue."
        : "pi was busy (a run started in pi-web or by you), so your message is queued and goes in when that run would stop. The person sees it in pi-web's queue.";
    case "parked":
      return "pi is compacting the conversation; your message goes out when that ends.";
    case "sending":
      return "pi has not taken your message yet (pi-web is loading the session, or an extension asks something first). It stays on its way; pi_wait reports what happens to it.";
    case "refused":
      return `pi did not take your message: ${outcome.reason}`;
  }
}

function renderSend(id: string, result: SendResult): ToolText {
  const lines = [sendHeadline(result.send), statusLine(result.status), ...dialogLines(id, result.status.dialogs)];
  if (result.send.outcome.state !== "refused") lines.push("Follow pi with pi_wait and this cursor.");
  lines.push(cursorLine(result.cursor));
  return { text: lines.join("\n"), isError: result.send.outcome.state === "refused" };
}

function waitHeadline(result: WaitResult): string {
  const seconds = Math.round(result.waitedMs / 1000);
  const { status } = result;
  switch (result.reason) {
    case "settled":
      return "pi is at rest.";
    case "dialog":
      return "An extension asks a question (below).";
    case "aborted":
      return "The wait ended early (cancelled, or pi-web is stopping). Call pi_wait again with the new cursor.";
    case "now":
      return "Now:";
    case "timeout":
      return status.running || status.subagentsActive || status.sendsInFlight > 0
        ? `pi is still working after ${seconds} s. Call pi_wait again with the new cursor.`
        : `Nothing new after ${seconds} s; pi is idle and the person may be away. Call pi_wait again to keep waiting.`;
  }
}

const DELTA_HEADING: Readonly<Record<WaitResult["delta"]["kind"], string>> = {
  since: "New since your cursor:",
  moved: "The conversation in pi-web moved to another branch (an earlier message was edited, or the branch switched). The current branch after the fork:",
  unknown: "That cursor is not from this session; its latest messages:",
};

function newsLine(send: SentMessage): string {
  const quoted = `"${oneLine(send.text, 80)}"`;
  if (send.outcome.state === "refused") return `pi did not take your message ${quoted}: ${send.outcome.reason}`;
  return `Your message ${quoted} never reached pi: Stop or Recall took it out of pi's queue first (done in pi-web, that puts it in the person's composer).`;
}

function renderWait(id: string, result: WaitResult): ToolText {
  const { delta } = result;
  const lines = [waitHeadline(result), statusLine(result.status)];
  if (delta.messages.length > 0 || delta.kind !== "since") {
    lines.push(DELTA_HEADING[delta.kind]);
    if (delta.omitted > 0) lines.push(`(${delta.omitted === 1 ? "1 earlier entry" : `${delta.omitted} earlier entries`} not shown; pi_read shows them.)`);
    lines.push(...renderMessages(delta.messages, delta.authors, BUDGETS.report, { endsAtNewest: true }));
  }
  lines.push(...result.news.map(newsLine), ...result.notices, ...dialogLines(id, result.status.dialogs), cursorLine(result.cursor));
  return { text: lines.join("\n") };
}

function renderAnswer(dialogId: string, result: AnswerResult): ToolText {
  if (result.outcome === "closed") {
    return { text: `Dialog ${dialogId} is no longer open: it was answered or closed, maybe by the person in pi-web. Call pi_wait to see what happened.` };
  }
  return { text: `Answered dialog ${dialogId}: ${result.shown}. If the person answered first, theirs counts. Call pi_wait to follow pi.` };
}

function renderStop(result: StopResult): ToolText {
  switch (result.kind) {
    case "send-pending":
      return { text: `Your message is still on its way to pi, so nothing was stopped. Call pi_stop again in a moment.\n${statusLine(result.status)}` };
    case "idle":
      return { text: `There was nothing to stop.\n${statusLine(result.status)}` };
    case "unwinding":
      return { text: "Stop was sent, but pi is still unwinding the run (a tool that ignores its abort signal). pi_wait shows when it ends." };
    case "stopped": {
      const lines = ["Stopped pi."];
      if (result.withdrawn.length > 0) {
        lines.push("Stop withdrew these queued messages. They were not sent, and they do not go back to the person's composer:");
        lines.push(...result.withdrawn.map((item) => `  - [${item.author}] ${oneLine(item.text, 500)}`));
      }
      lines.push(statusLine(result.status));
      return { text: lines.join("\n") };
    }
  }
}

function renderNewSession(result: NewSessionResult, call: CallContext): ToolText {
  const { session } = result;
  const lines = [
    `Started session ${session.id} in ${session.cwd}${session.branch ? ` (branch ${session.branch})` : ""}. Model ${result.model ?? "none"}, thinking ${result.thinkingLevel}.`,
    ...(result.untrusted ? ["This folder's project extensions stay off until the person trusts it in pi-web."] : []),
    `pi-web link for the person: ${call.linkBase}/${sessionDeepLink(session.id)}`,
  ];
  const send = renderSend(session.id, result.send);
  return { text: [...lines, send.text].join("\n"), isError: send.isError };
}

function renderWorktree(result: NewWorktreeResult): ToolText {
  switch (result.kind) {
    case "created":
      return { text: `Created worktree ${result.path} for branch ${result.branch}. An existing branch is checked out; a new one starts from the main checkout's HEAD (or an already-fetched origin/${result.branch}). Nothing was fetched. Start pi there with pi_new_session {"cwd":${JSON.stringify(result.path)}, …}.` };
    case "exists":
      return { text: `Branch ${result.branch} is already checked out at ${result.path}. Start pi there with pi_new_session {"cwd":${JSON.stringify(result.path)}, …}.` };
    case "held-by-missing":
      return { text: `Branch ${result.branch} belongs to a worktree whose folder is gone (${result.path}). git worktree prune clears it; pi-web never runs it for you.`, isError: true };
    case "creating":
      return { text: `git is still creating the worktree for ${result.branch}. Call pi_new_worktree again with the same arguments.` };
  }
}
