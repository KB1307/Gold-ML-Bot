import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { goldPriceRouter } from "./routes/goldPrice";
import { diagnosticsRouter } from "./routes/diagnostics";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  goldPrice: goldPriceRouter,
  diagnostics: diagnosticsRouter,
});

export type AppRouter = typeof appRouter;
