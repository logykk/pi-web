// Client-safe: pi's refusal of a plain prompt while its agent runs, which the page
// gets when another client (an MCP agent, another tab) started a run first.
import { isPromptRejectedError } from "./agent-client";

/** How pi's refusal starts. The rest of its sentence names pi's options, which may change. */
export const AGENT_BUSY_REFUSAL = "Agent is already processing";

export function isAgentBusyRefusal(error: unknown): boolean {
  return isPromptRejectedError(error) && error.message.startsWith(AGENT_BUSY_REFUSAL);
}
