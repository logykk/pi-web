import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createTools, INSTRUCTIONS } = await jiti.import("./tools.ts");
const { DeskError } = await jiti.import("./desk.ts");
const { decodeCursor } = await jiti.import("./transcript.ts");

const call = { signal: new AbortController().signal, linkBase: "https://pi.example.net" };
const CURSOR = "e9~0~mhz3k2q1";
const idleStatus = { loaded: true, running: false, subagentsActive: false, sendsInFlight: 0, dialogs: [], queued: { steering: [], followUp: [] }, activity: null };

function toolsWith(desk) {
  return Object.fromEntries(createTools(desk).map((tool) => [tool.name, tool]));
}

test("the eight tools, and every schema keyword is one validateArgs enforces", () => {
  const tools = createTools({});
  assert.deepEqual(tools.map((tool) => tool.name), [
    "pi_sessions", "pi_read", "pi_send", "pi_wait", "pi_answer", "pi_stop", "pi_new_session", "pi_new_worktree",
  ]);
  const enforced = new Set(["type", "minLength", "maxLength", "enum", "default", "description", "minimum", "maximum"]);
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool.inputSchema).sort(), ["additionalProperties", "properties", "type", ...(tool.inputSchema.required ? ["required"] : [])].sort(), tool.name);
    for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
      for (const keyword of Object.keys(schema)) assert.ok(enforced.has(keyword), `${tool.name}.${name} uses ${keyword}`);
    }
  }
});

test("every pi_* tool named in the instructions, descriptions and replies exists", async () => {
  const names = new Set(createTools({}).map((tool) => tool.name));
  const sources = [
    INSTRUCTIONS,
    ...createTools({}).map((tool) => tool.description),
    await readFile(new URL("./tools.ts", import.meta.url), "utf8"),
    await readFile(new URL("./desk.ts", import.meta.url), "utf8"),
    await readFile(new URL("./transcript.ts", import.meta.url), "utf8"),
  ];
  const named = new Set(sources.flatMap((text) => text.match(/\bpi_[a-z_]+/g) ?? []));
  assert.ok(named.size >= 8);
  for (const name of named) assert.ok(names.has(name), `${name} is named but is no tool`);
});

test("pi_wait shows the news, the open dialog with the exact call that answers it, and a cursor last", async () => {
  const dialog = { id: "d7", kind: "choice", title: "Apply the migration?", options: ["yes", "no"] };
  const tools = toolsWith({
    wait: async (id, cursor, timeoutMs) => {
      assert.deepEqual([id, cursor.entryId, timeoutMs], ["verify-seeded-chat", "e9", 45_000]);
      return {
        reason: "dialog",
        waitedMs: 3_000,
        status: { ...idleStatus, running: true, dialogs: [dialog], queued: { steering: [], followUp: ["x"] } },
        delta: { kind: "since", omitted: 0, messages: [{ role: "user", content: "hi" }], authors: ["person"] },
        news: [{ text: "queued text", outcome: { state: "accepted", disposition: "queued", at: 1 }, placement: { kind: "missing", since: 5 } }],
        notices: [],
        cursor: { entryId: "f1", dialogs: "abcd1234", at: 99 },
      };
    },
  });
  const reply = await tools.pi_wait.run({ session: "https://pi.example.net/?session=verify-seeded-chat", cursor: CURSOR, timeout_s: 45 }, call);
  const lines = reply.text.split("\n");
  assert.equal(lines[0], "An extension asks a question (below).");
  assert.equal(lines[1], "pi is waiting for an answer. Queued: 1 follow-up.");
  assert.ok(lines.includes("[person] hi"));
  assert.ok(lines.some((line) => line.startsWith('Your message "queued text" never reached pi')));
  const answerCall = lines.find((line) => line.includes("pi_answer {"));
  const json = answerCall.slice(answerCall.indexOf("{"), answerCall.indexOf("}") + 1);
  assert.deepEqual(JSON.parse(json), { session: "verify-seeded-chat", dialog: "d7", answer: "yes" });
  assert.deepEqual(decodeCursor(lines.at(-1).replace(/^cursor: /, "")), { entryId: "f1", dialogs: "abcd1234", at: 99 });
});

