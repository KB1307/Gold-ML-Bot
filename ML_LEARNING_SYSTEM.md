# Machine Learning & Data Persistence System

## Overview
Your trading signal app now has a complete backend system that:
1. **Saves every signal** with its outcome (WIN/LOSS/PARTIAL)
2. **Tracks feature performance** to improve future predictions
3. **Stores settings & metrics** across sessions
4. **Provides ML training data** for continuous improvement

## How It Works

### 1. Automatic Signal Syncing
Every signal generated is automatically saved to the backend with:
- Entry/exit prices and times
- TP1/TP2/TP3 targets hit
- Confidence score vs actual outcome
- Top features that influenced the decision
- Profit/loss in pips
- Market conditions (session, volatility, trend)

**Location**: `hooks/useSignalSync.ts`
**Frequency**: Real-time when signals are created/updated

### 2. Learning Engine Data Collection

#### What Gets Saved:
```typescript
{
  signalId: "abc123",
  confidence: 0.85,        // Your model predicted 85%
  actualOutcome: "WIN",    // Actual result
  profitLoss: 45.50,       // Pips gained/lost
  topFeatures: [
    { feature: "RSI_Oversold", score: 0.92 },
    { feature: "MACD_Bullish", score: 0.87 }
  ],
  marketConditions: {
    session: "LONDON",
    volatility: 0.65,
    trend: "BULLISH"
  }
}
```

#### Backend Endpoints:
- `trpc.signals.saveSignal` - Save new signal
- `trpc.signals.updateSignalOutcome` - Update when TP/SL hit
- `trpc.signals.getMLTrainingData` - Get all completed signals for ML

### 3. Feature Performance Analysis

The system tracks which features lead to winning trades:

```typescript
// Get feature performance stats
const featurePerformance = await trpc.signals.getFeaturePerformance.query();

// Returns:
[
  {
    feature: "RSI_Oversold",
    winRate: 0.73,           // 73% win rate
    avgProfitLoss: 32.5,     // Average 32.5 pips profit
    count: 150               // Used in 150 signals
  },
  {
    feature: "MACD_Bearish",
    winRate: 0.45,           // Only 45% win rate - needs adjustment
    avgProfitLoss: -12.3,
    count: 89
  }
]
```

**Use Case**: Identify which features are most reliable and adjust their weights in the signal engine.

### 4. Confidence Calibration

Compare predicted confidence vs actual win rates:

```typescript
const adjustments = await trpc.learning.calculateConfidenceAdjustments.query();

// Returns:
[
  {
    confidenceRange: 0.8,    // Signals with 80% confidence
    actualWinRate: 0.65,     // Actually won 65% of time
    sampleSize: 45,
    adjustment: -0.15        // Overconfident by 15%
  },
  {
    confidenceRange: 0.7,
    actualWinRate: 0.72,     // Actually won 72%
    sampleSize: 78,
    adjustment: +0.02        // Well calibrated
  }
]
```

**Use Case**: Adjust confidence scores to be more accurate. If your model says 80% but only wins 65%, you can recalibrate.

### 5. Settings & Performance Persistence

All settings and metrics are saved automatically:

```typescript
// Settings sync every 30 seconds when changed
trpc.settings.saveSettings.mutate({
  userId: 'default_user',
  settings: {
    tp1Pips: 20,
    tp2Pips: 40,
    minConfidence: 0.70,
    ...
  }
});

// Metrics sync every 60 seconds
trpc.settings.saveMetrics.mutate({
  userId: 'default_user',
  metrics: {
    totalTrades: 150,
    winRate: 68.5,
    sharpeRatio: 1.85,
    ...
  }
});

// Account balance snapshots every 5 minutes
trpc.settings.saveAccountSnapshot.mutate({
  balance: 2458.50,
  equity: 2458.50,
  openPositions: 2
});
```

### 6. How ML Improves Over Time

#### Phase 1: Data Collection (Testing Phase)
- Every signal outcome is saved
- Features are tracked
- No changes to the model yet

#### Phase 2: Analysis (After 50-100 signals)
```typescript
// Get training data
const trainingData = await trpc.signals.getMLTrainingData.query();

// Analyze feature performance
const features = await trpc.signals.getFeaturePerformance.query();

// Identify:
// - Which features predict winners
// - Which features are unreliable
// - Confidence calibration errors
```

