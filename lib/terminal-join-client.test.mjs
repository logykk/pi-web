import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { joinableTerminalTab } = await jiti.import("./terminal-join-client.ts");

const ID = "9f2c41d07a3b4e1f8c2d6e5a4b3c2d1e";

function withFetch(t, respond) {
  const asked = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url) => {
    asked.push(url);
    return respond();
  };
  t.after(() => { globalThis.fetch = previous; });
  return asked;
}

test("the first joinable terminal becomes a restored tab with the browser's own cwd", async (t) => {
  const asked = withFetch(t, () => Response.json({ terminals: [{ id: ID }, { id: "a".repeat(32) }] }));
  assert.deepEqual(await joinableTerminalTab("/w/my project"), { id: ID, cwd: "/w/my project", restored: true });
  assert.deepEqual(asked, ["/api/terminals?cwd=%2Fw%2Fmy%20project"]);
});

test("no terminal, a refusal, a failed request or an id a tab cannot adopt is null: the button starts a shell", async (t) => {
  const replies = [
    () => Response.json({ terminals: [] }),
    () => Response.json({ error: "Access denied" }, { status: 403 }),
    () => { throw new TypeError("Failed to fetch"); },
    () => Response.json({ terminals: [{ id: "not-a-terminal-id" }] }),
    () => new Response("<html>", { status: 200 }),
  ];
  let next = 0;
  withFetch(t, () => replies[next++]());
  for (let i = 0; i < replies.length; i++) assert.equal(await joinableTerminalTab("/w"), null, `reply ${i}`);
});
