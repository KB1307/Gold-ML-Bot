import { TRPCError } from "@trpc/server";
import { publicProcedure } from "./create-context";
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

export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const authHeader = ctx.req.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    });
  }
  
  const userId = authHeader.replace('Bearer ', '');
  
  await initDB();
  const result = await db.query<any[][]>(
    `SELECT * FROM users WHERE id = $userId LIMIT 1`,
    { userId }
  );
  
  const user = result && result[0] && result[0][0];
  
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not found',
    });
  }
  
  return next({
    ctx: {
      ...ctx,
      user: {
        id: user.id,
        email: user.email,
        isPremium: user.isPremium || false,
        tier: user.tier || 'free',
      },
    },
  });
});

export const premiumProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  await initDB();
  
  const result = await db.query<any[][]>(
    `SELECT isPremium, tier, expiryDate, subscriptionStatus FROM users WHERE id = $userId LIMIT 1`,
    { userId: ctx.user.id }
  );
  
  const user = result && result[0] && result[0][0];
  
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'User not found',
    });
  }
  
  if (user.expiryDate && new Date(user.expiryDate) < new Date()) {
    await db.merge(ctx.user.id, {
      isPremium: false,
      subscriptionStatus: 'expired',
    });
    
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Subscription expired. Please renew to continue.',
    });
  }
  
  if (!user.isPremium) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Premium subscription required',
    });
  }
  
  return next({
    ctx: {
      ...ctx,
      user: {
        ...ctx.user,
        tier: user.tier,
      },
    },
  });
});

export const goldProcedure = premiumProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.tier !== 'gold') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Gold tier subscription required for this feature',
    });
  }
  
  return next();
});
