# Complete Multi-Signal Trading System v2.0 Documentation

## 🎯 System Overview

This document provides a comprehensive breakdown of the **Multi-Signal Trading System v2.0**, which now fully supports tracking and managing **multiple active signals simultaneously**. The previous single-signal architecture has been completely refactored to eliminate blocking logic and enable parallel signal generation.

---

## 📊 System Architecture

### **Core Components**

1. **TradingProvider (State Management)**
   - Location: `contexts/TradingContext.tsx`
   - Role: Central state manager for all trading operations
   
2. **SignalGenerationEngine**
   - Location: `services/signalEngine.ts`
   - Role: AI-powered signal generation with 50+ market features

3. **Signal History (Single Source of Truth)**
   - Type: `TradingSignal[]`
   - Storage: AsyncStorage + React State
   - Contains: ALL signals (active, closed, expired)

---

## 🔄 Key Changes from v1.x to v2.0

### **Removed: Single Signal Blocking**

**Before (v1.x):**
```typescript
const [currentSignal, setCurrentSignal] = useState<TradingSignal | null>(null);

if (currentSignal && currentSignal.status === "ACTIVE") {
  console.log("⚠️ BLOCKED: Active signal already exists.");
  return; // ❌ Prevents new signals
}
```

**After (v2.0):**
```typescript
// ✅ No currentSignal state
// ✅ No blocking logic in TradingProvider
// ✅ Engine handles multi-signal logic internally
```

### **Enhanced: Active Signal Filtering**

The system now uses **dynamic filtering** instead of a single state variable:

```typescript
const activeSignals = signalHistory.filter(s => 
  s.status === "ACTIVE" || 
  s.status === "TP1_HIT" || 
  s.status === "TP2_HIT"
);
```

This approach:
- ✅ Supports unlimited active signals
- ✅ Accurate real-time status tracking
- ✅ No stale state issues
- ✅ Single source of truth (`signalHistory`)

---

## 🧠 Signal Generation Flow

### **Step-by-Step Process**

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Timer Trigger (every 30 seconds)                        │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. TradingProvider.checkAndGenerateSignal()                │
│    - Fetch market outlook                                   │
│    - Check market hours                                     │
│    - Filter active signals from signalHistory               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. signalEngine.generateSignal()                           │
│    INPUT: (settings, accountBalance, activeSignals[])      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Signal Generation Checks (in order)                     │
│    ✓ Dynamic Cooldown (regime-based)                       │
│    ✓ Macro Event Suppression                               │
│    ✓ Confidence Threshold (≥70%)                           │
│    ✓ Price Proximity Filter (≥15 pips from active signals) │
│    ✓ Direction Conflict Override (requires 95% confidence) │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. Signal Approved → Calculate Levels                      │
│    - Entry Price (current + slippage)                      │
│    - TP1, TP2, TP3 (confidence-adjusted)                   │
│    - SL (ATR-adjusted: 70 pips base)                       │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Signal Added to signalHistory                           │
│    - State: ACTIVE                                          │
│    - Persisted to AsyncStorage                              │
│    - Triggers metrics recalculation                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Multi-Signal Protection: Price Proximity Filter

### **Purpose**
Prevent redundant signals at nearly identical price levels.

### **Logic**
```typescript
const MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL = 15;
const MAX_RECENT_SIGNAL_TIME_MINUTES = 5;

// Filter active signals of the same type (BUY/SELL) generated in last 5 minutes
const recentActiveSignals = activeSignals.filter(signal => {
  return signal.status === "ACTIVE" && 
         signal.type === proposedType &&
         (now - signal.timestamp) < 5 * 60 * 1000;
});

// Check each active signal
for (const signal of recentActiveSignals) {
  const priceDifference = Math.abs(proposedEntryPrice - signal.entryPrice) * 1000; // Convert to pips
  
  if (priceDifference < 15) {
    return { blocked: true }; // ❌ Too close to existing signal
  }
}
```

### **Example Scenario**

**Time: 10:00 AM**
- Active Signal #1: BUY @ 2650.5 (ACTIVE)

