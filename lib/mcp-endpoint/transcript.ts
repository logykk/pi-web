// The read side of co-driving, as pure functions: the cursor an agent carries from reply to
// reply, what is new on the session's current branch since it, who wrote each user message, and
// the text the agent reads.
//
// The cursor is the agent's whole read state. The server keeps none per agent, so a reply lost
// to a dropped connection or a 524 costs nothing: the agent repeats the call with the same cursor
// and gets the same news. Entry ids live in the session file, so a cursor also survives pi-web
// restarts and wrapper replacement.

import { createHash } from "node:crypto";
import type { AgentMessage, ToolResultMessage } from "../types";

export interface Cursor {
  /** The leaf of the branch when the reply was composed; null when the session had no entries. */
  readonly entryId: string | null;
  /** dialogDigest() of the blocking dialogs the reply showed ("0": none). */
  readonly dialogs: string;
  /** Server clock (ms) when the reply was composed: delivery news after it is new to this cursor. */
  readonly at: number;
}

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^(0|[0-9a-f]{8})$/;
const BASE36 = /^[0-9a-z]{1,12}$/;

/** `<entryId|->~<digest>~<at base36>`, e.g. `5e1d77a0~0~mhz3k2q1`. Opaque to the agent. */
export function encodeCursor(cursor: Cursor): string {
  return `${cursor.entryId ?? "-"}~${cursor.dialogs}~${cursor.at.toString(36)}`;
}

/** Null for anything encodeCursor() did not produce. */
export function decodeCursor(text: string): Cursor | null {
  const parts = text.trim().split("~");
  if (parts.length !== 3) return null;
  const [entryId, dialogs, at] = parts;
  if (entryId !== "-" && !ENTRY_ID.test(entryId)) return null;
  if (!DIGEST.test(dialogs) || !BASE36.test(at)) return null;
  return { entryId: entryId === "-" ? null : entryId, dialogs, at: parseInt(at, 36) };
}

/** "0" for none; else the first 8 hex of sha1 over the sorted ids. Order-independent. */
export function dialogDigest(openDialogIds: readonly string[]): string {
  if (openDialogIds.length === 0) return "0";
  return createHash("sha1").update([...openDialogIds].sort().join("\n")).digest("hex").slice(0, 8);
}

/** The fields of a pi session entry this module reads (the SDK's SessionEntry is structurally one). */
export interface EntryLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly timestamp: string;
  readonly message?: { readonly role?: string; readonly timestamp?: number };
  readonly display?: boolean;
  readonly summary?: string;
}

/** SessionManager's O(1) reads: the live wrapper's in-memory one, or the cached file one. */
export interface BranchReader {
  getLeafId(): string | null;
  getEntry(id: string): EntryLike | undefined;
}

/**
 * The current branch after a cursor, oldest first, capped to the newest `maxEntries`.
 *  since:   the cursor's entry is on the branch (or null: the whole branch is new).
 *  moved:   the cursor's entry is on another branch ("Edit from here" or a branch switch in
 *           pi-web); entries run from the fork point, the deepest common ancestor.
 *  unknown: the cursor's entry is not in this session; entries are the newest ones.
 * `visible` counts the new entries that render; `omitted` counts the ones the cap cut.
 */
export interface Delta {
  readonly kind: "since" | "moved" | "unknown";
  readonly leafId: string | null;
  readonly entries: readonly EntryLike[];
  readonly visible: number;
  readonly omitted: number;
}

/** What the chat renders: messages other than transcript system messages, compactions, branch summaries, shown custom messages. */
export function isVisibleEntry(entry: EntryLike): boolean {
  switch (entry.type) {
    case "message":
      return entry.message?.role !== "system";
    case "compaction":
      return true;
    case "branch_summary":
      return Boolean(entry.summary);
    case "custom_message":
      return entry.display === true;
    default:
      return false;
  }
}

/** Iterative: a linear session's chain is as long as the session. */
function chainFrom(reader: BranchReader, id: string | null, stopAt: (entry: EntryLike) => boolean): { chain: EntryLike[]; stop: EntryLike | null } {
  const chain: EntryLike[] = [];
  for (let entry = id ? reader.getEntry(id) : undefined; entry; entry = entry.parentId ? reader.getEntry(entry.parentId) : undefined) {
    if (stopAt(entry)) return { chain, stop: entry };
    chain.push(entry);
  }
  return { chain, stop: null };
}

export function branchSince(reader: BranchReader, cursorEntryId: string | null, maxEntries: number): Delta {
  const leafId = reader.getLeafId();
  const delta = (kind: Delta["kind"], newestFirst: EntryLike[]): Delta => {
    const all = newestFirst.reverse();
    const entries = all.slice(Math.max(0, all.length - maxEntries));
    return { kind, leafId, entries, visible: all.filter(isVisibleEntry).length, omitted: all.length - entries.length };
  };
  const toCursor = chainFrom(reader, leafId, (entry) => entry.id === cursorEntryId);
  if (cursorEntryId === null || toCursor.stop) return delta("since", toCursor.chain);
  if (!reader.getEntry(cursorEntryId)) return delta("unknown", toCursor.chain);
  const cursorAncestors = new Set(chainFrom(reader, cursorEntryId, () => false).chain.map((entry) => entry.id));
  return delta("moved", chainFrom(reader, leafId, (entry) => cursorAncestors.has(entry.id)).chain);
}

