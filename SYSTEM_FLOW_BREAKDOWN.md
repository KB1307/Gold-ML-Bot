# XAUUSD Trading Signal System - Complete Flow Breakdown

**Last Updated:** After fixes for auto-generation, signal expiration, and timezone consistency

---

## 🎯 System Overview

This is a **signal provider system** (not an auto-executor) that generates high-confidence trading signals for XAUUSD (Gold) using a self-learning transformer-based analysis engine with dynamic cooldowns, intermarket correlation, and walk-forward optimization.

---

## 📋 Core System Components

### 1. **Signal Generation Engine** (`services/signalEngine.ts`)
- **Purpose**: Core ML-based signal generation with 30+ market features
- **Key Features**:
  - Transformer attention mechanism
  - Intermarket analysis (DXY, US10Y, VIX)
  - Dynamic cooldown (15s - 120s based on regime & confidence)
  - Walk-forward optimization (retrains every 7 days or on confidence degradation)
  - Signal lock system (prevents overlapping signals)

### 2. **Trading Context** (`contexts/TradingContext.tsx`)
- **Purpose**: State management for entire app
- **Manages**:
  - Current active signal
  - Signal history
  - Performance metrics
  - Account settings
  - Market outlook

### 3. **UI Screens**
- **Dashboard**: Current signal, price chart, performance metrics
- **History**: Past signals with outcomes
- **Outlook**: Market analysis and regime detection
- **Settings**: User configuration

---

## 🔄 Signal Generation Flow (30-Second Timer)

### **Timer Setup** (Line 93-99 in `TradingContext.tsx`)
```
Every 30 seconds → checkAndGenerateSignal()
```

### **Step 1: Pre-Generation Checks**

#### A. Market Status Check (Line 437-440)
```
if (!marketOutlook.isMarketOpen) → EXIT
```
**Reasoning**: No trading during weekends or market closures

#### B. Active Signal Lock (Line 442-445)
```
if (currentSignal && currentSignal.status === "ACTIVE") → EXIT
```
**Reasoning**: Only one signal active at a time. Prevents signal spam.

#### C. Signal Lock Status (Line 1356-1371 in `signalEngine.ts`)
```
isSignalLocked() checks:
  - Is there an activeSignalId?
  - Is activeSignalStatus terminal? (SL_HIT, ALL_TARGETS_HIT, CLOSED)
  - If terminal → auto-unlock → allow new signal
```

### **Step 2: Signal Generation** (Line 1157-1354 in `signalEngine.ts`)

#### A. Fetch Live Price & Market Features (Lines 1170-1171)
```
updateCurrentPrice() → Fetches live gold price from APIs
calculateMarketFeatures() → Calculates 30+ features:
  - Asian High/Low
  - Pivot Points (R1-R3, S1-S3)
  - RSI, ATR, MACD
  - DXY, US10Y, VIX (intermarket)
  - Order Flow, Volume Profile
  - Fibonacci Levels
  - Sentiment Analysis
  - Liquidity Window (session detection)
  - Market Regime (TRENDING, RANGING, VOLATILE, QUIET)
```

#### B. Transformer Analysis (Line 777-941 in `signalEngine.ts`)
```
enhancedTransformerAnalysis():
  1. Calculate attention scores for each feature
  2. Apply session-based weights (London = +0.3, NY = +0.1)
  3. Detect institutional orders (+0.12 if large orders)
  4. Check regime strength (TRENDING +0.15, VOLATILE -0.05)
  5. Fibonacci alignment (+0.10 if near key levels)
  6. Sentiment impact (+0.15 if positive)
  7. Output: signalType (BUY/SELL) + confidence (0.60-0.98)
```

