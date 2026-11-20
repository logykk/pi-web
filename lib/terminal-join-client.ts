import { newTerminalTab, type TerminalTab } from "../components/terminal-tab-state";

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

export function terminalTabFor(cwd: string): Promise<TerminalTab> {
  const pending = lookups.get(cwd);
  if (pending) return pending;
  const lookup = joinableTerminalTab(cwd)
    .then((joined) => joined ?? newTerminalTab(cwd))
    .finally(() => lookups.delete(cwd));
  lookups.set(cwd, lookup);
  return lookup;
}