**Time: 10:01 AM**
- Proposed Signal: BUY @ 2651.0
- Price Difference: |2651.0 - 2650.5| × 1000 = 0.5 × 1000 = **5 pips**
- Result: ❌ **BLOCKED** (< 15 pips)

**Time: 10:03 AM**
- Proposed Signal: BUY @ 2665.0
- Price Difference: |2665.0 - 2650.5| × 1000 = 14.5 × 1000 = **145 pips**
- Result: ✅ **ALLOWED** (> 15 pips)

---

## ⏱️ Dynamic Cooldown System

The cooldown between signals adapts to market conditions:

| Market Regime | Base Cooldown | Multiplier | Final Cooldown |
|---------------|---------------|------------|----------------|
| **TRENDING** (Strong) | 60s | 0.25x | 15s |
| **TRENDING** | 60s | 0.35x | 21s |
| **VOLATILE** | 60s | 0.30x | 18s |
| **RANGING** | 60s | 1.0x | 60s |
| **QUIET** | 60s | 1.5x | 90s |

### **Confidence Overrides**

- **≥95% Confidence**: Cooldown = 0s (instant generation)
- **≥90% Confidence**: Cooldown × 0.5
- **≥85% Confidence**: Cooldown × 0.7

**Example:**
- Regime: TRENDING
- Base Cooldown: 60s × 0.35 = 21s
- Confidence: 92%
- Final Cooldown: 21s × 0.5 = **10.5 seconds**

---

## 📍 Signal Status Lifecycle

```
ACTIVE
  ↓
  ├─→ (Price hits TP1) → TP1_HIT
  │                         ↓
  │                      TP2_HIT
  │                         ↓
  │                      TP3_HIT → ALL_TARGETS_HIT (Final)
  │
  ├─→ (Price hits SL) → SL_HIT (Final)
  │
  ├─→ (2 hours elapsed) → CLOSED (Final)
  │
  └─→ (Manual close) → CLOSED (Final)
```

### **Status Update Mechanism**

**Function:** `updateAllSignalsStatus()` (runs every 5 seconds)

**Process:**
```typescript
1. Get current price from signalEngine
2. Get current timestamp
3. For each signal in signalHistory:
   
   IF signal is already final (CLOSED, SL_HIT, ALL_TARGETS_HIT):
     → Skip (immutable)
   
   IF signal age > 2 hours:
     → Set status = CLOSED
     → Add exitTime
   
   ELSE IF signal.type === "BUY":
     IF price <= signal.sl:
       → Set status = SL_HIT, targetsHit = 0, add exitTime
     ELSE IF price >= signal.tp3:
       → Set status = ALL_TARGETS_HIT, targetsHit = 3, add exitTime
     ELSE IF price >= signal.tp2:
       → Set status = TP2_HIT, targetsHit = 2
     ELSE IF price >= signal.tp1:
       → Set status = TP1_HIT, targetsHit = 1
   
   ELSE IF signal.type === "SELL":
     (inverse price checks)
   
4. IF any status changed:
   → Persist to AsyncStorage
   → Trigger metrics recalculation
```

---

## 🎯 Stop Loss Calculation (70 Pips Base)

### **Base SL: 70 pips** (Updated from 120 pips)

**Location:** `contexts/TradingContext.tsx` (Line 11)
```typescript
const DEFAULT_SETTINGS: Settings = {
  slPips: 70, // ← Base stop loss
  ...
};
```

### **Dynamic ATR Adjustment**

The actual SL adjusts based on market volatility (ATR):

```typescript
const atrMultiplier = 
  features.atr > 10 ? 1.2 :   // High Volatility: 70 × 1.2 = 84 pips
  features.atr < 8  ? 0.9 :   // Low Volatility:  70 × 0.9 = 63 pips
  1.0;                        // Normal:          70 × 1.0 = 70 pips

const dynamicSlPips = settings.slPips * atrMultiplier;
```

**Example Scenarios:**

