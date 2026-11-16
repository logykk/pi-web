/**
 * Sets each variable for the rest of the test (undefined unsets it) and puts the old values back
 * after it. Call it once per test: node:test runs after hooks first in, first out.
 */
export function withEnv(t, values) {
  const set = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => set(previous));
  set(values);
}
