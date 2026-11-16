import { createHash } from "node:crypto";
import type { AgentMessage, ToolResultMessage } from "../types";

export interface Cursor {
  readonly entryId: string | null;
  readonly dialogs: string;
  readonly at: number;
}

const ENTRY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^(0|[0-9a-f]{8})$/;
const BASE36 = /^[0-9a-z]{1,12}$/;

export function encodeCursor(cursor: Cursor): string {
  return `${cursor.entryId ?? "-"}~${cursor.dialogs}~${cursor.at.toString(36)}`;
}

export function decodeCursor(text: string): Cursor | null {
  const parts = text.trim().split("~");
  if (parts.length !== 3) return null;
  const [entryId, dialogs, at] = parts;
  if (entryId !== "-" && !ENTRY_ID.test(entryId)) return null;
  if (!DIGEST.test(dialogs) || !BASE36.test(at)) return null;
  return { entryId: entryId === "-" ? null : entryId, dialogs, at: parseInt(at, 36) };
}

export const NO_DIALOGS = "0";

export function dialogDigest(openDialogIds: readonly string[]): string {
  if (openDialogIds.length === 0) return NO_DIALOGS;
  return createHash("sha1").update([...openDialogIds].sort().join("\n")).digest("hex").slice(0, 8);
}

export interface EntryLike {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  readonly timestamp: string;
  readonly message?: { readonly role?: string; readonly content?: unknown };
}

export interface BranchReader {
  getLeafId(): string | null;
  getEntry(id: string): EntryLike | undefined;
}

export interface Delta {
  readonly kind: "since" | "moved" | "unknown";
  readonly leafId: string | null;
  readonly entries: readonly EntryLike[];
  readonly omitted: number;
}

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
    return { kind, leafId, entries, omitted: all.length - entries.length };
  };
  const toCursor = chainFrom(reader, leafId, (entry) => entry.id === cursorEntryId);
  if (cursorEntryId === null || toCursor.stop) return delta("since", toCursor.chain);
  if (!reader.getEntry(cursorEntryId)) return delta("unknown", toCursor.chain);
  const cursorAncestors = new Set(chainFrom(reader, cursorEntryId, () => false).chain.map((entry) => entry.id));
  return delta("moved", chainFrom(reader, leafId, (entry) => cursorAncestors.has(entry.id)).chain);
}

export type Author = "agent" | "person" | "user" | "pi" | "shell" | "extension" | "summary";

/** `userAuthor`: who wrote a user message, which only the ledger knows. */
export function authorOf(message: AgentMessage, entryType: string, userAuthor: () => Extract<Author, "agent" | "person" | "user">): Author {
  if (entryType === "branch_summary" || entryType === "compaction") return "summary";
  switch (message.role) {
    case "user":
      return userAuthor();
    case "assistant":
    case "toolResult":
      return "pi";
    case "bashExecution":
      return "shell";
    case "custom":
      return "extension";
  }
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : "")
    .filter(Boolean)
    .join("\n");
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
  return dropped > 0 ? [`(${dropped} earlier message${dropped === 1 ? "" : "s"} not shown here; pi_read shows them.)`, ...kept] : kept;
}
