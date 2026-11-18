import type { TerminalEnd } from "./ports";
import type { News, StreamModes } from "./terminal-stream";

export const READY_QUIET_MS = 300;
export const PAUSE_QUIET_MS = 2_000;
export const TERMINAL_TICK_MS = 250;

export type TerminalWaitReason = "ready" | "paused" | "more" | "exited" | "closed" | "timeout" | "aborted";

export type Front = "line-editor" | "program" | "unknown";

export interface TerminalObservation {
  readonly now: number;
  readonly deadline: number;
  readonly aborted: boolean;
  readonly end: TerminalEnd | null;
  readonly news: News;
  readonly overPage: boolean;
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
 * on while they read a line and off on Enter.
 */
export function frontOf(modes: StreamModes, foreground: { readonly kind: "shell" | "program" | "unknown" }): Front {
  if (modes.alternateScreen) return "program";
  if (modes.bracketedPaste !== "unknown") return modes.bracketedPaste === "on" ? "line-editor" : "program";
  return foreground.kind === "shell" ? "line-editor" : foreground.kind;
}

function done(reason: TerminalWaitReason): TerminalStep {
  return { kind: "done", reason };
}

export function stepTerminalWait(observation: TerminalObservation): TerminalStep {
  const { now, deadline } = observation;
  if (observation.aborted) return done("aborted");
  if (observation.end) return done(observation.end.kind);
  if (observation.overPage) return done("more");
  if (observation.news === "entered") {
    const quiet = now - observation.lastActivityAt;
    if (observation.front === "line-editor" && quiet >= READY_QUIET_MS) return done("ready");
    const waitsOnInput = observation.endsInText || observation.alternateScreen || observation.front === "unknown";
    if (waitsOnInput && quiet >= PAUSE_QUIET_MS) return done("paused");
  }
  if (now >= deadline) return done("timeout");
  return { kind: "watching", recheckInMs: Math.min(TERMINAL_TICK_MS, deadline - now) };
}
