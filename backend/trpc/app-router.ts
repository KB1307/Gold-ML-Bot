import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { goldPriceRouter } from "./routes/goldPrice";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  goldPrice: goldPriceRouter,
});

export type AppRouter = typeof appRouter;
