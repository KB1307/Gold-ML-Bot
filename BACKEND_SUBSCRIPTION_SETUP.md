# Backend Subscription Management Setup

## Overview
This backend provides a complete subscription management system for your Gold Trading Signals app with tiered access control (Free, Silver, Gold).

## Architecture

### Database Schema (SurrealDB)

#### Users Table
```sql
DEFINE TABLE users SCHEMAFULL;
DEFINE FIELD googleId ON users TYPE string ASSERT $value != NONE;
DEFINE FIELD email ON users TYPE string ASSERT $value != NONE;
DEFINE FIELD name ON users TYPE string;
DEFINE FIELD photoUrl ON users TYPE string;
DEFINE FIELD isPremium ON users TYPE bool DEFAULT false;
DEFINE FIELD tier ON users TYPE string DEFAULT 'free';
DEFINE FIELD subscriptionStatus ON users TYPE string DEFAULT 'none';
DEFINE FIELD subscriptionId ON users TYPE string;
DEFINE FIELD purchaseToken ON users TYPE string;
DEFINE FIELD expiryDate ON users TYPE datetime;
DEFINE FIELD createdAt ON users TYPE datetime;
DEFINE FIELD lastLogin ON users TYPE datetime;
DEFINE FIELD lastSubscriptionUpdate ON users TYPE datetime;
DEFINE INDEX idx_googleId ON users COLUMNS googleId UNIQUE;
DEFINE INDEX idx_email ON users COLUMNS email UNIQUE;
```

#### Subscription Events Table
```sql
DEFINE TABLE subscription_events SCHEMAFULL;
DEFINE FIELD userId ON subscription_events TYPE string;
DEFINE FIELD eventType ON subscription_events TYPE string;
DEFINE FIELD tier ON subscription_events TYPE string;
DEFINE FIELD previousTier ON subscription_events TYPE string;
DEFINE FIELD timestamp ON subscription_events TYPE datetime;
```

#### Signal Requests Table (Rate Limiting)
```sql
DEFINE TABLE signal_requests SCHEMAFULL;
DEFINE FIELD userId ON signal_requests TYPE string;
DEFINE FIELD tier ON signal_requests TYPE string;
DEFINE FIELD timestamp ON signal_requests TYPE datetime;
```

## API Routes

### Authentication Routes (`auth` router)

#### 1. Sign In with Google
```typescript
trpc.auth.signInWithGoogle.mutate({
  googleId: "105885291326896477392",
  email: "user@gmail.com",
  name: "John Doe",
  photoUrl: "https://..."
})
```

#### 2. Get User
```typescript
trpc.auth.getUser.query({
  userId: "users:abc123"
  // OR
  googleId: "105885291326896477392"
})
```

#### 3. Check Subscription Status
```typescript
trpc.auth.checkSubscriptionStatus.query({
  userId: "users:abc123"
})
```

### Subscription Routes (`subscription` router)

#### 1. Update Subscription (After Purchase)
```typescript
trpc.subscription.updateSubscription.mutate({
  userId: "users:abc123",
  tier: "gold",
  isPremium: true,
  subscriptionId: "gold_signals_monthly",
  purchaseToken: "token_from_google_play",
  expiryDate: "2025-02-18T00:00:00Z",
  status: "active"
})
```

#### 2. Handle Webhook (For RevenueCat/Play Store)
```typescript
trpc.subscription.handleWebhook.mutate({
  eventType: "RENEWAL", // or EXPIRATION, CANCELLATION, etc.
  userId: "users:abc123",
  subscriptionId: "gold_signals_monthly",
  purchaseToken: "token",
  expiryDate: "2025-03-18T00:00:00Z",
  productId: "gold_monthly"
})
```

#### 3. Get Tier Features
```typescript
trpc.subscription.getTierFeatures.query()
```

### Protected Signal Routes (`protectedSignals` router)

#### 1. Get Premium Signals (Silver/Gold only)
```typescript
// Requires Authorization header: "Bearer users:abc123"
trpc.protectedSignals.getPremiumSignals.query({
  limit: 50
})
```

#### 2. Get Gold Features (Gold only)
```typescript
trpc.protectedSignals.getGoldFeatures.query()
```

#### 3. Request Live Signal (with rate limiting)
```typescript
trpc.protectedSignals.requestLiveSignal.mutate()
```

## Tier System

### Free Tier
- View basic market trends
- Limited signal history (7 days)
- No live signals

### Silver Tier ($29.99/month)
- Basic Buy/Sell signals
- TP1 & TP2 targets (TP3 hidden)
- Standard Stop Loss
- Signal history (30 days)
- 3 signal requests per hour
- Confidence scores hidden

### Gold Tier ($79.99/month)
- All Silver features
- TP3 (Runner targets) visible
- AI Confidence scores visible
- ATR-adjusted Stop Loss
- Market Regime Analysis
- Unlimited history
- 10 signal requests per hour
- Priority features

