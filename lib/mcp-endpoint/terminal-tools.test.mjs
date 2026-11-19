import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { serverFor } = await jiti.import("./tools.ts");
const { handleMcpBody } = await jiti.import("./jsonrpc.ts");

const call = { signal: new AbortController().signal, linkBase: "https://pi.example.net" };
const ID = "9f2c41d07a3b4e1f8c2d6e5a4b3c2d1e";
const OTHER = "7d1e0b2c3a4f5e6d7c8b9a0f1e2d3c4b";
const CWD = "/w/project";
const TERMINAL = {
  id: ID, cwd: CWD, cols: 120, rows: 40, state: { kind: "running" }, foreground: { kind: "shell" }, front: "line-editor", shownInPiWeb: false, agentStarted: true,
};
const SHOWN = { ...TERMINAL, id: OTHER, agentStarted: false, shownInPiWeb: true, cols: 132, rows: 41 };
const PAGE = { lines: [], screen: null, trimmed: false, lost: 0, more: false, earlier: null };
const HEADING = `Terminal ${ID} in ${CWD}: 120x40; the shell reads a line; not open in pi-web; started through these tools.`;

async function callTool(terminals, name, args) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const { result } = (await handleMcpBody(serverFor({}, terminals), body, null, call)).body;
  return { text: result.content[0].text, isError: result.isError };
}

const waited = (fields) => ({ kind: "waited", reason: "ready", waitedMs: 400, terminal: TERMINAL, page: PAGE, typed: [], cursor: 1234, foreign: false, live: [], ...fields });

test("pi_terminals lists each terminal on one line, or says how to start one", async () => {
  const terminals = { list: async ({ cwd }) => ({ terminals: cwd ? [] : [TERMINAL, { ...SHOWN, foreground: { kind: "program", name: "npm" }, front: "program" }] }) };
  assert.deepEqual(await callTool(terminals, "pi_terminals", {}), {
    text: [
      "2 terminals:",
      `- ${ID} in ${CWD}: 120x40; the shell reads a line; not open in pi-web; started through these tools.`,
      `- ${OTHER} in ${CWD}: 132x41; npm runs in front; open in pi-web.`,
    ].join("\n"),
    isError: false,
  });
  assert.equal((await callTool(terminals, "pi_terminals", { cwd: "/w/x" })).text, 'No terminals in /w/x. pi_terminal_open {"cwd":"/w/x"} starts one.');
});

test("pi_terminal_open: a started shell tells how the person joins it; a joined one the person has open does not", async () => {
  const opened = { joined: false, terminal: TERMINAL, page: { ...PAGE, lines: ["$"] }, cursor: 1234 };
  const started = await callTool({ open: async () => opened }, "pi_terminal_open", { cwd: CWD });
  assert.deepEqual(started, {
    text: [
      `Started a shell in ${CWD}: terminal ${ID}, 120x40 until a pi-web tab shows it and sets its size.`,
      "The person joins it in pi-web: select this folder, then Open workspace terminal (the terminal key with the files) opens this shell.",
      HEADING,
      "It shows:",
      "| $",
      "Type with pi_terminal_send and this cursor.",
      "cursor: term~9f2c41d0~ya",
    ].join("\n"),
    isError: false,
  });
  const joined = { joined: true, terminal: SHOWN, page: { ...PAGE, lines: ["$ git status", " M a.ts", "$"], earlier: 40 }, cursor: 999 };
  assert.equal((await callTool({ open: async () => joined }, "pi_terminal_open", { cwd: CWD })).text, [
    `Joined terminal ${OTHER} in ${CWD}, which the person has open in pi-web.`,
    `Terminal ${OTHER} in ${CWD}: 132x41; the shell reads a line; open in pi-web.`,
    "It shows:",
    "| $ git status",
    "|  M a.ts",
    "| $",
    `earlier: pi_terminal_read {"terminal":"${OTHER}","before":"term~7d1e0b2c~14"}`,
    "Type with pi_terminal_send and this cursor.",
    "cursor: term~7d1e0b2c~rr",
  ].join("\n"));
});

