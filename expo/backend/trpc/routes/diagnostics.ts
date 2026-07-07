import * as z from "zod";

import { createTRPCRouter, publicProcedure } from "../create-context";
import { saveLatestExport } from "../../diagnosticsStore";

export const diagnosticsRouter = createTRPCRouter({
  saveExport: publicProcedure
    .input(z.object({ content: z.string().min(1) }))
    .mutation(({ input }) => {
      const stored = saveLatestExport(input.content);
      return { ok: true as const, savedAt: stored.createdAt };
    }),
});
