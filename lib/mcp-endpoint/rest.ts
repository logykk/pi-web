// Why a quiet period: pi's SDK clears its run flag before it awaits the extensions'
// agent_settled handlers, and a prompt that arrives meanwhile is deferred and starts its run
// right after the emit, so a listener can read the session idle while the next run is a
// microtask away. `prompt_done` is no help: pi-web emits it only for prompts without
// streamingBehavior (never the endpoint's), never for runs the person or a subagent report
// started.

export const SETTLE_MS = 600;
export const TICK_MS = 1_000;

/** pi works for someone: a run, subagents that will report back, or the agent's own send on its way. */
export function isBusy(status: { readonly running: boolean; readonly subagentsActive: boolean; readonly sendsInFlight: number }): boolean {
  return status.running || status.subagentsActive || status.sendsInFlight > 0;
}

export interface RestObservation {
  readonly now: number;
  readonly deadline: number;
  readonly aborted: boolean;
  readonly busy: boolean;
  readonly hasNews: boolean;
  /** An open dialog the agent's cursor has not seen. */
  readonly unseenDialog: boolean;
}

export type RestReason =
  | "settled"
  | "dialog"
  | "timeout"
  | "aborted";

export type RestPhase =
  | { readonly kind: "watching" }
  | { readonly kind: "settling"; readonly since: number }
  | { readonly kind: "done"; readonly reason: RestReason };

type OpenPhase = Exclude<RestPhase, { kind: "done" }>;

function next(phase: OpenPhase, obs: RestObservation): RestPhase {
  if (obs.aborted) return { kind: "done", reason: "aborted" };
  if (obs.unseenDialog) return { kind: "done", reason: "dialog" };
  if (obs.busy || !obs.hasNews) return { kind: "watching" };
  if (phase.kind !== "settling") return { kind: "settling", since: obs.now };
  return obs.now - phase.since >= SETTLE_MS ? { kind: "done", reason: "settled" } : phase;
}

export function stepRest(phase: OpenPhase, obs: RestObservation): RestPhase {
  const stepped = next(phase, obs);
  return stepped.kind !== "done" && obs.now >= obs.deadline ? { kind: "done", reason: "timeout" } : stepped;
}

export function recheckIn(phase: OpenPhase, obs: Pick<RestObservation, "now" | "deadline">): number {
  const until = [TICK_MS, obs.deadline - obs.now];
  if (phase.kind === "settling") until.push(phase.since + SETTLE_MS - obs.now);
  return Math.max(0, Math.min(...until));
}
