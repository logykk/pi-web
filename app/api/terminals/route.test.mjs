import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-terminals-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = path.join(scratch, "agent");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../lib/allowed-roots.ts");
const { processGlobal } = await jiti.import("../../../lib/mcp-endpoint/process-global.ts");
const { createTerminalDeskMemory } = await jiti.import("../../../lib/mcp-endpoint/terminal-desk.ts");

const previousTerminals = globalThis.__piWebTerminals;
test.after(async () => {
  globalThis.__piWebTerminals = previousTerminals;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(scratch, { recursive: true, force: true });
});

const hex = (n) => n.toString(16).padStart(8, "0").repeat(4);

function record(cwd, { exited = false } = {}) {
  return { cwd, pty: { pid: 1, cols: 80, rows: 24 }, listeners: new Set(), backlog: "", offset: 0, exited, exitCode: exited ? 0 : null, cleanupTimer: null };
}

const get = async (cwd) => {
  const response = await GET(new Request(`http://localhost/api/terminals${cwd === undefined ? "" : `?cwd=${encodeURIComponent(cwd)}`}`));
  return { status: response.status, body: await response.json() };
};

test("lists the running terminals an agent started or holds in the folder, newest agent touch first, matched by real path", async () => {
  const project = path.join(scratch, "project");
  const elsewhere = path.join(scratch, "elsewhere");
  await mkdir(project);
  await mkdir(elsewhere);
  const linked = path.join(scratch, "linked");
  await symlink(project, linked);
  allowFileRoot(project);
  allowFileRoot(elsewhere);

  const [started, held, persons, exited, other] = [1, 2, 3, 4, 5].map(hex);
  globalThis.__piWebTerminals = new Map([
    [started, record(project)],
    [held, record(linked)],
    [persons, record(project)],
    [exited, record(project, { exited: true })],
    [other, record(elsewhere)],
  ]);
  const memory = processGlobal("terminal-desk", createTerminalDeskMemory);
  memory.started.set(started, 1_000);
  memory.started.set(exited, 3_000);
  memory.started.set(other, 4_000);
  memory.holds.set(held, { touchedAt: 2_000 });

  assert.deepEqual(await get(project), { status: 200, body: { terminals: [{ id: held }, { id: started }] } });
  assert.deepEqual(await get(linked), { status: 200, body: { terminals: [{ id: held }, { id: started }] } });
  assert.deepEqual((await get(elsewhere)).body, { terminals: [{ id: other }] });
});

test("a folder outside pi-web's allowed roots is refused, and a missing cwd is a bad request", async () => {
  const outside = path.join(scratch, "outside");
  await mkdir(outside);
  assert.deepEqual(await get(outside), { status: 403, body: { error: "Access denied" } });
  assert.deepEqual(await get(path.join(scratch, "missing")), { status: 403, body: { error: "Access denied" } });
  assert.equal((await get(undefined)).status, 400);
});
