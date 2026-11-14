// What an agent can do in pi sessions, in co-driving terms, behind one small object. Every
// operation returns within a bound and returns domain results; tools.ts turns them into text.
// Written against ports.ts and the ledger only, so the wait loop, wrapper replacement and
// delivery bookkeeping are tested with fakes.
//
// Invariants:
//  - Every prompt carries streamingBehavior (LiveSession.prompt cannot send without one): one
//    request shape for an idle and a busy session, so the agent never gets "Agent is already
//    processing".
//  - Reads never start a wrapper (pi_read, pi_wait, pi_sessions).
//  - The agent's read position lives only in its cursor. Nothing here advances on its behalf.
//  - Engaging a session (send, wait, answer, stop, create) holds it (ports.hold).

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ToolPreset } from "../tool-presets";
import type { AgentMessage, ExtensionUiRequest, ExtensionUiResponse } from "../types";
import type { LiveSession, PiEvent, PiWebPorts, SessionRow, TranscriptSource, WorktreeOutcome } from "./ports";
import { recheckIn, stepRest, type RestPhase, type RestReason } from "./rest";
import { deliveryNews, reconcileFates, sendsInFlight, type Delivery, type Ledger, type SentMessage } from "./session-ledger";
import { authorOf, branchSince, contentText, dialogDigest, matchLandings, type Author, type Cursor, type Delta, type EntryLike } from "./transcript";

/** Longest wait a call may ask for: the generic MCP SDK client gives up at 60 s, nginx too, Cloudflare at 100 s. */
export const WAIT_MAX_MS = 50_000;
export const WAIT_DEFAULT_MS = 45_000;
/** How long pi_send waits for pi to take a message (cold start, extension binding, MCP servers). */
export const SEND_ACCEPT_MS = 15_000;
/** How long pi_new_session waits for the session to be built, before its first send. */
export const CREATE_MS = 35_000;
/** How long pi_new_worktree waits for git before answering "still checking out". */
export const WORKTREE_MS = 45_000;
/** How long pi_stop waits for the run to unwind (a tool that ignores its abort signal can hold it). */
export const STOP_MS = 20_000;
/** How long pi_stop lets the agent's own send on its way land first: aborting before it lands hits nothing, and the prompt would run. */
export const STOP_SEND_GRACE_MS = 5_000;
/** Most entries one wait reports; past it the reply says how many it left to pi_read. */
export const MAX_DELTA_ENTRIES = 400;

export type SessionId = string & { readonly __brand: "SessionId" };

/** pi-web's session ids, as its session reader accepts them. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** A session id, or a pi-web link holding `?session=<id>`. */
export function parseSessionRef(input: string): SessionId | null {
  const text = input.trim();
  let id = text;
  if (text.includes("session=")) {
    try {
      id = new URL(text, "http://pi-web.invalid").searchParams.get("session") ?? "";
    } catch {
      return null;
    }
  }
  return id.length <= 200 && SESSION_ID.test(id) ? id as SessionId : null;
}

/** A blocking extension dialog, as the agent can answer it (a panel only the person can). */
export type Dialog =
  | { readonly id: string; readonly kind: "choice"; readonly title: string; readonly options: readonly string[] }
  | { readonly id: string; readonly kind: "confirm"; readonly title: string; readonly message: string }
  | { readonly id: string; readonly kind: "text"; readonly title: string; readonly multiline: boolean; readonly placeholder?: string; readonly prefill?: string }
  | { readonly id: string; readonly kind: "panel"; readonly lines: readonly string[] };

export interface SessionStatus {
  /** A live wrapper exists. False: idle and not loaded (nothing can be running). */
  readonly loaded: boolean;
  readonly running: boolean;
  readonly subagentsActive: boolean;
  readonly sendsInFlight: number;
  readonly dialogs: readonly Dialog[];
  readonly queued: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  /** The newest running tool and how long it has run, e.g. "bash `npm test` for 31 s". */
  readonly activity: string | null;
}

export interface SessionHeading {
  readonly id: SessionId;
  readonly title: string | null;
  readonly cwd: string;
  readonly branch: string | null;
}

