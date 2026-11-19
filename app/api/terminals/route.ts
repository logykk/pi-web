import { realpath } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { agentTerminalIds } from "@/lib/mcp-endpoint/terminal-desk";
import { terminalSnapshots } from "@/lib/terminal-list";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Fork (/mcp terminals): the running terminals in `cwd` that an /mcp agent started or holds, newest
 * agent touch first, for pi-web's terminal button to join. Folders match by real path: a browser's
 * terminal keeps `path.resolve(cwd)`, an agent's the real path. A person's own terminals are never
 * listed, so two browser windows still get a shell each, as upstream.
 */
export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd?.trim()) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  const target = resolve(cwd);
  if (!isExistingFilePathAllowed(target, await getAllowedFileRoots())) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  const folder = await realpath(target);
  const running = new Map(terminalSnapshots().filter((terminal) => terminal.state.kind === "running").map((terminal) => [terminal.id, terminal]));
  const terminals: { id: string }[] = [];
  for (const id of agentTerminalIds()) {
    const terminal = running.get(id);
    if (terminal && await realpath(terminal.cwd).catch(() => terminal.cwd) === folder) terminals.push({ id });
  }
  return NextResponse.json({ terminals });
}
