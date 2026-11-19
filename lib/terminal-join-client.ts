import { newTerminalTab, type TerminalTab } from "../components/terminal-tab-state";

/**
 * Fork (/mcp terminals): a live terminal an /mcp agent started or holds in `cwd`, as a tab that
 * attaches to it (a restored tab GETs and streams, never starts a shell). It keeps the browser's
 * `cwd` string, so the one-tab-per-folder match keeps working. Null when there is none or the
 * lookup fails: the button then starts a shell as before.
 */
export async function joinableTerminalTab(cwd: string): Promise<{ id: string; cwd: string; restored: true } | null> {
  try {
    const response = await fetch(`/api/terminals?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const id = ((await response.json()) as { terminals?: { id?: unknown }[] }).terminals?.[0]?.id;
    return typeof id === "string" && /^[a-f0-9]{32}$/.test(id) ? { id, cwd, restored: true } : null;
  } catch {
    return null;
  }
}

const lookups = new Map<string, Promise<TerminalTab>>();

/**
 * Fork (/mcp terminals): the tab the terminal button opens in `cwd`: the agent's terminal to join,
 * else a new shell. Calls for one folder while its lookup runs share it and get the same tab, so a
 * double click across the lookup adds one tab, as upstream's synchronous handler did.
 */
export function terminalTabFor(cwd: string): Promise<TerminalTab> {
  const pending = lookups.get(cwd);
  if (pending) return pending;
  const lookup = joinableTerminalTab(cwd)
    .then((joined) => joined ?? newTerminalTab(cwd))
    .finally(() => lookups.delete(cwd));
  lookups.set(cwd, lookup);
  return lookup;
}
