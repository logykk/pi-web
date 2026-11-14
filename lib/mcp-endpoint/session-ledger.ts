// The one piece of server-side memory the endpoint keeps: the messages it sent into each pi
// session, and what became of them. Per pi session, not per agent (without MCP sessions there is
// no agent identity). Two readers:
//   - provenance: a user entry one of these landed as reads `[agent]` (transcript.ts);
//   - delivery news: a send pi refused after pi_send had replied, or a queued send that vanished
//     (Stop or Recall in pi-web moved it into the person's composer), is news to every cursor
//     older than it.
// Every write is monotonic (an outcome settles once; landed and missing are set once), so any
// number of concurrent waits may reconcile the same records. On globalThis, as all shared pi-web
// state; lost on restart, which is why user entries older than `since` read `[user]`.

export type Delivery = "followUp" | "steer";

export type SendOutcome =
  | { readonly state: "sending" }
  /** pi took it. started/queued is a guess from isRunning() at send time, for the reply only. */
  | { readonly state: "accepted"; readonly disposition: "started" | "queued"; readonly at: number }
  /** pi-web parked it behind a running compaction; it goes out when compaction ends. */
  | { readonly state: "parked"; readonly at: number }
  | { readonly state: "refused"; readonly reason: string; readonly at: number };

export interface SentMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: Delivery;
  readonly sentAt: number;
  readonly outcome: SendOutcome;
  /** pi_send replied while the outcome was still "sending": the outcome is news for later waits. */
  readonly repliedWhileSending: boolean;
  /** The user entry it landed as. */
  readonly landedEntryId: string | null;
  /** When a reconcile first found it accepted, unlanded, out of pi's queue, with pi at rest. */
  readonly missingSince: number | null;
}

export interface Ledger {
  /** When this ledger began: user entries older than it have unknown authors. */
  readonly since: number;
  record(sessionId: string, text: string, delivery: Delivery): SentMessage;
  settle(sendId: string, outcome: Exclude<SendOutcome, { state: "sending" }>): void;
  markRepliedWhileSending(sendId: string): void;
  markLanded(sendId: string, entryId: string): void;
  markMissing(sendId: string, at: number): void;
  get(sendId: string): SentMessage | undefined;
  forSession(sessionId: string): readonly SentMessage[];
}

const MAX_PER_SESSION = 200;
const MAX_AGE_MS = 24 * 60 * 60_000;
/** A send younger than this is not missing yet: pi may still be writing its entry. */
const MISSING_AFTER_MS = 2_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function createLedger(now: () => number = Date.now): Ledger {
  const since = now();
  const bySession = new Map<string, Mutable<SentMessage>[]>();
  const byId = new Map<string, Mutable<SentMessage>>();
  let counter = 0;

  const prune = (sessionId: string) => {
    const records = bySession.get(sessionId) ?? [];
    const cutoff = now() - MAX_AGE_MS;
    const keep = records.filter((record) => record.sentAt >= cutoff).slice(-MAX_PER_SESSION);
    for (const record of records) if (!keep.includes(record)) byId.delete(record.id);
    bySession.set(sessionId, keep);
  };

  return {
    since,
    record(sessionId, text, delivery) {
      counter += 1;
      const record: Mutable<SentMessage> = {
        id: `send-${since.toString(36)}-${counter}`,
        sessionId,
        text,
        delivery,
        sentAt: now(),
        outcome: { state: "sending" },
        repliedWhileSending: false,
        landedEntryId: null,
        missingSince: null,
      };
      bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), record]);
      byId.set(record.id, record);
      prune(sessionId);
      return { ...record };
    },
    settle(sendId, outcome) {
      const record = byId.get(sendId);
      if (record?.outcome.state === "sending") record.outcome = outcome;
    },
    markRepliedWhileSending(sendId) {
      const record = byId.get(sendId);
      if (record?.outcome.state === "sending") record.repliedWhileSending = true;
    },
    markLanded(sendId, entryId) {
      const record = byId.get(sendId);
      if (record && record.landedEntryId === null) record.landedEntryId = entryId;
    },
    markMissing(sendId, at) {
      const record = byId.get(sendId);
      if (record && record.landedEntryId === null && record.missingSince === null) record.missingSince = at;
    },
    get(sendId) {
      const record = byId.get(sendId);
      return record ? { ...record } : undefined;
    },
    forSession(sessionId) {
      return (bySession.get(sessionId) ?? []).map((record) => ({ ...record }));
    },
  };
}

const LEDGER = Symbol.for("pi-web.mcp-endpoint.ledger");

/** The process-wide ledger: dev hot reload and every route bundle share it. */
export function ledger(): Ledger {
  const store = globalThis as unknown as Record<symbol, Ledger | undefined>;
  return store[LEDGER] ??= createLedger();
}

export function sendsInFlight(sends: readonly SentMessage[]): number {
  return sends.filter((send) => send.outcome.state === "sending").length;
}

/**
 * The agent's sends with news for a cursor composed at `cursorAt`: refused after pi_send had
 * replied, or gone missing. Pure: repeating a wait with the same cursor repeats the same news.
 */
export function deliveryNews(sends: readonly SentMessage[], cursorAt: number): SentMessage[] {
  return sends.filter((send) =>
    (send.repliedWhileSending && send.outcome.state === "refused" && send.outcome.at > cursorAt)
    || (send.missingSince !== null && send.missingSince > cursorAt));
}

/**
 * Fates to record after an observation. Landed: the matched landings of unlanded sends. Missing
 * needs all of: accepted (not parked, not refused), not landed, its text not in pi's queue, pi at
 * rest, older than 2 s, and not a `/command` (an extension command may run without a user entry).
 */
export function reconcileFates(
  sends: readonly SentMessage[],
  observed: {
    readonly landings: readonly { readonly sendId: string; readonly entryId: string }[];
    readonly queuedTexts: readonly string[];
    readonly atRest: boolean;
    readonly now: number;
  },
): { landed: { sendId: string; entryId: string }[]; missing: string[] } {
  const unlanded = new Set(sends.filter((send) => send.landedEntryId === null).map((send) => send.id));
  const landed = observed.landings.filter((landing) => unlanded.has(landing.sendId));
  const landedNow = new Set(landed.map((landing) => landing.sendId));
  const queued = new Set(observed.queuedTexts.map((text) => text.trim()));
  const missing = !observed.atRest ? [] : sends
    .filter((send) => send.outcome.state === "accepted"
      && send.landedEntryId === null
      && !landedNow.has(send.id)
      && send.missingSince === null
      && !send.text.trim().startsWith("/")
      && !queued.has(send.text.trim())
      && observed.now - send.sentAt > MISSING_AFTER_MS)
    .map((send) => send.id);
  return { landed, missing };
}