/**
 * Who wrote a rendered message. pi records no author, so a user message is:
 *  agent:  sent through this endpoint (the ledger recorded it and it landed as this entry);
 *  person: not sent through it, and newer than the ledger (pi-web's web UI or the pi CLI);
 *  user:   older than this process's ledger, so unknown.
 */
export type Author = "agent" | "person" | "user" | "pi" | "shell" | "extension" | "summary";

export function authorOf(
  message: AgentMessage,
  entry: { readonly id: string; readonly type: string; readonly time: number },
  landedEntryIds: ReadonlySet<string>,
  ledgerSince: number,
): Author {
  if (entry.type === "branch_summary" || entry.type === "compaction") return "summary";
  switch (message.role) {
    case "user":
      return landedEntryIds.has(entry.id) ? "agent" : entry.time >= ledgerSince ? "person" : "user";
    case "assistant":
    case "toolResult":
      return "pi";
    case "bashExecution":
      return "shell";
    case "custom":
      return "extension";
  }
}

/** The plain text of message content: a string, or its text blocks (images as "[image]"). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : "")
    .filter(Boolean)
    .join("\n");
}

/** How far a user entry may predate the send it landed for (clock skew between the two writers). */
const LANDING_SKEW_MS = 2_000;

/**
 * Pairs the agent's unlanded sends with user entries, oldest first, each at most once: same
 * trimmed text, entry time >= sentAt - 2 s. Known miss: a `/command` pi expands lands with other
 * text and stays unlanded (and reads as the person's).
 */
export function matchLandings(
  sends: readonly { readonly id: string; readonly text: string; readonly sentAt: number }[],
  userEntries: readonly { readonly entryId: string; readonly text: string; readonly time: number }[],
): { sendId: string; entryId: string }[] {
  const used = new Set<string>();
  const landings: { sendId: string; entryId: string }[] = [];
  const entries = [...userEntries].sort((a, b) => a.time - b.time);
  for (const send of [...sends].sort((a, b) => a.sentAt - b.sentAt)) {
    const text = send.text.trim();
    const entry = entries.find((candidate) => !used.has(candidate.entryId)
      && candidate.time >= send.sentAt - LANDING_SKEW_MS
      && candidate.text.trim() === text);
    if (!entry) continue;
    used.add(entry.entryId);
    landings.push({ sendId: send.id, entryId: entry.entryId });
  }
  return landings;
}

export interface RenderBudget {
  readonly total: number;
  readonly userText: number;
  readonly assistantText: number;
  readonly lastAssistantText: number;
  readonly toolArgs: number;
  readonly toolResult: number;
}

/** report: pi_wait / pi_send replies; read: pi_read, with longer tool output. */
export const BUDGETS: Readonly<Record<"report" | "read", RenderBudget>> = {
  report: { total: 12_000, userText: 2_000, assistantText: 3_000, lastAssistantText: 8_000, toolArgs: 160, toolResult: 160 },
  read: { total: 40_000, userText: 8_000, assistantText: 8_000, lastAssistantText: 16_000, toolArgs: 2_000, toolResult: 2_000 },
};

/** Results up to this budget show their first line; longer budgets show the text itself. */
const FIRST_LINE_BUDGET = 400;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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

/**
 * One block per message, prefixed `[agent]`, `[person]`, `[user]`, `[pi]`, `[shell]`,
 * `[extension <type>]` or `[summary]`. Tool calls are indented under their reply with their
 * result ("running" when `endsAtNewest` and none came yet); thinking is left out. `(stopped)` and
 * `(error: …)` flag aborted and failed replies. Past `total`, the oldest blocks go and the first
 * line says how many.
 */
export function renderMessages(
  messages: readonly AgentMessage[],
  authors: readonly Author[],
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
          : message.stopReason === "error" ? ` (error: ${clip((message.errorMessage ?? "unknown").replace(/\s+/g, " "), 300)})`
          : "";
        const calls = message.content.filter((block) => block.type === "toolCall");
        const lines: string[] = [];
        if (text) lines.push(`[pi] ${clip(text, index === lastReply ? budget.lastAssistantText : budget.assistantText)}${flag}`);
        else if (flag || calls.length === 0) lines.push(`[pi]${flag || " (no text)"}`);
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
  return dropped > 0 ? [`(${dropped} earlier message${dropped === 1 ? "" : "s"} not shown here; pi_read shows them.)`, ...kept] : kept;
}
