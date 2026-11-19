/**
 * Pure facts about a terminal's raw output, read from terminal-manager's backlog: where a page may
 * end, which modes the programs in it set, what kind of news a span holds, and the agent's cursor.
 * Offsets are TM's: UTF-16 units since the shell started.
 */

export interface TerminalWindow {
  /** The last 131072 units at most. */
  readonly backlog: string;
  /** TM's offset after the backlog's last unit. */
  readonly offset: number;
  readonly cols: number;
  readonly rows: number;
}

export function windowBase(window: TerminalWindow): number {
  return window.offset - window.backlog.length;
}

/**
 * The first offset a render reads. A window that lost its beginning starts after its first line
 * break, so no render starts inside a line or an escape sequence.
 */
export function windowStart(window: TerminalWindow): number {
  const base = windowBase(window);
  if (base === 0) return 0;
  const lineBreak = window.backlog.indexOf("\n");
  return lineBreak < 0 ? base : base + lineBreak + 1;
}

/** A page's cost: each unit, plus one per line break for the `| ` a reply puts before each line. */
function cost(code: number): number {
  return code === 10 ? 2 : 1;
}

/**
 * Where a forward page from `from` ends. After the last line break within the budget; a single
 * longer line is taken whole (the reply clips it), because a render shows whole logical lines and
 * a cut inside one would show it again on the next page. Output with no line break left is taken
 * to the end.
 */
export function pageEnd(window: TerminalWindow, from: number, budget: number): number {
  const base = windowBase(window);
  const text = window.backlog;
  let spent = 0;
  let lastBreak = -1;
  for (let i = Math.max(from, windowStart(window)) - base; i < text.length; i++) {
    spent += cost(text.charCodeAt(i));
    if (spent > budget) {
      if (lastBreak >= 0) return base + lastBreak + 1;
      const next = text.indexOf("\n", i);
      return next < 0 ? window.offset : base + next + 1;
    }
    if (text.charCodeAt(i) === 10) lastBreak = i;
  }
  return window.offset;
}

/**
 * Where a page that ends at `end` starts: the earliest line start whose lines fit the budget, or
 * the start of the line before `end` when that line alone does not; never before `windowStart`.
 */
export function pageStart(window: TerminalWindow, end: number, budget: number): number {
  const base = windowBase(window);
  const text = window.backlog;
  const floor = windowStart(window) - base;
  let spent = 0;
  let chosen = -1;
  for (let i = end - base - 1; i >= floor; i--) {
    spent += cost(text.charCodeAt(i));
    if (i !== floor && text.charCodeAt(i - 1) !== 10) continue;
    if (spent > budget && chosen >= 0) break;
    chosen = i;
    if (spent > budget) break;
  }
  return chosen < 0 ? Math.max(end, floor + base) : base + chosen;
}

export interface StreamModes {
  /** Bash 5 and Python's REPL set it while they read a line, and clear it on Enter. */
  readonly bracketedPaste: "on" | "off" | "unknown";
  readonly alternateScreen: boolean;
  readonly applicationCursorKeys: boolean;
}

function lastToggle(text: string, modes: readonly string[]): "on" | "off" | "unknown" {
  let at = -1;
  let state: "on" | "off" | "unknown" = "unknown";
  for (const mode of modes) {
    for (const [suffix, value] of [["h", "on"], ["l", "off"]] as const) {
      const found = text.lastIndexOf(`\x1b[?${mode}${suffix}`);
      if (found > at) {
        at = found;
        state = value;
      }
    }
  }
  return state;
}

/** The last toggle of each mode in the window; a mode set before the window is not seen. */
export function modesOf(window: TerminalWindow): StreamModes {
  const text = window.backlog;
  return {
    bracketedPaste: lastToggle(text, ["2004"]),
    alternateScreen: lastToggle(text, ["1049", "1047", "47"]) === "on",
    applicationCursorKeys: lastToggle(text, ["1"]) === "on",
  };
}

/**
 * What changed after a cursor. `entered`: a line went in (a line break, a line editor reading
 * again, a full-screen program starting or ending, or the agent's own input). `typing`: only the
 * line being edited changed, the person typing, which never ends a wait.
 */
export type News = "none" | "typing" | "entered";

const ENTERED = /\n|\x1b\[\?(?:2004h|1049[hl]|1047[hl]|47[hl])/;

export function newsSince(window: TerminalWindow, cursor: number, agentTyped: boolean): News {
  if (agentTyped) return "entered";
  if (cursor >= window.offset) return "none";
  const text = window.backlog.slice(Math.max(cursor - windowBase(window), 0));
  return ENTERED.test(text) ? "entered" : "typing";
}

// CSI, OSC (BEL or ST), DCS/APC/PM strings, charset designations, and other two-character escapes.
const ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P_^][^\x1b]*\x1b\\|[()*+][0-9A-Za-z]|[@-Z\\-_=>78c])/g;

/** True when the output's last visible character is not a line end: a prompt such as `[Y/n] ` waits on it. */
export function endsInText(window: TerminalWindow): boolean {
  const tail = window.backlog.slice(-512).replace(ESCAPE_SEQUENCE, "").replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
  return tail.length > 0 && !/[\r\n]$/.test(tail);
}

/** `term~<the id's first 8 hex>~<offset base36>`. */
export interface TerminalCursor {
  readonly tag: string;
  readonly offset: number;
}

const CURSOR = /^term~([0-9a-f]{8})~([0-9a-z]{1,11})$/;

export function encodeTerminalCursor(id: string, offset: number): string {
  return `term~${id.slice(0, 8)}~${offset.toString(36)}`;
}

export function decodeTerminalCursor(text: string): TerminalCursor | null {
  const match = CURSOR.exec(text.trim());
  if (!match) return null;
  const offset = parseInt(match[2], 36);
  return Number.isSafeInteger(offset) ? { tag: match[1], offset } : null;
}
