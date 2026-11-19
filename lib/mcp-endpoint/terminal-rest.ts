import type { TerminalEnd } from "./ports";
import type { News, StreamModes } from "./terminal-stream";

/** A line editor that has been quiet this long read the line and is waiting for the next. */
export const READY_QUIET_MS = 300;
/** A program quiet this long after printing a prompt (or drawing a screen) probably waits for input. */
export const PAUSE_QUIET_MS = 2_000;
export const TERMINAL_TICK_MS = 250;

export type TerminalWaitReason = "ready" | "paused" | "more" | "exited" | "closed" | "timeout" | "aborted";

/** Who reads the keyboard: a shell or REPL reading a line, a program, or no way to tell. */
export type Front = "line-editor" | "program" | "unknown";

export interface TerminalObservation {
  readonly now: number;
  readonly deadline: number;
  readonly aborted: boolean;
  readonly end: TerminalEnd | null;
  readonly news: News;
  /** More output since the cursor than one page holds. */
  readonly overPage: boolean;
  /** The terminal's last output, or the agent's last input, whichever is later. */
  readonly lastActivityAt: number;
  readonly front: Front;
  readonly endsInText: boolean;
  readonly alternateScreen: boolean;
}

export type TerminalStep =
  | { readonly kind: "done"; readonly reason: TerminalWaitReason }
  | { readonly kind: "watching"; readonly recheckInMs: number };

/**
 * The bracketed-paste toggle tells a line editor from a program: bash 5 and Python's REPL turn it
 * on while they read a line and off on Enter. Without a toggle in the window, the foreground
 * process group stands in (Linux only). `pty.process` is no help: it names a pipeline's first command.
 */
export function frontOf(modes: StreamModes, foreground: { readonly kind: "shell" | "program" | "unknown" }): Front {
  if (modes.alternateScreen) return "program";
  if (modes.bracketedPaste !== "unknown") return modes.bracketedPaste === "on" ? "line-editor" : "program";
  return foreground.kind === "shell" ? "line-editor" : foreground.kind;
}

function done(reason: TerminalWaitReason): TerminalStep {
  return { kind: "done", reason };
}

/** Whether a wait is over. Cheap raw facts only; the reply renders once, at the end. */
export function stepTerminalWait(observation: TerminalObservation): TerminalStep {
  const { now, deadline } = observation;
  if (observation.aborted) return done("aborted");
  if (observation.end) return done(observation.end.kind);
  if (observation.overPage) return done("more");
  // Typing (the person editing a line) never ends a wait: only a line that went in does.
  if (observation.news === "entered") {
    const quiet = now - observation.lastActivityAt;
    if (observation.front === "line-editor" && quiet >= READY_QUIET_MS) return done("ready");
    const waitsOnInput = observation.endsInText || observation.alternateScreen || observation.front === "unknown";
    if (waitsOnInput && quiet >= PAUSE_QUIET_MS) return done("paused");
  }
  if (now >= deadline) return done("timeout");
  return { kind: "watching", recheckInMs: Math.min(TERMINAL_TICK_MS, deadline - now) };
}