test("pi_terminal_send types, then reports the wait; its arguments reach the desk as given", async () => {
  const seen = [];
  const terminals = {
    send: async (...args) => {
      seen.push(args.slice(0, 4));
      return { kind: "typed", shown: '"ls" enter', wait: waited({ page: { ...PAGE, lines: ["$ ls", "a.txt", "$"] }, typed: [{ offset: 1, shown: '"ls" enter', at: 0 }] }) };
    },
  };
  const reply = await callTool(terminals, "pi_terminal_send", { terminal: ID.toUpperCase(), text: "ls", enter: true, cursor: "term~9f2c41d0~ya", timeout_s: 30 });
  assert.deepEqual(seen, [[ID, { keys: undefined, text: "ls", enter: true }, { tag: "9f2c41d0", offset: 1234 }, 30_000]]);
  assert.deepEqual(reply, {
    text: [
      'Typed "ls" enter.',
      "A line went in and the shell (or REPL) reads a line again, after 0.4 s.",
      HEADING,
      "New since your cursor:",
      "| $ ls",
      "| a.txt",
      "| $",
      'Your input since the cursor: "ls" enter.',
      "cursor: term~9f2c41d0~ya",
    ].join("\n"),
    isError: false,
  });
  await callTool(terminals, "pi_terminal_send", { terminal: ID, keys: "ctrl+c" });
  assert.deepEqual(seen[1], [ID, { keys: "ctrl+c", text: undefined, enter: false }, null, 45_000]);
});

test("a refused send is an error that shows the line and what to do; a send to a closed terminal names the folder's live ones", async () => {
  const refused = { kind: "refused", reason: "changed", terminal: TERMINAL, page: { ...PAGE, lines: ["$ git sta"] }, typed: [], cursor: 1300 };
  assert.deepEqual(await callTool({ send: async () => refused }, "pi_terminal_send", { terminal: ID, text: "ls", enter: true, cursor: "term~9f2c41d0~ya" }), {
    text: [
      "Nothing was typed: the terminal printed since your cursor, so the person may be typing.",
      HEADING,
      "Since your cursor:",
      "| $ git sta",
      "Never clear or edit a line you did not type. Send again with this cursor once the line is free (pi_terminal_wait tells you when a line went in), or omit cursor to type after what is there.",
      "cursor: term~9f2c41d0~104",
    ].join("\n"),
    isError: true,
  });
  const gone = { kind: "gone", id: ID, ended: { cwd: CWD, at: 0, end: { kind: "closed" }, by: "elsewhere" }, agoMs: 12_000, live: [SHOWN] };
  assert.deepEqual(await callTool({ send: async () => gone }, "pi_terminal_send", { terminal: ID, text: "ls" }), {
    text: `Terminal ${ID} was closed 12 s ago (Close or Restart in pi-web).\nRunning in ${CWD} now: ${OTHER} (open in pi-web). pi_terminal_open {"cwd":"${CWD}"} joins the first.`,
    isError: true,
  });
});

test("pi_terminal_wait: the reason first, the terminal, its lines or screen, who typed, the cursor last", async () => {
  const wait = (result) => callTool({ wait: async () => result }, "pi_terminal_wait", { terminal: ID, cursor: "term~9f2c41d0~ya" });
  assert.equal((await wait(waited({ page: { ...PAGE, lines: ["$ git log -1", "abc fix", "$"] } }))).text, [
    "A line went in and the shell (or REPL) reads a line again, after 0.4 s.",
    HEADING,
    "New since your cursor:",
    "| $ git log -1",
    "| abc fix",
    "| $",
    "You typed nothing since your cursor, so this came from pi-web or a program.",
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));

  assert.equal((await wait(waited({ reason: "more", page: { ...PAGE, lines: ["41321"], lost: 278_382, more: true } }))).text, [
    "More output than one reply holds. This page ends at a line break; pi_terminal_wait with this cursor returns the next one at once.",
    HEADING,
    "(278382 earlier characters left the terminal's memory before you read them; pi-web keeps the last 131072.)",
    "New since your cursor:",
    "| 41321",
    "You typed nothing since your cursor, so this came from pi-web or a program.",
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));

  const vim = { ...TERMINAL, foreground: { kind: "program", name: "vim" }, front: "program" };
  const screen = { rows: ["first line", "~"], cursor: { row: 0, col: 4 } };
  assert.equal((await wait(waited({ reason: "paused", waitedMs: 2_300, terminal: vim, page: { ...PAGE, lines: ["$ vim notes.txt"], screen }, typed: [{ offset: 1, shown: '"vim notes.txt" enter', at: 0 }] }))).text, [
    "Quiet for 2 s after its output: the program may be waiting for input.",
    `Terminal ${ID} in ${CWD}: 120x40; vim runs in front; not open in pi-web; started through these tools.`,
    "New since your cursor:",
    "| $ vim notes.txt",
    "Full screen (cursor at row 1, column 5):",
    "| first line",
    "| ~",
    'Your input since the cursor: "vim notes.txt" enter.',
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));

  assert.equal((await wait(waited({ reason: "closed", page: { ...PAGE, lines: ["$"] }, live: [] }))).text, [
    "The terminal was closed (Close or Restart in pi-web, or pi_terminal_close), so its shell ended.",
    HEADING,
    "New since your cursor:",
    "| $",
    "You typed nothing since your cursor, so this came from pi-web or a program.",
    `No terminal runs in ${CWD} now; pi_terminal_open {"cwd":"${CWD}"} starts one.`,
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));

  assert.equal((await wait(waited({ reason: "timeout", waitedMs: 45_000 }))).text, [
    "Nothing new after 45 s; the person may be away. Call pi_terminal_wait again to keep waiting.",
    HEADING,
    "Nothing new since your cursor.",
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));

  assert.equal((await wait(waited({ reason: "now", foreign: true, page: { ...PAGE, lines: ["$"], trimmed: true } }))).text, [
    "That cursor is not from this terminal; what it shows now:",
    HEADING,
    "(The screen was cleared since your cursor.)",
    "It shows:",
    "| $",
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));
});

