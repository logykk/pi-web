import { createHash } from "node:crypto";
import type { AgentMessage } from "../types";

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

/** Who wrote a user message, or a summary entry. Any other message's role says who wrote it. */
export type Author = "agent" | "person" | "user" | "summary";

/** `userAuthor`: who wrote a user message, which only the ledger knows. Null where the role says who. */
export function authorOf(message: AgentMessage, entryType: string, userAuthor: () => Exclude<Author, "summary">): Author | null {
  if (entryType === "branch_summary" || entryType === "compaction") return "summary";
  return message.role === "user" ? userAuthor() : null;
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: { type?: string; text?: string }) => block?.type === "text" ? block.text ?? "" : block?.type === "image" ? "[image]" : "")
    .filter(Boolean)
    .join("\n");
}
