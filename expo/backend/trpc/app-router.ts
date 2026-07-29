import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { goldPriceRouter } from "./routes/goldPrice";
import { diagnosticsRouter } from "./routes/diagnostics";
import { telegramRouter } from "./routes/telegram";
import { economicCalendarRouter } from "./routes/economicCalendar";
import { srZonesRouter } from "./routes/srZones";
import { learningRouter } from "./routes/learning";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  goldPrice: goldPriceRouter,
  diagnostics: diagnosticsRouter,
  telegram: telegramRouter,
  economicCalendar: economicCalendarRouter,
  srZones: srZonesRouter,
  learning: learningRouter,
});

export type AppRouter = typeof appRouter;