#### Phase 3: Model Improvement
Based on the data:
1. **Increase weight** of features with high win rates
2. **Decrease weight** of features with low win rates
3. **Adjust confidence scores** based on actual outcomes
4. **Update risk parameters** (TP/SL ratios)

#### Phase 4: Save New Weights
```typescript
await trpc.learning.saveModelWeights.mutate({
  modelVersion: "v2.1.0",
  weights: {
    "RSI_Oversold": 0.92,    // Increased (was 0.85)
    "MACD_Bearish": 0.45,    // Decreased (was 0.70)
    "VolumeSpike": 0.88,
    ...
  },
  performance: {
    accuracy: 0.71,
    precision: 0.75,
    recall: 0.68,
    f1Score: 0.71
  }
});
```

### 7. Retrieve ML Data for Analysis

Example usage in your app:

```typescript
// In a settings screen or admin panel
import { trpc } from '@/lib/trpc';

function MLAnalyticsDashboard() {
  const { data: mlData } = trpc.signals.getMLTrainingData.useQuery();
  const { data: featurePerf } = trpc.signals.getFeaturePerformance.useQuery();
  const { data: analytics } = trpc.signals.getPerformanceAnalytics.useQuery();
  
  // Show:
  // - Total signals analyzed
  // - Win/loss breakdown by feature
  // - Confidence calibration charts
  // - Recommendation: "Retrain model - 150 new signals available"
  
  return (
    <View>
      <Text>Signals Collected: {mlData?.length}</Text>
      <Text>Win Rate: {analytics?.wins / analytics?.totalSignals}</Text>
      
      {featurePerf?.map(f => (
        <View key={f.feature}>
          <Text>{f.feature}: {f.winRate * 100}%</Text>
        </View>
      ))}
    </View>
  );
}
```

## Database Schema (SurrealDB)

### Tables Created:
1. **signals** - Every trading signal with outcomes
2. **user_settings** - TP/SL settings, confidence thresholds
3. **user_metrics** - Performance statistics
4. **account_snapshots** - Balance history
5. **daily_ohlc** - Price data for pattern recognition
6. **model_weights** - ML model versions and weights
7. **feature_importance** - Feature performance over time

## Testing Before Launch

While testing:
1. ✅ All signals are saved with outcomes
2. ✅ Settings are persisted across sessions
3. ✅ Performance metrics are tracked
4. ✅ Feature performance is analyzed
5. ✅ Data is ready for ML training

You can:
- Test different settings and compare results
- See which features work best in your testing
- Calibrate confidence scores before real trading
- Build up training data without risk

## Integration Status

✅ **Backend Routes Created**:
- `backend/trpc/routes/signals.ts` - Signal storage & ML data
- `backend/trpc/routes/settings.ts` - Settings & metrics
- `backend/trpc/routes/learning.ts` - ML weights & OHLC data

✅ **Auto-sync Hook**:
- `hooks/useSignalSync.ts` - Syncs everything automatically

✅ **Context Integration**:
- `contexts/TradingContext.tsx` - Uses `useSignalSync` hook

## Next Steps (When Ready)

1. **After 50-100 signals**: Review feature performance
2. **Adjust model weights**: Based on what's working
3. **Recalibrate confidence**: Match predictions to reality
4. **Save new model version**: Track improvements over time
5. **A/B test**: Compare old vs new model performance

## API Usage Examples

```typescript
// Save a signal outcome
await trpc.signals.updateSignalOutcome.mutate({
  id: signalId,
  status: "ALL_TARGETS_HIT",
  exitTime: "14:35",
  targetsHit: 3,
  profitLoss: 65.5,
  actualOutcome: "WIN"
});

// Get ML training data
const mlData = await trpc.signals.getMLTrainingData.query();

// Analyze which features work best
const features = await trpc.signals.getFeaturePerformance.query();

// Get overall performance
const analytics = await trpc.signals.getPerformanceAnalytics.query();
console.log(`Win Rate: ${analytics.wins / analytics.totalSignals * 100}%`);
```

## Benefits

1. **Continuous Learning**: Every trade improves the model
2. **Data-Driven**: Make decisions based on actual results
3. **Risk Management**: Track what works before real money
4. **Accountability**: Full audit trail of all signals
5. **Reproducible**: Can analyze and replay any time period

---

**Status**: ✅ System is active and syncing data automatically!