test("a refused send is an error the model sees, with the reason; a bad session or cursor says what to do", async () => {
  const tools = toolsWith({
    send: async () => ({
      send: { delivery: "followUp", outcome: { state: "refused", reason: "Directory does not exist: /gone", at: 1 } },
      status: idleStatus,
      cursor: { entryId: "e1", dialogs: "0", at: 1 },
    }),
    read: async () => { throw new DeskError("not-found", "No pi session x. pi_sessions lists the sessions."); },
  });
  const refused = await tools.pi_send.run({ session: "s1", message: "go", steer: false }, call);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^pi did not take your message: Directory does not exist: \/gone/);
  assert.match(refused.text, /\ncursor: e1~0~1$/);
  assert.deepEqual(await tools.pi_send.run({ session: "a b", message: "go", steer: false }, call), {
    text: '"a b" is not a pi session id or a pi-web link with ?session=<id>. pi_sessions lists the sessions.', isError: true,
  });
  assert.match((await tools.pi_wait.run({ session: "s1", cursor: "nope", timeout_s: 1 }, call)).text, /did not come from this server/);
  assert.equal((await tools.pi_read.run({ session: "x", messages: 1 }, call)).isError, true);
  assert.match((await tools.pi_answer.run({ session: "s1", dialog: "d" }, call)).text, /Pass answer, or cancel/);
});

test("pi_stop says what it did: a send on its way, nothing to stop, still unwinding, or what it withdrew", async () => {
  const results = [
    { kind: "send-pending", status: idleStatus },
    { kind: "idle", status: idleStatus },
    { kind: "unwinding" },
    { kind: "stopped", withdrawn: [{ text: "person steer", author: "person" }, { text: "agent\nfollow-up", author: "agent" }], status: idleStatus },
  ];
  const replies = [];
  for (const result of results) replies.push((await toolsWith({ stop: async () => result }).pi_stop.run({ session: "s1" }, call)).text);
  assert.deepEqual(replies, [
    "Your message is still on its way to pi, so nothing was stopped. Call pi_stop again in a moment.\npi is idle.",
    "There was nothing to stop.\npi is idle.",
    "Stop was sent, but pi is still unwinding the run (a tool that ignores its abort signal). pi_wait shows when it ends.",
    [
      "Stopped pi.",
      "Stop withdrew these queued messages. They were not sent, and they do not go back to the person's composer:",
      "  - [person] person steer",
      "  - [agent] agent follow-up",
      "pi is idle.",
    ].join("\n"),
  ]);
});

test("pi_read shows the latest page with a cursor, and an older page without one", async () => {
  const session = { id: "s1", title: "Fix the 500", cwd: "/w", branch: "main" };
  const asked = [{ role: "user", content: "hi" }];
  const called = [{ role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {} }], provider: "p", model: "m" }];
  const results = [
    { kind: "latest", session, status: idleStatus, page: { messages: asked, authors: ["person"], hasMore: true, oldestEntryId: "e1" }, cursor: { entryId: "e2", dialogs: "0", at: 1 } },
    { kind: "latest", session, status: idleStatus, page: { messages: [], authors: [], hasMore: false, oldestEntryId: null }, cursor: { entryId: null, dialogs: "0", at: 1 } },
    { kind: "older", session, status: idleStatus, page: { messages: called, authors: ["pi"], hasMore: true, oldestEntryId: "e0" } },
    { kind: "older", session, status: idleStatus, page: { messages: [], authors: [], hasMore: false, oldestEntryId: null } },
  ];
  const replies = [];
  for (const result of results) replies.push((await toolsWith({ read: async () => result }).pi_read.run({ session: "s1", messages: 12 }, call)).text);
  const head = 'Session s1 "Fix the 500" in /w (branch main).\npi-web link: https://pi.example.net/?session=s1\npi is idle.';
  assert.deepEqual(replies, [
    `${head}\nLatest messages:\n[person] hi\nolder: pi_read {"session":"s1","before":"e1"}\ncursor: e2~0~1`,
    `${head}\nNo messages yet.\ncursor: -~0~1`,
    `${head}\nOlder messages:\n[pi]\n  - bash {} -> no result\nolder: pi_read {"session":"s1","before":"e0"}\n(An older page: keep using the cursor you have.)`,
    `${head}\nNo older messages.\n(An older page: keep using the cursor you have.)`,
  ]);
});

test("pi_new_session hands the person a link on the caller's base", async () => {
  const tools = toolsWith({
    newSession: async (request) => ({
      session: { id: "new-1", title: null, cwd: request.cwd, branch: "fix/x" },
      model: "anthropic/claude-x",
      thinkingLevel: "high",
      untrusted: true,
      send: { send: { delivery: "followUp", outcome: { state: "accepted", disposition: "started", at: 1 } }, status: { ...idleStatus, running: true }, cursor: { entryId: null, dialogs: "0", at: 1 } },
    }),
  });
  const reply = await tools.pi_new_session.run({ cwd: "/w", message: "go", tools: "configured" }, call);
  assert.match(reply.text, /^Started session new-1 in \/w \(branch fix\/x\)\. Model anthropic\/claude-x, thinking high\./);
  assert.match(reply.text, /trusts it in pi-web/);
  assert.match(reply.text, /pi-web link for the person: https:\/\/pi\.example\.net\/\?session=new-1\n/);
  assert.match(reply.text, /pi started working on your message\./);
  assert.match(reply.text, /\ncursor: -~0~1$/);
});
