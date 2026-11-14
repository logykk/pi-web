// When a wait is over, as a pure state machine. desk.ts feeds it one observation per wake-up (an
// event from the session, a tick, the settle timer, the deadline); it answers whether to keep
// waiting and how long until it must be asked again without an event.
//
// Why a quiet period: pi's SDK clears its run flag before it awaits the extensions'
// agent_settled handlers, and a prompt that arrives meanwhile is deferred and starts its run
// right after the emit, so a listener can read the session idle while the next run is a
// microtask away. `prompt_done` is no help: pi-web emits it only for prompts without
// streamingBehavior (never the endpoint's), never for runs the person or a subagent report
// started. So rest is "not busy, with something new, continuously for SETTLE_MS".

export const SETTLE_MS = 600;
/** Re-check cadence with no event: subagent state and the agent's sends in flight change silently. */
export const TICK_MS = 1_000;

export interface RestObservation {
  readonly now: number;
  readonly deadline: number;
  /** The client went away or pi-web is stopping. */
  readonly aborted: boolean;
  /** isRunning(): a prompt admitted, a run streaming, compaction, a `!` command. */
  readonly running: boolean;
  /** A subagent of this session can still report back, and each report starts a run here. */
  readonly subagentsActive: boolean;
  /** The agent's own sends pi has neither taken nor refused yet. */
  readonly sendsInFlight: number;
  /** Visible entries after the cursor, a moved branch, or delivery news after cursor.at. */
  readonly hasNews: boolean;
  /** dialogDigest() of the blocking dialogs open now, and how many there are. */
  readonly dialogs: string;
  readonly dialogCount: number;
  /** The digest the agent's cursor carries: the dialogs it has been shown. */
  readonly cursorDialogs: string;
}

export type RestReason =
  /** pi is at rest and there is something new. */
  | "settled"
  /** A blocking dialog the agent has not been shown is open. */
  | "dialog"
  /** The deadline passed (with the progress so far). */
  | "timeout"
  | "aborted";

export type RestPhase =
  | { readonly kind: "watching" }
  | { readonly kind: "settling"; readonly since: number }
  | { readonly kind: "done"; readonly reason: RestReason };

function next(phase: RestPhase, obs: RestObservation): RestPhase {
  if (obs.aborted) return { kind: "done", reason: "aborted" };
  // A dialog already shown (the same digest) does not end the next wait: the agent left it to the person.
  if (obs.dialogCount > 0 && obs.dialogs !== obs.cursorDialogs) return { kind: "done", reason: "dialog" };
  if (obs.running || obs.subagentsActive || obs.sendsInFlight > 0 || !obs.hasNews) return { kind: "watching" };
  if (phase.kind !== "settling") return { kind: "settling", since: obs.now };
  return obs.now - phase.since >= SETTLE_MS ? { kind: "done", reason: "settled" } : phase;
}

export function stepRest(phase: RestPhase, obs: RestObservation): RestPhase {
  if (phase.kind === "done") return phase;
  const stepped = next(phase, obs);
  return stepped.kind !== "done" && obs.now >= obs.deadline ? { kind: "done", reason: "timeout" } : stepped;
}

/** Ms until the next unprompted check: settle end, deadline, or TICK_MS, whichever is first (>= 0). */
export function recheckIn(phase: RestPhase, obs: Pick<RestObservation, "now" | "deadline">): number {
  const until = [TICK_MS, obs.deadline - obs.now];
  if (phase.kind === "settling") until.push(phase.since + SETTLE_MS - obs.now);
  return Math.max(0, Math.min(...until));
}
