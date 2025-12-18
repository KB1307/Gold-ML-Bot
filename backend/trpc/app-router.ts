import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { signalsRouter } from "./routes/signals";
import { settingsRouter } from "./routes/settings";
import { learningRouter } from "./routes/learning";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  signals: signalsRouter,
  settings: settingsRouter,
  learning: learningRouter,
});

export type AppRouter = typeof appRouter;
