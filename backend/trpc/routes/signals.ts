import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { getDB } from "../../db";

const SignalDataSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.enum(["BUY", "SELL"]),
  entryPrice: z.number(),
  entryPriceWithSlippage: z.number(),
  tp1: z.number(),
  tp2: z.number(),
  tp3: z.number(),
  sl: z.number(),
  slMultiplier: z.number(),
  confidence: z.number(),
  status: z.string(),
  targetsHit: z.number(),
  entryTime: z.string(),
  exitTime: z.string().optional(),
  topFeatures: z.array(z.object({
    feature: z.string(),
    score: z.number(),
  })),
  macroWarning: z.object({
    name: z.string(),
    impact: z.enum(["HIGH", "MEDIUM", "LOW"]),
    timeUntilEvent: z.number(),
  }).optional(),
  riskJustification: z.string(),
  createdAt: z.number().optional(),
  profitLoss: z.number().optional(),
  actualOutcome: z.enum(["WIN", "LOSS", "PARTIAL"]).optional(),
  marketConditions: z.object({
    session: z.string().optional(),
    volatility: z.number().optional(),
    trend: z.string().optional(),
  }).optional(),
});

export const signalsRouter = createTRPCRouter({
  saveSignal: publicProcedure
    .input(SignalDataSchema)
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      const result = await db.create("signals", {
        ...input,
        savedAt: new Date().toISOString(),
      });
      
      console.log(`✅ Signal saved: ${input.id} - ${input.status}`);
      return { success: true, id: result };
    }),

  updateSignalOutcome: publicProcedure
    .input(z.object({
      id: z.string(),
      status: z.string(),
      exitTime: z.string(),
      targetsHit: z.number(),
      profitLoss: z.number(),
      actualOutcome: z.enum(["WIN", "LOSS", "PARTIAL"]),
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      await db.merge(`signals:${input.id}`, {
        status: input.status,
        exitTime: input.exitTime,
        targetsHit: input.targetsHit,
        profitLoss: input.profitLoss,
        actualOutcome: input.actualOutcome,
        updatedAt: new Date().toISOString(),
      });
      
      console.log(`✅ Signal outcome updated: ${input.id} - ${input.actualOutcome}`);
      return { success: true };
    }),

  getSignalHistory: publicProcedure
    .input(z.object({
      limit: z.number().optional().default(100),
      status: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      let query = "SELECT * FROM signals";
      if (input.status) {
        query += ` WHERE status = $status`;
      }
      query += " ORDER BY savedAt DESC LIMIT $limit";
      
      const signals = await db.query<any[][]>(query, {
        status: input.status,
        limit: input.limit,
      });
      
      return (signals && signals[0]) || [];
    }),

  getMLTrainingData: publicProcedure
    .query(async () => {
      const db = await getDB();
      
      const completedSignals = await db.query<any[][]>(`
        SELECT 
          confidence,
          topFeatures,
          actualOutcome,
          profitLoss,
          type,
          status,
          marketConditions
        FROM signals 
        WHERE actualOutcome IN ['WIN', 'LOSS', 'PARTIAL']
        ORDER BY savedAt DESC
      `);
      
      const results = (completedSignals && completedSignals[0]) || [];
      console.log(`📊 Retrieved ${results.length} signals for ML training`);
      return results;
    }),

  getPerformanceAnalytics: publicProcedure
    .query(async () => {
      const db = await getDB();
      
      const analytics = await db.query<any[][]>(`
        SELECT 
          COUNT() as totalSignals,
          math::sum(profitLoss) as totalProfitLoss,
          math::avg(confidence) as avgConfidence,
          COUNT(actualOutcome = 'WIN') as wins,
          COUNT(actualOutcome = 'LOSS') as losses,
          COUNT(actualOutcome = 'PARTIAL') as partials
        FROM signals 
        WHERE actualOutcome IS NOT NONE
        GROUP ALL
      `);
      
      return (analytics && analytics[0] && analytics[0][0]) || null;
    }),

  getFeaturePerformance: publicProcedure
    .query(async () => {
      const db = await getDB();
      
      const featureStats = await db.query<any[][]>(`
        SELECT 
          topFeatures[*].feature as features,
          actualOutcome,
          profitLoss
        FROM signals 
        WHERE actualOutcome IS NOT NONE
      `);
      
      const featureMap = new Map();
      const results = (featureStats && featureStats[0]) || [];
      results.forEach((signal: any) => {
        signal.features?.forEach((feature: string) => {
          if (!featureMap.has(feature)) {
            featureMap.set(feature, { wins: 0, losses: 0, totalPL: 0, count: 0 });
          }
          const stats = featureMap.get(feature);
          stats.count++;
          stats.totalPL += signal.profitLoss || 0;
          if (signal.actualOutcome === 'WIN') stats.wins++;
          if (signal.actualOutcome === 'LOSS') stats.losses++;
        });
      });
      
      return Array.from(featureMap.entries()).map(([feature, stats]: [string, any]) => ({
        feature,
        winRate: stats.wins / (stats.wins + stats.losses) || 0,
        avgProfitLoss: stats.totalPL / stats.count,
        count: stats.count,
      }));
    }),
});
