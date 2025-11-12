# XAUUSD Trading Signal System - Complete Breakdown

## 🎯 System Overview

This is a gold (XAUUSD) trading signal generation system built with React Native/Expo. The system analyzes market conditions and generates high-probability trade signals using machine learning principles and technical analysis.

**Key Principle**: The system acts as a **signal provider**, not an execution engine. It provides entry/exit recommendations but does not execute trades automatically.

---

## 📂 Architecture

### File Structure
```
contexts/
  └── TradingContext.tsx       # React Context for app-wide state management
services/
  └── signalEngine.ts          # Core signal generation logic
app/(tabs)/
  ├── dashboard.tsx            # Active signal display
  ├── history.tsx              # Past signals
  ├── outlook.tsx              # Market conditions
  └── settings.tsx             # User preferences
types/
  └── trading.ts               # TypeScript interfaces
```

---

## 🔄 Core System Flow

### 1. **App Initialization**
```
App Starts
    ↓
TradingContext initializes
    ↓
signalEngine.loadPersistedLearningData() loads historical trade outcomes
    ↓
AsyncStorage loads: settings, signal history, metrics, account balance
    ↓
Price update timer starts (every 3 seconds)
    ↓
Dashboard ready
```

### 2. **Signal Generation Flow** (Manual Only)

The system **does NOT auto-generate signals**. All signal generation is manual.

```
User clicks "Generate New Signal" button
    ↓
manualGenerateSignal() called
    ↓
checkAndGenerateSignal() checks:
    ├─ Is market open? → No → Exit
    ├─ Is there an active signal? → Yes → Exit
    └─ Yes → Continue
    ↓
signalEngine.generateSignal() runs:
    ├─ Fetch live gold price
    ├─ Calculate market features (RSI, ATR, Pivots, etc.)
    ├─ Fetch intermarket data (DXY, US10Y, VIX)
    ├─ Detect market regime (TRENDING, RANGING, VOLATILE, QUIET)
    ├─ Run transformer analysis
    ├─ Calculate confidence score
    ├─ Check if confidence >= minConfidence setting
    ├─ Apply dynamic cooldown based on regime
    ├─ Generate signal with entry, TP1, TP2, TP3, SL
    └─ Lock signal (prevent new signals until this one closes)
    ↓
Signal appears on dashboard
    ↓
User takes trade manually on their broker
    ↓
Signal monitoring begins
```

### 3. **Signal Monitoring Flow**

Once a signal is generated, the system monitors it every 10 seconds:

```
useEffect runs every 10 seconds when currentSignal exists
    ↓
updateSignalStatus() checks:
    ├─ Has regime changed? → Yes → Close signal as EXPIRED
    ├─ Has 2 hours passed? → Yes → Close signal as EXPIRED
    ├─ Has price hit TP1? → Yes → Update to TP1_HIT
    ├─ Has price hit TP2? → Yes → Update to TP2_HIT
    ├─ Has price hit TP3? → Yes → Update to ALL_TARGETS_HIT → Close signal
    ├─ Has price hit SL? → Yes → Update to SL_HIT → Close signal
    └─ No changes → Continue monitoring
    ↓
If SL_HIT or ALL_TARGETS_HIT:
    ├─ Add exit time
    ├─ Release signal lock
    ├─ Move to history
    └─ New signal can be generated
```

---

## 🧠 Signal Lock System

### Purpose
Prevents the system from generating multiple conflicting signals simultaneously.

### Lock States
```typescript
this.activeSignalId: string | null        // ID of locked signal
this.activeSignalStatus: SignalStatus | null  // Current status
```

### Lock Lifecycle
```
Signal Generated
    ↓
Lock Enabled (activeSignalId = signal.id, activeSignalStatus = "ACTIVE")
    ↓
System blocks new signal generation
    ↓
Signal monitoring continues
    ↓
Signal reaches terminal state (SL_HIT | ALL_TARGETS_HIT | CLOSED)
    ↓
Lock Released (activeSignalId = null, activeSignalStatus = null)
    ↓
New signal can be generated
```

