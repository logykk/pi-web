import { Terminal, type IBuffer, type IMarker } from "@xterm/xterm";
import { windowBase, windowStart, type TerminalWindow } from "./terminal-stream";

export interface Screen {
  readonly rows: readonly string[];
  /** 0-based. */
  readonly cursor: { readonly row: number; readonly col: number };
}

export interface RenderedSpan {
  /** Logical lines (wrapped rows joined) added or changed from `from` to `to`, oldest first. */
  readonly lines: readonly string[];
  /** The alternate screen at `to`, while a full-screen program shows one. */
  readonly screen: Screen | null;
  /**
   * The checkpoint's line and every screen row above it are gone (`clear` erased them): `lines`
   * start at the oldest row left.
   */
  readonly trimmed: boolean;
}

/** Injected into the terminal desk, whose tests run on mocked timers that would stall xterm's parser. */
export type RenderSpan = (window: TerminalWindow, from: number, to: number) => Promise<RenderedSpan>;

interface MarkedRow {
  readonly row: number;
  readonly marker: IMarker;
  readonly text: string;
}

/**
 * A marker on each screen row from the top down to the start of the cursor's logical line. xterm
 * moves a marker as rows leave a full buffer, and disposes it when its row is erased (`clear`, or
 * erase-below after a cursor-up redraw), so any marker left tells where the others are now.
 */
interface Checkpoint {
  readonly above: readonly MarkedRow[];
  readonly line: MarkedRow;
  /** The cursor's whole logical line. */
  readonly text: string;
}

const ALTERNATE_SCREEN_EXIT = /\x1b\[\?(?:1049|1047|47)l/;

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/** A cell written with a space is content to xterm; a reader sees a blank. */
function rowText(buffer: IBuffer, row: number): string {
  return buffer.getLine(row)?.translateToString(true).trimEnd() ?? "";
}

function lineStart(buffer: IBuffer, row: number): number {
  while (row > 0 && buffer.getLine(row)?.isWrapped) row--;
  return row;
}

/** The last row with text, or the cursor's row when that is later. */
function lastRow(buffer: IBuffer): number {
  const cursor = buffer.baseY + buffer.cursorY;
  for (let row = buffer.length - 1; row > cursor; row--) if (rowText(buffer, row)) return row;
  return cursor;
}

/** Wrapped rows joined: a row that continues on the next keeps its trailing blanks. */
function logicalLines(buffer: IBuffer, first: number, last: number): string[] {
  const lines: string[] = [];
  for (let row = first; row <= last; row++) {
    const line = buffer.getLine(row);
    const continues = row < last && buffer.getLine(row + 1)?.isWrapped === true;
    const text = continues ? line?.translateToString(false) ?? "" : rowText(buffer, row);
    if (row > first && line?.isWrapped) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

function takeCheckpoint(terminal: Terminal): Checkpoint {
  const buffer = terminal.buffer.normal;
  const cursor = buffer.baseY + buffer.cursorY;
  const start = lineStart(buffer, cursor);
  let end = cursor;
  while (buffer.getLine(end + 1)?.isWrapped) end++;
  const mark = (row: number): MarkedRow => ({ row, marker: terminal.registerMarker(row - cursor), text: rowText(buffer, row) });
  const above: MarkedRow[] = [];
  for (let row = buffer.baseY; row < start; row++) above.push(mark(row));
  return { above, line: mark(start), text: logicalLines(buffer, start, end)[0] ?? "" };
}

function newsAfter(terminal: Terminal, checkpoint: Checkpoint): { lines: string[]; trimmed: boolean } {
  const buffer = terminal.buffer.normal;
  const rows = [...checkpoint.above, checkpoint.line];
  const alive = rows.find(({ marker }) => !marker.isDisposed);
  if (!alive) return { lines: logicalLines(buffer, 0, lastRow(buffer)), trimmed: true };
  const shift = alive.row - alive.marker.line;
  // A row above that a cursor-up redraw changed, or erased, starts the news; one that left the buffer does not.
  const redrawn = checkpoint.above.find(({ row, marker, text }) => row - shift >= 0 && (marker.isDisposed || rowText(buffer, row - shift) !== text));
  const first = lineStart(buffer, Math.max((redrawn ?? checkpoint.line).row - shift, 0));
  const lines = logicalLines(buffer, first, lastRow(buffer));
  // The cursor's line, unchanged with nothing redrawn above it, was shown already.
  if (!redrawn && !checkpoint.line.marker.isDisposed && lines[0] === checkpoint.text) lines.shift();
  return { lines, trimmed: false };
}

function screenOf(terminal: Terminal): Screen {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let row = 0; row < terminal.rows; row++) rows.push(rowText(buffer, buffer.baseY + row));
  while (rows.length > 0 && rows.at(-1) === "") rows.pop();
  return { rows, cursor: { row: buffer.cursorY, col: buffer.cursorX } };
}

/** Rows the span can add: one per line break, one per `cols` units, plus a screen. */
function scrollbackFor(span: string, window: TerminalWindow): number {
  let lineBreaks = 0;
  for (let i = span.indexOf("\n"); i >= 0; i = span.indexOf("\n", i + 1)) lineBreaks += 1;
  return lineBreaks + Math.ceil(span.length / window.cols) + window.rows;
}

/**
 * One transient xterm (the engine the person's browser runs, never opened, its `onData` never
 * wired, so it answers no terminal query) at the PTY's size. It reads the window up to `from`, takes
 * a checkpoint at the start of the cursor's logical line, reads on to `to`, and returns what changed.
 */
export const renderSpan: RenderSpan = async (window, from, to) => {
  const base = windowBase(window);
  const start = Math.max(from, windowStart(window));
  let span = window.backlog.slice(start - base, Math.max(to, start) - base);
  const terminal = new Terminal({ cols: window.cols, rows: window.rows, scrollback: scrollbackFor(span, window), disableStdin: true });
  try {
    await write(terminal, window.backlog.slice(windowStart(window) - base, start - base));
    // The normal buffer stands still under a full-screen program, as it was when the program
    // started; the checkpoint goes on it once the program leaves.
    while (terminal.buffer.active.type === "alternate") {
      const exit = ALTERNATE_SCREEN_EXIT.exec(span);
      if (!exit) break;
      await write(terminal, span.slice(0, exit.index + exit[0].length));
      span = span.slice(exit.index + exit[0].length);
    }
    const checkpoint = terminal.buffer.active.type === "normal" ? takeCheckpoint(terminal) : null;
    await write(terminal, span);
    const news = checkpoint ? newsAfter(terminal, checkpoint) : { lines: [], trimmed: false };
    return { ...news, screen: terminal.buffer.active.type === "alternate" ? screenOf(terminal) : null };
  } finally {
    terminal.dispose();
  }
};
