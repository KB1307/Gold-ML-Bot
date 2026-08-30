import { Hono } from "../expo/node_modules/hono";

import legacyApi from "../expo/backend/hono";
import { bindRuntimeEnv } from "../expo/backend/runtimeEnv";

type WorkerBindings = Record<string, unknown>;

const app = new Hono<{ Bindings: WorkerBindings }>();

app.use("*", async (context, next) => {
  bindRuntimeEnv(context.env);
  await next();
});

function healthPayload(service: string): Record<string, string> {
  return {
    status: "ok",
    service,
    runtime: "cloudflare",
    checkedAt: new Date().toISOString(),
  };
}

app.get("/", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json(healthPayload("gold-signal-bot-backend"));
});

app.get("/ping", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json(healthPayload("gold-signal-bot-backend"));
});

// Stable plain-JSON probe registered before the tRPC mount so it cannot be
// interpreted as a procedure call.
app.get("/api/trpc/health", (context) => {
  context.header("Cache-Control", "no-store");
  return context.json(healthPayload("trpc"));
});

// Preserve the existing public contract. Hono route() prefixes the legacy
// app's already-registered /trpc/* and /export/latest routes correctly;
// basePath() does not retroactively prefix those routes.
app.route("/api", legacyApi);

export default app;