test("pi_terminal_read: the latest page with its cursor, an earlier page without one; a long line is clipped", async () => {
  const latest = { kind: "latest", terminal: TERMINAL, page: { ...PAGE, lines: ["x".repeat(40_005)], earlier: 99 }, cursor: 1234, foreign: false };
  assert.equal((await callTool({ read: async () => latest }, "pi_terminal_read", { terminal: ID })).text, [
    HEADING,
    "It shows:",
    `| ${"x".repeat(40_000)}…(+5 characters)`,
    `earlier: pi_terminal_read {"terminal":"${ID}","before":"term~9f2c41d0~2r"}`,
    "cursor: term~9f2c41d0~ya",
  ].join("\n"));
  const before = { kind: "before", terminal: TERMINAL, page: { ...PAGE, lines: ["1", "2"] } };
  const seen = [];
  assert.equal((await callTool({ read: async (...args) => { seen.push(args); return before; } }, "pi_terminal_read", { terminal: ID, before: "term~9f2c41d0~2r" })).text, [
    HEADING,
    "Earlier:",
    "| 1",
    "| 2",
    "(An earlier page: keep using the cursor you have.)",
  ].join("\n"));
  assert.deepEqual(seen, [[ID, { tag: "9f2c41d0", offset: 99 }]]);
});

test("pi_terminal_close says whose tab it ended; a closed terminal says who closed it", async () => {
  assert.deepEqual(await callTool({ close: async () => ({ kind: "closed", terminal: SHOWN }) }, "pi_terminal_close", { terminal: OTHER }), {
    text: `Closed terminal ${OTHER} in ${CWD}: its shell ended for everyone. It was open in pi-web, so the person's tab shows it closed.`,
    isError: false,
  });
  const gone = { kind: "gone", id: ID, ended: { cwd: CWD, at: 0, end: { kind: "closed" }, by: "agent" }, agoMs: 3_000, live: [] };
  assert.equal((await callTool({ close: async () => gone }, "pi_terminal_close", { terminal: ID })).text,
    `You closed terminal ${ID} 3.0 s ago (pi_terminal_close).\nNo terminal runs in ${CWD} now; pi_terminal_open {"cwd":"${CWD}"} starts one.`);
});

test("a bad terminal id, a session cursor or a malformed one is an error that says what to do", async () => {
  const desk = { wait: async () => assert.fail("reached the desk") };
  assert.deepEqual(await callTool(desk, "pi_terminal_wait", { terminal: "abc", cursor: "term~9f2c41d0~ya" }), {
    text: '"abc" is not a terminal id (32 hex). pi_terminals lists the terminals.', isError: true,
  });
  for (const cursor of ["e9~0~mhz3k2q1", "nope", "term~9f2c41d0~"]) {
    assert.deepEqual(await callTool(desk, "pi_terminal_wait", { terminal: ID, cursor }), {
      text: "That cursor did not come from a terminal reply of this server. pi_terminal_read gives a fresh one.", isError: true,
    });
  }
  assert.match((await callTool(desk, "pi_terminal_wait", { terminal: ID, cursor: "term~9f2c41d0~ya", timeout_s: 51 })).text, /timeout_s must be at most 50/);
});
