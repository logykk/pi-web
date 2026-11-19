import { isPathWithinRoots } from "../path-security";
import type { TerminalSnapshot, TerminalState } from "../terminal-list";
import { canonicalDirectory, HOLD_MS, ToolError, WAIT_MAX_MS, type Clock } from "./desk";
import type { Foreground, TerminalEnd, TerminalId, TerminalPorts, TerminalSignal } from "./ports";
import { processGlobal } from "./process-global";
import { BUDGETS } from "./replies";
import { encodeInput, type AgentInputRequest } from "./terminal-keys";
import type { RenderedSpan, RenderSpan } from "./terminal-render";
import { frontOf, stepTerminalWait, type Front, type TerminalWaitReason } from "./terminal-rest";
import {
  endsInText, modesOf, newsSince, pageEnd, pageStart, windowStart, type TerminalCursor, type TerminalWindow,
} from "./terminal-stream";

const MAX_INPUTS = 50;
/** How long `open` waits for a shell it started to print its first prompt. */
const START_WAIT_MS = 10_000;
const MAX_ENDED = 100;
const ENDED_KEEP_MS = 60 * 60_000;
const TERMINAL_ID = /^[0-9a-f]{32}$/;

export function parseTerminalId(input: string): TerminalId | null {
  const id = input.trim().toLowerCase();
  return TERMINAL_ID.test(id) ? id as TerminalId : null;
}

export interface AgentInput {
  /** TM's offset when it was written. */
  readonly offset: number;
  readonly shown: string;
  readonly at: number;
}

