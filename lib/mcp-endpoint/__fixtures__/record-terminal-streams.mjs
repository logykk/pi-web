// Records the terminal streams terminal-render.test.mjs replays: node lib/mcp-endpoint/__fixtures__/record-terminal-streams.mjs
// A neutral shell (no profile, no rc, PS1 "$ ", a scratch HOME, a minimal environment), so no fixture
// carries a user name, a host name or a home path; the recording fails if one does.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const { spawn } = createRequire(import.meta.url)("node-pty");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ESC = "\x1b";

async function record(home, steps, { cols = 80, rows = 24 } = {}) {
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TERM: "xterm-256color", LANG: "C.UTF-8", PS1: "$ ", HISTFILE: "/dev/null", INPUTRC: "/dev/null", LESSHISTFILE: "-" };
  const pty = spawn("/bin/bash", ["--noprofile", "--norc", "-i"], { name: "xterm-256color", cols, rows, cwd: home, env });
  let stream = "";
  pty.onData((data) => { stream += data; });
  const marks = {};
  const shell = {
    mark: (name) => { marks[name] = stream.length; },
    write: (data) => pty.write(data),
    type: async (text) => { for (const char of text) { pty.write(char); await sleep(15); } },
    sleep,
  };
  await sleep(500);
  for (const step of steps) await step(shell);
  await sleep(400);
  pty.kill();
  return { cols, rows, stream, marks };
}

const scenarios = {
  readline: [async (s) => {
    s.mark("start");
    await s.type("echo helo"); s.write("\x7f\x7f"); await s.sleep(100); await s.type("llo world"); s.write("\r"); await s.sleep(300);
    s.mark("history");
    s.write(`${ESC}[A`); await s.sleep(200); s.write("\r"); await s.sleep(300);
    s.mark("midline");
    await s.type("echo abc"); s.write(`${ESC}[D${ESC}[D`); await s.sleep(100); s.write("X"); await s.sleep(100); s.write("\r"); await s.sleep(300);
    s.mark("half");
    await s.type("echo half");
  }],
  progress: [async (s) => {
    s.mark("start");
    s.write("for i in 10 20 30 40 50 60 70 80 90 100; do printf '\\rdownloading %3d%%' $i; sleep 0.02; done; echo; echo done\r");
    await s.sleep(800);
  }],
  "multiline-progress": [async (s) => {
    s.mark("start");
    s.write("printf 'a: 0%%\\nb: 0%%\\n'; for i in 25 50 75 100; do printf '\\033[2A\\ra: %d%%\\033[K\\nb: %d%%\\033[K\\n' $i $((i/2)); sleep 0.05; done\r");
    await s.sleep(800);
  }],
  clear: [async (s) => {
    s.write("echo before\r"); await s.sleep(300);
    s.mark("before-clear");
    s.write("clear\r"); await s.sleep(300);
    s.write("echo after\r"); await s.sleep(300);
  }],
  longline: [async (s) => {
    s.mark("start");
    await s.type(`echo ${"x".repeat(100)}`); s.write(`${ESC}[H`); await s.sleep(100); s.write(`${ESC}[F`); await s.sleep(100);
    for (let i = 0; i < 20; i++) s.write(`${ESC}[D`);
    await s.sleep(200); s.write("YY"); await s.sleep(200); s.write("\r"); await s.sleep(300);
  }],
  vim: [async (s) => {
    s.write("printf 'first line\\n' > notes.txt\r"); await s.sleep(300);
    s.mark("start");
    s.write("vim -u NONE -N -i NONE --cmd 'set notitle noicon' notes.txt\r"); await s.sleep(1000);
    s.write("Go"); await s.sleep(100); await s.type("added line"); s.write(ESC); await s.sleep(400);
    s.mark("editing");
    s.write(":wq\r"); await s.sleep(500);
    s.write("cat notes.txt\r"); await s.sleep(300);
  }],
  less: [async (s) => {
    s.mark("start");
    s.write("seq 1 200 | less\r"); await s.sleep(600);
    s.write(" "); await s.sleep(400);
    s.mark("paged");
    s.write("q"); await s.sleep(300);
  }],
};

const scratch = await mkdtemp(join(tmpdir(), "pi-web-terminal-fixtures-"));
try {
  const recorded = {};
  for (const [name, steps] of Object.entries(scenarios)) recorded[name] = await record(scratch, steps);
  const json = `${JSON.stringify(recorded, null, 1)}\n`;
  for (const secret of [userInfo().username, hostname(), homedir(), scratch]) {
    if (json.includes(secret)) throw new Error(`a fixture contains ${JSON.stringify(secret)}; nothing written`);
  }
  await writeFile(new URL("./terminal-streams.json", import.meta.url), json);
  console.log(Object.entries(recorded).map(([name, { stream }]) => `${name}: ${stream.length} units`).join("\n"));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
process.exit(0);