#### C. Dynamic Cooldown Check (Lines 1092-1133 in `signalEngine.ts`)
```
calculateDynamicCooldown():
  BASE_COOLDOWN = 60s

  Regime-based multiplier:
    - TRENDING (strong) → 0.25x (15s cooldown)
    - TRENDING → 0.35x (21s)
    - VOLATILE → 0.30x (18s)
    - RANGING → 1.0x (60s)
    - QUIET → 1.5x (90s)

  Confidence boost:
    - ≥95% → 0s (instant, no cooldown)
    - ≥90% → 0.5x multiplier
    - ≥85% → 0.7x multiplier

  Final cooldown = BASE * regime_multiplier * confidence_multiplier
  Clamped to: [15s, 120s]

  Check: If (now - lastSignalTime) < cooldown → EXIT
```

#### D. Macro Event Suppression (Lines 1186-1189)
```
detectMacroEvents() → Checks for:
  - NFP (Non-Farm Payrolls)
  - CPI Data
  - FOMC Statements

If HIGH impact event within 30 minutes → SUPPRESS SIGNAL
```

#### E. Confidence Filtering (Lines 1191-1199)
```
if (confidence < settings.minConfidence) → REJECT
if (confidence < 0.60) → REJECT (absolute minimum)
```

#### F. Opposite Signal Override (Lines 1201-1209)
```
if (lastSignalType !== null && lastSignalType !== signalType):
  if (confidence < 0.95) → REJECT (conflict)
  else → OVERRIDE (ultra-high confidence allows direction change)
```

### **Step 3: Signal Creation** (Lines 1211-1353)

#### A. Calculate Entry Price + Slippage (Lines 1211-1217)
```
entryPrice = currentPrice
slippageBuffer = calculateDynamicSlippage():
  - VOLATILE regime → 3.0x (1.5 pips)
  - TRENDING → 1.5x (0.75 pips)
  - RANGING → 1.0x (0.5 pips)
  - QUIET → 0.8x (0.4 pips)
  - High latency (>100ms) → additional penalty

entryPriceWithSlippage = entryPrice ± slippageBuffer
```

#### B. Calculate Stop Loss (Lines 1222-1226)
```
dynamicSlPips = settings.slPips * atrMultiplier:
  - High ATR (>10) → 1.2x multiplier (wider SL)
  - Low ATR (<8) → 0.9x multiplier (tighter SL)
  - Normal ATR → 1.0x

sl = entryPrice ± dynamicSlPips
```

#### C. Calculate Take Profit Targets (Lines 1228-1244)
```
Base distances:
  - TP1: 20 pips
  - TP2: 40 pips
  - TP3: 65 pips

Confidence adjustments:
  - ≥95% confidence → TP3 * 1.3, TP2 * 1.15 (widen targets)
  - ≥85% confidence → TP3 * 1.15
  - <70% confidence → TP1 * 0.85, TP2 * 0.85, TP3 * 0.7 (tighten)

tp1 = entryPrice ± (tp1Distance * pipValue)
tp2 = entryPrice ± (tp2Distance * pipValue)
tp3 = entryPrice ± (tp3Distance * pipValue)
```

#### D. Generate Timestamp (UTC+2) (Lines 1260-1262)
```
now = new Date()
utc2Hours = (now.getUTCHours() + 2) % 24
timeString = "HH:MM" (UTC+2 format)
```

#### E. Activate Signal Lock (Lines 1291-1294)
```
activeSignalId = signalId
activeSignalStatus = "ACTIVE"

Lock prevents new signals until:
  - SL_HIT
  - ALL_TARGETS_HIT
  - CLOSED (regime change or 2-hour expiry)
```

#### F. Return Signal Object (Line 1324-1353)
```javascript
{
  id: "signal_timestamp_random",
  timestamp: Date,
  type: "BUY" | "SELL",
  entryPrice: number,
  entryPriceWithSlippage: number,
  tp1, tp2, tp3, sl: number,
  confidence: number,
  status: "ACTIVE",
  targetsHit: 0,
  entryTime: "HH:MM" (UTC+2),
  topFeatures: [{ feature: string, score: number }],
  generatedRegime: { type, strength, confidence },
  // ... additional metadata
}
```

---

