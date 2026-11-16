import { isPromptRejectedError } from "./agent-client";

/** How pi's refusal starts. The rest of its sentence names pi's options, which may change. */
export const AGENT_BUSY_REFUSAL = "Agent is already processing";

export function isAgentBusyRefusal(error: unknown): boolean {
  return isPromptRejectedError(error) && error.message.startsWith(AGENT_BUSY_REFUSAL);
}
