// The seam to pi-web's internals. Everything the MCP endpoint needs from upstream code goes
// through PiWebPorts, and piWebPorts() is the only place that imports rpc-manager,
// session-reader, worktree and friends. A rebase that reshapes one of them breaks this file's
// typecheck (or ports.integration.test.mjs) and nothing else; desk.ts is written against these
// interfaces and tested with fakes. pi-web's command vocabulary stays private here.

import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { allowFileRoot } from "../file-access";
import { getProjectTrustStatus } from "../project-trust";
import {
  getAwaitingInputRpcSessionIds, getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds, startRpcSession,
  type AgentEvent, type AgentSessionWrapper,
} from "../rpc-manager";
import { isHiddenRelation } from "../session-family";
import { registerSessionLivenessProvider } from "../session-liveness";
import {
  attachSessionProjectInfo, buildSessionContext, getAgentDir, invalidateSessionListCache, listAllSessions, mergeSessionLists,
  openSessionManager, resolveSessionPath,
} from "../session-reader";
import { hasUnsettledSubagentRun } from "../subagent-runtime";
import { getToolNamesForPreset, type ToolPreset } from "../tool-presets";
import type { AgentMessage, ExtensionUiResponse, SessionEntry } from "../types";
import { addWorktree, resolveProject, WorktreeBranchInUseError } from "../worktree";
import type { BranchReader, EntryLike } from "./transcript";

/** An event as the wrapper fans it out (unprojected; the SSE route's projection is not used). */
export type PiEvent = AgentEvent;

/** A session's transcript, read-only: the live wrapper's in-memory SessionManager or the cached file one. */
export interface TranscriptSource extends BranchReader {
  getEntries(): readonly EntryLike[];
  getSessionName(): string | undefined;
  getCwd(): string;
}

/**
 * A live pi session, as the endpoint uses it. Adapts one AgentSessionWrapper; `isAlive()` false
 * means it was shut down or replaced, and the caller re-resolves through PiWebPorts.live().
 */
export interface LiveSession {
  readonly id: string;
  isAlive(): boolean;
  /** A prompt admitted, a run streaming, compaction, or a `!` command. */
  isRunning(): boolean;
  /**
   * Subscribes to every event. Synchronously, inside this call, the wrapper first replays the
   * open extension dialogs and each running top-level tool's start (with elapsedMs); a wrapper an
   * extension shut down delivers `session_ended` at once.
   */
  onEvent(listener: (event: PiEvent) => void): () => void;
  /**
   * Resolves when pi accepted the message (started a run, queued it, or an extension command
   * took it), `{ parked: true }` when pi-web parked it behind a manual compaction; rejects with
   * pi's reason when refused. Never waits for the run. streamingBehavior is required, so "Agent is
   * already processing" cannot happen.
   */
  prompt(message: string, streamingBehavior: "followUp" | "steer"): Promise<{ parked: boolean }>;
  /** Session-wide; returns every queued text it withdrew, whoever queued it. */
  abort(): Promise<{ steering: string[]; followUp: string[] }>;
  /** The first answer from any client wins; later ones are dropped silently. */
  answer(response: ExtensionUiResponse): Promise<void>;
  /** pi's queue. Prompts parked behind a compaction are not included. */
  queued(): { steering: readonly string[]; followUp: readonly string[] };
  transcript(): TranscriptSource;
  model(): string | null;
  thinkingLevel(): string;
}

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly isWorktree: boolean;
  readonly modified: string;
  readonly state: "working" | "waiting" | "idle";
}

export interface NewSessionOptions {
  readonly model?: { readonly provider: string; readonly modelId: string };
  readonly thinkingLevel?: ThinkingLevel;
  readonly tools: ToolPreset;
}

export type WorktreeOutcome =
  | { readonly kind: "created"; readonly path: string; readonly branch: string }
  | { readonly kind: "exists"; readonly path: string; readonly branch: string }
  | { readonly kind: "held-by-missing"; readonly path: string; readonly branch: string };