### Lock Release Conditions
1. **SL_HIT**: Stop loss was hit
2. **ALL_TARGETS_HIT**: All take profit targets reached
3. **CLOSED**: Signal expired due to:
   - Regime change
   - 2-hour timeout
   - Manual closure by user

---

## 📊 Market Regime Detection

The system categorizes market conditions into 4 regimes:

| Regime | Conditions | Signal Behavior |
|--------|-----------|-----------------|
| **TRENDING** | ATR > 9.5, Volume > 1.0 | Reduced cooldown (35%), wider TP targets |
| **VOLATILE** | ATR > 11, Volume > 1.1 OR VIX > 22 | Reduced cooldown (30%), higher slippage buffer |
| **RANGING** | ATR 8.5-11, Volume 0.9-1.1 | Standard cooldown (60s), normal TPs |
| **QUIET** | ATR < 8.5, Volume < 0.9, VIX < 16 | Extended cooldown (90s), tighter TPs |

### Regime Change Auto-Close
If the market regime changes while a signal is active:
```
Signal generated in TRENDING regime
    ↓
Market shifts to VOLATILE regime
    ↓
updateSignalStatus() detects mismatch
    ↓
Signal auto-closed as EXPIRED
    ↓
Lock released
```

---

## 🎯 Confidence System

### Base Confidence Calculation
```javascript
baseConfidence = 0.65

// London Session (06:00-13:00 UTC)
if (isLondonSession) baseConfidence += 0.3

// Price near Asian High/Low
if (nearAsianRange) baseConfidence += 0.2

// RSI confirmation
if (RSI favorable) baseConfidence += 0.15

// DXY inverse correlation
if (DXY inverse move) baseConfidence += 0.2

// High volume
if (volume > 1.0) baseConfidence += 0.15

// Sentiment
baseConfidence += (sentimentScore * 0.1)

// Fibonacci alignment
if (nearFibLevel) baseConfidence += 0.05

// Learning adjustment (from past performance)
baseConfidence += ((profitFactor - 1.5) * 0.05)

// Random variance
baseConfidence += (random -0.04 to +0.04)

// Final confidence smoothed over last 5 signals
smoothedConfidence = EMA(baseConfidence, 5)
```

### Confidence Thresholds
- **< 60%**: Signal rejected (absolute minimum)
- **60-75%**: Signal generated with normal position sizing
- **75-85%**: Signal generated with increased position sizing (1.25x-1.75x)
- **85-90%**: Signal generated with high position sizing (1.75x), 30% cooldown reduction
- **90-95%**: Signal generated with ultra position sizing (2.0x), 50% cooldown reduction
- **≥ 95%**: Signal generated with max sizing, **COOLDOWN CANCELLED** (instant next signal allowed)

---

## 🎲 Dynamic Position Sizing (Kelly Criterion)

The system calculates optimal position sizes based on:

### Formula
```javascript
winRate = recentWins / recentTrades
avgWinLoss = profitFactor
kellyPercentage = (winRate * avgWinLoss - (1 - winRate)) / avgWinLoss
fractionalKelly = 0.25  // Use 25% of Kelly for safety
optimalKellyPercentage = min(5%, kellyPercentage * fractionalKelly)

recommendedSize = basePositionSize * confidenceMultiplier

if (useKellyCriterion) {
  kellyBasedSize = accountBalance * optimalKellyPercentage
  recommendedSize = max(basePositionSize, kellyBasedSize)
}

// Cap at max risk
maxSize = accountBalance * (maxRiskPercentage / 100) / 100
recommendedSize = min(recommendedSize, maxSize)
```

### Example
```
Account Balance: $10,000
Base Position: 0.01 lots
Win Rate: 65%
Profit Factor: 1.8
Signal Confidence: 87%

Kelly = (0.65 * 1.8 - 0.35) / 1.8 = 45.8%
Fractional Kelly = 45.8% * 0.25 = 11.45%
Optimal Kelly = min(5%, 11.45%) = 5%
Kelly-Based Size = $10,000 * 5% = $500 = 0.5 lots

Confidence Multiplier (87%) = 1.75x
Recommended Size = 0.01 * 1.75 = 0.0175 lots

Final Size = max(0.0175, 0.5) = 0.5 lots
```

