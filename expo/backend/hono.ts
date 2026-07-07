import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { appRouter } from "./trpc/app-router";
import { createContext } from "./trpc/create-context";
import { getLatestExport } from "./diagnosticsStore";

const app = new Hono();


app.use(
  "*",
  cors({
    origin: (_origin) => _origin,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-trpc-source"],
    credentials: true,
  })
);


app.use(
  "/trpc/*",
  trpcServer({
    endpoint: "/api/trpc",
    router: appRouter,
    createContext,
  }),
);

app.get("/", (c) => {
  return c.json({ status: "ok", message: "API is running" });
});

// Stable pull-by-URL download for the Settings > Export Diagnostics feature.
// Always serves whatever was most recently POSTed via diagnostics.saveExport —
// no caching, so this never serves a stale export.
app.get("/export/latest", (c) => {
  const latest = getLatestExport();

  c.header("Cache-Control", "no-store, no-cache, must-revalidate");

  if (!latest) {
    c.header("Content-Type", "text/plain; charset=utf-8");
    return c.body(
      "No diagnostics export has been generated yet.\n\nOpen the app, go to Settings > Export Diagnostics, and tap Export to create one.",
      404,
    );
  }

  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="diagnostics-export.txt"');
  return c.body(latest.content);
});

export default app;
