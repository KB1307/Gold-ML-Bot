import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { default as Surreal } from "surrealdb";

const db = new Surreal();

const initDB = async () => {
  try {
    await db.connect(process.env.EXPO_PUBLIC_RORK_DB_ENDPOINT!, {
      namespace: process.env.EXPO_PUBLIC_RORK_DB_NAMESPACE!,
      database: "trading_signals",
    });
    await db.authenticate(process.env.EXPO_PUBLIC_RORK_DB_TOKEN!);
  } catch (error) {
    console.error("DB connection error:", error);
  }
};

export const learningRouter = createTRPCRouter({
  saveDailyOHLC: publicProcedure
    .input(z.object({
      date: z.string(),
      open: z.number(),
      high: z.number(),
      low: z.number(),
      close: z.number(),
      volume: z.number().optional(),
      patterns: z.array(z.string()).optional(),
    }))
    .mutation(async ({ input }) => {
      await initDB();
      
      await db.create("daily_ohlc", {
        ...input,
        savedAt: new Date().toISOString(),
      });
      
      return { success: true };
    }),

  getDailyOHLC: publicProcedure
    .input(z.object({
      days: z.number().optional().default(100),
    }))
    .query(async ({ input }) => {
      await initDB();
      
      const ohlc = await db.query<any[][]>(`
        SELECT * FROM daily_ohlc
        ORDER BY date DESC
        LIMIT $limit
      `, { limit: input.days });
      
      return (ohlc && ohlc[0]) || [];
    }),

  saveModelWeights: publicProcedure
    .input(z.object({
      modelVersion: z.string(),
      weights: z.record(z.string(), z.number()),
      performance: z.object({
        accuracy: z.number(),
        precision: z.number(),
        recall: z.number(),
        f1Score: z.number(),
      }),
    }))
    .mutation(async ({ input }) => {
      await initDB();
      
      await db.create("model_weights", {
        ...input,
        createdAt: new Date().toISOString(),
      });
      
      console.log(`✅ Model weights saved: ${input.modelVersion}`);
      return { success: true };
    }),

  getLatestModelWeights: publicProcedure
    .query(async () => {
      await initDB();
      
      const weights = await db.query<any[][]>(`
        SELECT * FROM model_weights
        ORDER BY createdAt DESC
        LIMIT 1
      `);
      
      return (weights && weights[0] && weights[0][0]) || null;
    }),

  saveFeatureImportance: publicProcedure
    .input(z.object({
      features: z.array(z.object({
        name: z.string(),
        importance: z.number(),
        winRate: z.number(),
        avgProfitLoss: z.number(),
      })),
    }))
    .mutation(async ({ input }) => {
      await initDB();
      
      await db.create("feature_importance", {
        features: input.features,
        calculatedAt: new Date().toISOString(),
      });
      
      return { success: true };
    }),

  getFeatureImportance: publicProcedure
    .query(async () => {
      await initDB();
      
      const importance = await db.query<any[][]>(`
        SELECT * FROM feature_importance
        ORDER BY calculatedAt DESC
        LIMIT 1
      `);
      
      return (importance && importance[0] && importance[0][0] && importance[0][0].features) || [];
    }),

  calculateConfidenceAdjustments: publicProcedure
    .query(async () => {
      await initDB();
      
      const recentSignals = await db.query<any[][]>(`
        SELECT 
          confidence,
          actualOutcome,
          topFeatures[*].feature as features
        FROM signals
        WHERE actualOutcome IS NOT NONE
        ORDER BY savedAt DESC
        LIMIT 1000
      `);

      const confidenceBuckets = new Map();
      const results = (recentSignals && recentSignals[0]) || [];
      
      results.forEach((signal: any) => {
        const bucket = Math.floor(signal.confidence * 10) / 10;
        if (!confidenceBuckets.has(bucket)) {
          confidenceBuckets.set(bucket, { wins: 0, total: 0 });
        }
        const stats = confidenceBuckets.get(bucket);
        stats.total++;
        if (signal.actualOutcome === 'WIN') stats.wins++;
      });

      const adjustments = Array.from(confidenceBuckets.entries()).map(([bucket, stats]: [number, any]) => ({
        confidenceRange: bucket,
        actualWinRate: stats.wins / stats.total,
        sampleSize: stats.total,
        adjustment: (stats.wins / stats.total) - bucket,
      }));

      return adjustments;
    }),
});
