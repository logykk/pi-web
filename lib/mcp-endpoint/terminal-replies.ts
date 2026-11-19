import type { ToolText } from "./jsonrpc";
import type { AgentInput, GoneResult, TerminalCloseResult, TerminalInfo, TerminalListResult, TerminalOpenResult, TerminalPage, TerminalReadResult, TerminalSendResult, TerminalWaited, TerminalWaitResult } from "./terminal-desk";
import { BUDGETS } from "./replies";
import { PAUSE_QUIET_MS } from "./terminal-rest";
import { encodeTerminalCursor } from "./terminal-stream";

const BACKLOG_UNITS = 131_072;

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function callExample(tool: string, args: Readonly<Record<string, unknown>>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

function cursorLine(id: string, offset: number): string {
  return `cursor: ${encodeTerminalCursor(id, offset)}`;
}

/** Terminal text, marked so it never reads as pi-web's words. */
function bar(text: string): string {
  return text ? `| ${text}` : "|";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} characters)` : text;
}

function stateOf(terminal: TerminalInfo): string {
  if (terminal.state.kind === "closed") return "closed";
  if (terminal.state.kind === "exited") return `the shell exited with code ${terminal.state.code}`;
  if (terminal.foreground.kind === "program") return `${terminal.foreground.name} runs in front`;
  if (terminal.foreground.kind === "shell" || terminal.front === "line-editor") return "the shell reads a line";
  return terminal.front === "program" ? "a program runs in front" : "running";
}

function details(terminal: TerminalInfo): string {
  return [
    `${terminal.cols}x${terminal.rows}`,
    stateOf(terminal),
    ...(terminal.state.kind === "closed" ? [] : [terminal.shownInPiWeb ? "open in pi-web" : "not open in pi-web"]),
    ...(terminal.agentStarted ? ["started through these tools"] : []),
  ].join("; ");
}

function headingLine(terminal: TerminalInfo): string {
  return `Terminal ${terminal.id} in ${terminal.cwd}: ${details(terminal)}.`;
}

const HOW_THE_PERSON_JOINS = "The person joins it in pi-web: select this folder, then Open workspace terminal (the terminal key with the files) opens this shell.";

function pageLines(page: TerminalPage, heading: string, empty: string, budget: number): string[] {
  const lines: string[] = [];
  if (page.lost > 0) lines.push(`(${plural(page.lost, "earlier character")} left the terminal's memory before you read them; pi-web keeps the last ${BACKLOG_UNITS}.)`);
  if (page.trimmed) lines.push("(The screen was cleared since your cursor.)");
  if (page.lines.length > 0) lines.push(heading, ...page.lines.map((line) => bar(clip(line, budget))));
  if (page.screen) {
    lines.push(`Full screen (cursor at row ${page.screen.cursor.row + 1}, column ${page.screen.cursor.col + 1}):`, ...page.screen.rows.map((row) => bar(row)));
  }
  if (page.lines.length === 0 && !page.screen) lines.push(empty);
  return lines;
}

function earlierLine(id: string, page: TerminalPage): string[] {
  return page.earlier === null ? [] : [`earlier: ${callExample("pi_terminal_read", { terminal: id, before: encodeTerminalCursor(id, page.earlier) })}`];
}

function liveLine(cwd: string, live: readonly TerminalInfo[]): string {
  if (live.length === 0) return `No terminal runs in ${cwd} now; ${callExample("pi_terminal_open", { cwd })} starts one.`;
  const listed = live.map((terminal) => `${terminal.id} (${terminal.shownInPiWeb ? "open in pi-web" : "not open in pi-web"})`).join(", ");
  return `Running in ${cwd} now: ${listed}. ${callExample("pi_terminal_open", { cwd })} joins the first.`;
}

function typedLine(typed: readonly AgentInput[]): string {
  return typed.length > 0
    ? `Your input since the cursor: ${typed.map((input) => input.shown).join("; ")}.`
    : "You typed nothing since your cursor, so this came from pi-web or a program.";
}

export function renderTerminalList({ terminals }: TerminalListResult, cwd: string | undefined): ToolText {
  if (terminals.length === 0) {
    return { text: cwd === undefined ? "No terminals run on this pi-web. pi_terminal_open starts one in a folder." : `No terminals in ${cwd}. ${callExample("pi_terminal_open", { cwd })} starts one.` };
  }
  const lines = [`${plural(terminals.length, "terminal")}:`, ...terminals.map((terminal) => `- ${terminal.id} in ${terminal.cwd}: ${details(terminal)}.`)];
  return { text: lines.join("\n") };
}

export function renderTerminalOpen(result: TerminalOpenResult): ToolText {
  const { terminal } = result;
  const headline = !result.joined
    ? `Started a shell in ${terminal.cwd}: terminal ${terminal.id}, ${terminal.cols}x${terminal.rows} until a pi-web tab shows it and sets its size.`
    : terminal.shownInPiWeb
      ? `Joined terminal ${terminal.id} in ${terminal.cwd}, which the person has open in pi-web.`
      : `Joined terminal ${terminal.id} in ${terminal.cwd}.`;
  return {
    text: [
      headline,
      ...(terminal.shownInPiWeb ? [] : [HOW_THE_PERSON_JOINS]),
      headingLine(terminal),
      ...pageLines(result.page, "It shows:", "It shows nothing yet.", BUDGETS.report.total),
      ...earlierLine(terminal.id, result.page),
      "Type with pi_terminal_send and this cursor.",
      cursorLine(terminal.id, result.cursor),
    ].join("\n"),
  };
}

