type RuntimeBindings = Record<string, unknown>;

let workerBindings: RuntimeBindings = {};

/** Makes Cloudflare Worker bindings visible to the legacy Hono route modules. */
export function bindRuntimeEnv(bindings: RuntimeBindings): void {
  workerBindings = bindings;
}

/** Reads a runtime value from Worker bindings, falling back to legacy process.env. */
export function readRuntimeEnv(name: string): string | undefined {
  const workerValue = workerBindings[name];
  if (typeof workerValue === "string") {
    return workerValue;
  }

  if (typeof process !== "undefined") {
    return process.env?.[name];
  }

  return undefined;
}
