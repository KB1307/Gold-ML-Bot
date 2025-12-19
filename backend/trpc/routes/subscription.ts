import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { getDB } from "../../db";

export const subscriptionRouter = createTRPCRouter({
  updateSubscription: publicProcedure
    .input(z.object({
      userId: z.string(),
      tier: z.enum(['free', 'silver', 'gold']),
      isPremium: z.boolean(),
      subscriptionId: z.string().optional(),
      purchaseToken: z.string().optional(),
      expiryDate: z.string().optional(),
      status: z.enum(['active', 'cancelled', 'expired', 'grace_period', 'none']),
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      await db.merge(input.userId, {
        tier: input.tier,
        isPremium: input.isPremium,
        subscriptionId: input.subscriptionId,
        purchaseToken: input.purchaseToken,
        expiryDate: input.expiryDate,
        subscriptionStatus: input.status,
        lastSubscriptionUpdate: new Date().toISOString(),
      });
      
      console.log(`✅ Subscription updated for user: ${input.userId} - Tier: ${input.tier}, Status: ${input.status}`);
      
      return { success: true };
    }),

  handleWebhook: publicProcedure
    .input(z.object({
      eventType: z.enum([
        'INITIAL_PURCHASE',
        'RENEWAL',
        'CANCELLATION',
        'EXPIRATION',
        'BILLING_ISSUE',
        'REFUND',
      ]),
      userId: z.string(),
      subscriptionId: z.string(),
      purchaseToken: z.string().optional(),
      expiryDate: z.string().optional(),
      productId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = await getDB();
      
      console.log(`🔔 Webhook received: ${input.eventType} for user ${input.userId}`);
      
      const result = await db.query<any[][]>(
        `SELECT * FROM users WHERE id = $userId LIMIT 1`,
        { userId: input.userId }
      );
      
      const user = result && result[0] && result[0][0];
      
      if (!user) {
        console.error(`❌ User not found: ${input.userId}`);
        return { success: false, error: 'User not found' };
      }
      
      let updateData: any = {
        lastWebhookEvent: input.eventType,
        lastWebhookTime: new Date().toISOString(),
      };
      
      switch (input.eventType) {
        case 'INITIAL_PURCHASE':
        case 'RENEWAL':
          const tier = input.productId?.includes('gold') ? 'gold' : 
                       input.productId?.includes('silver') ? 'silver' : 'free';
          
          updateData = {
            ...updateData,
            isPremium: true,
            tier: tier,
            subscriptionStatus: 'active',
            subscriptionId: input.subscriptionId,
            purchaseToken: input.purchaseToken,
            expiryDate: input.expiryDate,
          };
          
          await db.create("subscription_events", {
            userId: input.userId,
            eventType: input.eventType,
            tier: tier,
            timestamp: new Date().toISOString(),
          });
          
          console.log(`✅ Access GRANTED for user ${input.userId} - Tier: ${tier}`);
          break;
          
        case 'CANCELLATION':
          updateData = {
            ...updateData,
            subscriptionStatus: 'cancelled',
          };
          console.log(`⚠️ Subscription cancelled (access until expiry): ${input.userId}`);
          break;
          
        case 'EXPIRATION':
          updateData = {
            ...updateData,
            isPremium: false,
            tier: 'free',
            subscriptionStatus: 'expired',
          };
          
          await db.create("subscription_events", {
            userId: input.userId,
            eventType: 'EXPIRATION',
            previousTier: user.tier,
            timestamp: new Date().toISOString(),
          });
          
          console.log(`🔒 Access REVOKED for user ${input.userId}`);
          break;
          
        case 'BILLING_ISSUE':
          updateData = {
            ...updateData,
            subscriptionStatus: 'grace_period',
          };
          console.log(`⚠️ Billing issue for user ${input.userId}`);
          break;
          
        case 'REFUND':
          updateData = {
            ...updateData,
            isPremium: false,
            tier: 'free',
            subscriptionStatus: 'refunded',
          };
          console.log(`💸 Refund processed for user ${input.userId}`);
          break;
      }
      
      await db.merge(input.userId, updateData);
      
      return { success: true, action: input.eventType };
    }),

  getSubscriptionHistory: publicProcedure
    .input(z.object({
      userId: z.string(),
    }))
    .query(async ({ input }) => {
      const db = await getDB();
      
      const events = await db.query<any[][]>(
        `SELECT * FROM subscription_events WHERE userId = $userId ORDER BY timestamp DESC`,
        { userId: input.userId }
      );
      
      return (events && events[0]) || [];
    }),

  getTierFeatures: publicProcedure
    .query(async () => {
      return {
        free: {
          name: 'Free',
          features: [
            'View basic market trends',
            'Limited signal history (7 days)',
            'No live signals',
          ],
          price: 0,
        },
        silver: {
          name: 'Silver',
          features: [
            'Basic Buy/Sell signals',
            'TP1 & TP2 targets',
            'Standard Stop Loss',
            'Signal history (30 days)',
            'Email notifications',
          ],
          price: 29.99,
          billingPeriod: 'monthly',
        },
        gold: {
          name: 'Gold VIP',
          features: [
            'All Silver features',
            'TP3 (Runner targets)',
            'AI Confidence scores',
            'ATR-adjusted Stop Loss',
            'Market Regime Analysis',
            'Unlimited history',
            'Priority support',
            'SMS notifications',
          ],
          price: 79.99,
          billingPeriod: 'monthly',
          recommended: true,
        },
      };
    }),
});