function renderGone(result: GoneResult, isError: boolean): ToolText {
  const { ended } = result;
  const ago = seconds(result.agoMs);
  const what = ended.by === "agent" ? `You closed terminal ${result.id} ${ago} ago (pi_terminal_close).`
    : ended.end.kind === "exited" ? `The shell of terminal ${result.id} exited with code ${ended.end.code} ${ago} ago.`
    : `Terminal ${result.id} was closed ${ago} ago (Close or Restart in pi-web).`;
  return { text: [what, liveLine(ended.cwd, result.live)].join("\n"), isError };
}

export function renderTerminalRead(result: TerminalReadResult): ToolText {
  if (result.kind === "gone") return renderGone(result, false);
  const { terminal, page } = result;
  if (result.kind === "before") {
    return {
      text: [
        headingLine(terminal),
        ...pageLines(page, "Earlier:", "Nothing earlier is kept.", BUDGETS.read.total),
        ...earlierLine(terminal.id, page),
        "(An earlier page: keep using the cursor you have.)",
      ].join("\n"),
    };
  }
  return {
    text: [
      ...(result.foreign ? ["That cursor is not from this terminal; what it shows now:"] : []),
      headingLine(terminal),
      ...pageLines(page, "It shows:", "It shows nothing yet.", BUDGETS.read.total),
      ...earlierLine(terminal.id, page),
      cursorLine(terminal.id, result.cursor),
    ].join("\n"),
  };
}

function waitHeadline(result: TerminalWaited): string {
  const waited = seconds(result.waitedMs);
  const hasNews = result.page.lines.length > 0 || result.page.screen !== null;
  switch (result.reason) {
    case "ready":
      return `A line went in and the shell (or REPL) reads a line again, after ${waited}.`;
    case "paused":
      return `Quiet for ${PAUSE_QUIET_MS / 1000} s after its output: the program may be waiting for input.`;
    case "more":
      return "More output than one reply holds. This page ends at a line break; pi_terminal_wait with this cursor returns the next one at once.";
    case "exited":
      return result.terminal.state.kind === "exited" ? `The shell exited with code ${result.terminal.state.code}.` : "The shell exited.";
    case "closed":
      return "The terminal was closed (Close or Restart in pi-web, or pi_terminal_close), so its shell ended.";
    case "aborted":
      return "The wait ended early (cancelled, or pi-web is stopping). Call pi_terminal_wait again with the new cursor.";
    case "now":
      return result.foreign ? "That cursor is not from this terminal; what it shows now:" : "Now:";
    case "timeout":
      return hasNews
        ? `Still going after ${waited}. Call pi_terminal_wait again with the new cursor.`
        : `Nothing new after ${waited}; the person may be away. Call pi_terminal_wait again to keep waiting.`;
  }
}

function waitedLines(result: TerminalWaited): string[] {
  const { terminal, page } = result;
  const hasNews = page.lines.length > 0 || page.screen !== null;
  return [
    waitHeadline(result),
    headingLine(terminal),
    ...pageLines(page, result.foreign ? "It shows:" : "New since your cursor:", "Nothing new since your cursor.", BUDGETS.report.total),
    ...(hasNews && !result.foreign ? [typedLine(result.typed)] : []),
    ...(result.reason === "exited" || result.reason === "closed" ? [liveLine(terminal.cwd, result.live)] : []),
    cursorLine(terminal.id, result.cursor),
  ];
}

export function renderTerminalWait(result: TerminalWaitResult): ToolText {
  return result.kind === "gone" ? renderGone(result, false) : { text: waitedLines(result).join("\n") };
}

const REFUSED: Readonly<Record<Extract<TerminalSendResult, { kind: "refused" }>["reason"], { headline: string; heading: string; next: string }>> = {
  changed: {
    headline: "Nothing was typed: since your cursor a line went in or the line being typed changed, so the person may be typing.",
    heading: "Since your cursor:",
    next: "Never clear or edit a line you did not type. Send again with this cursor once the line is free (pi_terminal_wait tells you when a line went in), or omit cursor to type after what is there.",
  },
  "already-typed": {
    headline: "Nothing was typed: you already typed at or after this cursor, so this call is a repeat.",
    heading: "What followed:",
    next: "Pass this cursor to type more.",
  },
  foreign: {
    headline: "Nothing was typed: that cursor is not from this terminal.",
    heading: "It shows:",
    next: "Pass this cursor to type.",
  },
};

export function renderTerminalSend(result: TerminalSendResult): ToolText {
  switch (result.kind) {
    case "gone":
      return renderGone(result, true);
    case "typed":
      return { text: [`Typed ${result.shown}.`, ...waitedLines(result.wait)].join("\n") };
    case "refused": {
      const reply = REFUSED[result.reason];
      return {
        text: [
          reply.headline,
          headingLine(result.terminal),
          ...pageLines(result.page, reply.heading, "Nothing new since your cursor.", BUDGETS.report.total),
          ...(result.typed.length > 0 ? [typedLine(result.typed)] : []),
          reply.next,
          cursorLine(result.terminal.id, result.cursor),
        ].join("\n"),
        isError: true,
      };
    }
  }
}

export function renderTerminalClose(result: TerminalCloseResult): ToolText {
  if (result.kind === "gone") return renderGone(result, false);
  const { terminal } = result;
  const tab = terminal.shownInPiWeb ? "It was open in pi-web, so the person's tab shows it closed." : "No pi-web tab showed it.";
  return { text: `Closed terminal ${terminal.id} in ${terminal.cwd}: its shell ended for everyone. ${tab}` };
}
