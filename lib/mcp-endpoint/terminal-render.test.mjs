import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { renderSpan } = await jiti.import("./terminal-render.ts");
const { pageEnd, pageStart, windowBase, windowStart } = await jiti.import("./terminal-stream.ts");

// Recorded by __fixtures__/record-terminal-streams.mjs from a neutral bash (PS1 "$ ", 80x24).
const recorded = JSON.parse(readFileSync(new URL("./__fixtures__/terminal-streams.json", import.meta.url), "utf8"));
const BUDGET = 12_000;

function fixture(name) {
  const { stream, cols, rows, marks } = recorded[name];
  return { window: { backlog: stream, offset: stream.length, cols, rows }, marks };
}

/** TM keeps the last 131072 units. */
function windowOf(stream, { cols = 80, rows = 24 } = {}) {
  return { backlog: stream.slice(-131_072), offset: stream.length, cols, rows };
}

function seqStream(count) {
  const numbers = Array.from({ length: count }, (_, index) => `${index + 1}\r\n`).join("");
  return `\x1b[?2004h$ seq 1 ${count}\r\n\x1b[?2004l\r${numbers}\x1b[?2004h$ `;
}

/** What a reply spends on a page: `| ` and a line break around each line. */
const replyCost = (lines) => lines.reduce((sum, line) => sum + line.length + 3, 0);

test("readline edits: Backspace and a mid-line insert read as the line the shell ran", async () => {
  const { window, marks } = fixture("readline");
  assert.deepEqual((await renderSpan(window, marks.start, marks.history)).lines, ["$ echo hello world", "hello world", "$"]);
  assert.deepEqual((await renderSpan(window, marks.history, marks.midline)).lines, ["$ echo hello world", "hello world", "$"]);
  assert.deepEqual(await renderSpan(window, marks.midline, window.offset), {
    lines: ["$ echo aXbc", "aXbc", "$ echo half"], screen: null, trimmed: false,
  });
});

test("a \\r progress line reads as its last state", async () => {
  const { window, marks } = fixture("progress");
  const { lines } = await renderSpan(window, marks.start, window.offset);
  assert.deepEqual(lines.slice(1), ["downloading 100%", "done", "$"]);
  assert.match(lines[0], /^\$ for i in 10 20 .* echo done$/);
});

test("a cursor-up redraw above the cursor starts the news at the first redrawn line", async () => {
  const { window, marks } = fixture("multiline-progress");
  assert.deepEqual((await renderSpan(window, marks.start, window.offset)).lines.slice(1), ["a: 100%", "b: 50%", "$"]);
  const afterSecondUpdate = window.backlog.indexOf("b: 25%\x1b[K\r\n") + "b: 25%\x1b[K\r\n".length;
  assert.deepEqual((await renderSpan(window, afterSecondUpdate, window.offset)).lines, ["a: 100%", "b: 50%", "$"]);
});

test("clear: what the screen shows after it, and the checkpoint reported gone", async () => {
  const { window, marks } = fixture("clear");
  assert.deepEqual(await renderSpan(window, marks["before-clear"], window.offset), {
    lines: ["$ echo after", "after", "$"], screen: null, trimmed: true,
  });
});

test("a checkpoint scrolled off the screen and then cleared away is reported trimmed", async () => {
  const before = "\x1b[?2004h$ seq 1 7\r\n\x1b[?2004l\r";
  const stream = `${before}1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n\x1b[?2004h$ clear\r\n\x1b[?2004l\r\x1b[H\x1b[2J\x1b[3J\x1b[?2004h$ echo fresh\r\nfresh\r\n$ `;
  const window = windowOf(stream, { rows: 5 });
  assert.deepEqual(await renderSpan(window, before.length, window.offset), { lines: ["$ echo fresh", "fresh", "$"], screen: null, trimmed: true });
  assert.deepEqual((await renderSpan(window, before.length, before.length + 9)).lines, ["1", "2", "3"]);
});

test("a long line: wrapped rows join into one line, and an edit across the wrap keeps every character", async () => {
  const { window, marks } = fixture("longline");
  const xs = `${"x".repeat(80)}YY${"x".repeat(20)}`;
  const { lines } = await renderSpan(window, marks.start, window.offset);
  // readline moves down with a line feed, which clears xterm's wrap flag: the person's xterm shows the same two rows.
  assert.equal(lines[0] + lines[1], `$ echo ${xs}`);
  assert.deepEqual(lines.slice(2), [xs, "$"]);
});

