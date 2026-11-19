import { applyTerminalModifiers, terminalExtraKeySequence, type TerminalExtraKey, type TerminalModifiers } from "../terminal-extra-keys";
import { asBracketedPaste } from "../terminal-input";
import type { StreamModes } from "./terminal-stream";

/** The cap of the person's input route (`POST /api/terminal/[id]`). */
export const MAX_TEXT_UNITS = 65_536;
const MAX_KEYS = 64;

interface Key {
  readonly name: string;
  readonly signal: boolean;
  bytes(applicationCursorKeys: boolean): string;
}

const EXTRA_KEYS: Readonly<Record<string, TerminalExtraKey>> = {
  esc: "Escape", escape: "Escape", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};

const PLAIN_KEYS: Readonly<Record<string, string>> = {
  enter: "\r", backspace: "\x7f", delete: "\x1b[3~", insert: "\x1b[2~", space: " ", "shift+tab": "\x1b[Z",
  f1: "\x1bOP", f2: "\x1bOQ", f3: "\x1bOR", f4: "\x1bOS", f5: "\x1b[15~", f6: "\x1b[17~",
  f7: "\x1b[18~", f8: "\x1b[19~", f9: "\x1b[20~", f10: "\x1b[21~", f11: "\x1b[23~", f12: "\x1b[24~",
};

const MODIFIER = /^(ctrl|alt)\+(?=.)/i;

/** Ctrl+C, Ctrl+Z, Ctrl+\: the line discipline signals the foreground group and drops input typed ahead. */
const SIGNAL_CHARACTERS = new Set(["c", "z", "\\"]);

export const KEY_NAMES = "enter tab shift+tab esc backspace delete insert space up down left right home end pageup pagedown f1…f12, any single character, and ctrl+ or alt+ before a character or a key (ctrl+c, ctrl+left, alt+b)";

function parseKey(token: string): Key | null {
  const lower = token.toLowerCase();
  if (Object.hasOwn(PLAIN_KEYS, lower)) return { name: lower, signal: false, bytes: () => PLAIN_KEYS[lower] };
  const modifiers: TerminalModifiers = { ctrl: false, alt: false };
  let base = token;
  for (;;) {
    const prefix = MODIFIER.exec(base);
    if (!prefix) break;
    modifiers[prefix[1].toLowerCase() as keyof TerminalModifiers] = true;
    base = base.slice(prefix[0].length);
  }
  const name = `${modifiers.ctrl ? "ctrl+" : ""}${modifiers.alt ? "alt+" : ""}`;
  const extra = EXTRA_KEYS[base.toLowerCase()];
  if (extra) return { name: name + base.toLowerCase(), signal: false, bytes: (application) => terminalExtraKeySequence(extra, modifiers, application) };
  const plain = PLAIN_KEYS[base.toLowerCase()];
  if (plain && !modifiers.ctrl) return { name: name + base.toLowerCase(), signal: false, bytes: () => (modifiers.alt ? `\x1b${plain}` : plain) };
  if ([...base].length !== 1) return null;
  const data = applyTerminalModifiers(base, modifiers);
  if (modifiers.ctrl && data.endsWith(base)) return null;
  const signal = modifiers.ctrl && !modifiers.alt && SIGNAL_CHARACTERS.has(base.toLowerCase());
  return { name: name + (modifiers.ctrl ? base.toLowerCase() : base), signal, bytes: () => data };
}

export interface AgentInputRequest {
  readonly keys?: string;
  readonly text?: string;
  readonly enter: boolean;
}

export type EncodedInput =
  | { readonly ok: true; readonly data: string; readonly shown: string }
  | { readonly ok: false; readonly error: string };

/**
 * The bytes the person's xterm would send for keys, then text, then Enter, as one write so the
 * person's keystrokes never land inside it. Arrows follow the program's cursor-key mode. Text is
 * typed with line breaks as Enter (`\r`), and multi-line text is pasted the way xterm pastes it
 * when the program asked for bracketed paste.
 */
export function encodeInput(request: AgentInputRequest, modes: Pick<StreamModes, "applicationCursorKeys" | "bracketedPaste">): EncodedInput {
  const tokens = request.keys?.trim() ? request.keys.trim().split(/\s+/) : [];
  const text = request.text ?? "";
  if (tokens.length === 0 && !text && !request.enter) return { ok: false, error: "Pass keys, text or enter: true." };
  if (tokens.length > MAX_KEYS) return { ok: false, error: `At most ${MAX_KEYS} keys per call.` };
  if (text.length > MAX_TEXT_UNITS) return { ok: false, error: `text holds ${text.length} characters; at most ${MAX_TEXT_UNITS} per call.` };
  const keys = tokens.map((token) => ({ token, key: parseKey(token) }));
  const unknown = keys.filter(({ key }) => !key).map(({ token }) => JSON.stringify(token));
  if (unknown.length > 0) return { ok: false, error: `Unknown key ${unknown.join(", ")}. keys takes ${KEY_NAMES}; text takes anything to type.` };
  const parsed = keys.map(({ key }) => key!);
  const signal = parsed.find((key) => key.signal);
  if (signal && (parsed.length > 1 || text || request.enter)) {
    return { ok: false, error: `${signal.name} must come alone: the signal drops whatever is typed ahead of it. Send it in its own call, then the rest.` };
  }
  const typed = text.replace(/\r?\n/g, "\r");
  const pasted = typed.includes("\r") && modes.bracketedPaste === "on" ? asBracketedPaste(typed) : typed;
  return {
    ok: true,
    data: parsed.map((key) => key.bytes(modes.applicationCursorKeys)).join("") + pasted + (request.enter ? "\r" : ""),
    shown: [...parsed.map((key) => key.name), ...(text ? [JSON.stringify(text)] : []), ...(request.enter ? ["enter"] : [])].join(" "),
  };
}