export interface PiWebPorts {
  /** The live session, or null. Never starts one. */
  live(id: string): LiveSession | null;
  /** The live session, else started from its file (extensions load: seconds); null when there is no such session. */
  open(id: string): Promise<LiveSession | null>;
  /** A brand-new session in `cwd`, published the way /api/agent/new publishes it. */
  create(cwd: string, options: NewSessionOptions): Promise<LiveSession>;
  /** The saved transcript; null when there is no such session file. */
  saved(id: string): Promise<TranscriptSource | null>;
  /** Display messages of exactly these entries, with parallel entry ids. */
  toMessages(entries: readonly EntryLike[], sessionId: string): { messages: AgentMessage[]; entryIds: string[] };
  /** A history page: the `tail` user and pi messages ending at `endId` (before it when `before`). */
  page(source: TranscriptSource, sessionId: string, endId: string | null, tail: number, before: boolean):
    { messages: AgentMessage[]; entryIds: string[]; hasMore: boolean; oldestEntryId: string | null };
  /** The sidebar's list, newest first: saved and live-only rows, subagents and side chats left out. */
  listSessions(): Promise<SessionRow[]>;
  subagentsActive(id: string): boolean;
  project(cwd: string): Promise<{ branch: string | null; isWorktree: boolean }>;
  /** The folder has project resources that stay off until the person trusts it in pi-web. */
  untrusted(cwd: string): boolean;
  /** Keeps the session from being reaped for HOLD_MS after the last touch, across wrapper replacement. */
  hold(id: string): void;
  /** addWorktree, joined when the same (dir, branch) is already being checked out. */
  addWorktree(dir: string, branch: string): Promise<WorktreeOutcome>;
}

/** Covers an agent away doing its own work between calls; the idle timer is 10 min. */
export const HOLD_MS = 30 * 60_000;
export const HOLD_PROVIDER_NAME = "pi-web-mcp-endpoint";

const HOLDS = Symbol.for("pi-web.mcp-endpoint.holds");
const WORKTREE_JOBS = Symbol.for("pi-web.mcp-endpoint.worktree-jobs");

function shared<T>(key: symbol, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  return store[key] ??= create();
}

function asEntries(entries: readonly EntryLike[]): SessionEntry[] {
  return entries as unknown as SessionEntry[];
}

