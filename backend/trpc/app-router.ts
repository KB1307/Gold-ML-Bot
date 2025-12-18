import { createTRPCRouter } from "./create-context";
import { exampleRouter } from "./routes/example";
import { signalsRouter } from "./routes/signals";
import { settingsRouter } from "./routes/settings";
import { learningRouter } from "./routes/learning";
import { authRouter } from "./routes/auth";
import { subscriptionRouter } from "./routes/subscription";

export const appRouter = createTRPCRouter({
  example: exampleRouter,
  signals: signalsRouter,
  settings: settingsRouter,
  learning: learningRouter,
  auth: authRouter,
  subscription: subscriptionRouter,
});

export type AppRouter = typeof appRouter;
