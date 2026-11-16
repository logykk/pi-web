/**
 * One value per process for `name`, made on first use. Route bundles and dev hot reloads
 * evaluate a module again, so a module-level value would be one per evaluation.
 */
export function processGlobal<T extends NonNullable<unknown>>(name: string, create: () => T): T {
  const store = globalThis as Record<symbol, T | undefined>;
  return (store[Symbol.for(`pi-web.mcp-endpoint.${name}`)] ??= create());
}