---

## 📈 Performance Metrics Calculation

### Win/Loss Determination
```javascript
closedTrades = history.filter(s => 
  s.status === "CLOSED" || 
  s.status === "SL_HIT" || 
  s.status === "ALL_TARGETS_HIT"
)

for each signal:
  if (signal.type === "BUY") {
    if (status === "ALL_TARGETS_HIT") pnl = (tp3 - entry) * positionSize
    else if (status === "SL_HIT") pnl = (sl - entry) * positionSize  // Negative
    else pnl = (currentPrice - entry) * positionSize
  }
  
  if (pnl > 0) → Winning Trade
  else → Losing Trade
```

### Key Metrics
- **Win Rate**: (Wins / TotalTrades) * 100
- **Profit Factor**: TotalProfit / TotalLoss
- **Sharpe Ratio**: (AvgReturn / StdDev) * √252
- **Max Drawdown**: Largest peak-to-trough decline in account balance
- **Expectancy**: (TotalProfit - TotalLoss) / TotalTrades

---

## ⏰ Timezone Handling (UTC+2)

### Problem
- System initially used UTC timestamps
- User is in UTC+2 timezone
- Timestamps in history showed incorrect times

### Solution
All timestamps are now converted to UTC+2:
```javascript
const now = new Date()
const utc2Hours = (now.getUTCHours() + 2) % 24
const timeString = `${utc2Hours.toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`
```

### Applied To
- Signal entry time
- Signal exit time
- Display on dashboard
- Display in history

---

## 🛠️ Self-Learning System

### Trade Outcome Recording
Every closed signal is recorded with:
```typescript
{
  signalId: string
  entryPrice: number
  exitPrice: number
  result: 'WIN' | 'LOSS'
  pnl: number
  confidence: number
  features: MarketFeatures  // All indicators at signal time
  misleadingFeatures?: FeatureConfidence[]  // Failed features on loss
  signalDuration?: number
}
```

### Model Retraining
Triggered when:
1. **Scheduled**: Every 7 days
2. **Performance Drop**: Average winning confidence falls below 75%

### Walk-Forward Optimization
```
Training Window: Last 90 days
Minimum Outcomes: 20 trades

Retraining Process:
1. Filter outcomes from last 90 days
2. Separate winning vs losing trades
3. Calculate average feature values for each
4. Update model weights:
   - rsi_weight = (avgWinRSI - avgLossRSI) / 100
   - volume_weight = avgWinVolume - avgLossVolume
   - sentiment_weight = (avgWinSentiment - avgLossSentiment) * 2
5. Persist weights to AsyncStorage
6. Apply on next signal generation
```

---

## 🔍 Feature Correlation Monitoring

### Purpose
Detect when multiple features provide redundant information (multicollinearity).

### Process (Every 30 days or 20+ trades)
```
Calculate correlations between:
- RSI vs Volume
- RSI vs Sentiment
- Volume vs Sentiment

If correlation > 0.85:
  - Flag as "MODERATE" (1-2 pairs) or "POOR" (3+ pairs)
  - Reduce model health score
  - Log warning
```

### Model Health Score
```
Starting Score: 100

Deductions:
- Days since retraining > 7: -3 points per day (max -30)
- Confidence degradation: -40 points per 1% drop below 75%
- Feature correlation MODERATE: -15 points
- Feature correlation POOR: -30 points

Final Score: max(0, min(100, adjusted_score))

if (score < 70) → Warning: "System check recommended"
```

---

## 🚨 Common Issues & Fixes

### Issue 1: "Hooks Order Error"
**Cause**: Hooks called conditionally or after early returns.
**Fix**: Ensure all hooks are called unconditionally at the top level of the component.

### Issue 2: "Signals generating every few seconds"
**Cause**: Auto-refresh timer was calling checkAndGenerateSignal().
**Fix**: Removed auto-refresh. Only manual generation via button now.

### Issue 3: "All signals marked as expired in history"
**Cause**: Timezone mismatch (UTC vs UTC+2).
**Fix**: All timestamps now calculated in UTC+2.

### Issue 4: "Win/Loss ratio incorrect"
**Cause**: Signals being overwritten before reaching terminal state.
**Fix**: Implemented signal lock system to prevent new signals during active monitoring.

---

## 📱 User Workflow

### 1. Generate Signal
- Open dashboard
- Check market status (must be open)
- Click "Generate New Signal"
- Wait for analysis
- Signal appears with confidence %

### 2. Take Trade
- Note entry price
- Set TP1, TP2, TP3 on broker
- Set SL on broker
- Execute trade manually

### 3. Monitor Signal
- Dashboard shows live P/L
- Progress bar to TP3
- Target hits update automatically
- Exit time added when closed

### 4. Review Performance
- Go to History tab
- See all past signals (active and closed)
- Check win rate, profit factor
- Review model health score
- **Clear expired signals**: Remove closed/completed signals while keeping active ones
  - Button: "Clear Expired Signals"
  - Only removes: CLOSED, SL_HIT, ALL_TARGETS_HIT
  - Preserves: ACTIVE, TP1_HIT, TP2_HIT (in progress)

### 5. Adjust Settings
- Go to Settings tab
- Adjust TP/SL pips
- Change position size
- Set min confidence threshold
- Toggle Kelly Criterion

---

## 🧪 Testing Checklist

### Signal Generation
- [ ] Market closed → No signal generated
- [ ] Market open + no active signal → Signal generated
- [ ] Market open + active signal → Signal blocked
- [ ] Confidence < threshold → Signal rejected
- [ ] Confidence ≥ threshold → Signal generated

### Signal Monitoring
- [ ] Price hits TP1 → Status updates to TP1_HIT
- [ ] Price hits TP2 → Status updates to TP2_HIT
- [ ] Price hits TP3 → Status updates to ALL_TARGETS_HIT → Signal closed
- [ ] Price hits SL → Status updates to SL_HIT → Signal closed
- [ ] 2 hours pass → Signal marked CLOSED
- [ ] Regime changes → Signal marked CLOSED

### Timezone
- [ ] Dashboard shows UTC+2 time
- [ ] History shows UTC+2 time
- [ ] Exit time in UTC+2

### Performance Metrics
- [ ] Win rate calculated correctly
- [ ] Profit factor calculated correctly
- [ ] Drawdown calculated correctly
- [ ] Model health score updates

---

## 🎓 Key Takeaways

1. **No Auto-Trading**: System provides signals, user executes trades
2. **Signal Lock**: Only one active signal at a time
3. **Regime-Based**: Different strategies for different market conditions
4. **Self-Learning**: System improves from past performance
5. **Risk Management**: Kelly Criterion for optimal position sizing
6. **Quality Over Quantity**: High-confidence signals only
7. **Auto-Expiry**: Signals close on regime change or 2-hour timeout

---

## 🔮 Future Enhancements (Not Implemented)

- Multiple timeframe analysis (1H, 4H, Daily)
- News sentiment integration via API
- Push notifications for signal generation
- Backtesting module with historical data
- Export trade history to CSV
- Advanced charting with indicators
- Signal success prediction heatmap

---

## 📝 Changelog

### Version 1.2.1 (2025-11-12)
**Changes:**
- ✅ Updated "Clear History" button to only remove expired signals
  - Old behavior: Cleared ALL signals including active ones
  - New behavior: Only removes CLOSED, SL_HIT, and ALL_TARGETS_HIT signals
  - Benefit: Preserves active signals while cleaning up completed trades
  - Console log: Shows count of cleared vs kept signals
- ✅ Updated button text: "Clear All History" → "Clear Expired Signals"
- ✅ Updated confirmation dialog to reflect new behavior

---

**Last Updated**: 2025-11-12
**System Version**: 1.2.1
**Status**: ✅ Production Ready