## 📊 Signal Monitoring Flow (10-Second Status Check)

### **Timer Setup** (Line 598-608 in `TradingContext.tsx`)
```
Every 10 seconds (while currentSignal exists) → updateSignalStatus()
```

### **Step 1: Expiry Checks**

#### A. Regime Change Detection (Lines 307-334)
```
currentMarketOutlook = getMarketOutlook()
currentRegimeType = calculate from outlook (TRENDING/RANGING/VOLATILE/QUIET)

if (signal.generatedRegime.type !== currentRegimeType):
  → Status = "CLOSED"
  → Release signal lock
  → Move to history
  → Set exitTime (UTC+2)
```

**Example**: Signal generated during TRENDING regime. Market shifts to RANGING. Signal expires immediately.

#### B. 2-Hour Time-to-Live (Lines 336-359)
```
signalAge = now - signal.timestamp
twoHoursInMs = 2 * 60 * 60 * 1000

if (signalAge > twoHoursInMs):
  → Status = "CLOSED"
  → Release lock
  → Move to history
  → Set exitTime (UTC+2)
```

### **Step 2: Price-Based Status Updates**

#### For BUY Signals (Lines 369-382):
```
if (price <= sl) → SL_HIT → Lock released → Move to history
else if (price >= tp3) → ALL_TARGETS_HIT → Lock released → Move to history
else if (price >= tp2) → TP2_HIT → targetsHit = 2
else if (price >= tp1) → TP1_HIT → targetsHit = 1
```

#### For SELL Signals (Lines 383-397):
```
if (price >= sl) → SL_HIT → Lock released → Move to history
else if (price <= tp3) → ALL_TARGETS_HIT → Lock released → Move to history
else if (price <= tp2) → TP2_HIT → targetsHit = 2
else if (price <= tp1) → TP1_HIT → targetsHit = 1
```

### **Step 3: Terminal State Handling** (Lines 413-423)
```
if (status === "SL_HIT" || status === "ALL_TARGETS_HIT"):
  1. Set exitTime (UTC+2)
  2. Update signal in history
  3. Release signal lock
  4. Clear currentSignal
```

---

## 🧠 Self-Learning System (Walk-Forward Optimization)

### **Trade Outcome Recording** (Line 943-1018 in `signalEngine.ts`)

When a signal closes:
```javascript
recordTradeOutcome({
  signalId,
  entryPrice,
  exitPrice,
  result: "WIN" | "LOSS",
  pnl: number,
  confidence: number,
  features: MarketFeatures,
  misleadingFeatures: [{ feature, score }], // If LOSS
  signalDuration: milliseconds
})
```

### **Performance Tracking** (Lines 965-980)
```
Recent 20 trades:
  - Win Rate = wins / (wins + losses)
  - Profit Factor = winPnl / lossPnl
  - Average Confidence = sum(confidences) / count
  - Winning Confidences (last 10)
```

### **Retraining Triggers** (Lines 995-1008)
```
Trigger 1: Scheduled (every 7 days)
Trigger 2: Confidence Degradation
  → avgRecentWinConfidence < 0.75 (MIN_CONFIDENCE_FOR_RETRAINING)

Retraining:
  1. Filter to last 90 days of trades
  2. Calculate feature weights:
     - avgWinRSI vs avgLossRSI
     - avgWinVolume vs avgLossVolume
     - avgWinSentiment vs avgLossSentiment
  3. Update model weights
  4. Persist to AsyncStorage
```

### **Model Health Score** (Lines 745-774)
```
healthScore = 100

Deductions:
  - Days since retraining > 7 → -3 per day (max -30)
  - Confidence degradation → up to -40
  - Feature correlation MODERATE → -15
  - Feature correlation POOR → -30

Final score: [0, 100]

If score < 70 → Warning logged
```

---

## 🌍 Timezone Handling (UTC+2 Throughout)

