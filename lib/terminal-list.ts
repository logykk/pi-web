export type TerminalState = { readonly kind: "running" } | { readonly kind: "exited"; readonly code: number };

export interface TerminalSnapshot {
  readonly id: string;
  readonly cwd: string;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  readonly offset: number;
  readonly backlog: string;
  readonly state: TerminalState;
  readonly listeners: number;
}

type TerminalRecord = NonNullable<typeof globalThis.__piWebTerminals> extends Map<string, infer R> ? R : never;

function records(): Map<string, TerminalRecord> | null {
  const terminals = globalThis.__piWebTerminals;
  return terminals instanceof Map ? terminals : null;
}

function snapshotOf(id: string, record: TerminalRecord): TerminalSnapshot {
  return {
    id,
    cwd: record.cwd,
    pid: record.pty.pid,
    cols: record.pty.cols,
    rows: record.pty.rows,
    offset: record.offset,
    backlog: record.backlog,
    state: record.exited ? { kind: "exited", code: record.exitCode ?? -1 } : { kind: "running" },
    listeners: record.listeners.size,
  };
}

export function terminalSnapshots(): TerminalSnapshot[] {
  return [...records() ?? []].map(([id, record]) => snapshotOf(id, record));
}

export function terminalSnapshot(id: string): TerminalSnapshot | null {
  const record = records()?.get(id);
  return record ? snapshotOf(id, record) : null;
}