/** Messages with their authors, ready for renderMessages(). */
export interface LabeledMessages {
  readonly messages: readonly AgentMessage[];
  readonly authors: readonly Author[];
}

export interface ReadResult {
  readonly session: SessionHeading;
  readonly status: SessionStatus;
  readonly page: LabeledMessages & { readonly hasMore: boolean; readonly oldestEntryId: string | null };
  /** Null for a `before` page: the agent keeps the cursor it has. */
  readonly cursor: Cursor | null;
}

export interface SendResult {
  readonly send: SentMessage;
  readonly status: SessionStatus;
  /** The caller's cursor, or the leaf before this message: the next wait shows it landing. */
  readonly cursor: Cursor;
}

export interface WaitResult {
  readonly reason: RestReason | "now";
  readonly waitedMs: number;
  readonly status: SessionStatus;
  readonly delta: Pick<Delta, "kind" | "omitted"> & LabeledMessages;
  /** The agent's sends with news since the cursor (late refusal, withdrawn by Stop or Recall). */
  readonly news: readonly SentMessage[];
  /** prompt_error / extension_error texts seen during this wait. */
  readonly notices: readonly string[];
  readonly cursor: Cursor;
}

export type DialogAnswer = { readonly cancel: true } | { readonly value: string | number | boolean };

export type AnswerResult =
  /** Delivered while open (the person may still have answered first). */
  | { readonly outcome: "sent"; readonly dialog: Dialog; readonly shown: string }
  /** Already answered or closed. */
  | { readonly outcome: "closed" };

export interface StopResult {
  readonly stopped: boolean;
  /** Stop was sent, but the run had not unwound within STOP_MS. */
  readonly unwinding: boolean;
  /** Our own send was still on its way after STOP_SEND_GRACE_MS, so nothing was stopped. */
  readonly sendPending: boolean;
  /** What Stop withdrew from pi's queue. It goes to the agent, not back to the person's composer. */
  readonly withdrawn: readonly { readonly text: string; readonly author: "agent" | "person" }[];
  readonly status: SessionStatus;
}

export interface NewSessionResult {
  readonly session: SessionHeading;
  readonly model: string | null;
  readonly thinkingLevel: string;
  readonly untrusted: boolean;
  readonly send: SendResult;
}

export type NewWorktreeResult = WorktreeOutcome | { readonly kind: "creating"; readonly branch: string };

export class DeskError extends Error {
  constructor(readonly kind: "not-found" | "bad-input" | "unavailable", message: string) {
    super(message);
  }
}

export interface Clock {
  now(): number;
}

export interface NewSessionRequest {
  readonly cwd: string;
  readonly message: string;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly tools: ToolPreset;
}