### **Signal Generation** (Line 1260-1262 in `signalEngine.ts`)
```javascript
const now = new Date();
const utc2Hours = (now.getUTCHours() + 2) % 24;
const entryTime = `${utc2Hours.toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`;
```

### **Signal Expiry** (Lines 278-283, 315-320, etc. in `TradingContext.tsx`)
```javascript
const now = new Date();
const utc2Hours = (now.getUTCHours() + 2) % 24;
const exitTime = `${utc2Hours.toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`;
```

### **Display on Dashboard** (Lines 128-133 in `dashboard.tsx`)
```javascript
const date = new Date(signal.timestamp);
const utc2Date = new Date(date.getTime() + 2 * 60 * 60 * 1000);
return `${utc2Date.toLocaleDateString('en-GB', { timeZone: 'UTC' })}, ${signal.entryTime}`;
```

### **Display in History** (Lines 114-120 in `history.tsx`)
```javascript
const date = new Date(signal.timestamp);
const utc2Date = new Date(date.getTime() + 2 * 60 * 60 * 1000);
return `${utc2Date.toLocaleDateString('en-GB', { timeZone: 'UTC' })}, ${signal.entryTime}`;
```

**All timestamps are stored in UTC internally, converted to UTC+2 for display.**

---

## ⚙️ Key System Parameters

### **Generation Settings**
```
Signal Generation Interval: 30 seconds
Price Update Interval: 3 seconds
Status Check Interval: 10 seconds (when signal active)

Cooldowns:
  - Min: 15 seconds
  - Base: 60 seconds
  - Max: 120 seconds

Confidence Thresholds:
  - Absolute Minimum: 60%
  - User Configurable: 75% (default)
  - Ultra-High: 95% (bypasses cooldown)
```

### **Signal Parameters (Default)**
```
TP1: 20 pips
TP2: 40 pips
TP3: 65 pips
SL: 70 pips (adjusted by ATR)

Position Sizing:
  - Base: 0.01 lots
  - Max Risk: 2% of account
  - Confidence Multipliers:
    - 90%+: 2.0x
    - 85-90%: 1.75x
    - 80-85%: 1.5x
    - 75-80%: 1.25x
    - 70-75%: 1.0x
    - <70%: 0.75x
```

### **Learning Parameters**
```
Training Window: 90 days
Walk-Forward Window: 12 weeks
Retraining Interval: 7 days OR confidence drop
Min Confidence for Retraining: 75%
Feature Correlation Check: Every 30 days
Outcome History Limit: 100 trades
```

---

## 🔍 Fault-Checking Checklist

### **Issue: Signals expiring too quickly**
✅ **Fixed**: Removed 5-second expiration bug
- Check: `updateSignalStatus()` regime change logic (should compare regime TYPE, not volatility level)
- Check: 2-hour expiry calculation (should use `Date.now() - timestamp`, not relative time)

### **Issue: Multiple signals generated rapidly**
✅ **Fixed**: Signal lock system active
- Check: `isSignalLocked()` returns true when activeSignalId exists
- Check: `checkAndGenerateSignal()` exits early if `currentSignal.status === "ACTIVE"`

### **Issue: Dashboard not showing active signals**
✅ **Fixed**: 30-second timer reinstated
- Check: Timer in `TradingContext.tsx` line 93-99 calls `checkAndGenerateSignal` every 30s
- Check: Signal added to history and set as currentSignal (lines 452-457)

### **Issue: History shows UTC instead of UTC+2**
✅ **Fixed**: All timestamps converted to UTC+2
- Check: All `exitTime` assignments use UTC+2 conversion
- Check: Display components use UTC+2 calculation for `timestamp` field

### **Issue: Win/Loss ratio incorrect**
✅ **Fixed**: Signal lock prevents overwrites
- Check: No new signal can be generated while `currentSignal` exists with status "ACTIVE"
- Check: Signals only removed from currentSignal when terminal state reached

---

## 📈 Performance Metrics Calculation

### **Metrics Updated On** (Lines 271-275 in `TradingContext.tsx`)
```
Every time signalHistory changes:
  → calculatePerformanceMetrics()
  → Store to AsyncStorage
```

### **Calculated Metrics** (Lines 148-268)
```
1. Win Rate = (winningTrades / totalTrades) * 100
2. Profit Factor = totalProfit / totalLoss
3. Sharpe Ratio = (avgReturn / stdDev) * sqrt(252)
4. Max Drawdown = max((peak - runningBalance) / peak)
5. Expectancy = (totalProfit - totalLoss) / totalTrades
6. Average Win = totalProfit / winCount
7. Average Loss = totalLoss / lossCount
```

### **P&L Calculation Logic** (Lines 169-189)
```
For CLOSED trades:
  - ALL_TARGETS_HIT → P&L = (tp3 - entry) * positionSize
  - SL_HIT → P&L = (sl - entry) * positionSize
  - CLOSED (other) → P&L = (currentPrice - entry) * positionSize

Sign:
  - BUY: Positive if price went up
  - SELL: Positive if price went down
```

---

## 🚀 System Startup Flow

1. **App Launch**
   - `TradingProvider` wraps app
   - `useEffect` (line 54-61) runs init:
     - Load persisted learning data from AsyncStorage
     - Load user settings, history, metrics
     - Fetch initial market outlook

2. **Price Timer Starts** (line 63-91)
   - Every 3 seconds: Update gold price
   - Add to priceHistory (max 60 points)

3. **Signal Generation Timer Starts** (line 93-99)
   - Every 30 seconds: Attempt signal generation
   - Respects all checks (market open, signal lock, cooldown)

4. **Status Monitoring Timer** (line 598-608)
   - Starts when currentSignal exists
   - Every 10 seconds: Check price vs TP/SL
   - Check expiry conditions

---

## 🛠️ Manual User Actions

### **Manual Refresh** (`refreshData()` - Line 646-653)
- Updates market outlook
- Fetches latest price
- Re-checks all signal statuses in history

### **Clear History** (`clearHistoryCache()` - Line 655-659)
- Removes all signals from history
- Resets performance metrics to defaults
- Does NOT affect learning engine data

### **Delete Signal** (`deleteSignalFromHistory()` - Line 632-638)
- Removes single signal from user view
- Learning engine retains data

---

## 📱 UI State Management

### **Dashboard Shows**
- currentSignal (active signal card)
- currentPrice (live)
- priceHistory (chart)
- performanceMetrics
- positionSizing (for active signal)
- marketOutlook

### **History Shows**
- signalHistory array (sorted newest first)
- Status color-coded:
  - Green: ALL_TARGETS_HIT, TP3_HIT
  - Orange: TP2_HIT, TP1_HIT
  - Red: SL_HIT
  - Gray: CLOSED (expired)

### **Outlook Shows**
- Current market regime
- Session status (ASIAN, LONDON, NEW_YORK)
- Trend & volatility
- Support/Resistance levels

---

## ⏰ Critical Timing Summary

| **Event** | **Interval** | **Purpose** |
|-----------|-------------|-------------|
| Price Update | 3 seconds | Keep chart & current price fresh |
| Signal Generation | 30 seconds | Attempt new signal (if allowed) |
| Status Check | 10 seconds | Monitor active signal TP/SL/Expiry |
| Cooldown Check | Dynamic (15-120s) | Prevent signal spam based on regime |
| Retraining | 7 days OR confidence drop | Update ML model weights |
| Feature Correlation | 30 days | Check for redundant features |

---

## ✅ System Health Indicators

### **Green (Healthy)**
- Model Health Score: 100-70
- Feature Correlation: HEALTHY
- Win Rate: ≥60%
- Profit Factor: ≥2.0

### **Yellow (Warning)**
- Model Health Score: 69-50
- Feature Correlation: MODERATE
- Win Rate: 50-59%
- Profit Factor: 1.5-1.99

### **Red (Degraded)**
- Model Health Score: <50
- Feature Correlation: POOR
- Win Rate: <50%
- Profit Factor: <1.5

---

## 🎓 Key Insights for Fault-Checking

1. **Signal Lock is CRITICAL**: Without it, rapid signals overwrite and corrupt metrics.
2. **Regime Change Expiry**: Must compare regime TYPE (TRENDING vs RANGING), not specific trend (BULLISH vs BEARISH).
3. **Timezone Consistency**: All internal timestamps UTC, display converts to UTC+2.
4. **Dynamic Cooldown**: Prevents spam in quiet markets, allows rapid signals in volatile/trending markets.
5. **Terminal States**: Only SL_HIT, ALL_TARGETS_HIT, CLOSED release the lock.

---

## 📝 Recent Fixes Applied

### **Fix 1: Reinstated 30-Second Timer** (Line 93-99 in `TradingContext.tsx`)
- **Problem**: Manual button only, no auto-generation
- **Solution**: Added timer calling `checkAndGenerateSignal()` every 30s

### **Fix 2: Removed Manual Button** (Dashboard)
- **Problem**: User could spam signals, bypass lock
- **Solution**: Removed manual generation button from UI

### **Fix 3: Regime Change Comparison** (Already correct)
- **Problem**: Signals were expiring on minor trend changes
- **Solution**: Verified comparison uses regime TYPE (not trend direction)

### **Fix 4: Added Clear History Function**
- **Problem**: Beta test data corrupted metrics
- **Solution**: Added `clearHistoryCache()` to reset all history

### **Fix 5: UTC+2 Display Everywhere**
- **Problem**: History showed UTC, dashboard showed UTC+2
- **Solution**: All display code converts timestamp to UTC+2

---

## 🎯 Expected Behavior After Fixes

### **Signal Generation**
- ✅ New signal every 30 seconds (if conditions met)
- ✅ Only when market open
- ✅ Only when no active signal
- ✅ Only after cooldown period
- ✅ Only if confidence ≥75%

### **Signal Expiry**
- ✅ Expires on regime change (TRENDING → RANGING, etc.)
- ✅ Expires after 2 hours (fallback)
- ✅ Does NOT expire on minor price moves
- ✅ Exit time shown in UTC+2

### **Dashboard**
- ✅ Shows active signal until terminal state
- ✅ Auto-refreshes every 3 seconds (price)
- ✅ No manual generation button

### **History**
- ✅ All timestamps in UTC+2
- ✅ Clear history button available
- ✅ Individual delete available

---

## 🔄 System Lifecycle

```
App Start
   ↓
Load Data (AsyncStorage)
   ↓
Start Timers (Price: 3s, Generation: 30s)
   ↓
[Market Closed] → Wait → [Market Opens]
   ↓
Attempt Signal Generation (every 30s)
   ↓
[Checks] → Market Open? Lock? Cooldown? Confidence?
   ↓
Generate Signal → Set Lock → Add to History
   ↓
Monitor Signal (every 10s) → Check TP/SL/Expiry
   ↓
[Terminal State] → Release Lock → Move to History
   ↓
Record Outcome → Update Metrics → Check Retraining
   ↓
[Loop Back to Attempt Generation]
```

---

## 📞 Support & Debugging

If signals are still not generating correctly:

1. **Check Console Logs**:
   - "Market is closed" → Expected during weekends
   - "Active signal already exists" → Lock is working
   - "✅ SIGNAL GENERATED" → Generation successful
   - "🔒 Signal lock ENABLED" → Lock activated
   - "🔓 Signal lock RELEASED" → Lock released

2. **Check Signal Status**:
   - Active signal should show on Dashboard
   - Status should update every 10 seconds
   - Terminal states should clear currentSignal

3. **Check Timers**:
   - Price should update every 3 seconds
   - Generation should attempt every 30 seconds
   - Status check should run every 10 seconds (if signal active)

4. **Check AsyncStorage**:
   - History should persist between app restarts
   - Metrics should update after each closed trade

---

**End of System Breakdown** 🎉
