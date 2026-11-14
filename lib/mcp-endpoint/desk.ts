import { isAbsolute } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isHiddenCustomMessage } from "../message-display";
import { isPathWithinRoots } from "../path-security";
import { SESSION_ID_PATTERN } from "../session-ui-state-shared";
import { toolInputPreview } from "../tool-fields";
import type { ToolPreset } from "../tool-presets";
import type { AgentMessage, BlockingExtensionUiRequest, ExtensionUiResponse } from "../types";
import type { LiveSession, PiWebPorts, RunningTool, SessionRow, TranscriptSource, WorktreeOutcome } from "./ports";
import { isBusy, recheckIn, stepRest, type RestPhase, type RestReason } from "./rest";
import { createLedger, type Delivery, type Ledger, type PiQueue, type SentMessage, type UserEntry, type Withdrawn } from "./session-ledger";
import { authorOf, branchSince, contentText, dialogDigest, NO_DIALOGS, type Author, type Cursor, type Delta, type EntryLike } from "./transcript";

/** The generic MCP SDK client gives up at 60 s, nginx too, Cloudflare at 100 s. */
export const WAIT_MAX_MS = 50_000;
export const WAIT_DEFAULT_MS = 45_000;
export const SEND_ACCEPT_MS = 15_000;
export const CREATE_MS = WAIT_MAX_MS - SEND_ACCEPT_MS - 5_000;
export const WORKTREE_MS = 45_000;
export const STOP_MS = 20_000;
export const STOP_SEND_GRACE_MS = 5_000;
export const HOLD_MS = 30 * 60_000;
export const MAX_DELTA_ENTRIES = 400;

export type SessionId = string & { readonly __brand: "SessionId" };

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
  return id.length <= 200 && SESSION_ID_PATTERN.test(id) ? id as SessionId : null;
}

export type Dialog =
  | { readonly id: string; readonly kind: "choice"; readonly title: string; readonly options: readonly string[] }
  | { readonly id: string; readonly kind: "confirm"; readonly title: string; readonly message: string }
  | { readonly id: string; readonly kind: "text"; readonly title: string; readonly multiline: boolean; readonly placeholder?: string; readonly prefill?: string }
  | { readonly id: string; readonly kind: "panel"; readonly lines: readonly string[] };

export interface SessionStatus {
  readonly loaded: boolean;
  readonly running: boolean;
  readonly subagentsActive: boolean;
  readonly sendsInFlight: number;
  readonly dialogs: readonly Dialog[];
  readonly queued: { readonly steering: readonly string[]; readonly followUp: readonly string[] };
  readonly activity: string | null;
}

export interface SessionHeading {
  readonly id: SessionId;
  readonly title: string | null;
  readonly cwd: string;
  readonly branch: string | null;
}

export interface LabeledMessages {
  readonly messages: readonly AgentMessage[];
  readonly authors: readonly (Author | "by-role")[];
}

export interface ReadPage extends LabeledMessages {
  readonly hasMore: boolean;
  readonly oldestEntryId: string | null;
}

export type ReadResult =
  | { readonly kind: "latest"; readonly session: SessionHeading; readonly status: SessionStatus; readonly page: ReadPage; readonly cursor: Cursor }
  | { readonly kind: "older"; readonly session: SessionHeading; readonly status: SessionStatus; readonly page: ReadPage };

export interface SendResult {
  readonly send: SentMessage;
  readonly status: SessionStatus;
  readonly cursor: Cursor;
}

export interface WaitResult {
  readonly reason: RestReason | "now";
  readonly waitedMs: number;
  readonly status: SessionStatus;
  readonly delta: Pick<Delta, "kind" | "omitted"> & LabeledMessages;
  readonly news: readonly SentMessage[];
  readonly notices: readonly string[];
  readonly cursor: Cursor;
}

export type DialogAnswer = { readonly cancel: true } | { readonly value: string | number | boolean };

export type AnswerResult =
  | { readonly outcome: "sent"; readonly dialog: Dialog; readonly shown: string }
  | { readonly outcome: "closed" };

