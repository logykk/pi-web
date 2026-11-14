export type Delivery = "followUp" | "steer";

export type SendOutcome =
  | { readonly state: "sending" }
  | { readonly state: "accepted"; readonly disposition: "started" | "queued"; readonly at: number }
  | { readonly state: "parked"; readonly at: number }
  | { readonly state: "refused"; readonly reason: string; readonly at: number };

export interface SentMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: Delivery;
  readonly sentAt: number;
  readonly outcome: SendOutcome;
  readonly repliedWhileSending: boolean;
  readonly landedEntryId: string | null;
  readonly missingSince: number | null;
}

export interface Ledger {
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

export function deliveryNews(sends: readonly SentMessage[], cursorAt: number): SentMessage[] {
  return sends.filter((send) =>
    (send.repliedWhileSending && send.outcome.state === "refused" && send.outcome.at > cursorAt)
    || (send.missingSince !== null && send.missingSince > cursorAt));
}

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
      // An extension command may run without a user entry.
      && !send.text.trim().startsWith("/")
      && !queued.has(send.text.trim())
      && observed.now - send.sentAt > MISSING_AFTER_MS)
    .map((send) => send.id);
  return { landed, missing };
}