export interface Desk {
  sessions(filter: { cwd?: string; limit: number }): Promise<{ rows: SessionRow[]; total: number }>;
  read(id: SessionId, page: { messages: number; before?: string }): Promise<ReadResult>;
  send(id: SessionId, text: string, options: { steer: boolean; cursor: Cursor | null }, signal: AbortSignal): Promise<SendResult>;
  wait(id: SessionId, cursor: Cursor, timeoutMs: number, signal: AbortSignal): Promise<WaitResult>;
  answer(id: SessionId, dialogId: string, answer: DialogAnswer): Promise<AnswerResult>;
  stop(id: SessionId): Promise<StopResult>;
  newSession(request: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResult>;
  newWorktree(request: { project: string; branch: string }, signal: AbortSignal): Promise<NewWorktreeResult>;
}

const NEVER = new AbortController().signal;

function notFound(id: string): DeskError {
  return new DeskError("not-found", `No pi session ${id}. pi_sessions lists the sessions.`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryTime(entry: EntryLike | undefined): number {
  const time = entry ? Date.parse(entry.timestamp) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

export function createDesk(ports: PiWebPorts, ledger: Ledger, clock: Clock = Date): Desk {
  function statusOf(id: string, watch: SessionWatch, live: LiveSession | null): SessionStatus {
    return {
      loaded: live !== null,
      running: live?.isRunning() ?? false,
      subagentsActive: ports.subagentsActive(id),
      sendsInFlight: sendsInFlight(ledger.forSession(id)),
      dialogs: watch.openDialogs(),
      queued: live?.queued() ?? { steering: [], followUp: [] },
      activity: watch.activity(clock.now()),
    };
  }

  /** A watch attached and closed at once: the replay alone gives the open dialogs and running tools. */
  function snapshotStatus(id: string): SessionStatus {
    const watch = new SessionWatch(ports, id, clock);
    try {
      return statusOf(id, watch, watch.live());
    } finally {
      watch.close();
    }
  }

  async function source(id: string, live: LiveSession | null): Promise<TranscriptSource> {
    const found = live?.transcript() ?? await ports.saved(id);
    if (!found) throw notFound(id);
    return found;
  }

  /**
   * Lands the agent's sends on user entries (over all entries since the oldest unlanded send, not
   * just a delta: the agent's cursor may be past the landing), and with an observation of pi at
   * rest, records the accepted ones that left pi's queue without landing. Writes are monotonic.
   */
  function reconcile(id: string, transcript: TranscriptSource, observed: { status: SessionStatus; now: number } | null): void {
    const sends = ledger.forSession(id);
    // A send already found missing is not matched any more: a later entry with its text is the person's.
    const unlanded = sends.filter((send) => send.landedEntryId === null && send.missingSince === null && send.outcome.state !== "refused");
    if (unlanded.length === 0) return;
    const landedIds = new Set(sends.map((send) => send.landedEntryId));
    const from = Math.min(...unlanded.map((send) => send.sentAt)) - 2_000;
    const userEntries = transcript.getEntries()
      .filter((entry) => entry.type === "message" && entry.message?.role === "user" && !landedIds.has(entry.id) && entryTime(entry) >= from)
      .map((entry) => ({ entryId: entry.id, text: contentText(entry.message?.content), time: entryTime(entry) }));
    const fates = reconcileFates(sends, {
      landings: matchLandings(unlanded, userEntries),
      queuedTexts: observed ? [...observed.status.queued.steering, ...observed.status.queued.followUp] : [],
      atRest: observed !== null && !observed.status.running,
      now: observed?.now ?? clock.now(),
    });
    for (const landing of fates.landed) ledger.markLanded(landing.sendId, landing.entryId);
    for (const sendId of fates.missing) ledger.markMissing(sendId, observed?.now ?? clock.now());
  }

  function label(id: string, transcript: TranscriptSource, converted: { messages: AgentMessage[]; entryIds: string[] }): LabeledMessages {
    reconcile(id, transcript, null);
    const landed = new Set(ledger.forSession(id).map((send) => send.landedEntryId).filter((entryId) => entryId !== null));
    const authors = converted.messages.map((message, index) => {
      const entry = transcript.getEntry(converted.entryIds[index]);
      return authorOf(message, { id: converted.entryIds[index], type: entry?.type ?? "message", time: entryTime(entry) }, landed, ledger.since);
    });
    return { messages: converted.messages, authors };
  }

  async function heading(id: SessionId, transcript: TranscriptSource): Promise<SessionHeading> {
    const cwd = transcript.getCwd();
    const firstUser = transcript.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "user");
    const title = transcript.getSessionName()?.trim() || contentText(firstUser?.message?.content).trim() || null;
    const project = await ports.project(cwd).catch(() => ({ branch: null }));
    return { id, title, cwd, branch: project.branch };
  }

  /** The one path pi_send and pi_new_session share. */
  async function deliver(id: string, text: string, delivery: Delivery, cursor: Cursor, signal: AbortSignal): Promise<SendResult> {
    const record = ledger.record(id, text, delivery);
    const outcome = (async () => {
      const session = await ports.open(id);
      if (!session) throw new Error("the session is gone");
      const wasRunning = session.isRunning();
      const { parked } = await session.prompt(text, delivery);
      return parked
        ? { state: "parked" as const, at: clock.now() }
        : { state: "accepted" as const, disposition: wasRunning ? "queued" as const : "started" as const, at: clock.now() };
    })();
    // Not tied to `signal`: once handed to pi-web the message is pi's. A cancelled call can
    // still deliver, and the next wait shows it land (or its refusal as news).
    const settled = outcome.then(
      (accepted) => ledger.settle(record.id, accepted),
      (error: unknown) => ledger.settle(record.id, { state: "refused", reason: errorText(error), at: clock.now() }),
    );
    await within(settled, SEND_ACCEPT_MS, signal);
    if (ledger.get(record.id)?.outcome.state === "sending") ledger.markRepliedWhileSending(record.id);
    return { send: ledger.get(record.id) ?? record, status: snapshotStatus(id), cursor };
  }

  return {
    async sessions({ cwd, limit }) {
      const dir = cwd === undefined ? null : canonicalDirectory(cwd);
      const rows = (await ports.listSessions())
        .filter((row) => dir === null || row.cwd === dir || row.cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep));
      return { rows: rows.slice(0, limit), total: rows.length };
    },

    async read(id, { messages, before }) {
      const live = ports.live(id);
      const transcript = await source(id, live);
      if (before !== undefined && !transcript.getEntry(before)) {
        throw new DeskError("bad-input", `${before} is not an entry of session ${id}. Use the id from an \`older:\` line.`);
      }
      const page = ports.page(transcript, id, before ?? null, messages, before !== undefined);
      const status = snapshotStatus(id);
      return {
        session: await heading(id, transcript),
        status,
        page: { ...label(id, transcript, page), hasMore: page.hasMore, oldestEntryId: page.oldestEntryId },
        // The reply shows the open dialogs, so its cursor counts them as shown.
        cursor: before !== undefined ? null : { entryId: transcript.getLeafId(), dialogs: dialogDigest(status.dialogs.map((dialog) => dialog.id)), at: clock.now() },
      };
    },

    async send(id, text, { steer, cursor }, signal) {
      const transcript = await source(id, ports.live(id));
      ports.hold(id);
      // dialogs "0": the agent was shown none, so its next wait reports any open one.
      const from = cursor ?? { entryId: transcript.getLeafId(), dialogs: "0", at: clock.now() };
      return deliver(id, text, steer ? "steer" : "followUp", from, signal);
    },

    async wait(id, cursor, timeoutMs, signal) {
      const started = clock.now();
      const deadline = started + Math.min(Math.max(timeoutMs, 0), WAIT_MAX_MS);
      const watch = new SessionWatch(ports, id, clock);
      try {
        await source(id, watch.live());
        ports.hold(id);
        let phase: RestPhase = { kind: "watching" };
        for (;;) {
          const now = clock.now();
          const live = watch.live();
          const transcript = await source(id, live);
          const status = statusOf(id, watch, live);
          reconcile(id, transcript, { status, now });
          const delta = branchSince(transcript, cursor.entryId, MAX_DELTA_ENTRIES);
          const news = deliveryNews(ledger.forSession(id), cursor.at);
          const dialogs = dialogDigest(status.dialogs.map((dialog) => dialog.id));
          phase = stepRest(phase, {
            now, deadline, aborted: signal.aborted,
            running: status.running, subagentsActive: status.subagentsActive, sendsInFlight: status.sendsInFlight,
            hasNews: delta.visible > 0 || delta.kind !== "since" || news.length > 0,
            dialogs, dialogCount: status.dialogs.length, cursorDialogs: cursor.dialogs,
          });
          if (phase.kind === "done") {
            const converted = ports.toMessages(delta.entries, id);
            return {
              reason: phase.reason === "timeout" && timeoutMs <= 0 ? "now" : phase.reason,
              waitedMs: now - started,
              status,
              delta: { kind: delta.kind, omitted: delta.omitted, ...label(id, transcript, converted) },
              news,
              notices: [...watch.notices],
              // The progress so far comes with a new cursor even on a timeout, so the agent can steer mid-run.
              cursor: { entryId: delta.leafId, dialogs, at: now },
            };
          }
          await watch.changed(recheckIn(phase, { now, deadline }), signal);
        }
      } finally {
        watch.close();
      }
    },

    async answer(id, dialogId, answer) {
      if (!ports.live(id)) {
        await source(id, null);
        return { outcome: "closed" };
      }
      const dialog = snapshotStatus(id).dialogs.find((open) => open.id === dialogId);
      const live = ports.live(id);
      if (!dialog || !live) return { outcome: "closed" };
      const { response, shown } = toResponse(dialog, answer);
      await live.answer(response);
      ports.hold(id);
      return { outcome: "sent", dialog, shown };
    },

    async stop(id) {
      const live = ports.live(id);
      const idle = (status: SessionStatus): StopResult => ({ stopped: false, unwinding: false, sendPending: false, withdrawn: [], status });
      if (!live) {
        await source(id, null);
        return idle(snapshotStatus(id));
      }
      ports.hold(id);
      for (const until = clock.now() + STOP_SEND_GRACE_MS; sendsInFlight(ledger.forSession(id)) > 0 && clock.now() < until;) {
        await sleep(100);
      }
      if (sendsInFlight(ledger.forSession(id)) > 0) return { ...idle(snapshotStatus(id)), sendPending: true };
      const before = snapshotStatus(id);
      // An abort on an idle session would stop nothing.
      if (!live.isRunning() && before.dialogs.length === 0) return idle(before);
      const withdrawn = await within(live.abort(), STOP_MS, NEVER);
      if (!withdrawn) return { stopped: true, unwinding: true, sendPending: false, withdrawn: [], status: snapshotStatus(id) };
      reconcile(id, live.transcript(), null);
      const ours = ledger.forSession(id).filter((send) => send.outcome.state === "accepted" && send.landedEntryId === null);
      const now = clock.now();
      const labeled = [...withdrawn.steering, ...withdrawn.followUp].map((text) => {
        const index = ours.findIndex((send) => send.text.trim() === text.trim());
        if (index === -1) return { text, author: "person" as const };
        ledger.markMissing(ours[index].id, now);
        ours.splice(index, 1);
        return { text, author: "agent" as const };
      });
      return { stopped: true, unwinding: false, sendPending: false, withdrawn: labeled, status: snapshotStatus(id) };
    },

    async newSession({ cwd, message, model, thinking, tools }, signal) {
      const dir = canonicalDirectory(cwd);
      const slash = model?.indexOf("/") ?? -1;
      if (model !== undefined && (slash <= 0 || slash === model.length - 1)) {
        throw new DeskError("bad-input", `model must be provider/modelId, e.g. anthropic/claude-sonnet-4-5, not ${JSON.stringify(model)}.`);
      }
      const creating = ports.create(dir, {
        tools,
        ...(model !== undefined ? { model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
      });
      let session: LiveSession | null;
      try {
        session = await within(creating, CREATE_MS, signal);
      } catch (error) {
        throw new DeskError("bad-input", `pi-web could not start a session in ${dir}: ${errorText(error)}`);
      }
      if (!session) throw new DeskError("unavailable", `pi-web was still building the session after ${CREATE_MS / 1000} s; nothing was sent. Try again.`);
      ports.hold(session.id);
      const transcript = session.transcript();
      const send = await deliver(session.id, message, "followUp", { entryId: transcript.getLeafId(), dialogs: "0", at: clock.now() }, signal);
      return {
        session: await heading(session.id as SessionId, transcript),
        model: session.model(),
        thinkingLevel: session.thinkingLevel(),
        untrusted: ports.untrusted(dir),
        send,
      };
    },

    async newWorktree({ project, branch }, signal) {
      const dir = canonicalDirectory(project);
      try {
        return await within(ports.addWorktree(dir, branch), WORKTREE_MS, signal) ?? { kind: "creating", branch: branch.trim() };
      } catch (error) {
        throw new DeskError("bad-input", `git could not create the worktree: ${errorText(error)}`);
      }
    },
  };
}

/** Events that only stream text: they change no rest observation. */
const HIGH_RATE = new Set(["message_update", "tool_execution_update", "bash_output"]);

/**
 * Wakes a waiter on anything that can change a rest observation, across wrapper replacement.
 *
 * Attaches to the live wrapper, if any. The synchronous replay inside onEvent() is state (open
 * dialogs, running tools), not news, so it seeds them without waking. `session_shutdown` or
 * `session_ended` detaches: the next live() re-resolves through ports.live(), which finds the
 * replacement a fork, trust change, idle reap or tool rebuild registered under the same id. With
 * no live wrapper, changed() still returns every tick, so a wrapper the person's page starts is
 * picked up. A wait never starts one.
 */
class SessionWatch {
  private session: LiveSession | null = null;
  private off: (() => void) | null = null;
  private wake: (() => void) | null = null;
  private dirty = false;
  private readonly dialogs = new Map<string, Dialog>();
  private readonly tools = new Map<string, { name: string; detail: string; startedAt: number }>();
  readonly notices: string[] = [];

  constructor(private readonly ports: PiWebPorts, private readonly id: string, private readonly clock: Clock) {}

  live(): LiveSession | null {
    if (this.session && !this.session.isAlive()) this.detach();
    if (!this.session) this.attach();
    return this.session;
  }

  openDialogs(): Dialog[] {
    return [...this.dialogs.values()];
  }

  activity(now: number): string | null {
    let newest: { name: string; detail: string; startedAt: number } | null = null;
    for (const tool of this.tools.values()) if (!newest || tool.startedAt >= newest.startedAt) newest = tool;
    if (!newest) return null;
    return `${newest.name}${newest.detail ? ` ${newest.detail}` : ""} for ${Math.max(0, Math.round((now - newest.startedAt) / 1000))} s`;
  }

  /** Resolves on the next waking event (or one since the last call), after `ms`, or on abort. Never rejects. */
  changed(ms: number, signal: AbortSignal): Promise<void> {
    if (this.dirty || signal.aborted) {
      this.dirty = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (this.wake === done) this.wake = null;
        this.dirty = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }

  close(): void {
    this.detach();
  }

  private attach(): void {
    const session = this.ports.live(this.id);
    if (!session) return;
    this.session = session;
    let replaying = true;
    let endedDuringReplay = false;
    const off = session.onEvent((event) => {
      if (event.type === "session_shutdown" || event.type === "session_ended") {
        // In the replay it is state, not news: waking on it would re-attach to the ended wrapper at once, forever.
        if (replaying) endedDuringReplay = true;
        else {
          this.detach();
          this.poke();
        }
        return;
      }
      this.track(event);
      if (replaying) return;
      if (event.type === "prompt_error") this.notices.push(`pi reported an error: ${String(event.errorMessage)}`);
      if (event.type === "extension_error") this.notices.push(`Extension ${String(event.extensionPath)} failed: ${String(event.error)}`);
      if (!HIGH_RATE.has(event.type)) this.poke();
    });
    replaying = false;
    this.off = off;
    if (endedDuringReplay) this.detach();
  }

  private detach(): void {
    this.off?.();
    this.off = null;
    this.session = null;
    this.dialogs.clear();
    this.tools.clear();
  }

  private track(event: PiEvent): void {
    switch (event.type) {
      case "extension_ui_request": {
        const request = event as unknown as ExtensionUiRequest;
        const dialog = toDialog(request);
        if (dialog) this.dialogs.set(request.id, dialog);
        else this.dialogs.delete(request.id);
        return;
      }
      case "extension_ui_closed":
        this.dialogs.delete(String(event.id));
        return;
      case "tool_execution_start":
        this.tools.set(String(event.toolCallId), {
          name: String(event.toolName),
          detail: toolDetail(event.args),
          startedAt: this.clock.now() - (typeof event.elapsedMs === "number" ? event.elapsedMs : 0),
        });
        return;
      case "tool_execution_end":
        this.tools.delete(String(event.toolCallId));
        return;
      case "agent_end":
      case "agent_settled":
        this.tools.clear();
        return;
    }
  }

  private poke(): void {
    const wake = this.wake;
    if (wake) wake();
    else this.dirty = true;
  }
}

/** The blocking dialogs (pi's TUI blocks on exactly these), as the agent sees them; null for everything else. */
function toDialog(request: ExtensionUiRequest): Dialog | null {
  switch (request.method) {
    case "select":
      return { id: request.id, kind: "choice", title: request.title, options: request.options };
    case "confirm":
      return { id: request.id, kind: "confirm", title: request.title, message: request.message };
    case "input":
      return { id: request.id, kind: "text", title: request.title, multiline: false, ...(request.placeholder ? { placeholder: request.placeholder } : {}) };
    case "editor":
      return { id: request.id, kind: "text", title: request.title, multiline: true, ...(request.prefill ? { prefill: request.prefill } : {}) };
    case "custom":
      return request.closed ? null : { id: request.id, kind: "panel", lines: request.lines };
    default:
      return null;
  }
}

const YES_NO: Readonly<Record<string, boolean>> = { yes: true, true: true, y: true, no: false, false: false, n: false };

/** The response the dialog's kind takes, or a bad-input error naming what it takes. */
function toResponse(dialog: Dialog, answer: DialogAnswer): { response: ExtensionUiResponse; shown: string } {
  if ("cancel" in answer) return { response: { type: "extension_ui_response", id: dialog.id, cancelled: true }, shown: "cancel" };
  const { value } = answer;
  switch (dialog.kind) {
    case "panel":
      throw new DeskError("bad-input", "That is a panel that takes keystrokes; only the person can answer it in pi-web.");
    case "choice": {
      const option = typeof value === "number"
        ? (Number.isInteger(value) ? dialog.options[value - 1] : undefined)
        : typeof value === "string"
          ? dialog.options.find((candidate) => candidate === value) ?? dialog.options.find((candidate) => candidate.trim().toLowerCase() === value.trim().toLowerCase())
          : undefined;
      if (option === undefined) {
        throw new DeskError("bad-input", `This question takes one of its options, by text or 1-based number: ${dialog.options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`);
      }
      return { response: { type: "extension_ui_response", id: dialog.id, value: option }, shown: option };
    }
    case "confirm": {
      const confirmed = typeof value === "boolean" ? value : typeof value === "string" ? YES_NO[value.trim().toLowerCase()] : undefined;
      if (confirmed === undefined) throw new DeskError("bad-input", "This question takes true or false.");
      return { response: { type: "extension_ui_response", id: dialog.id, confirmed }, shown: confirmed ? "yes" : "no" };
    }
    case "text": {
      if (typeof value === "boolean") throw new DeskError("bad-input", "This question takes text.");
      return { response: { type: "extension_ui_response", id: dialog.id, value: String(value) }, shown: String(value) };
    }
  }
}

function toolDetail(args: unknown): string {
  if (typeof args !== "object" || args === null) return "";
  const record = args as Record<string, unknown>;
  const value = [record.command, record.path, record.pattern, ...Object.values(record)].find((candidate) => typeof candidate === "string");
  if (typeof value !== "string") return "";
  const flat = value.replace(/\s+/g, " ").trim();
  return `\`${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}\``;
}

/**
 * The spelling pi-web already uses for a folder, so the agent's sessions group with the person's:
 * `~` expanded, absolute, an existing directory, then its realpath (the directory picker selects
 * the realpath, and pi's TUI uses the physical cwd). Any directory is allowed: the token is as
 * strong as the web password, and the web UI can open any folder too. The rule is one cwd per
 * folder, not containment.
 */
export function canonicalDirectory(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new DeskError("bad-input", `${JSON.stringify(input)} is not an absolute path (or ~/…) on pi-web's machine.`);
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    throw new DeskError("bad-input", `${expanded} does not exist on pi-web's machine.`);
  }
  if (!statSync(real).isDirectory()) throw new DeskError("bad-input", `${real} is a file, not a folder.`);
  return real;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The promise's value, or null when `ms` pass or `signal` aborts first. The promise runs on either way. */
async function within<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | null> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const cutoff = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    onAbort = () => resolve(null);
    if (signal.aborted) resolve(null);
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cutoff]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