| ATR | Regime | Multiplier | Base SL | Final SL | Reasoning |
|-----|--------|------------|---------|----------|-----------|
| 12.5 | VOLATILE | 1.2x | 70 | **84 pips** | Wider SL to avoid premature stop-outs |
| 9.5 | NORMAL | 1.0x | 70 | **70 pips** | Standard protection |
| 7.2 | QUIET | 0.9x | 70 | **63 pips** | Tighter SL to reduce risk in calm markets |

**Visual Formula:**
```
Final SL = Base SL (70) × ATR Multiplier
         = 70 × (0.9 to 1.2)
         = 63 to 84 pips
```

---

## 📈 Target Profit (TP) Calculation

### **Base TP Levels (in pips)**

```typescript
tp1Pips: 20  // First target
tp2Pips: 40  // Second target
tp3Pips: 65  // Final target
```

### **Confidence-Based Adjustments**

```typescript
if (confidence >= 0.95) {
  tp3Distance = tp3Pips × 1.3;  // 65 × 1.3 = 84.5 pips
  tp2Distance = tp2Pips × 1.15; // 40 × 1.15 = 46 pips
  
} else if (confidence >= 0.85) {
  tp3Distance = tp3Pips × 1.15; // 65 × 1.15 = 74.75 pips
  
} else if (confidence < 0.70) {
  tp1Distance = tp1Pips × 0.85; // 20 × 0.85 = 17 pips
  tp2Distance = tp2Pips × 0.85; // 40 × 0.85 = 34 pips
  tp3Distance = tp3Pips × 0.7;  // 65 × 0.7 = 45.5 pips
}
```

**Example:**

**High Confidence Signal (92%)**
- Entry: 2650.0
- TP1: 2650.0 + (20 × 0.1) = **2652.0** (unchanged)
- TP2: 2650.0 + (46 × 0.1) = **2654.6** (widened)
- TP3: 2650.0 + (74.75 × 0.1) = **2657.475** (widened)
- SL: 2650.0 - (70 × 0.1) = **2643.0**

---

## 🧮 Performance Metrics Calculation

### **Real-Time Metrics** (Recalculated on every `signalHistory` change)

```typescript
const closedTrades = signalHistory.filter(s => 
  s.status === "CLOSED" || 
  s.status === "SL_HIT" || 
  s.status === "ALL_TARGETS_HIT"
);

// For each closed trade:
let pnl = 0;

if (signal.type === "BUY") {
  if (signal.status === "ALL_TARGETS_HIT") {
    pnl = (signal.tp3 - signal.entryPrice) × basePositionSize;
  } else if (signal.status === "SL_HIT") {
    pnl = (signal.sl - signal.entryPrice) × basePositionSize;
  }
} else {
  // SELL logic (inverted)
}

if (pnl > 0) {
  winningTrades++;
  totalProfit += pnl;
} else {
  losingTrades++;
  totalLoss += Math.abs(pnl);
}
```

### **Calculated Metrics**

| Metric | Formula | Purpose |
|--------|---------|---------|
| **Win Rate** | (winningTrades / totalTrades) × 100 | % of profitable trades |
| **Profit Factor** | totalProfit / totalLoss | Risk/reward efficiency |
| **Expectancy** | (totalProfit - totalLoss) / totalTrades | Average $ per trade |
| **Sharpe Ratio** | (avgReturn / stdDev) × √252 | Risk-adjusted returns |
| **Max Drawdown** | Max % decline from peak balance | Worst losing streak |

---

## 🔍 Signal History Display (Time Sync)

### **Issue Fixed: UTC vs Local Time**

**Problem:** Dashboard showed signals in UTC+2 (local time), but History tab showed UTC.

**Solution:** Standardize all timestamps to use consistent `toLocaleTimeString()` with explicit formatting:

```typescript
const exitTime = now.toLocaleTimeString([], { 
  hour: '2-digit', 
  minute: '2-digit', 
  hour12: false 
});
```

**Result:** All timestamps now reflect the **user's local timezone** consistently across Dashboard, History, and Outlook tabs.

---

## 🚀 System Initialization Flow

