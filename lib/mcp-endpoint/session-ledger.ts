export type Delivery = "followUp" | "steer";

export type SendOutcome =
  | { readonly state: "sending" }
  | { readonly state: "accepted"; readonly disposition: "started" | "queued"; readonly at: number }
  | { readonly state: "parked"; readonly at: number }
  | { readonly state: "refused"; readonly reason: string; readonly at: number };

/** Where a send stands in the transcript; it leaves `open` once, to a user entry or to nowhere. */
export type Placement =
  | { readonly kind: "open" }
  | { readonly kind: "landed"; readonly entryId: string }
  | { readonly kind: "missing"; readonly since: number };

export interface SentMessage {
  readonly id: string;
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: Delivery;
  readonly sentAt: number;
  readonly outcome: SendOutcome;
  readonly repliedWhileSending: boolean;
  readonly placement: Placement;
}

export interface UserEntry {
  readonly entryId: string;
  readonly text: string;
  readonly time: number;
}

export interface Ledger {
  record(sessionId: string, text: string, delivery: Delivery): SentMessage;
  settle(sendId: string, outcome: Exclude<SendOutcome, { state: "sending" }>): void;
  /** pi_send replied now; a send still on its way is remembered as such. Returns the send as replied. */
  markReplied(sendId: string): SentMessage;
  /**
   * Lands open sends on the session's user entries. `queued`: pi's queue while pi is at rest,
   * null while it works or when the caller cannot tell; with it, an accepted send that is neither
   * landed nor queued goes missing.
   */
  observe(sessionId: string, observed: { readonly userEntries: readonly UserEntry[]; readonly queued: readonly string[] | null; readonly now: number }): void;
  /** Texts pi withdrew from its queue: each is the agent's when an open send of that text matches, which goes missing. */
  withdraw(sessionId: string, texts: readonly string[], now: number): ("agent" | "person")[];
  /** Who wrote a user entry: a send landed there, or anyone after (person) or before (user) the ledger began. */
  authorOf(sessionId: string, entry: { readonly id: string; readonly time: number }): "agent" | "person" | "user";
  /** Late refusals and missing sends after `at`, for every cursor older than the event. */
  news(sessionId: string, at: number): SentMessage[];
  inFlight(sessionId: string): number;
}

const MAX_PER_SESSION = 200;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MISSING_AFTER_MS = 2_000;
const LANDING_SKEW_MS = 2_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isOpen(send: SentMessage): boolean {
  return send.placement.kind === "open" && send.outcome.state !== "refused";
}

function land(open: readonly Mutable<SentMessage>[], userEntries: readonly UserEntry[]): void {
  const used = new Set<string>();
  const entries = [...userEntries].sort((a, b) => a.time - b.time);
  for (const send of [...open].sort((a, b) => a.sentAt - b.sentAt)) {
    const text = send.text.trim();
    const entry = entries.find((candidate) => !used.has(candidate.entryId)
      && candidate.time >= send.sentAt - LANDING_SKEW_MS
      && candidate.text.trim() === text);
    if (!entry) continue;
    used.add(entry.entryId);
    send.placement = { kind: "landed", entryId: entry.entryId };
  }
}

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
  const sendsOf = (sessionId: string) => bySession.get(sessionId) ?? [];

  return {
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
        placement: { kind: "open" },
      };
      bySession.set(sessionId, [...sendsOf(sessionId), record]);
      byId.set(record.id, record);
      prune(sessionId);
      return { ...record };
    },
    settle(sendId, outcome) {
      const record = byId.get(sendId);
      if (record?.outcome.state === "sending") record.outcome = outcome;
    },
    markReplied(sendId) {
      const record = byId.get(sendId);
      if (!record) throw new Error(`The ledger has no send ${sendId}`);
      if (record.outcome.state === "sending") record.repliedWhileSending = true;
      return { ...record };
    },
    observe(sessionId, { userEntries, queued, now: at }) {
      const sends = sendsOf(sessionId);
      const open = sends.filter(isOpen);
      if (open.length === 0) return;
      const taken = new Set(sends.flatMap((send) => send.placement.kind === "landed" ? [send.placement.entryId] : []));
      land(open, userEntries.filter((entry) => !taken.has(entry.entryId)));
      if (queued === null) return;
      const waiting = new Set(queued.map((text) => text.trim()));
      for (const send of open) {
        if (send.placement.kind !== "open" || send.outcome.state !== "accepted") continue;
        const text = send.text.trim();
        // An extension command may run without a user entry.
        if (text.startsWith("/") || waiting.has(text) || at - send.sentAt <= MISSING_AFTER_MS) continue;
        send.placement = { kind: "missing", since: at };
      }
    },
    withdraw(sessionId, texts, at) {
      const open = sendsOf(sessionId).filter((send) => isOpen(send) && send.outcome.state === "accepted");
      return texts.map((text) => {
        const index = open.findIndex((send) => send.text.trim() === text.trim());
        if (index === -1) return "person";
        open.splice(index, 1)[0].placement = { kind: "missing", since: at };
        return "agent";
      });
    },
    authorOf(sessionId, entry) {
      if (sendsOf(sessionId).some((send) => send.placement.kind === "landed" && send.placement.entryId === entry.id)) return "agent";
      return entry.time >= since ? "person" : "user";
    },
    news(sessionId, at) {
      return sendsOf(sessionId)
        .filter((send) => (send.repliedWhileSending && send.outcome.state === "refused" && send.outcome.at > at)
          || (send.placement.kind === "missing" && send.placement.since > at))
        .map((send) => ({ ...send }));
    },
    inFlight(sessionId) {
      return sendsOf(sessionId).filter((send) => send.outcome.state === "sending").length;
    },
  };
}

const LEDGER = Symbol.for("pi-web.mcp-endpoint.ledger");

/** The process-wide ledger: dev hot reload and every route bundle share it. */
export function ledger(): Ledger {
  const store = globalThis as unknown as Record<symbol, Ledger | undefined>;
  return store[LEDGER] ??= createLedger();
}
