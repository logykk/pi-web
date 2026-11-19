import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { encodeInput, MAX_TEXT_UNITS } = await jiti.import("./terminal-keys.ts");

const SHELL = { applicationCursorKeys: false, bracketedPaste: "on" };
const VIM = { applicationCursorKeys: true, bracketedPaste: "on" };
const PROGRAM = { applicationCursorKeys: false, bracketedPaste: "off" };
const typed = (request, modes = SHELL) => encodeInput({ enter: false, ...request }, modes);

test("keys, then text, then Enter, as one write, and what the reply shows of it", () => {
  assert.deepEqual(typed({ keys: "esc", text: ":wq", enter: true }, VIM), { ok: true, data: "\x1b:wq\r", shown: 'esc ":wq" enter' });
  assert.deepEqual(typed({ text: "ls -la", enter: true }), { ok: true, data: "ls -la\r", shown: '"ls -la" enter' });
  assert.deepEqual(typed({ enter: true }), { ok: true, data: "\r", shown: "enter" });
  assert.deepEqual(typed({ keys: "q" }), { ok: true, data: "q", shown: "q" });
});

test("arrows and Home/End follow the program's cursor-key mode; modified ones do not", () => {
  assert.equal(typed({ keys: "up down right left home end" }).data, "\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F");
  assert.equal(typed({ keys: "up down right left home end" }, VIM).data, "\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF");
  assert.equal(typed({ keys: "ctrl+left alt+right" }, VIM).data, "\x1b[1;5D\x1b[1;3C");
});

test("named keys and modifiers give the bytes xterm sends", () => {
  const bytes = (keys) => typed({ keys }).data;
  assert.equal(bytes("Tab shift+tab Backspace delete insert space pageup pagedown"), "\t\x1b[Z\x7f\x1b[3~\x1b[2~ \x1b[5~\x1b[6~");
  assert.equal(bytes("f1 f5 f12"), "\x1bOP\x1b[15~\x1b[24~");
  assert.equal(bytes("ctrl+a ctrl+E ctrl+] ctrl+d"), "\x01\x05\x1d\x04");
  assert.equal(bytes("alt+b alt+B alt+backspace ctrl+alt+x"), "\x1bb\x1bB\x1b\x7f\x1b\x18");
  assert.equal(typed({ keys: "ctrl+r" }).shown, "ctrl+r");
});

test("a signal key (ctrl+c, ctrl+z, ctrl+\\) must come alone", () => {
  assert.deepEqual(typed({ keys: "ctrl+c" }), { ok: true, data: "\x03", shown: "ctrl+c" });
  assert.deepEqual(typed({ keys: "Ctrl+Z" }), { ok: true, data: "\x1a", shown: "ctrl+z" });
  assert.deepEqual(typed({ keys: "ctrl+\\" }), { ok: true, data: "\x1c", shown: "ctrl+\\" });
  for (const request of [{ keys: "ctrl+c", text: "ls" }, { keys: "ctrl+c", enter: true }, { keys: "ctrl+c ctrl+c" }, { keys: "esc ctrl+z" }]) {
    const encoded = typed(request);
    assert.equal(encoded.ok, false, JSON.stringify(request));
    assert.match(encoded.error, /must come alone/);
  }
});

test("multi-line text is pasted bracketed when the program asked for it, typed line by line when not", () => {
  assert.equal(typed({ text: "echo a\necho b\r\n", enter: true }).data, "\x1b[200~echo a\recho b\r\x1b[201~\r");
  assert.equal(typed({ text: "echo a\necho b" }, PROGRAM).data, "echo a\recho b");
  assert.equal(typed({ text: "one line" }).data, "one line");
});

test("unknown key names, nothing to send, and text over the cap are refused with what to do", () => {
  const unknown = typed({ keys: "ctrl+c2 hyper+x ctrl+1 enter" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /^Unknown key "ctrl\+c2", "hyper\+x", "ctrl\+1"\. keys takes enter tab /);
  assert.deepEqual(typed({}), { ok: false, error: "Pass keys, text or enter: true." });
  assert.equal(typed({ keys: "   " }).ok, false);
  assert.match(typed({ text: "x".repeat(MAX_TEXT_UNITS + 1) }).error, /at most 65536/);
  assert.equal(typed({ text: "x".repeat(MAX_TEXT_UNITS) }).ok, true);
  assert.match(typed({ keys: Array(65).fill("a").join(" ") }).error, /At most 64 keys/);
});