```
App Launch
    ↓
TradingProvider Mount
    ↓
┌─────────────────────────────────────────────────┐
│ 1. signalEngine.loadPersistedLearningData()    │
│    - Load trade outcomes                        │
│    - Load model weights                         │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│ 2. loadPersistedData()                          │
│    - Load settings                              │
│    - Load signalHistory                         │
│    - Load metrics                               │
│    - Load account balance                       │
│    - Set isLoading = false                      │
└─────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────┐
│ 3. Start Background Services                    │
│    - Price updates (every 3s)                   │
│    - Market outlook updates (every 5s)          │
│    - Signal status updates (every 5s)           │
│    - Signal generation checks (every 30s)       │
└─────────────────────────────────────────────────┘
    ↓
System Ready ✅
```

---

## 🛠️ API Reference

### **TradingProvider Exports**

```typescript
const {
  // State
  isLoggedIn: boolean,
  isLoading: boolean,
  signalHistory: TradingSignal[],
  settings: Settings,
  marketOutlook: MarketOutlook | null,
  performanceMetrics: PerformanceMetrics,
  positionSizing: PositionSizing | null,
  accountBalance: number,
  currentPrice: number,
  priceHistory: PriceDataPoint[],
  
  // Actions
  login: (username: string) => Promise<void>,
  logout: () => Promise<void>,
  updateSettings: (newSettings: Partial<Settings>) => Promise<void>,
  deleteSignalFromHistory: (signalId: string) => Promise<void>,
  manualCloseSignal: (signalId: string) => void,
  refreshData: () => Promise<void>,
} = useTrading();
```

### **Key Functions**

#### **manualCloseSignal(signalId: string)**
Manually closes a specific signal.

**Before (v1.x):**
```typescript
manualCloseSignal(); // Closes currentSignal
```

**After (v2.0):**
```typescript
manualCloseSignal('signal_1699999999999_abc123'); // Closes specific signal by ID
```

**Usage in UI:**
```typescript
<Button onPress={() => manualCloseSignal(signal.id)}>
  Close Signal
</Button>
```

#### **deleteSignalFromHistory(signalId: string)**
Permanently removes a signal from history.

**Usage:**
```typescript
<Button onPress={() => deleteSignalFromHistory(signal.id)}>
  Delete
</Button>
```

---

## 🧪 Testing Multi-Signal System

### **Scenario 1: Multiple Active Signals**

**Expected Behavior:**
1. Signal #1 generates at 10:00 AM (BUY @ 2650.0)
2. Price moves to 2670.0 (+20 pips, outside proximity filter)
3. Signal #2 generates at 10:01 AM (BUY @ 2670.0)
4. Both signals now tracked independently in `signalHistory`
5. Status updates apply to both signals every 5 seconds
6. Dashboard shows 2 active signals

### **Scenario 2: Price Proximity Block**

**Expected Behavior:**
1. Signal #1 generates (BUY @ 2650.0) at 10:00 AM
2. Attempt to generate Signal #2 (BUY @ 2652.0) at 10:01 AM
3. Price difference: 2 pips (< 15 pips threshold)
4. Console log: `❌ REJECTED: Price Proximity Filter Block`
5. No new signal added to history

### **Scenario 3: TP Progression**

**Expected Behavior:**
1. Signal generates: BUY @ 2650.0
   - Status: ACTIVE
2. Price hits 2652.0 (TP1)
   - Status updates to: TP1_HIT
   - targetsHit = 1
3. Price hits 2654.0 (TP2)
   - Status updates to: TP2_HIT
   - targetsHit = 2
4. Price hits 2656.5 (TP3)
   - Status updates to: ALL_TARGETS_HIT
   - targetsHit = 3
   - exitTime added
   - Signal finalized (no further updates)

---

## 🔐 Data Persistence

### **AsyncStorage Keys**

| Key | Data Type | Purpose |
|-----|-----------|---------|
| `trading_settings` | Settings | User configuration |
| `signal_history` | TradingSignal[] | All signals (active + closed) |
| `performance_metrics` | PerformanceMetrics | Calculated stats |
| `account_balance` | number | Virtual account balance |
| `is_logged_in` | boolean | Authentication state |
| `trade_outcomes_learning` | TradeOutcome[] | AI learning data |
| `model_weights_v1` | Map<string, number> | AI model weights |

