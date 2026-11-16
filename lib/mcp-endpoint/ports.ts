import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { normalizeDirectory, resolveDirectory } from "../directory-browser";
import { isBlockingExtensionUiRequest } from "../extension-ui-queue";
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
import type { AgentMessage, BlockingExtensionUiRequest, ExtensionUiRequest, ExtensionUiResponse, SessionEntry } from "../types";
import { addWorktree, resolveProject, WorktreeBranchInUseError } from "../worktree";
import type { BranchReader, EntryLike } from "./transcript";

export type SessionEvent =
  | { readonly kind: "ended" }
  | { readonly kind: "prompt-error"; readonly message: string }
  | { readonly kind: "extension-error"; readonly extensionPath: string; readonly error: string }
  | { readonly kind: "streaming" }
  | { readonly kind: "other" };

export interface RunningTool {
  readonly toolName: string;
  readonly args: unknown;
  readonly elapsedMs: number;
}

export interface TranscriptSource extends BranchReader {
  getEntries(): readonly EntryLike[];
  getSessionName(): string | undefined;
  getCwd(): string;
}

export interface LiveSession {
  readonly id: string;
  isAlive(): boolean;
  /** A prompt admitted, a run streaming, compaction, or a `!` command. */
  isRunning(): boolean;
  /**
   * Subscribes to every event, narrowed. Synchronously, inside this call, the wrapper first replays
   * the open extension dialogs, each running top-level tool's start and latest update, and the
   * startup notices; a wrapper an extension shut down delivers `ended` at once.
   */
  onEvent(listener: (event: SessionEvent) => void): () => void;
  openDialogs(): BlockingExtensionUiRequest[];
  /**
   * The top-level tool calls under way, from a fresh replay, oldest first: calls a tool makes itself
   * (a codemode script's) are left out, and a finished call's nested ones go with it.
   */
  runningTools(): RunningTool[];
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

export type DirectoryLookup =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "file"; readonly path: string };

export interface PiWebPorts {
  live(id: string): LiveSession | null;
  open(id: string): Promise<LiveSession | null>;
  create(cwd: string, options: NewSessionOptions): Promise<LiveSession>;
  saved(id: string): Promise<TranscriptSource | null>;
  toMessages(entries: readonly EntryLike[], sessionId: string): { messages: AgentMessage[]; entryIds: string[] };
  page(source: TranscriptSource, sessionId: string, before: string | null, tail: number):
    { messages: AgentMessage[]; entryIds: string[]; hasMore: boolean; oldestEntryId: string | null };
  listSessions(): Promise<SessionRow[]>;
  subagentsActive(id: string): boolean;
  project(cwd: string): Promise<{ mainCheckout: string; branch: string | null }>;
  untrusted(cwd: string): boolean;
  /**
   * A session-liveness provider for the session id: while `isActive()`, no idle timeout reaps its
   * wrapper, across wrapper replacement; Stop's forced shutdown still wins. `isActive` must never
   * throw: a throwing provider pins the session.
   */
  registerLiveness(id: string, isActive: () => boolean): () => void;
  addWorktree(dir: string, branch: string): Promise<WorktreeOutcome>;
  directory(path: string): Promise<DirectoryLookup>;
}

const LIVENESS_PROVIDER_NAME = "pi-web-mcp-endpoint";

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
      return path ? openSessionManager(path) : null;
    },

    toMessages(entries, sessionId) {
      // Given only the slice, the branch walk stops where a parent is missing: exactly the slice.
      const context = buildSessionContext(asEntries(entries), entries.at(-1)?.id ?? null, { deferThinking: true, deferToolResultImages: true, sessionId });
      return { messages: context.messages, entryIds: context.entryIds };
    },

    page(source, sessionId, before, tail) {
      const context = buildSessionContext(asEntries(source.getEntries()), before ?? source.getLeafId(), {
        tail, excludeLeaf: before !== null, deferThinking: true, deferToolResultImages: true, sessionId,
      });
      return { messages: context.messages, entryIds: context.entryIds, hasMore: context.hasMore, oldestEntryId: context.oldestEntryId };
    },

    async listSessions() {
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
      return { mainCheckout: info.projectRoot, branch: info.branch };
    },

    untrusted(cwd) {
      const status = getProjectTrustStatus(cwd, getAgentDir());
      return status.requiresTrust && !status.trusted;
    },

    registerLiveness: (id, isActive) => registerSessionLivenessProvider({ name: LIVENESS_PROVIDER_NAME, sessionId: id, isActive }),

    async directory(path) {
      let real: string;
      try {
        real = await resolveDirectory(path);
      } catch {
        return { kind: "missing", path: normalizeDirectory(path) };
      }
      return (await stat(real)).isDirectory() ? { kind: "directory", path: real } : { kind: "file", path: real };
    },

    addWorktree: (dir, branch) => addWorktree(dir, branch).then(
      (created): WorktreeOutcome => ({ kind: "created", path: created.path, branch: created.branch }),
      (error: unknown): WorktreeOutcome => {
        if (!(error instanceof WorktreeBranchInUseError)) throw error;
        return { kind: error.missing ? "held-by-missing" : "exists", path: error.worktreePath, branch: error.branch };
      },
    ),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toSessionEvent(event: AgentEvent): SessionEvent {
  switch (event.type) {
    case "session_shutdown":
    case "session_ended":
      return { kind: "ended" };
    case "prompt_error":
      return { kind: "prompt-error", message: text(event.errorMessage, "Command failed") };
    case "extension_error":
      return { kind: "extension-error", extensionPath: text(event.extensionPath, "unknown"), error: text(event.error, "Extension command failed") };
    case "message_update":
    case "tool_execution_update":
    case "bash_output":
      return { kind: "streaming" };
    default:
      return { kind: "other" };
  }
}

function replay(wrapper: AgentSessionWrapper): AgentEvent[] {
  const seen: AgentEvent[] = [];
  wrapper.onEvent((event) => seen.push(event))();
  return seen;
}

function adapt(wrapper: AgentSessionWrapper): LiveSession {
  // Never wrapper.onDestroy(): the registry owns that single callback.
  return {
    id: wrapper.sessionId,
    isAlive: () => wrapper.isAlive(),
    isRunning: () => wrapper.isRunning(),
    onEvent: (listener) => wrapper.onEvent((event) => listener(toSessionEvent(event))),
    openDialogs: () => replay(wrapper)
      .filter((event) => event.type === "extension_ui_request")
      .map((event) => event as unknown as ExtensionUiRequest)
      .filter(isBlockingExtensionUiRequest),
    runningTools: () => replay(wrapper).flatMap((event): RunningTool[] =>
      event.type === "tool_execution_start" && typeof event.toolName === "string"
        ? [{ toolName: event.toolName, args: event.args, elapsedMs: typeof event.elapsedMs === "number" ? event.elapsedMs : 0 }]
        : []),
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
