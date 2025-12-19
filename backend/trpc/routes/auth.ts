import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { getDB } from "../../db";

export const authRouter = createTRPCRouter({
  signInWithGoogle: publicProcedure
    .input(z.object({
      googleId: z.string(),
      email: z.string().email(),
      name: z.string().optional(),
      photoUrl: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      const existingUsers = await db.query<any[][]>(
        `SELECT * FROM users WHERE googleId = $googleId LIMIT 1`,
        { googleId: input.googleId }
      );
      
      let user;
      
      if (existingUsers && existingUsers[0] && existingUsers[0].length > 0) {
        user = existingUsers[0][0];
        await db.merge(`users:${user.id.split(':')[1]}`, {
          lastLogin: new Date().toISOString(),
        });
        console.log(`✅ User logged in: ${input.email}`);
      } else {
        const newUser = await db.create("users", {
          googleId: input.googleId,
          email: input.email,
          name: input.name,
          photoUrl: input.photoUrl,
          isPremium: false,
          tier: 'free',
          subscriptionStatus: 'none',
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        });
        user = newUser;
        console.log(`🆕 New user created: ${input.email}`);
      }
      
      return { 
        success: true, 
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          photoUrl: user.photoUrl,
          isPremium: user.isPremium || false,
          tier: user.tier || 'free',
          subscriptionStatus: user.subscriptionStatus,
          expiryDate: user.expiryDate,
        }
      };
    }),

  getUser: publicProcedure
    .input(z.object({
      userId: z.string().optional(),
      googleId: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      let query = "";
      let params = {};
      
      if (input.userId) {
        query = `SELECT * FROM users WHERE id = $userId LIMIT 1`;
        params = { userId: input.userId };
      } else if (input.googleId) {
        query = `SELECT * FROM users WHERE googleId = $googleId LIMIT 1`;
        params = { googleId: input.googleId };
      } else {
        throw new Error("Either userId or googleId is required");
      }
      
      const result = await db.query<any[][]>(query, params);
      const user = result && result[0] && result[0][0];
      
      if (!user) {
        return null;
      }
      
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        photoUrl: user.photoUrl,
        isPremium: user.isPremium || false,
        tier: user.tier || 'free',
        subscriptionStatus: user.subscriptionStatus,
        expiryDate: user.expiryDate,
        createdAt: user.createdAt,
      };
    }),

  checkSubscriptionStatus: publicProcedure
    .input(z.object({
      userId: z.string(),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      const result = await db.query<any[][]>(
        `SELECT isPremium, tier, subscriptionStatus, expiryDate FROM users WHERE id = $userId LIMIT 1`,
        { userId: input.userId }
      );
      
      const user = result && result[0] && result[0][0];
      
      if (!user) {
        return { hasAccess: false, tier: 'free', status: 'none' };
      }
      
      if (user.expiryDate && new Date(user.expiryDate) < new Date()) {
        await db.merge(input.userId, {
          isPremium: false,
          subscriptionStatus: 'expired',
        });
        return { hasAccess: false, tier: 'free', status: 'expired' };
      }
      
      return {
        hasAccess: user.isPremium || false,
        tier: user.tier || 'free',
        status: user.subscriptionStatus || 'none',
        expiryDate: user.expiryDate,
      };
    }),
});