### **Persistence Flow**

```typescript
// On every signalHistory update:
setSignalHistory((prev) => {
  const updated = [...prev, newSignal];
  AsyncStorage.setItem("signal_history", JSON.stringify(updated));
  return updated;
});
```

---

## 📊 Console Logging Strategy

### **Signal Generation Attempt**

```
============================================================
🔍 SIGNAL CHECK [14:32:05]
============================================================
Market Open: true
Current Session: LONDON
Active Signals: 2
  - BUY @ 2650.5 (ACTIVE)
  - SELL @ 2670.0 (TP1_HIT)
Min Confidence: 70%
Account Balance: 10000
Settings - TP1: 20, TP2: 40, TP3: 65, SL: 70
============================================================
```

### **Signal Approved**

```
============================================================
✅ ✅ ✅ NEW SIGNAL GENERATED ✅ ✅ ✅
============================================================
Type: BUY @ 2655.5 | Confidence: 85.2%
📊 Top Features: LONDON SESSION (30%), DXY INVERSE (20%), HIGH VOLUME (15%)
⚙️ SL Multiplier: 1.00x (Normal Volatility | ATR: 9.5)
📊 Market Regime: TRENDING (Strength: 75%, Confidence: 88%)
🎯 Signal Generation Rate: 45.5% (10 signals / 22 attempts)
⏱️ Next Dynamic Cooldown: 21.0s
⏰ Time-To-Live (TTL): ~180 minutes
============================================================
```

### **Signal Rejected**

```
❌ REJECTED: Price Proximity Filter Block
   Active signal #abc123 at 2650.5 is within 15 pips of proposed entry (5.0 pips difference).
   💡 TIP: Next attempt in 21s. Price must move >15 pips from existing BUY signals.
============================================================
```

---

## 🎓 Best Practices for Developers

### **1. Never Mutate signalHistory Directly**

❌ **Wrong:**
```typescript
signalHistory[0].status = "CLOSED"; // Mutates state directly
```

✅ **Correct:**
```typescript
setSignalHistory(prev => 
  prev.map(s => s.id === targetId ? { ...s, status: "CLOSED" } : s)
);
```

### **2. Always Filter Active Signals Fresh**

❌ **Wrong (Stale State):**
```typescript
const [activeSignals, setActiveSignals] = useState([]);
// activeSignals might be outdated
```

✅ **Correct (Always Fresh):**
```typescript
const activeSignals = signalHistory.filter(s => 
  s.status === "ACTIVE" || s.status === "TP1_HIT" || s.status === "TP2_HIT"
);
```

### **3. Use Signal IDs for Operations**

❌ **Wrong (Reference Equality Breaks):**
```typescript
const targetSignal = currentSignal; // Reference can become stale
closeSignal(targetSignal);
```

✅ **Correct (ID-Based Lookup):**
```typescript
const signalId = signal.id;
closeSignal(signalId); // Function looks up signal by ID
```

---

## 🚨 Common Issues & Troubleshooting

### **Issue: Signals Not Generating**

**Possible Causes:**
1. ❌ Market is closed (check `marketOutlook.isMarketOpen`)
2. ❌ Confidence below threshold (check logs for actual confidence)
3. ❌ Dynamic cooldown still active (check regime and last signal time)
4. ❌ Price proximity filter (existing signal too close)
5. ❌ Macro event suppression (NFP, FOMC, CPI within 30 min)

**Debugging Steps:**
```typescript
console.log('Market Open:', marketOutlook?.isMarketOpen);
console.log('Active Signals:', activeSignals.length);
console.log('Last Signal Time:', new Date(lastSignalTime));
console.log('Min Confidence:', settings.minConfidence);
```

### **Issue: Multiple Identical Signals**

**Diagnosis:** Price proximity filter not working.

**Check:**
```typescript
// In signalEngine.ts
console.log('Proximity Check:', {
  proposedEntry: proposedEntryPrice,
  activeSignals: activeSignals.map(s => ({ id: s.id, entry: s.entryPrice })),
  minDistance: MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL
});
```

