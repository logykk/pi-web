import { ToolError, WAIT_DEFAULT_MS, WAIT_MAX_MS } from "./desk";
import { endpointTool, type ToolSpec } from "./jsonrpc";
import type { TerminalId } from "./ports";
import { parseTerminalId, type TerminalDesk } from "./terminal-desk";
import { KEY_NAMES } from "./terminal-keys";
import {
  renderTerminalClose, renderTerminalList, renderTerminalOpen, renderTerminalRead, renderTerminalSend, renderTerminalWait,
} from "./terminal-replies";
import { decodeTerminalCursor, type TerminalCursor } from "./terminal-stream";

const TERMINAL = { type: "string", minLength: 1, description: "The terminal's id (32 hex) from pi_terminals or pi_terminal_open." } as const;
const CURSOR = { type: "string", minLength: 1, description: "The `cursor:` line of the newest reply about this terminal." } as const;
const TIMEOUT = { type: "integer", minimum: 0, maximum: WAIT_MAX_MS / 1000, default: WAIT_DEFAULT_MS / 1000 } as const;

export const TERMINAL_INSTRUCTIONS = [
  "Workspace terminals are shells on pi-web's machine that the person may be typing in at the same time, in pi-web's terminal tab: both of you type, both see everything.",
  "Join a folder's terminal (or start one) with pi_terminal_open; pi_terminals lists them. Run a command with pi_terminal_send {text, enter: true, cursor}: it types, then waits until the shell reads a line again, a program waits for input, or timeout_s passes. While a command runs, call pi_terminal_wait with the newest cursor.",
  "With a cursor, pi_terminal_send types nothing if the terminal printed since it, so a repeated call never types twice and you never type into a line the person is editing. Never clear or edit a line you did not type. Send ctrl+c (or ctrl+z, ctrl+\\) alone, in its own call.",
].join(" ");

function terminalId(ref: string): TerminalId {
  const id = parseTerminalId(ref);
  if (!id) throw new ToolError(`${JSON.stringify(ref)} is not a terminal id (32 hex). pi_terminals lists the terminals.`);
  return id;
}

function terminalCursor(text: string): TerminalCursor {
  const cursor = decodeTerminalCursor(text);
  if (!cursor) throw new ToolError("That cursor did not come from a terminal reply of this server. pi_terminal_read gives a fresh one.");
  return cursor;
}

export function terminalTools(desk: TerminalDesk): ToolSpec[] {
  return [
    endpointTool({
      name: "pi_terminals",
      title: "List workspace terminals",
      description: "List the workspace terminals (shells) on this pi-web, the person's and yours: id, folder, size, what runs in front, and whether pi-web shows it.",
      inputSchema: {
        type: "object",
        properties: { cwd: { type: "string", minLength: 1, description: "Only terminals in this folder or below it." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ cwd }) => renderTerminalList(await desk.list({ cwd }), cwd),
    }),

    endpointTool({
      name: "pi_terminal_open",
      title: "Open a workspace terminal",
      description: "Join the live terminal of a folder (the one pi-web shows first, then the one an agent used last), or start a shell there. Returns its id, what it shows now, how the person joins it in pi-web, and the cursor for pi_terminal_send. pi-web keeps a terminal you use alive until 30 min after your last open, send or wait.",
      inputSchema: {
        type: "object",
        properties: { cwd: { type: "string", minLength: 1, description: "Absolute path (or ~/…) of a folder on pi-web's machine." } },
        required: ["cwd"],
        additionalProperties: false,
      },
      annotations: { openWorldHint: false },
      run: async ({ cwd }) => renderTerminalOpen(await desk.open(cwd)),
    }),

    endpointTool({
      name: "pi_terminal_read",
      title: "Read a workspace terminal",
      description: "Read what a terminal shows now (its latest lines, and the screen of a full-screen program) without typing or waiting, or the lines before an `earlier:` cursor. Pages hold up to 40000 characters.",
      inputSchema: {
        type: "object",
        properties: {
          terminal: TERMINAL,
          before: { ...CURSOR, description: "The cursor from an `earlier:` line: the lines before it." },
        },
        required: ["terminal"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ terminal, before }) => renderTerminalRead(await desk.read(terminalId(terminal), before === undefined ? null : terminalCursor(before))),
    }),

    endpointTool({
      name: "pi_terminal_send",
      title: "Type into a workspace terminal",
      description: "Type as the person's keyboard does: keys, then text, then Enter; then wait and report as pi_terminal_wait does. Run a command with text and enter: true; stop one with keys: \"ctrl+c\". With cursor, nothing is typed if the terminal printed since it (the person may be typing) or you already typed at it, so repeating a call whose reply was lost never types twice. Keys alone are always typed.",
      inputSchema: {
        type: "object",
        properties: {
          terminal: TERMINAL,
          keys: { type: "string", minLength: 1, description: `Keys pressed before text, space-separated: ${KEY_NAMES}. ctrl+c, ctrl+z and ctrl+\\ must come alone.` },
          text: { type: "string", minLength: 1, description: "Typed after keys. A line break is Enter; lines are pasted, not run, when the program asked for bracketed paste (bash does)." },
          enter: { type: "boolean", default: false, description: "Press Enter after text." },
          cursor: { ...CURSOR, description: "Your newest cursor for this terminal: the reply then shows everything after it." },
          timeout_s: TIMEOUT,
        },
        required: ["terminal"],
        additionalProperties: false,
      },
      annotations: { openWorldHint: false },
      run: async ({ terminal, keys, text, enter, cursor, timeout_s }, call) => renderTerminalSend(await desk.send(
        terminalId(terminal), { keys, text, enter }, cursor === undefined ? null : terminalCursor(cursor), timeout_s * 1000, call.signal,
      )),
    }),

    endpointTool({
      name: "pi_terminal_wait",
      title: "Wait for a workspace terminal",
      description: `Wait until a line went in (the person's too) and the shell reads a line again, a program is quiet after printing a prompt or drawing a screen, the shell ends, more output arrives than one reply holds, or timeout_s passes; then report everything since cursor, up to 12000 characters. The person typing a line does not end it. On an idle terminal it waits for the person. timeout_s 0 reports at once; each wait lasts at most ${WAIT_MAX_MS / 1000} s.`,
      inputSchema: {
        type: "object",
        properties: { terminal: TERMINAL, cursor: CURSOR, timeout_s: TIMEOUT },
        required: ["terminal", "cursor"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ terminal, cursor, timeout_s }, call) => renderTerminalWait(await desk.wait(terminalId(terminal), terminalCursor(cursor), timeout_s * 1000, call.signal)),
    }),

    endpointTool({
      name: "pi_terminal_close",
      title: "Close a workspace terminal",
      description: "End a terminal's shell for everyone, as Close in pi-web does. To leave a terminal to the person, just stop calling.",
      inputSchema: { type: "object", properties: { terminal: TERMINAL }, required: ["terminal"], additionalProperties: false },
      annotations: { destructiveHint: true, openWorldHint: false },
      run: async ({ terminal }) => renderTerminalClose(await desk.close(terminalId(terminal))),
    }),
  ];
}
