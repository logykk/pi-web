import { sessionDeepLink } from "../session-links";
import type { AgentMessage, ToolResultMessage } from "../types";
import type {
  AnswerResult, Dialog, NewSessionResult, NewWorktreeResult, ReadResult, SendResult, SessionHeading, SessionStatus, StopResult, WaitResult,
} from "./desk";
import type { ToolText } from "./jsonrpc";
import type { SessionRow } from "./ports";
import { isBusy } from "./rest";
import type { SentMessage } from "./session-ledger";
import { contentText, encodeCursor, type Author, type Cursor } from "./transcript";

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

export function callExample(tool: string, args: Readonly<Record<string, unknown>>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

function cursorLine(cursor: Cursor): string {
  return `cursor: ${encodeCursor(cursor)}`;
}

function sessionLink(linkBase: string, id: string): string {
  return `${linkBase}/${sessionDeepLink(id)}`;
}

function place(cwd: string, branch: string | null, isWorktree = false): string {
  return branch ? `${cwd} (${isWorktree ? "worktree, " : ""}branch ${branch})` : cwd;
}

export interface RenderBudget {
  readonly total: number;
  readonly userText: number;
  readonly assistantText: number;
  readonly lastAssistantText: number;
  readonly toolArgs: number;
  readonly toolResult: number;
}

export const BUDGETS: Readonly<Record<"report" | "read", RenderBudget>> = {
  report: { total: 12_000, userText: 2_000, assistantText: 3_000, lastAssistantText: 8_000, toolArgs: 160, toolResult: 160 },
  read: { total: 40_000, userText: 8_000, assistantText: 8_000, lastAssistantText: 16_000, toolArgs: 2_000, toolResult: 2_000 },
};

const FIRST_LINE_BUDGET = 400;

function summarize(text: string, max: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no output)";
  const lines = trimmed.split("\n");
  if (max > FIRST_LINE_BUDGET) return clip(trimmed, max).split("\n").join("\n      ");
  const first = clip(lines[0].trim(), max);
  return lines.length > 1 ? `${first} (+${lines.length - 1} lines)` : first;
}

function resultLine(result: ToolResultMessage | undefined, budget: RenderBudget, endsAtNewest: boolean): string {
  if (!result) return endsAtNewest ? "running" : "no result";
  return `${result.isError ? "error" : "ok"}: ${summarize(contentText(result.content), budget.toolResult)}`;
}

export function renderMessages(
  messages: readonly AgentMessage[],
  authors: readonly (Author | "by-role")[],
  budget: RenderBudget,
  options: { readonly endsAtNewest: boolean },
): string[] {
  const results = new Map<string, ToolResultMessage>();
  const calledHere = new Set<string>();
  let lastReply = -1;
  messages.forEach((message, index) => {
    if (message.role === "toolResult") results.set(message.toolCallId, message);
    if (message.role !== "assistant") return;
    lastReply = index;
    for (const block of message.content) if (block.type === "toolCall") calledHere.add(block.toolCallId);
  });

  const blocks: string[] = [];
  messages.forEach((message, index) => {
    const author = authors[index];
    switch (message.role) {
      case "user":
        blocks.push(`[${author}] ${clip(contentText(message.content).trim(), budget.userText)}`);
        return;
      case "assistant": {
        const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
        const flag = message.stopReason === "aborted" ? " (stopped)"
          : message.stopReason === "error" ? ` (error: ${oneLine(message.errorMessage ?? "unknown", 300)})`
          : "";
        const calls = message.content.filter((block) => block.type === "toolCall");
        const lines: string[] = [];
        if (text) lines.push(`[pi] ${clip(text, index === lastReply ? budget.lastAssistantText : budget.assistantText)}${flag}`);
        else lines.push(`[pi]${flag || (calls.length === 0 ? " (no text)" : "")}`);
        for (const call of calls) {
          lines.push(`  - ${call.toolName} ${clip(JSON.stringify(call.input ?? {}), budget.toolArgs)} -> ${resultLine(results.get(call.toolCallId), budget, options.endsAtNewest)}`);
        }
        blocks.push(lines.join("\n"));
        return;
      }
      case "toolResult":
        if (!calledHere.has(message.toolCallId)) {
          blocks.push(`  - result of ${message.toolName ?? "a tool"} -> ${resultLine(message, budget, options.endsAtNewest)}`);
        }
        return;
      case "bashExecution": {
        const outcome = message.cancelled ? "cancelled" : `exit ${message.exitCode ?? "?"}`;
        blocks.push(`[shell] $ ${clip(message.command, budget.toolArgs)} -> ${outcome}: ${summarize(message.output, budget.toolResult)}`);
        return;
      }
      case "custom": {
        const text = clip(contentText(message.content).trim(), budget.assistantText);
        blocks.push(author === "summary" ? `[summary] ${text}` : `[extension ${message.customType}] ${text}`);
        return;
      }
    }
  });

  let size = blocks.reduce((sum, block) => sum + block.length + 1, 0);
  let dropped = 0;
  while (size > budget.total && blocks.length - dropped > 1) {
    size -= blocks[dropped].length + 1;
    dropped += 1;
  }
  const kept = blocks.slice(dropped);
  if (kept.length === 1 && size > budget.total) kept[0] = clip(kept[0], budget.total);
  return dropped > 0 ? [`(${plural(dropped, "earlier message")} not shown here; pi_read shows them.)`, ...kept] : kept;
}