### **Issue: Signals Not Closing at TP/SL**

**Diagnosis:** `updateAllSignalsStatus()` not running.

**Check:**
```typescript
// Ensure this useEffect is active:
useEffect(() => {
  const interval = setInterval(updateAllSignalsStatus, 5000);
  return () => clearInterval(interval);
}, [updateAllSignalsStatus]);
```

---

## 📝 Configuration Reference

### **Default Settings**

```typescript
const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 20,
  tp2Pips: 40,
  tp3Pips: 65,
  slPips: 70,              // ← Base SL (updated from 120)
  numberOfTPs: 3,
  minConfidence: 0.70,     // 70%
  enableNotifications: true,
  basePositionSize: 0.01,  // 0.01 lots
  maxRiskPercentage: 2.0,  // 2% of account
  useKellyCriterion: true,
};
```

### **Engine Constants**

```typescript
// services/signalEngine.ts (Lines 106-118)
const BASE_SLIPPAGE_BUFFER_PIPS = 0.5;
const CONFIDENCE_SMOOTHING_WINDOW = 5;
const LATENCY_WARNING_THRESHOLD_MS = 100;
const FEATURE_CORRELATION_CHECK_INTERVAL = 30 * 24 * 60 * 60 * 1000; // 30 days
const INTERMARKET_CACHE_DURATION = 10000; // 10 seconds
const HYPOTHETICAL_TRADE_HISTORY_LIMIT = 100;
const MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL = 15; // ← Price proximity threshold
const MAX_RECENT_SIGNAL_TIME_MINUTES = 5;     // ← Proximity time window
```

---

## 🎉 Summary of Improvements

### **Multi-Signal Support**
- ✅ Removed `currentSignal` blocking state
- ✅ Removed redundant `updateSignalStatus()` hook
- ✅ `signalHistory` is now the single source of truth
- ✅ Supports unlimited simultaneous active signals

### **Signal Quality Enhancements**
- ✅ Price Proximity Filter (15 pips minimum distance)
- ✅ 5-minute lookback window for redundancy checks
- ✅ Dynamic cooldown based on market regime
- ✅ ATR-adjusted SL (70 pips base → 63-84 pips actual)

### **Status Tracking**
- ✅ `updateAllSignalsStatus()` monitors ALL signals every 5 seconds
- ✅ Automatic expiry after 2 hours
- ✅ Real-time TP1/TP2/TP3 progression tracking
- ✅ SL hit detection with immediate finalization

### **Performance & Reliability**
- ✅ No stale state issues
- ✅ Consistent UTC+Local time display
- ✅ Atomic AsyncStorage updates
- ✅ Metrics recalculate on every history change

---

## 🔮 Future Enhancements (Roadmap)

1. **Signal Correlation Analysis**
   - Detect when multiple active signals have correlated outcomes
   - Adjust position sizing for correlated risk

2. **Advanced Multi-Signal Risk Management**
   - Total exposure calculation across all active signals
   - Dynamic position sizing based on total open risk

3. **Signal Performance Breakdown**
   - Track win rates by signal type (BUY vs SELL)
   - Track win rates by market regime (TRENDING vs RANGING)

4. **Enhanced History Tab**
   - Group signals by session (London, NY, Asian)
   - Filter by outcome (Winners, Losers, Break-even)
   - Export history to CSV

---

## 📞 Support & Debugging

For issues, check these files in order:

1. **contexts/TradingContext.tsx** (Lines 296-372) - Signal generation orchestration
2. **services/signalEngine.ts** (Lines 1157-1363) - Core signal logic
3. **Console logs** - Every generation attempt is logged with rejection reasons

**Key Log Patterns to Search:**
- `✅ SIGNAL GENERATED` - Successful generation
- `❌ REJECTED` - Generation blocked (with reason)
- `⚠️ BLOCKED` - Market closed or critical blocker

---

**Document Version:** 2.0  
**Last Updated:** November 12, 2025  
**System Version:** Multi-Signal Trading System v2.0  
**Base SL:** 70 pips (ATR-adjusted: 63-84 pips)
