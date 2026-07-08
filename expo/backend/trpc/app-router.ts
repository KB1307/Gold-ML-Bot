import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { goldPriceRouter } from "./routes/goldPrice";
import { diagnosticsRouter } from "./routes/diagnostics";
import { telegramRouter } from "./routes/telegram";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  goldPrice: goldPriceRouter,
  diagnostics: diagnosticsRouter,
  telegram: telegramRouter,
});

export type AppRouter = typeof appRouter;
