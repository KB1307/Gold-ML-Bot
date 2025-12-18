import { z } from "zod";
import { createTRPCRouter } from "../create-context";
import { premiumProcedure, goldProcedure } from "../middleware";
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

export const protectedSignalsRouter = createTRPCRouter({
  getPremiumSignals: premiumProcedure
    .input(z.object({
      limit: z.number().optional().default(50),
    }))
    .query(async ({ ctx, input }) => {
      await initDB();
      
      const query = `
        SELECT * FROM signals 
        WHERE status IN ['ACTIVE', 'TP1_HIT', 'TP2_HIT', 'TP3_HIT']
        ORDER BY savedAt DESC 
        LIMIT $limit
      `;
      
      const signals = await db.query<any[][]>(query, { limit: input.limit });
      const results = (signals && signals[0]) || [];
      
      if (ctx.user.tier === 'silver') {
        return results.map(signal => ({
          ...signal,
          tp3: null,
          confidence: null,
        }));
      }
      
      console.log(`✅ Premium signals delivered to user: ${ctx.user.id} (Tier: ${ctx.user.tier})`);
      return results;
    }),

  getGoldFeatures: goldProcedure
    .query(async ({ ctx }) => {
      await initDB();
      
      const analytics = await db.query<any[][]>(`
        SELECT 
          math::avg(confidence) as avgConfidence,
          COUNT(actualOutcome = 'WIN') as wins,
          COUNT(actualOutcome = 'LOSS') as losses
        FROM signals 
        WHERE actualOutcome IS NOT NONE
        GROUP ALL
      `);
      
      const result = (analytics && analytics[0] && analytics[0][0]) || {};
      
      console.log(`🏆 Gold analytics delivered to user: ${ctx.user.id}`);
      
      return {
        avgConfidence: result.avgConfidence || 0,
        winRate: result.wins && result.losses 
          ? (result.wins / (result.wins + result.losses)) * 100 
          : 0,
        totalSignals: (result.wins || 0) + (result.losses || 0),
      };
    }),

  requestLiveSignal: premiumProcedure
    .mutation(async ({ ctx }) => {
      await initDB();
      
      const rateLimitCheck = await db.query<any[][]>(`
        SELECT COUNT() as count FROM signal_requests 
        WHERE userId = $userId 
        AND timestamp > time::now() - 1h
      `, { userId: ctx.user.id });
      
      const requestCount = rateLimitCheck && rateLimitCheck[0] && rateLimitCheck[0][0]?.count || 0;
      
      const limit = ctx.user.tier === 'gold' ? 10 : 3;
      
      if (requestCount >= limit) {
        throw new Error(`Rate limit exceeded. ${ctx.user.tier === 'gold' ? 'Gold' : 'Silver'} users can request ${limit} signals per hour.`);
      }
      
      await db.create("signal_requests", {
        userId: ctx.user.id,
        tier: ctx.user.tier,
        timestamp: new Date().toISOString(),
      });
      
      console.log(`📊 Live signal requested by ${ctx.user.id} (${ctx.user.tier})`);
      
      return { 
        success: true, 
        message: 'Signal generation initiated',
        requestsRemaining: limit - requestCount - 1,
      };
    }),
});
