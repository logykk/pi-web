// The tools an agent sees, and how each turns a desk result into text for the model. Each tool's
// schema is its contract twice over: tools/list publishes it and validateArgs enforces it, and
// ArgsOf<> derives `run`'s argument type from it (jsonrpc.ts).

import packageJson from "../../package.json";
import { createDesk, DeskError, type Desk } from "./desk";
import { defineTool, type McpServerDefinition, type ToolSpec, type ToolText } from "./jsonrpc";
import { piWebPorts, type SessionRow } from "./ports";

export const INSTRUCTIONS = [
  "These tools work in pi sessions of a pi-web server. A person may be using the same session in pi-web's browser UI at the same time.",
  "Find a session with pi_sessions.",
].join(" ");

export function createTools(desk: Desk): ToolSpec[] {
  return [
    defineTool({
      name: "pi_sessions",
      title: "List pi sessions",
      description: "List pi sessions on this pi-web, newest first: id, state (working, waiting for an answer, idle), title, folder and git branch. Subagent and side-chat sessions are left out. Use it to find the session the person has open.",
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", minLength: 1, description: "Only sessions in this folder or below it." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (args) => guarded(async () => renderSessionList(await desk.sessions({ cwd: args.cwd, limit: args.limit }))),
    }),
  ];
}

let definition: McpServerDefinition | null = null;

export function mcpServer(): McpServerDefinition {
  definition ??= {
    name: "pi-web",
    title: "pi-web",
    version: packageJson.version,
    instructions: INSTRUCTIONS,
    tools: createTools(createDesk(piWebPorts())),
  };
  return definition;
}

/** A DeskError is the agent's to act on: its message becomes an isError result. Anything else is a bug for dispatch() to log. */
async function guarded(run: () => Promise<ToolText>): Promise<ToolText> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DeskError) return { text: error.message, isError: true };
    throw error;
  }
}

/** One line, at most `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATE_LABEL: Readonly<Record<SessionRow["state"], string>> = {
  working: "working",
  waiting: "waiting for an answer",
  idle: "idle",
};

function renderSessionList({ rows, total }: { rows: readonly SessionRow[]; total: number }): ToolText {
  if (total === 0) return { text: "No pi sessions match." };
  const lines = [total > rows.length ? `${total} sessions; the newest ${rows.length}:` : `${total} session${total === 1 ? "" : "s"}, newest first:`];
  for (const row of rows) {
    const where = row.branch ? `${row.cwd} (${row.isWorktree ? "worktree, " : ""}branch ${row.branch})` : row.cwd;
    lines.push(`- ${row.id} [${STATE_LABEL[row.state]}] "${oneLine(row.title, 80)}" in ${where}, last active ${row.modified}`);
  }
  return { text: lines.join("\n") };
}