## Implementation Steps

### Step 1: Frontend Integration

Add Google Sign-In to your app:

```typescript
// In your settings page or auth screen
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';

const [request, response, promptAsync] = Google.useAuthRequest({
  expoClientId: 'YOUR_EXPO_CLIENT_ID',
  androidClientId: 'YOUR_ANDROID_CLIENT_ID',
  webClientId: 'YOUR_WEB_CLIENT_ID',
});

// After successful auth
if (response?.type === 'success') {
  const { id_token } = response.params;
  
  await trpc.auth.signInWithGoogle.mutate({
    googleId: userInfo.id,
    email: userInfo.email,
    name: userInfo.name,
    photoUrl: userInfo.picture,
  });
}
```

### Step 2: Add Authorization to Requests

Store the userId in AsyncStorage after login and add it to protected requests:

```typescript
// In your TradingContext or auth context
const userId = await AsyncStorage.getItem('userId');

// Create tRPC client with auth header
const trpc = createTRPCReact<AppRouter>();
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/trpc`,
      headers: () => ({
        authorization: userId ? `Bearer ${userId}` : '',
      }),
    }),
  ],
});
```

### Step 3: Integrate with Google Play Billing

Use RevenueCat for simplicity:

1. Install RevenueCat: `npx expo install react-native-purchases`
2. Configure products in RevenueCat dashboard
3. Set up webhook to call your `handleWebhook` endpoint

```typescript
import Purchases from 'react-native-purchases';

// Initialize
await Purchases.configure({ apiKey: 'your_revenuecat_key' });

// Purchase
const purchase = await Purchases.purchasePackage(goldPackage);

// After successful purchase
await trpc.subscription.updateSubscription.mutate({
  userId: currentUser.id,
  tier: 'gold',
  isPremium: true,
  subscriptionId: purchase.productIdentifier,
  purchaseToken: purchase.purchaseToken,
  expiryDate: purchase.expiryDate,
  status: 'active',
});
```

### Step 4: Protect Your Signal Engine

Modify your signal generation to check subscription:

```typescript
// In contexts/TradingContext.tsx
const generateSignal = async () => {
  try {
    // Check subscription before expensive computation
    const status = await trpc.auth.checkSubscriptionStatus.query({
      userId: currentUser.id
    });
    
    if (!status.hasAccess) {
      Alert.alert('Premium Required', 'Upgrade to Silver or Gold to generate signals');
      return;
    }
    
    // Your existing signal generation logic
    // ...
  } catch (error) {
    console.error('Signal generation failed:', error);
  }
};
```

### Step 5: Set Up RevenueCat Webhook

In RevenueCat dashboard:
1. Go to Integrations → Webhooks
2. Add webhook URL: `https://your-backend.com/api/trpc/subscription.handleWebhook`
3. Select events: INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION
4. Use the secret key in your backend

## Security Best Practices

1. **Never trust the client**: Always verify subscription status on the backend
2. **Use server-side webhooks**: Let RevenueCat/Play Store notify your server directly
3. **Validate signatures**: Verify webhook signatures to prevent spoofing
4. **Rate limit requests**: Prevent abuse with per-tier rate limits
5. **Log all events**: Track subscription events for debugging and analytics

## Testing

### Test Free User
```bash
# User without subscription tries to access premium signals
curl -X POST http://localhost:8787/api/trpc/protectedSignals.getPremiumSignals \
  -H "Authorization: Bearer users:test_free_user" \
  -H "Content-Type: application/json"
# Should return 403 Forbidden
```

### Test Premium User
```bash
# User with active subscription
curl -X POST http://localhost:8787/api/trpc/protectedSignals.getPremiumSignals \
  -H "Authorization: Bearer users:test_premium_user" \
  -H "Content-Type: application/json"
# Should return signals
```

### Simulate Webhook Events
```typescript
// Test expiration
await trpc.subscription.handleWebhook.mutate({
  eventType: 'EXPIRATION',
  userId: 'users:test_user',
  subscriptionId: 'gold_monthly',
});
// User should lose access immediately
```

## Monitoring

Track these metrics:
- Active subscriptions by tier
- Churn rate (cancellations)
- Upgrade rate (Silver → Gold)
- Revenue per user
- Signal request usage

## Next Steps

1. **Add the protected procedures** to your existing signal routes
2. **Implement Google Sign-In** in your app
3. **Set up Google Play Console** with subscription products
4. **Configure RevenueCat** for easier subscription management
5. **Add subscription UI** to show current tier and upgrade options
6. **Test the full flow** from signup → purchase → signal access → expiration

## Support

For issues:
- Check SurrealDB connection logs
- Verify webhook signatures
- Monitor subscription status updates
- Test rate limiting behavior