test("a full-screen program shows as its screen with the cursor; after it quits, the lines the shell printed", async () => {
  const vim = fixture("vim");
  const editing = await renderSpan(vim.window, vim.marks.start, vim.marks.editing);
  assert.deepEqual(editing.lines, ["$ vim -u NONE -N -i NONE --cmd 'set notitle noicon' notes.txt"]);
  assert.deepEqual(editing.screen.rows.slice(0, 3), ["first line", "added line", "~"]);
  assert.deepEqual(editing.screen.cursor, { row: 1, col: 9 });
  assert.deepEqual(await renderSpan(vim.window, vim.marks.editing, vim.window.offset), {
    lines: ["$ cat notes.txt", "first line", "added line", "$"], screen: null, trimmed: false,
  });

  const less = fixture("less");
  const paged = await renderSpan(less.window, less.marks.start, less.marks.paged);
  assert.deepEqual(paged.lines, ["$ seq 1 200 | less"]);
  assert.deepEqual(paged.screen, { rows: [...Array.from({ length: 23 }, (_, index) => String(index + 24)), ":"], cursor: { row: 23, col: 1 } });
  assert.deepEqual(await renderSpan(less.window, less.marks.paged, less.window.offset), { lines: ["$"], screen: null, trimmed: false });
});

test("forward pages from the window's start hold every line of a large output exactly once", async () => {
  const window = windowOf(seqStream(60_000));
  const start = windowStart(window);
  assert.ok(windowBase(window) > 0 && start > windowBase(window));
  const firstWhole = Number(window.backlog.slice(start - windowBase(window)).split("\r\n")[0]);
  const lines = [];
  let pages = 0;
  for (let from = start; from < window.offset; pages++) {
    const to = pageEnd(window, from, BUDGET);
    const page = await renderSpan(window, from, to);
    assert.ok(replyCost(page.lines) <= BUDGET, `page ${pages} costs ${replyCost(page.lines)}`);
    lines.push(...page.lines);
    from = to;
  }
  const expected = Array.from({ length: 60_000 - firstWhole + 1 }, (_, index) => String(firstWhole + index));
  assert.deepEqual(lines, [...expected, "$"]);
  assert.ok(pages >= 10, `${pages} pages`);
});

test("backward pages from the end hold the same lines, each once", async () => {
  const window = windowOf(seqStream(60_000));
  const start = windowStart(window);
  const pages = [];
  for (let end = window.offset; end > start;) {
    const from = pageStart(window, end, BUDGET);
    assert.ok(from < end);
    const page = await renderSpan(window, from, end);
    assert.ok(replyCost(page.lines) <= BUDGET);
    pages.unshift(page.lines);
    end = from;
  }
  const firstWhole = Number(window.backlog.slice(start - windowBase(window)).split("\r\n")[0]);
  const expected = Array.from({ length: 60_000 - firstWhole + 1 }, (_, index) => String(firstWhole + index));
  assert.deepEqual(pages.flat(), [...expected, "$"]);
});

test("a window that lost its beginning drops the partial first line, even one cut inside an escape sequence", async () => {
  const stream = "AAAA\x1b[31mred line\x1b[0m\r\nnext line\r\n$ ";
  const window = { backlog: stream.slice(7), offset: stream.length, cols: 80, rows: 24 };
  assert.equal(window.backlog.slice(0, 5), "1mred");
  assert.equal(windowStart(window), stream.indexOf("next"));
  assert.deepEqual((await renderSpan(window, 0, window.offset)).lines, ["next line", "$"]);
  const whole = windowOf(stream);
  assert.equal(windowStart(whole), 0);
  assert.deepEqual((await renderSpan(whole, 0, whole.offset)).lines, ["AAAAred line", "next line", "$"]);
});

test("one line longer than a page is taken whole, and output with no line break left goes to the end", () => {
  const long = `${"y".repeat(20_000)}\r\nshort\r\n`;
  const window = windowOf(long);
  assert.equal(pageEnd(window, 0, BUDGET), long.indexOf("short"));
  assert.equal(pageStart(window, long.indexOf("short"), BUDGET), 0);
  const unbroken = windowOf("z".repeat(30_000));
  assert.equal(pageEnd(unbroken, 0, BUDGET), 30_000);
});

test("the cursor's line, already shown and left as it was, is not repeated; once changed it comes back whole", async () => {
  const shown = "\x1b[?2004h$ make\r\n\x1b[?2004l\rloading";
  const window = windowOf(`${shown}\r\ndone\r\n\x1b[?2004h$ `);
  assert.deepEqual((await renderSpan(window, shown.length, window.offset)).lines, ["done", "$"]);
  const typed = windowOf(`${shown} 3 files\r\n`);
  assert.deepEqual((await renderSpan(typed, shown.length, typed.offset)).lines, ["loading 3 files"]);
});