export function piWebPorts(): PiWebPorts {
  return {
    live(id) {
      const wrapper = getRpcSession(id);
      return wrapper?.isAlive() ? adapt(wrapper) : null;
    },

    async open(id) {
      const wrapper = getRpcSession(id);
      if (wrapper?.isAlive()) return adapt(wrapper);
      const path = await resolveSessionPath(id);
      if (!path) return null;
      // A closing wrapper (fork, trust change, extension shutdown) is waited out inside, which then builds its replacement.
      return adapt((await startRpcSession(id, path, undefined)).session);
    },

    async create(cwd, options) {
      const toolNames = getToolNamesForPreset(options.tools);
      // A fresh key per call: startRpcSession joins concurrent starts that share one.
      const { session } = await startRpcSession(`__new__${randomUUID()}`, "", cwd, {
        ...(toolNames ? { toolNames } : {}),
        ...(options.model ? { initialModel: options.model } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      });
      allowFileRoot(cwd);
      invalidateSessionListCache();
      return adapt(session);
    },

    async saved(id) {
      const path = await resolveSessionPath(id);
      // Never a forced read: it can evict an idle wrapper.
      return path ? openSessionManager(path) : null;
    },

    toMessages(entries, sessionId) {
      // Given only the slice, the branch walk stops where a parent is missing: exactly the slice.
      const context = buildSessionContext(asEntries(entries), entries.at(-1)?.id ?? null, { deferThinking: true, deferToolResultImages: true, sessionId });
      return { messages: context.messages, entryIds: context.entryIds };
    },

    page(source, sessionId, endId, tail, before) {
      const context = buildSessionContext(asEntries(source.getEntries()), endId ?? source.getLeafId(), {
        tail, excludeLeaf: before, deferThinking: true, deferToolResultImages: true, sessionId,
      });
      return { messages: context.messages, entryIds: context.entryIds, hasMore: context.hasMore, oldestEntryId: context.oldestEntryId };
    },

    async listSessions() {
      // app/api/sessions/route.ts's join, copied: extracting it would edit an upstream route.
      const [saved, live] = await Promise.all([listAllSessions(), attachSessionProjectInfo(getRpcSessionInfos())]);
      const running = new Set(getRunningRpcSessionIds());
      const waiting = new Set(getAwaitingInputRpcSessionIds());
      return mergeSessionLists(saved, live)
        .filter((session) => !isHiddenRelation(session.relation))
        .map((session) => ({
          id: session.id,
          title: session.name?.trim() || session.firstMessage,
          cwd: session.cwd,
          branch: session.branch ?? null,
          isWorktree: session.isWorktree === true,
          modified: session.modified,
          state: waiting.has(session.id) ? "waiting" : running.has(session.id) ? "working" : "idle",
        }));
    },

    subagentsActive: (id) => hasUnsettledSubagentRun(id),

    async project(cwd) {
      const info = await resolveProject(cwd);
      return { branch: info.branch, isWorktree: info.isWorktree };
    },

    untrusted(cwd) {
      const status = getProjectTrustStatus(cwd, getAgentDir());
      return status.requiresTrust && !status.trusted;
    },

    hold(id) {
      const holds = shared(HOLDS, () => new Map<string, { touchedAt: number; dispose: () => void }>());
      const now = Date.now();
      for (const [other, hold] of holds) {
        if (now - hold.touchedAt < HOLD_MS) continue;
        hold.dispose();
        holds.delete(other);
      }
      const existing = holds.get(id);
      if (existing) {
        existing.touchedAt = now;
        return;
      }
      // A liveness provider, not renewIdleTimer(): it spans gaps longer than the idle timeout, it
      // is keyed by session id so it holds whatever wrapper replaces this one, Stop's forced
      // shutdown still overrides it, and the Debug panel lists it by name.
      const hold = { touchedAt: now, dispose: () => {} };
      hold.dispose = registerSessionLivenessProvider({
        name: HOLD_PROVIDER_NAME,
        sessionId: id,
        isActive: () => Date.now() - hold.touchedAt < HOLD_MS,
      });
      holds.set(id, hold);
    },

    addWorktree(dir, branch) {
      // A checkout can take minutes. A repeat during it must join it, not read git's half-made
      // worktree as "exists"; a repeat after it lands in WorktreeBranchInUseError.
      const jobs = shared(WORKTREE_JOBS, () => new Map<string, Promise<WorktreeOutcome>>());
      const key = `${dir}\0${branch.trim()}`;
      const running = jobs.get(key);
      if (running) return running;
      const job = addWorktree(dir, branch).then(
        (created): WorktreeOutcome => ({ kind: "created", path: created.path, branch: created.branch }),
        (error: unknown): WorktreeOutcome => {
          if (!(error instanceof WorktreeBranchInUseError)) throw error;
          return { kind: error.missing ? "held-by-missing" : "exists", path: error.worktreePath, branch: error.branch };
        },
      ).finally(() => jobs.delete(key));
      jobs.set(key, job);
      return job;
    },
  };
}

function adapt(wrapper: AgentSessionWrapper): LiveSession {
  // Never wrapper.onDestroy(): the registry owns that single callback.
  return {
    id: wrapper.sessionId,
    isAlive: () => wrapper.isAlive(),
    isRunning: () => wrapper.isRunning(),
    onEvent: (listener) => wrapper.onEvent(listener),
    async prompt(message, streamingBehavior) {
      const result = await wrapper.send({ type: "prompt", message, streamingBehavior }) as { queued?: boolean } | null;
      return { parked: result?.queued === true };
    },
    async abort() {
      const result = await wrapper.send({ type: "abort" }) as { steering?: string[]; followUp?: string[] } | null;
      return { steering: result?.steering ?? [], followUp: result?.followUp ?? [] };
    },
    async answer(response) {
      await wrapper.send(response);
    },
    queued: () => ({ steering: wrapper.inner.getSteeringMessages(), followUp: wrapper.inner.getFollowUpMessages() }),
    transcript: () => wrapper.inner.sessionManager,
    model: () => wrapper.inner.model ? `${wrapper.inner.model.provider}/${wrapper.inner.model.id}` : null,
    thinkingLevel: () => wrapper.inner.agent.state?.thinkingLevel ?? "off",
  };
}
