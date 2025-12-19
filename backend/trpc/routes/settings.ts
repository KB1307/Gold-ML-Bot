import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { getDB } from "../../db";

const SettingsSchema = z.object({
  tp1Pips: z.number(),
  tp2Pips: z.number(),
  tp3Pips: z.number(),
  slPips: z.number(),
  numberOfTPs: z.number(),
  minConfidence: z.number(),
  enableNotifications: z.boolean(),
  basePositionSize: z.number(),
  maxRiskPercentage: z.number(),
  useKellyCriterion: z.boolean(),
});

const MetricsSchema = z.object({
  totalTrades: z.number(),
  winningTrades: z.number(),
  losingTrades: z.number(),
  totalProfit: z.number(),
  totalLoss: z.number(),
  maxDrawdown: z.number(),
  currentDrawdown: z.number(),
  sharpeRatio: z.number(),
  profitFactor: z.number(),
  winRate: z.number(),
  averageWin: z.number(),
  averageLoss: z.number(),
  expectancy: z.number(),
});

export const settingsRouter = createTRPCRouter({
  saveSettings: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
      settings: SettingsSchema,
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      const result = await db.merge(`user_settings:${input.userId}`, {
        ...input.settings,
        updatedAt: new Date().toISOString(),
      });
      
      console.log(`✅ Settings saved for user: ${input.userId}`);
      return { success: true, data: result };
    }),

  getSettings: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      const settings = await db.select(`user_settings:${input.userId}`);
      
      return Array.isArray(settings) && settings.length > 0 ? settings[0] : null;
    }),

  saveMetrics: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
      metrics: MetricsSchema,
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      const result = await db.merge(`user_metrics:${input.userId}`, {
        ...input.metrics,
        updatedAt: new Date().toISOString(),
      });
      
      console.log(`✅ Metrics saved for user: ${input.userId}`);
      return { success: true, data: result };
    }),

  getMetrics: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      const metrics = await db.select(`user_metrics:${input.userId}`);
      
      return Array.isArray(metrics) && metrics.length > 0 ? metrics[0] : null;
    }),

  saveAccountSnapshot: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
      balance: z.number(),
      equity: z.number().optional(),
      openPositions: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      await db.create("account_snapshots", {
        userId: input.userId,
        balance: input.balance,
        equity: input.equity,
        openPositions: input.openPositions,
        timestamp: new Date().toISOString(),
      });
      
      return { success: true };
    }),

  getAccountHistory: publicProcedure
    .input(z.object({
      userId: z.string().optional().default("default_user"),
      days: z.number().optional().default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - input.days);
      
      const snapshots = await db.query<any[][]>(`
        SELECT * FROM account_snapshots
        WHERE userId = $userId AND timestamp > $cutoffDate
        ORDER BY timestamp DESC
      `, {
        userId: input.userId,
        cutoffDate: cutoffDate.toISOString(),
      });
      
      return (snapshots && snapshots[0]) || [];
    }),
});