function headingLine(session: SessionHeading): string {
  const title = session.title ? ` "${oneLine(session.title, 80)}"` : "";
  return `Session ${session.id}${title} in ${place(session.cwd, session.branch)}.`;
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
    const call = (example: string | boolean, takes: string) =>
      `  Answer with ${callExample("pi_answer", { session: id, dialog: dialog.id, answer: example })} (answer takes ${takes}), or "cancel":true instead of answer.`;
    switch (dialog.kind) {
      case "choice":
        return [
          `An extension asks (a choice), dialog ${dialog.id}: ${dialog.title}`,
          `  ${dialog.options.map((option, index) => `${index + 1}. ${option}`).join("  ")}`,
          call(dialog.options[0] ?? "", "the option's text or its number"),
        ];
      case "confirm":
        return [`An extension asks (yes or no), dialog ${dialog.id}: ${dialog.title}`, `  ${oneLine(dialog.message, 500)}`, call(true, "true or false")];
      case "text":
        return [
          `An extension asks for ${dialog.multiline ? "a text" : "a line of text"}, dialog ${dialog.id}: ${dialog.title}`,
          ...(dialog.placeholder ? [`  (placeholder: ${dialog.placeholder})`] : []),
          ...(dialog.prefill ? [`  Prefilled with: ${oneLine(dialog.prefill, 500)}`] : []),
          call("…", "your text"),
        ];
      case "panel":
        return [`An extension shows a panel (dialog ${dialog.id}) that only the person can answer in pi-web:`, ...dialog.lines.slice(-20).map((line) => `  | ${line}`)];
    }
  });
}

export function renderSessionList({ rows, total }: { rows: readonly SessionRow[]; total: number }): ToolText {
  if (total === 0) return { text: "No pi sessions match." };
  const STATE: Readonly<Record<SessionRow["state"], string>> = { working: "working", waiting: "waiting for an answer", idle: "idle" };
  const lines = [total > rows.length ? `${total} sessions; the newest ${rows.length}:` : `${plural(total, "session")}, newest first:`];
  for (const row of rows) {
    lines.push(`- ${row.id} [${STATE[row.state]}] "${oneLine(row.title, 80)}" in ${place(row.cwd, row.branch, row.isWorktree)}, last active ${row.modified}`);
  }
  return { text: lines.join("\n") };
}

const READ_PAGE: Readonly<Record<ReadResult["kind"], { heading: string; empty: string }>> = {
  latest: { heading: "Latest messages:", empty: "No messages yet." },
  older: { heading: "Older messages:", empty: "No older messages." },
};

export function renderRead(result: ReadResult, linkBase: string): ToolText {
  const { session, status, page } = result;
  const lines = [headingLine(session), `pi-web link: ${sessionLink(linkBase, session.id)}`, statusLine(status)];
  if (page.messages.length === 0) lines.push(READ_PAGE[result.kind].empty);
  else lines.push(READ_PAGE[result.kind].heading, ...renderMessages(page.messages, page.authors, BUDGETS.read, { endsAtNewest: result.kind === "latest" }));
  if (page.hasMore && page.oldestEntryId) lines.push(`older: ${callExample("pi_read", { session: session.id, before: page.oldestEntryId })}`);
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

export function renderSend(id: string, result: SendResult): ToolText {
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
      return isBusy(status)
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

export function renderWait(id: string, result: WaitResult): ToolText {
  const { delta } = result;
  const lines = [waitHeadline(result), statusLine(result.status)];
  if (delta.messages.length > 0 || delta.kind !== "since") {
    lines.push(DELTA_HEADING[delta.kind]);
    if (delta.omitted > 0) lines.push(`(${plural(delta.omitted, "earlier entry", "earlier entries")} not shown; pi_read shows them.)`);
    lines.push(...renderMessages(delta.messages, delta.authors, BUDGETS.report, { endsAtNewest: true }));
  }
  lines.push(...result.news.map(newsLine), ...result.notices, ...dialogLines(id, result.status.dialogs), cursorLine(result.cursor));
  return { text: lines.join("\n") };
}

export function renderAnswer(dialogId: string, result: AnswerResult): ToolText {
  if (result.outcome === "closed") {
    return { text: `Dialog ${dialogId} is no longer open: it was answered or closed, maybe by the person in pi-web. Call pi_wait to see what happened.` };
  }
  return { text: `Answered dialog ${dialogId}: ${result.shown}. If the person answered first, theirs counts. Call pi_wait to follow pi.` };
}

export function renderStop(result: StopResult): ToolText {
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

export function renderNewSession(result: NewSessionResult, linkBase: string): ToolText {
  const { session } = result;
  const lines = [
    `Started session ${session.id} in ${place(session.cwd, session.branch)}. Model ${result.model ?? "none"}, thinking ${result.thinkingLevel}.`,
    ...(result.untrusted ? ["This folder's project extensions stay off until the person trusts it in pi-web."] : []),
    `pi-web link for the person: ${sessionLink(linkBase, session.id)}`,
  ];
  const send = renderSend(session.id, result.send);
  return { text: [...lines, send.text].join("\n"), isError: send.isError };
}

export function renderWorktree(result: NewWorktreeResult): ToolText {
  switch (result.kind) {
    case "created":
      return { text: `Created worktree ${result.path} for branch ${result.branch}. An existing branch is checked out; a new one starts from the main checkout's HEAD (or an already-fetched origin/${result.branch}). Nothing was fetched. Start pi there with ${callExample("pi_new_session", { cwd: result.path, message: "…" })}.` };
    case "exists":
      return { text: `Branch ${result.branch} is already checked out at ${result.path}. Start pi there with ${callExample("pi_new_session", { cwd: result.path, message: "…" })}.` };
    case "held-by-missing":
      return { text: `Branch ${result.branch} belongs to a worktree whose folder is gone (${result.path}). git worktree prune clears it; pi-web never runs it for you.`, isError: true };
    case "creating":
      return { text: `git is still creating the worktree for ${result.branch}. Call pi_new_worktree again with the same arguments.` };
  }
}