/** The agent's presence in one terminal: an in-process listener, so TM arms no cleanup while it lasts. */
interface Hold {
  touchedAt: number;
  lastOutputAt: number;
  readonly inputs: AgentInput[];
  readonly wakers: Set<() => void>;
  release: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface Ended {
  readonly cwd: string;
  readonly at: number;
  readonly end: TerminalEnd;
  readonly by: "agent" | "elsewhere";
}

/** Under its own `processGlobal` name: a field added to `DeskMemory` would be missing after a hot reload. */
export interface TerminalDeskMemory {
  readonly holds: Map<TerminalId, Hold>;
  /** Started through /mcp, at. */
  readonly started: Map<TerminalId, number>;
  /** Terminals that ended while held or that the agent closed: at most 100, each for 1 h. */
  readonly ended: Map<TerminalId, Ended>;
}

export function createTerminalDeskMemory(): TerminalDeskMemory {
  return { holds: new Map(), started: new Map(), ended: new Map() };
}

function memory(): TerminalDeskMemory {
  return processGlobal("terminal-desk", createTerminalDeskMemory);
}

/** Terminals an agent started or holds, newest agent touch first: the ones pi-web's terminal button joins. */
export function agentTerminalIds(): ReadonlySet<string> {
  const { holds, started } = memory();
  const touched = new Map<string, number>(started);
  for (const [id, hold] of holds) touched.set(id, Math.max(hold.touchedAt, touched.get(id) ?? 0));
  return new Set([...touched].sort((a, b) => b[1] - a[1]).map(([id]) => id));
}

export interface TerminalInfo {
  readonly id: TerminalId;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  /** `closed`: TM no longer has it (Close, Restart or pi_terminal_close). */
  readonly state: TerminalState | { readonly kind: "closed" };
  readonly foreground: Foreground;
  readonly front: Front;
  /** A pi-web tab streams it. */
  readonly shownInPiWeb: boolean;
  readonly agentStarted: boolean;
}

export interface TerminalPage extends RenderedSpan {
  /** Units that left TM's backlog before the agent read them. */
  readonly lost: number;
  /** More output after this page: the next wait returns it at once. */
  readonly more: boolean;
  /** Where the page before this one ends, when the backlog keeps one. */
  readonly earlier: number | null;
}

export interface GoneResult {
  readonly kind: "gone";
  readonly id: TerminalId;
  readonly ended: Ended;
  readonly agoMs: number;
  /** The folder's running terminals now. */
  readonly live: readonly TerminalInfo[];
}

export interface TerminalListResult {
  readonly terminals: readonly TerminalInfo[];
}

export interface TerminalOpenResult {
  readonly joined: boolean;
  readonly terminal: TerminalInfo;
  readonly page: TerminalPage;
  readonly cursor: number;
}

export type TerminalReadResult =
  | { readonly kind: "latest"; readonly terminal: TerminalInfo; readonly page: TerminalPage; readonly cursor: number; readonly foreign: boolean }
  | { readonly kind: "before"; readonly terminal: TerminalInfo; readonly page: TerminalPage }
  | GoneResult;

export interface TerminalWaited {
  readonly kind: "waited";
  readonly reason: TerminalWaitReason | "now";
  readonly waitedMs: number;
  readonly terminal: TerminalInfo;
  readonly page: TerminalPage;
  /** The agent's own inputs at or after the cursor; anything else came from the person or a program. */
  readonly typed: readonly AgentInput[];
  readonly cursor: number;
  readonly foreign: boolean;
  /** When the terminal ended: the folder's running terminals now. */
  readonly live: readonly TerminalInfo[];
}

export type TerminalWaitResult = TerminalWaited | GoneResult;

export type TerminalSendResult =
  | { readonly kind: "typed"; readonly shown: string; readonly wait: TerminalWaited }
  | {
    readonly kind: "refused";
    readonly reason: "changed" | "already-typed" | "foreign";
    readonly terminal: TerminalInfo;
    readonly page: TerminalPage;
    readonly typed: readonly AgentInput[];
    readonly cursor: number;
  }
  | GoneResult;

export type TerminalCloseResult = { readonly kind: "closed"; readonly terminal: TerminalInfo } | GoneResult;

export interface TerminalDesk {
  list(filter: { cwd?: string }): Promise<TerminalListResult>;
  open(cwd: string, signal: AbortSignal): Promise<TerminalOpenResult>;
  read(id: TerminalId, before: TerminalCursor | null): Promise<TerminalReadResult>;
  send(id: TerminalId, input: AgentInputRequest, cursor: TerminalCursor | null, timeoutMs: number, signal: AbortSignal): Promise<TerminalSendResult>;
  wait(id: TerminalId, cursor: TerminalCursor, timeoutMs: number, signal: AbortSignal): Promise<TerminalWaitResult>;
  close(id: TerminalId): Promise<TerminalCloseResult>;
}

const NO_FOREGROUND: Foreground = { kind: "unknown" };
const PAGE = BUDGETS.report.total;
const READ_PAGE = BUDGETS.read.total;

function windowOf(snapshot: TerminalSnapshot): TerminalWindow {
  return { backlog: snapshot.backlog, offset: snapshot.offset, cols: snapshot.cols, rows: snapshot.rows };
}

function isForeign(id: TerminalId, cursor: TerminalCursor, snapshot: TerminalSnapshot): boolean {
  return cursor.tag !== id.slice(0, 8) || cursor.offset > snapshot.offset;
}

function notFound(id: string): ToolError {
  return new ToolError(`No terminal ${id} on this pi-web. pi_terminals lists the terminals.`);
}

export function createTerminalDesk(
  ports: TerminalPorts,
  render: RenderSpan,
  { holds, started, ended }: TerminalDeskMemory = memory(),
  clock: Clock = Date,
): TerminalDesk {

  function pruneEnded(now: number): void {
    for (const [id, gone] of ended) if (now - gone.at > ENDED_KEEP_MS || ended.size > MAX_ENDED) ended.delete(id);
  }

  function recordEnd(id: TerminalId, cwd: string, end: TerminalEnd, by: Ended["by"]): void {
    if (ended.has(id)) return;
    ended.set(id, { cwd, at: clock.now(), end, by });
    pruneEnded(clock.now());
  }

  /** Subscribes on the first touch; every touch re-arms the HOLD_MS release. None for a shell that already exited. */
  function touch(snapshot: TerminalSnapshot): Hold | null {
    const id = snapshot.id as TerminalId;
    const now = clock.now();
    let hold = holds.get(id);
    if (!hold) {
      if (snapshot.state.kind === "exited") return null;
      const created: Hold = { touchedAt: now, lastOutputAt: now, inputs: [], wakers: new Set(), release: () => {}, timer: undefined };
      // Old code after a hot reload, so it stays small, and never throws into TM's emit.
      const unsubscribe = ports.hold(id, (signal: TerminalSignal) => {
        try {
          if (signal.kind === "output") created.lastOutputAt = clock.now();
          else {
            recordEnd(id, snapshot.cwd, signal.end, "elsewhere");
            created.release();
          }
          for (const wake of created.wakers) wake();
        } catch {
          // Nothing a hold does may break the person's stream.
        }
      });
      if (!unsubscribe) return null;
      created.release = () => {
        unsubscribe();
        clearTimeout(created.timer);
        if (holds.get(id) === created) holds.delete(id);
      };
      holds.set(id, created);
      hold = created;
    }
    hold.touchedAt = now;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(hold.release, HOLD_MS);
    hold.timer.unref?.();
    return hold;
  }

  async function realpaths(snapshots: readonly TerminalSnapshot[]): Promise<string[]> {
    return Promise.all(snapshots.map((snapshot) => ports.realpath(snapshot.cwd)));
  }

  function shownInPiWeb(snapshot: TerminalSnapshot): boolean {
    return snapshot.listeners - (holds.has(snapshot.id as TerminalId) ? 1 : 0) > 0;
  }

  /** The terminal now: a touch since the snapshot added the hold's listener. */
  function info(taken: TerminalSnapshot): TerminalInfo {
    const snapshot = ports.terminal(taken.id as TerminalId) ?? taken;
    const id = snapshot.id as TerminalId;
    const modes = modesOf(windowOf(snapshot));
    const foreground = snapshot.state.kind === "running" ? ports.foreground(id) : NO_FOREGROUND;
    return {
      id,
      cwd: snapshot.cwd,
      cols: snapshot.cols,
      rows: snapshot.rows,
      state: snapshot.state,
      foreground,
      front: frontOf(modes, foreground),
      shownInPiWeb: shownInPiWeb(snapshot),
      agentStarted: started.has(id),
    };
  }

  function terminals(): TerminalSnapshot[] {
    const all = ports.terminals().filter((snapshot) => parseTerminalId(snapshot.id) === snapshot.id);
    for (const id of started.keys()) if (!all.some((snapshot) => snapshot.id === id)) started.delete(id);
    return all;
  }

  /** The folder's running terminals: one a pi-web tab shows first, then the one an agent touched last, then the newest. */
  async function runningIn(dir: string): Promise<TerminalSnapshot[]> {
    const running = terminals().filter((snapshot) => snapshot.state.kind === "running");
    const real = await realpaths(running);
    const touchedAt = (id: string) => Math.max(holds.get(id as TerminalId)?.touchedAt ?? 0, started.get(id as TerminalId) ?? 0);
    return running
      .map((snapshot, order) => ({ snapshot, order, shown: shownInPiWeb(snapshot) }))
      .filter((_, index) => real[index] === dir)
      .sort((a, b) => Number(b.shown) - Number(a.shown) || touchedAt(b.snapshot.id) - touchedAt(a.snapshot.id) || b.order - a.order)
      .map(({ snapshot }) => snapshot);
  }

  async function gone(id: TerminalId): Promise<GoneResult> {
    const now = clock.now();
    pruneEnded(now);
    const tomb = ended.get(id);
    if (!tomb) throw notFound(id);
    return { kind: "gone", id, ended: tomb, agoMs: now - tomb.at, live: (await runningIn(await ports.realpath(tomb.cwd))).map(info) };
  }

  async function latest(snapshot: TerminalSnapshot, budget: number): Promise<{ page: TerminalPage; cursor: number }> {
    const window = windowOf(snapshot);
    const from = pageStart(window, window.offset, budget);
    const rendered = await render(window, from, window.offset);
    return { page: { ...rendered, lost: 0, more: false, earlier: from > windowStart(window) ? from : null }, cursor: window.offset };
  }

  /** The page after `cursor`; the next cursor is where it ends. */
  async function since(snapshot: TerminalSnapshot, cursor: number): Promise<{ page: TerminalPage; cursor: number }> {
    const window = windowOf(snapshot);
    const start = windowStart(window);
    const from = Math.max(cursor, start);
    const to = pageEnd(window, from, PAGE);
    const rendered = await render(window, from, to);
    return { page: { ...rendered, lost: Math.max(start - cursor, 0), more: to < window.offset, earlier: null }, cursor: to };
  }

  function typedSince(hold: Hold | null, offset: number): AgentInput[] {
    return hold?.inputs.filter((input) => input.offset >= offset) ?? [];
  }

  function nap(hold: Hold | null, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        hold?.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      hold?.wakers.add(done);
    });
  }

  /**
   * Observes until the wait rule says done. `startup`: the shell was just started, so its first
   * output counts as a line that went in, and it is done once it reads a line.
   */
  async function settle(first: TerminalSnapshot, hold: Hold | null, cursor: number, timeoutMs: number, signal: AbortSignal, startup = false) {
    const id = first.id as TerminalId;
    const startedAt = clock.now();
    const deadline = startedAt + Math.min(Math.max(timeoutMs, 0), WAIT_MAX_MS);
    let snapshot = first;
    for (;;) {
      const now = clock.now();
      const current = ports.terminal(id);
      if (current) snapshot = current;
      const window = windowOf(snapshot);
      const from = Math.max(cursor, windowStart(window));
      const typed = typedSince(hold, cursor);
      const modes = modesOf(window);
      const end: TerminalEnd | null = !current ? ended.get(id)?.end ?? { kind: "closed" }
        : current.state.kind === "exited" ? { kind: "exited", code: current.state.code } : null;
      const step = stepTerminalWait({
        now,
        deadline,
        aborted: signal.aborted,
        end,
        news: startup ? (window.offset > from ? "entered" : "none") : newsSince(window, from, typed.length > 0),
        overPage: pageEnd(window, from, PAGE) < window.offset,
        lastActivityAt: Math.max(hold?.lastOutputAt ?? 0, ...typed.map((input) => input.at)),
        front: frontOf(modes, modes.bracketedPaste === "unknown" && !end ? ports.foreground(id) : NO_FOREGROUND),
        endsInText: endsInText(window),
        alternateScreen: modes.alternateScreen,
      });
      if (step.kind === "done") return { reason: step.reason, waitedMs: now - startedAt, snapshot, current, typed, end };
      await nap(hold, step.recheckInMs, signal);
    }
  }

  async function watch(first: TerminalSnapshot, hold: Hold | null, cursor: number, timeoutMs: number, signal: AbortSignal): Promise<TerminalWaited> {
    const { reason, waitedMs, snapshot, current, typed, end } = await settle(first, hold, cursor, timeoutMs, signal);
    const { page, cursor: next } = await since(snapshot, cursor);
    return {
      kind: "waited",
      reason: reason === "timeout" && timeoutMs <= 0 ? "now" : reason,
      waitedMs,
      // TM dropped it: the last snapshot still reads as running and shown.
      terminal: current ? info(current) : {
        ...info(snapshot), state: end?.kind === "exited" ? end : { kind: "closed" }, foreground: NO_FOREGROUND, shownInPiWeb: false,
      },
      page,
      typed,
      cursor: next,
      foreign: false,
      live: end ? (await runningIn(await ports.realpath(snapshot.cwd))).map(info) : [],
    };
  }

  return {
    async list({ cwd }) {
      const all = terminals();
      if (cwd === undefined) return { terminals: all.map(info) };
      const roots = new Set([await canonicalDirectory(ports, cwd)]);
      const real = await realpaths(all);
      return { terminals: all.filter((_, index) => isPathWithinRoots(real[index], roots)).map(info) };
    },

    async open(cwd, signal) {
      const dir = await canonicalDirectory(ports, cwd);
      const joinable = (await runningIn(dir))[0];
      let snapshot = joinable;
      if (!snapshot) {
        let id: TerminalId;
        try {
          id = ports.start(dir);
        } catch (error) {
          throw new ToolError(`pi-web could not start a shell in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
        started.set(id, clock.now());
        const fresh = ports.terminal(id);
        if (!fresh) throw new ToolError(`The new shell in ${dir} ended at once.`);
        // It has printed nothing yet. A cursor from before its first prompt would make the
        // agent's first send read the prompt as the person typing, and type nothing.
        snapshot = (await settle(fresh, touch(fresh), 0, START_WAIT_MS, signal, true)).current ?? fresh;
      }
      touch(snapshot);
      return { joined: joinable !== undefined, terminal: info(snapshot), ...await latest(snapshot, PAGE) };
    },

    async read(id, before) {
      const snapshot = ports.terminal(id);
      if (!snapshot) return gone(id);
      if (!before || isForeign(id, before, snapshot)) {
        return { kind: "latest", terminal: info(snapshot), ...await latest(snapshot, READ_PAGE), foreign: before !== null };
      }
      const window = windowOf(snapshot);
      const end = Math.max(before.offset, windowStart(window));
      const from = pageStart(window, end, READ_PAGE);
      const rendered = await render(window, from, end);
      return {
        kind: "before",
        terminal: info(snapshot),
        page: { ...rendered, lost: 0, more: false, earlier: from > windowStart(window) ? from : null },
      };
    },

    async send(id, request, cursor, timeoutMs, signal) {
      const snapshot = ports.terminal(id);
      if (!snapshot) return gone(id);
      if (snapshot.state.kind === "exited") {
        throw new ToolError(`Terminal ${id} exited with code ${snapshot.state.code}; nothing was typed. pi_terminal_open starts a new shell in ${snapshot.cwd}.`);
      }
      const encoded = encodeInput(request, modesOf(windowOf(snapshot)));
      if (!encoded.ok) throw new ToolError(encoded.error);
      const hold = touch(snapshot);
      if (cursor && request.text) {
        const typed = typedSince(hold, cursor.offset);
        const reason = isForeign(id, cursor, snapshot) ? "foreign"
          : typed.length > 0 ? "already-typed"
          : snapshot.offset > cursor.offset ? "changed"
          : null;
        if (reason) {
          const shown = reason === "foreign" ? await latest(snapshot, PAGE) : await since(snapshot, cursor.offset);
          return { kind: "refused", reason, terminal: info(snapshot), typed, ...shown };
        }
      }
      const from = cursor && !isForeign(id, cursor, snapshot) ? cursor.offset : snapshot.offset;
      if (!ports.write(id, encoded.data)) throw new ToolError(`Terminal ${id} ended before the input reached it; nothing was typed.`);
      hold?.inputs.push({ offset: snapshot.offset, shown: encoded.shown, at: clock.now() });
      if (hold && hold.inputs.length > MAX_INPUTS) hold.inputs.splice(0, hold.inputs.length - MAX_INPUTS);
      return { kind: "typed", shown: encoded.shown, wait: await watch(snapshot, hold, from, timeoutMs, signal) };
    },

    async wait(id, cursor, timeoutMs, signal) {
      const snapshot = ports.terminal(id);
      if (!snapshot) return gone(id);
      const hold = touch(snapshot);
      if (isForeign(id, cursor, snapshot)) {
        return {
          kind: "waited", reason: "now", waitedMs: 0, terminal: info(snapshot), ...await latest(snapshot, PAGE),
          typed: [], foreign: true, live: [],
        };
      }
      return watch(snapshot, hold, cursor.offset, timeoutMs, signal);
    },

    async close(id) {
      const snapshot = ports.terminal(id);
      if (!snapshot) return gone(id);
      const terminal = info(snapshot);
      recordEnd(id, snapshot.cwd, { kind: "closed" }, "agent");
      ports.close(id);
      return { kind: "closed", terminal };
    },
  };
}
