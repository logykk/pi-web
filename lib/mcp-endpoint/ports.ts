// The seam to pi-web's internals. Everything the MCP endpoint needs from upstream code goes
// through PiWebPorts, and piWebPorts() is the only place that imports rpc-manager,
// session-reader, worktree and friends. A rebase that reshapes one of them breaks this file's
// typecheck and nothing else; desk.ts is written against these interfaces and tested with fakes.

import { getAwaitingInputRpcSessionIds, getRpcSessionInfos, getRunningRpcSessionIds } from "../rpc-manager";
import { attachSessionProjectInfo, listAllSessions, mergeSessionLists } from "../session-reader";
import { isHiddenRelation } from "../session-family";

export interface SessionRow {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly isWorktree: boolean;
  readonly modified: string;
  readonly state: "working" | "waiting" | "idle";
}

export interface PiWebPorts {
  /** The sidebar's list, newest first: saved and live-only rows, subagents and side chats left out. */
  listSessions(): Promise<SessionRow[]>;
}

export function piWebPorts(): PiWebPorts {
  return {
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
  };
}
