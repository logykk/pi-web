import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

test("processGlobal makes one value per process and name, however often its module is evaluated", async () => {
  const fresh = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const [first, second] = [await fresh.import("./process-global.ts"), await fresh.import("./process-global.ts")];
  let made = 0;
  const create = () => ({ made: (made += 1) });
  const value = first.processGlobal("process-global-test", create);
  assert.equal(second.processGlobal("process-global-test", create), value);
  assert.equal(made, 1);
  assert.notEqual(first.processGlobal("process-global-test-other", create), value, "another name is another value");
});
