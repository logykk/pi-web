// What an agent can do in pi sessions, in co-driving terms, behind one small object. Every
// operation returns within a bound and returns domain results; tools.ts turns them into text.
// Written against ports.ts only, so it is tested with fakes.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { PiWebPorts, SessionRow } from "./ports";

export class DeskError extends Error {
  constructor(readonly kind: "not-found" | "bad-input" | "unavailable", message: string) {
    super(message);
  }
}

export interface Desk {
  sessions(filter: { cwd?: string; limit: number }): Promise<{ rows: SessionRow[]; total: number }>;
}

export function createDesk(ports: PiWebPorts): Desk {
  return {
    async sessions({ cwd, limit }) {
      const dir = cwd === undefined ? null : canonicalDirectory(cwd);
      const rows = (await ports.listSessions())
        .filter((row) => dir === null || row.cwd === dir || row.cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep));
      return { rows: rows.slice(0, limit), total: rows.length };
    },
  };
}

/**
 * The spelling pi-web already uses for a folder, so the agent's sessions group with the person's:
 * `~` expanded, absolute, an existing directory, then its realpath (the directory picker selects
 * the realpath, and pi's TUI uses the physical cwd). Any directory is allowed: the token is as
 * strong as the web password, and the web UI can open any folder too. The rule is one cwd per
 * folder, not containment.
 */
export function canonicalDirectory(input: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) throw new DeskError("bad-input", `${JSON.stringify(input)} is not an absolute path (or ~/…) on pi-web's machine.`);
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    throw new DeskError("bad-input", `${expanded} does not exist on pi-web's machine.`);
  }
  if (!statSync(real).isDirectory()) throw new DeskError("bad-input", `${real} is a file, not a folder.`);
  return real;
}