export type StopResult =
  | { readonly kind: "send-pending"; readonly status: SessionStatus }
  | { readonly kind: "idle"; readonly status: SessionStatus }
  | { readonly kind: "unwinding" }
  | { readonly kind: "stopped"; readonly withdrawn: readonly Withdrawn[]; readonly status: SessionStatus };

export interface NewSessionResult {
  readonly session: SessionHeading;
  readonly model: string | null;
  readonly thinkingLevel: string;
  readonly untrusted: boolean;
  readonly send: SendResult;
}

export type NewWorktreeResult = WorktreeOutcome | { readonly kind: "creating"; readonly branch: string };

export class ToolError extends Error {}

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

function notFound(id: string): ToolError {
  return new ToolError(`No pi session ${id}. pi_sessions lists the sessions.`);
}

/** pi hands a blank message to the model as it is; pi-web's composer never sends one. */
function refuseBlank(text: string): void {
  if (!text.trim()) throw new ToolError("message must not be blank.");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function entryTime(entry: EntryLike | undefined): number {
  const time = entry ? Date.parse(entry.timestamp) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

function userEntries(transcript: TranscriptSource): UserEntry[] {
  return transcript.getEntries()
    .filter((entry) => entry.type === "message" && entry.message?.role === "user")
    .map((entry) => ({ entryId: entry.id, text: contentText(entry.message?.content), time: entryTime(entry) }));
}

export interface DeskMemory {
  readonly ledger: Ledger;
  readonly holds: Map<string, { touchedAt: number; dispose: () => void }>;
  /**
   * A checkout can take minutes. A repeat during it must join it, not read git's half-made
   * worktree as "exists".
   */
  readonly checkouts: Map<string, Promise<WorktreeOutcome>>;
}

export function createDeskMemory(): DeskMemory {
  return { ledger: createLedger(), holds: new Map(), checkouts: new Map() };
}

export function createDesk(ports: PiWebPorts, { ledger, holds, checkouts }: DeskMemory, clock: Clock = Date): Desk {

  function releaseExpiredHolds(now: number): void {
    for (const [id, held] of holds) {
      if (now - held.touchedAt < HOLD_MS) continue;
      held.dispose();
      holds.delete(id);
    }
  }

  function hold(id: string): void {
    const now = clock.now();
    releaseExpiredHolds(now);
    const existing = holds.get(id);
    if (existing) {
      existing.touchedAt = now;
      return;
    }
    const held = { touchedAt: now, dispose: () => {} };
    held.dispose = ports.registerLiveness(id, () => clock.now() - held.touchedAt < HOLD_MS);
    holds.set(id, held);
  }

  function statusOf(id: string, live: LiveSession | null): SessionStatus {
    return {
      loaded: live !== null,
      running: live?.isRunning() ?? false,
      subagentsActive: ports.subagentsActive(id),
      sendsInFlight: ledger.inFlight(id),
      dialogs: live?.openDialogs().map(toDialog) ?? [],
      queued: live?.queued() ?? { steering: [], followUp: [] },
      activity: activityOf(live?.runningTools() ?? []),
    };
  }

  function snapshotStatus(id: string): SessionStatus {
    return statusOf(id, ports.live(id));
  }

  async function source(id: string, live: LiveSession | null): Promise<TranscriptSource> {
    const found = live?.transcript() ?? await ports.saved(id);
    if (!found) throw notFound(id);
    return found;
  }

  function shownMessages(id: string, transcript: TranscriptSource, converted: { messages: AgentMessage[]; entryIds: string[] }): LabeledMessages {
    const messages: AgentMessage[] = [];
    const authors: (Author | "by-role")[] = [];
    converted.messages.forEach((message, index) => {
      if (isHiddenCustomMessage(message)) return;
      const entryId = converted.entryIds[index];
      const entry = transcript.getEntry(entryId);
      messages.push(message);
      authors.push(authorOf(message, entry?.type ?? "message", () => ledger.authorOf(id, { id: entryId, time: entryTime(entry) })));
    });
    return { messages, authors };
  }

  async function directoryOf(input: string): Promise<string> {
    const path = input.trim();
    if (path !== "~" && !path.startsWith("~/") && !isAbsolute(path)) {
      throw new ToolError(`${JSON.stringify(input)} is not an absolute path (or ~/…) on pi-web's machine.`);
    }
    const found = await ports.directory(path);
    switch (found.kind) {
      case "directory":
        return found.path;
      case "missing":
        throw new ToolError(`${found.path} does not exist on pi-web's machine.`);
      case "file":
        throw new ToolError(`${found.path} is a file, not a folder.`);
    }
  }

  async function heading(id: SessionId, transcript: TranscriptSource): Promise<SessionHeading> {
    const cwd = transcript.getCwd();
    const firstUser = transcript.getEntries().find((entry) => entry.type === "message" && entry.message?.role === "user");
    const title = transcript.getSessionName()?.trim() || contentText(firstUser?.message?.content).trim() || null;
    const project = await ports.project(cwd).catch(() => ({ branch: null }));
    return { id, title, cwd, branch: project.branch };
  }

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
    const settled = outcome.then(
      (accepted) => ledger.settle(record.id, accepted),
      (error: unknown) => ledger.settle(record.id, { state: "refused", reason: errorText(error), at: clock.now() }),
    );
    await waitAtMost(settled, SEND_ACCEPT_MS, signal);
    return { send: ledger.markReplied(record.id), status: snapshotStatus(id), cursor };
  }

  async function waitForOwnSendsToReachPi(id: string): Promise<void> {
    for (const until = clock.now() + STOP_SEND_GRACE_MS; ledger.inFlight(id) > 0 && clock.now() < until;) {
      await sleep(100);
    }
  }

  return {
    async sessions({ cwd, limit }) {
      const roots = cwd === undefined ? null : new Set([await directoryOf(cwd)]);
      const rows = (await ports.listSessions()).filter((row) => roots === null || isPathWithinRoots(row.cwd, roots));
      return { rows: rows.slice(0, limit), total: rows.length };
    },

    async read(id, { messages, before }) {
      const live = ports.live(id);
      const transcript = await source(id, live);
      if (before !== undefined && !transcript.getEntry(before)) {
        throw new ToolError(`${before} is not an entry of session ${id}. Use the id from an \`older:\` line.`);
      }
      const page = ports.page(transcript, id, before ?? null, messages);
      const status = statusOf(id, live);
      ledger.observe(id, { userEntries: userEntries(transcript), pi: { kind: "busy-or-unknown" }, now: clock.now() });
      const shown = {
        session: await heading(id, transcript),
        status,
        page: { ...shownMessages(id, transcript, page), hasMore: page.hasMore, oldestEntryId: page.oldestEntryId },
      };
      if (before !== undefined) return { kind: "older", ...shown };
      return { kind: "latest", ...shown, cursor: { entryId: transcript.getLeafId(), dialogs: dialogDigest(status.dialogs.map((dialog) => dialog.id)), at: clock.now() } };
    },

    async send(id, text, { steer, cursor }, signal) {
      refuseBlank(text);
      const transcript = await source(id, ports.live(id));
      hold(id);
      const from = cursor ?? { entryId: transcript.getLeafId(), dialogs: NO_DIALOGS, at: clock.now() };
      return deliver(id, text, steer ? "steer" : "followUp", from, signal);
    },

    async wait(id, cursor, timeoutMs, signal) {
      const started = clock.now();
      const deadline = started + Math.min(Math.max(timeoutMs, 0), WAIT_MAX_MS);
      const watch = new SessionWatch(ports, id);
      try {
        await source(id, watch.live());
        hold(id);
        let phase: RestPhase = { kind: "watching" };
        for (;;) {
          const now = clock.now();
          const live = watch.live();
          const transcript = await source(id, live);
          const status = statusOf(id, live);
          const pi: PiQueue = status.running ? { kind: "busy-or-unknown" } : { kind: "at-rest", queued: [...status.queued.steering, ...status.queued.followUp] };
          ledger.observe(id, { userEntries: userEntries(transcript), pi, now });
          const delta = branchSince(transcript, cursor.entryId, MAX_DELTA_ENTRIES);
          const shown = shownMessages(id, transcript, ports.toMessages(delta.entries, id));
          const news = ledger.deliveryNewsSince(id, cursor.at);
          const dialogs = dialogDigest(status.dialogs.map((dialog) => dialog.id));
          phase = stepRest(phase, {
            now, deadline, aborted: signal.aborted, busy: isBusy(status),
            hasNews: shown.messages.length > 0 || delta.kind !== "since" || news.length > 0,
            unseenDialog: dialogs !== NO_DIALOGS && dialogs !== cursor.dialogs,
          });
          if (phase.kind === "done") {
            return {
              reason: phase.reason === "timeout" && timeoutMs <= 0 ? "now" : phase.reason,
              waitedMs: now - started,
              status,
              delta: { kind: delta.kind, omitted: delta.omitted, ...shown },
              news,
              notices: [...watch.notices],
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
      const live = ports.live(id);
      if (!live) {
        await source(id, null);
        return { outcome: "closed" };
      }
      const request = live.openDialogs().find((open) => open.id === dialogId);
      if (!request) return { outcome: "closed" };
      const dialog = toDialog(request);
      const { response, shown } = toResponse(dialog, answer);
      await live.answer(response);
      hold(id);
      return { outcome: "sent", dialog, shown };
    },

    async stop(id) {
      await source(id, ports.live(id));
      await waitForOwnSendsToReachPi(id);
      const live = ports.live(id);
      if (live) hold(id);
      const status = statusOf(id, live);
      if (status.sendsInFlight > 0) return { kind: "send-pending", status };
      if (!live || (!status.running && status.dialogs.length === 0)) return { kind: "idle", status };
      const aborted = await waitAtMost(live.abort(), STOP_MS, NEVER);
      if (aborted.kind !== "done") return { kind: "unwinding" };
      const now = clock.now();
      ledger.observe(id, { userEntries: userEntries(live.transcript()), pi: { kind: "busy-or-unknown" }, now });
      const withdrawn = ledger.withdraw(id, [...aborted.value.steering, ...aborted.value.followUp], now);
      return { kind: "stopped", withdrawn, status: snapshotStatus(id) };
    },

    async newSession({ cwd, message, model, thinking, tools }, signal) {
      refuseBlank(message);
      const dir = await directoryOf(cwd);
      const slash = model?.indexOf("/") ?? -1;
      if (model !== undefined && (slash <= 0 || slash === model.length - 1)) {
        throw new ToolError(`model must be provider/modelId, e.g. anthropic/claude-sonnet-4-5, not ${JSON.stringify(model)}.`);
      }
      const creating = ports.create(dir, {
        tools,
        ...(model !== undefined ? { model: { provider: model.slice(0, slash), modelId: model.slice(slash + 1) } } : {}),
        ...(thinking ? { thinkingLevel: thinking } : {}),
      });
      let built: Bounded<LiveSession>;
      try {
        built = await waitAtMost(creating, CREATE_MS, signal);
      } catch (error) {
        throw new ToolError(`pi-web could not start a session in ${dir}: ${errorText(error)}`);
      }
      if (built.kind === "timeout") throw new ToolError(`pi-web was still building the session after ${CREATE_MS / 1000} s; nothing was sent. Try again.`);
      if (built.kind === "aborted") throw new ToolError("The call ended early (cancelled, or pi-web is stopping) while pi-web was building the session; nothing was sent.");
      const session = built.value;
      hold(session.id);
      const transcript = session.transcript();
      const send = await deliver(session.id, message, "followUp", { entryId: transcript.getLeafId(), dialogs: NO_DIALOGS, at: clock.now() }, signal);
      return {
        session: await heading(session.id as SessionId, transcript),
        model: session.model(),
        thinkingLevel: session.thinkingLevel(),
        untrusted: ports.untrusted(dir),
        send,
      };
    },

    async newWorktree({ project, branch }, signal) {
      const dir = await directoryOf(project);
      const key = `${(await ports.project(dir)).mainCheckout}\0${branch.trim()}`;
      let checkout = checkouts.get(key);
      if (!checkout) {
        checkout = ports.addWorktree(dir, branch).finally(() => checkouts.delete(key));
        checkouts.set(key, checkout);
      }
      try {
        const done = await waitAtMost(checkout, WORKTREE_MS, signal);
        return done.kind === "done" ? done.value : { kind: "creating", branch: branch.trim() };
      } catch (error) {
        throw new ToolError(`git could not create the worktree: ${errorText(error)}`);
      }
    },
  };
}

class SessionWatch {
  private session: LiveSession | null = null;
  private off: (() => void) | null = null;
  private wake: (() => void) | null = null;
  private dirty = false;
  readonly notices: string[] = [];

  constructor(private readonly ports: PiWebPorts, private readonly id: string) {}

  live(): LiveSession | null {
    if (this.session && !this.session.isAlive()) this.detach();
    if (!this.session) this.attach();
    return this.session;
  }

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
      if (replaying) {
        if (event.kind === "ended") endedDuringReplay = true;
        return;
      }
      switch (event.kind) {
        case "ended":
          this.detach();
          break;
        case "streaming":
          return;
        case "prompt-error":
          this.notices.push(`pi reported an error: ${event.message}`);
          break;
        case "extension-error":
          this.notices.push(`Extension ${event.extensionPath} failed: ${event.error}`);
          break;
      }
      this.poke();
    });
    replaying = false;
    this.off = off;
    if (endedDuringReplay) this.detach();
  }

  private detach(): void {
    this.off?.();
    this.off = null;
    this.session = null;
  }

  private poke(): void {
    const wake = this.wake;
    if (wake) wake();
    else this.dirty = true;
  }
}

function toDialog(request: BlockingExtensionUiRequest): Dialog {
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
      return { id: request.id, kind: "panel", lines: request.lines };
  }
}

function activityOf(tools: readonly RunningTool[]): string | null {
  const newest = tools.reduce<RunningTool | null>((latest, tool) => !latest || tool.elapsedMs <= latest.elapsedMs ? tool : latest, null);
  if (!newest) return null;
  const preview = toolInputPreview(newest.args, null, newest.toolName).replace(/\s+/g, " ").trim();
  return `${newest.toolName}${preview ? ` \`${preview}\`` : ""} for ${Math.round(newest.elapsedMs / 1000)} s`;
}

const YES_NO: Readonly<Record<string, boolean>> = { yes: true, true: true, y: true, no: false, false: false, n: false };

function toResponse(dialog: Dialog, answer: DialogAnswer): { response: ExtensionUiResponse; shown: string } {
  if ("cancel" in answer) return { response: { type: "extension_ui_response", id: dialog.id, cancelled: true }, shown: "cancel" };
  const { value } = answer;
  switch (dialog.kind) {
    case "panel":
      throw new ToolError("That is a panel that takes keystrokes; only the person can answer it in pi-web.");
    case "choice": {
      const option = typeof value === "number"
        ? (Number.isInteger(value) ? dialog.options[value - 1] : undefined)
        : typeof value === "string"
          ? dialog.options.find((candidate) => candidate === value) ?? dialog.options.find((candidate) => candidate.trim().toLowerCase() === value.trim().toLowerCase())
          : undefined;
      if (option === undefined) {
        throw new ToolError(`This question takes one of its options, by text or 1-based number: ${dialog.options.map((o, i) => `${i + 1}. ${o}`).join("  ")}`);
      }
      return { response: { type: "extension_ui_response", id: dialog.id, value: option }, shown: option };
    }
    case "confirm": {
      const confirmed = typeof value === "boolean" ? value : typeof value === "string" ? YES_NO[value.trim().toLowerCase()] : undefined;
      if (confirmed === undefined) throw new ToolError("This question takes true or false.");
      return { response: { type: "extension_ui_response", id: dialog.id, confirmed }, shown: confirmed ? "yes" : "no" };
    }
    case "text": {
      if (typeof value === "boolean") throw new ToolError("This question takes text.");
      return { response: { type: "extension_ui_response", id: dialog.id, value: String(value) }, shown: String(value) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Bounded<T> = { readonly kind: "done"; readonly value: T } | { readonly kind: "timeout" } | { readonly kind: "aborted" };

async function waitAtMost<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const cutoff = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    onAbort = () => resolve({ kind: "aborted" });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then((value): Bounded<T> => ({ kind: "done", value })), cutoff]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
