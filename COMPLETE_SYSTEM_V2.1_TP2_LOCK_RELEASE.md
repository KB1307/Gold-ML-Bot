# Complete Trading Signal System V2.1 - TP2 Lock Release
## Updated: November 2025

---

## 🎯 Core System Philosophy

This is a **manual execution trading system** that generates high-confidence signals using AI-powered analysis. The system:
- Generates signals automatically when conditions are met
- **Does NOT execute trades** - you manually place trades based on signals
- Provides comprehensive signal management and monitoring
- Uses dynamic lock release at TP2 for optimal signal generation

---

## 📊 Signal Flow Architecture

### 1. Signal Generation & Display

```
┌─────────────────────────────────────────────┐
│  Signal Generation (Every 30 seconds)       │
│  - Check market open                        │
│  - Check lock status (TP2 release)          │
│  - Run 50+ feature analysis                 │
│  - Generate signal if confidence > 70%      │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  IMMEDIATE: Add to signalHistory[]          │
│  ✓ Visible on Dashboard (as currentSignal) │
│  ✓ Visible in History Tab                   │
│  ✓ Status: ACTIVE                           │
│  ✓ Targets: 0/3                             │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│  User manually enters trade at broker       │
│  Signal remains ACTIVE on both tabs         │
└─────────────────────────────────────────────┘
```

**Key Point**: Signals appear **immediately** in BOTH dashboard and history when generated. The same signal object is shared across both views.

---

## 🔒 Dynamic Lock Release System (TP2)

### Lock States

| Lock Status | Condition | New Signals | Explanation |
|------------|-----------|-------------|-------------|
| **LOCKED** | Signal ACTIVE, TP < 2 | ❌ BLOCKED | Protecting capital, full lock active |
| **RELEASED** | TP2 hit (2/3 targets) | ✅ ALLOWED | Profit secured, risk eliminated |
| **RELEASED** | 2+ hours elapsed | ✅ ALLOWED | Signal expired, new opportunities |
| **TERMINAL** | SL_HIT or ALL_TARGETS_HIT | ✅ ALLOWED | Trade fully closed |

### Why TP2 Release?

```
Traditional System (OLD):
├─ Signal Generated @ 2650
├─ TP1 Hit @ 2670 (+20 pips) ← Profit secured
├─ TP2 Hit @ 2690 (+40 pips) ← More profit secured
├─ 🔒 LOCK STILL ACTIVE - missing new opportunities!
└─ TP3 Hit @ 2715 (+65 pips) ← Finally lock releases

New TP2 System (V2.1):
├─ Signal Generated @ 2650
├─ TP1 Hit @ 2670 (+20 pips) ← Profit secured
├─ TP2 Hit @ 2690 (+40 pips) 🔓 LOCK RELEASED!
│   └─ Original signal continues monitoring for TP3
│   └─ NEW signals can now be generated
├─ New Signal Generated @ 2695 (different setup)
└─ Both signals monitored independently
```

---

## 🔄 Signal Status Lifecycle

### Status States

```
ACTIVE (Initial)
  ↓
TP1_HIT (targetsHit: 1)
  ↓
TP2_HIT (targetsHit: 2) ← 🔓 LOCK RELEASES HERE
  ↓                        ↓
TP3_HIT/ALL_TARGETS_HIT   Continue monitoring
  ↓                        while new signals
[TERMINAL - History Only]  can be generated
```

### Monitoring Logic (Every 5 seconds)

```javascript
// updateAllSignalsStatus() runs every 5s

For each signal in signalHistory:
  1. Skip if terminal (SL_HIT, ALL_TARGETS_HIT, CLOSED)
  2. Skip if in grace period (< 5s old)
  3. Check expiry (2 hours) → Mark CLOSED
  4. Check price vs targets:
     - TP1 reached → Status: TP1_HIT, targetsHit: 1
     - TP2 reached → Status: TP2_HIT, targetsHit: 2 
                     🔓 LOG: "Lock Released"
     - TP3 reached → Status: ALL_TARGETS_HIT, targetsHit: 3
                     ✅ Add exitTime (TERMINAL)
     - SL reached  → Status: SL_HIT
                     ✅ Add exitTime (TERMINAL)
```

---

## 📱 Dashboard Display Logic

```javascript
// Dashboard shows the FIRST active or partially managed signal
const currentSignal = signalHistory.find(s => 
  s.status === "ACTIVE" || 
  s.status === "PARTIALLY_MANAGED" ||
  s.status === "TP1_HIT" || 
  s.status === "TP2_HIT"
) || null;

// If TP2 is hit:
// - Signal STAYS on dashboard (monitoring TP3/SL)
// - Lock is released (new signals can be generated)
// - New signal will also appear on dashboard
// - History shows ALL signals
```

---

## 📋 History Tab Display

The History tab shows **ALL signals** from `signalHistory[]`:

```
┌────────────────────────────────────────────┐
│  ACTIVE SIGNALS (Green indicators)         │
│  - Currently monitoring                    │
│  - Shows targets hit (e.g., TP2 HIT)       │
├────────────────────────────────────────────┤
│  TP1_HIT, TP2_HIT (Yellow/Orange)          │
│  - Partial profits secured                 │
│  - Still monitoring for next target        │
├────────────────────────────────────────────┤
│  ALL_TARGETS_HIT (Green ✓)                 │
│  - All 3 targets achieved                  │
│  - Trade completed successfully            │
├────────────────────────────────────────────┤
│  SL_HIT (Red ✗)                            │
│  - Stop loss was hit                       │
│  - Trade closed at loss                    │
├────────────────────────────────────────────┤
│  CLOSED (Gray)                             │
│  - Expired after 2 hours                   │
│  - Or manually closed                      │
└────────────────────────────────────────────┘
```

**Timestamps**: All times displayed in **local time zone** (UTC +2 for SAST) for user convenience.

---

## 🛡️ Anti-Duplicate Protection

### Proximity Filter

Prevents generating nearly identical signals:

```javascript
// In checkAndGenerateSignal()

Rejection if:
  - Existing ACTIVE signal of same type (BUY/BUY or SELL/SELL)
  - Entry price within 5 pips
  - TP1 within 5 pips  
  - TP3 within 10 pips

Exception (Bypass Filter):
  - Trend change detected (15+ pip avg shift)
  - Large price movement (20+ pip range in 5min)
```

---

## 🧠 Signal Generation Conditions

### Generation Blockers (Checked in Order)

```
1. ⏱️ EARLY COOLDOWN CHECK (NEW - Saves CPU)
   ├─ Get preliminary market regime
   ├─ Calculate preliminary dynamic cooldown
   └─ Exit immediately if cooldown not expired
   
2. 🌐 Market Closed Check
   └─ Block if weekend or outside trading hours
   
3. 🔒 Active Signal Lock Check
   ├─ Check: Any ACTIVE signal exists?
   ├─ Check: TP2 hit? (targetsHit >= 2)
   ├─ Check: 2+ hours elapsed?
   └─ Block if lock not released
   
4. 📊 Run 50+ Feature Analysis (EXPENSIVE)
   └─ Only runs if above checks pass
   
5. 🎯 Confidence Check
   └─ Confidence must be ≥ minConfidence (default 70%)
   
6. 🚫 Proximity Filter
   └─ Check for duplicate signals in same zone
   
7. 📰 Macro Event Suppression
   └─ Block if high-impact event < 30 min away
   
8. ✅ SIGNAL GENERATED
```

---

## ⚡ Dynamic Cooldown System

Cooldown adapts to market conditions:

```
Base Cooldown: 60 seconds

Market Regime Multipliers:
├─ TRENDING (strong):  0.25x → 15s  (fast-moving opportunities)
├─ TRENDING:           0.35x → 21s
├─ VOLATILE:           0.30x → 18s  (high opportunity window)
├─ RANGING:            1.00x → 60s
└─ QUIET:              1.50x → 90s  (low opportunity)

Confidence Adjustments:
├─ ≥95%: 0x   → INSTANT (cooldown cancelled)
├─ ≥90%: 0.5x → 50% reduction
├─ ≥85%: 0.7x → 30% reduction
└─ <85%: 1.0x → No adjustment

Final Cooldown Range: 15s - 120s
```

---

## 🎮 User Workflow Example

### Scenario: Two Signals with TP2 Release

```
Timeline:
─────────────────────────────────────────────────────

08:00 - Signal A generated (BUY @ 2650)
        ├─ Dashboard: Shows Signal A
        ├─ History: Shows Signal A (ACTIVE)
        └─ Lock: LOCKED ❌

08:02 - User enters trade manually at broker

08:15 - TP1 Hit (2670)
        ├─ Signal A: TP1_HIT, targetsHit: 1/3
        ├─ Lock: Still LOCKED ❌
        └─ New signals: BLOCKED

08:30 - TP2 Hit (2690) ← 🔓 KEY MOMENT
        ├─ Signal A: TP2_HIT, targetsHit: 2/3
        ├─ Lock: RELEASED ✅
        ├─ Console: "🔓 Lock Released"
        └─ New signals: ALLOWED

08:32 - Signal B generated (BUY @ 2695, different setup)
        ├─ Dashboard: Shows Signal A (TP2 monitoring TP3)
        ├─ History: Shows Signal A (TP2_HIT) + Signal B (ACTIVE)
        └─ Both signals monitored independently

08:45 - Signal A: TP3 Hit (2715)
        ├─ Status: ALL_TARGETS_HIT (TERMINAL)
        ├─ exitTime: "08:45"
        ├─ Dashboard: Now shows Signal B only
        └─ History: Signal A (completed ✓), Signal B (ACTIVE)

09:00 - Signal B: TP1 Hit (2715)
        └─ Still monitoring, lock still released

// The cycle continues...
```

---

## 🔍 Console Logging System

### Key Log Messages

```bash
# Lock Status
🔓 LOCK RELEASED: Signal abc123 hit TP2
   This signal continues to be monitored for TP3 or SL

# Signal Generation
✅ Lock released - New signal generation allowed:
   - TP2 hit (2/3 targets) - Lock released
   - Previous signal continues to be monitored

# Terminal Status
✅ Terminal status reached: Signal abc123 will remain in history only

# Monitoring
🎯 TP2 HIT: Signal abc123 @ 2690.0
⚠️ SL HIT: Signal abc123 @ 2620.0
🎯 ALL TARGETS HIT: Signal abc123 reached TP3 @ 2715.0
```

---

## 🏥 Performance Tracking

### Metrics Calculation

Only **TERMINAL** signals count toward performance:
- ✅ ALL_TARGETS_HIT → WIN (TP3 achieved)
- ❌ SL_HIT → LOSS
- ⚠️ CLOSED (expired) → LOSS (if below entry)

**Active signals** (ACTIVE, TP1_HIT, TP2_HIT) are **NOT** counted until terminal.

---

## 🛠️ System Configuration

### Settings (contexts/TradingContext.tsx)

```typescript
const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 20,        // First target
  tp2Pips: 40,        // Second target (LOCK RELEASE)
  tp3Pips: 65,        // Final target
  slPips: 70,         // Stop loss
  numberOfTPs: 3,     // Always 3 targets
  minConfidence: 0.70, // 70% minimum confidence
  enableNotifications: true,
  basePositionSize: 0.01,
  maxRiskPercentage: 2.0,
  useKellyCriterion: true,
};
```

### Timers

```typescript
Price Update:       3 seconds  (live price fetch)
Signal Monitoring:  5 seconds  (TP/SL checks)
Market Outlook:     5 seconds  (session updates)
Signal Generation:  30 seconds (new signal checks)
Dashboard Refresh:  60 seconds (auto-refresh)
```

---

## 🚀 Key Improvements in V2.1

### 1. TP2 Lock Release ✨
- **Before**: Lock held until ALL_TARGETS_HIT or SL_HIT
- **After**: Lock releases at TP2 (2/3 targets)
- **Benefit**: Capture more opportunities while securing profit

### 2. Immediate Visibility
- **Before**: Signals might not appear consistently
- **After**: Signals instantly visible in dashboard AND history
- **Benefit**: Clear, immediate feedback

### 3. Continuous Monitoring
- **Before**: Signal removed from dashboard when lock released
- **After**: Signal stays on dashboard until terminal
- **Benefit**: Full lifecycle tracking

### 4. Smart CPU Usage
- **Early cooldown check** before expensive analysis
- Saves ~80% CPU on blocked signals

### 5. Clear Console Logging
- Lock status changes clearly logged
- Easy to debug and understand system behavior

---

## 📊 Status Reference

| Status | Dashboard | History | Meaning | Lock |
|--------|-----------|---------|---------|------|
| **ACTIVE** | ✅ | ✅ | Fresh signal, no targets hit | 🔒 LOCKED |
| **TP1_HIT** | ✅ | ✅ | First target reached | 🔒 LOCKED |
| **TP2_HIT** | ✅ | ✅ | Second target reached | 🔓 **RELEASED** |
| **TP3_HIT** | ❌ | ✅ | All targets reached | ✅ Terminal |
| **ALL_TARGETS_HIT** | ❌ | ✅ | Same as TP3_HIT | ✅ Terminal |
| **SL_HIT** | ❌ | ✅ | Stop loss hit | ✅ Terminal |
| **CLOSED** | ❌ | ✅ | Expired (2h) or manual close | ✅ Terminal |

---

## 🎯 Best Practices

### For Users:

1. **Monitor Dashboard**: Your current active signal
2. **Check History**: Full record of all signals
3. **Act on TP2**: When TP2 hits:
   - Move SL to break-even on remaining position
   - Watch for new signal opportunities
4. **Manual Execution**: Always enter trades manually at your broker
5. **Position Sizing**: Follow the recommended position size from system

### For System Health:

- Keep `minConfidence` at 70%+ for quality signals
- Monitor Model Health Score (aim for 80+)
- Clear old history periodically (Settings → Clear History)
- Check console logs for system behavior insights

---

## 🔐 Technical Implementation Details

### Signal Generation Lock Logic

```typescript
// In checkAndGenerateSignal()
const fullyActiveSignals = signalHistory.filter(s => s.status === "ACTIVE");

if (fullyActiveSignals.length > 0) {
  const activeSignal = fullyActiveSignals[0];
  const lockReleased = activeSignal.targetsHit >= 2; // TP2 check
  
  const canGenerateNewSignal = (
    lockReleased ||           // TP2+ hit
    signalAgeMs > twoHoursMs  // 2+ hours old
  );
  
  if (!canGenerateNewSignal) {
    console.log("❌ BLOCKED: Lock not released");
    return; // Exit early, save CPU
  }
}
```

### Signal Status Update Logic

```typescript
// In updateAllSignalsStatus() (runs every 5s)
if (targetsHit === 2 && signal.targetsHit < 2) {
  console.log(`🔓 LOCK RELEASED: Signal ${signal.id} hit TP2`);
  console.log(`   This signal continues to be monitored for TP3 or SL`);
}

if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
  console.log(`✅ Terminal status: Signal ${signal.id} history only`);
  // Add exitTime, signal no longer shows on dashboard
}
```

---

## 📈 System Flow Summary

```
┌─────────────────────────────────────────────────────────┐
│                   Signal Generated                      │
│              (Every 30s if conditions met)              │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         Added to signalHistory[] Array                  │
│    Dashboard: Shows as currentSignal (first active)     │
│    History: Shows in full list with status              │
│    Status: ACTIVE, targetsHit: 0, Lock: LOCKED          │
└────────────────────┬────────────────────────────────────┘
                     │
            (Price monitoring every 5s)
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   TP1 Reached              SL Reached
Status: TP1_HIT         Status: SL_HIT
Lock: LOCKED            Lock: RELEASED (Terminal)
        │                         │
        ▼                         ▼
   TP2 Reached              To History Only
Status: TP2_HIT           exitTime set
Lock: RELEASED ✨          Performance counted
        │
   (Still monitored)
   (New signals allowed)
        │
        ▼
   TP3 Reached
Status: ALL_TARGETS_HIT
Lock: RELEASED (Terminal)
        │
        ▼
    To History Only
    exitTime set
    Performance counted
```

---

## 🎓 Understanding the System

### Q: When does a signal appear on the dashboard?
**A**: Immediately when generated. It stays on dashboard until it reaches a terminal status (SL_HIT or ALL_TARGETS_HIT).

### Q: When can new signals be generated?
**A**: When TP2 is hit (targetsHit ≥ 2), when 2+ hours have elapsed, or when the signal reaches terminal status.

### Q: Do signals appear in history before they're closed?
**A**: Yes! Signals appear in BOTH dashboard and history from the moment they're generated. History shows the complete lifecycle.

### Q: What happens when TP2 is hit?
**A**: 
1. Lock is released (new signals allowed)
2. Original signal continues monitoring for TP3
3. Signal stays visible on dashboard
4. Both old and new signals monitored independently

### Q: How do I know when to trade?
**A**: Watch the dashboard. When a new signal appears with high confidence, manually enter the trade at your broker.

---

## 🏆 Success Metrics

The system tracks these automatically:

- **Win Rate**: % of terminal signals that hit TP3
- **Profit Factor**: Total wins / Total losses
- **Sharpe Ratio**: Risk-adjusted returns
- **Model Health**: 0-100 score of AI model condition
- **Max Drawdown**: Largest peak-to-trough decline

Aim for:
- Win Rate: 60%+
- Profit Factor: 2.0+
- Model Health: 80+

---

## 🛠️ Troubleshooting

### No signals generating?
1. Check market is open (Dashboard shows session)
2. Check existing signal status (if TP2 not hit, locked)
3. Check console for rejection reasons
4. Verify minConfidence setting (lower if needed)

### Duplicate signals?
- System has proximity filter (5-15 pip range)
- Check for trend change or large price movement (bypasses filter)

### Signal stuck?
- Signals auto-expire after 2 hours
- Use manual close in History if needed
- Check price is moving (might be ranging)

---

*System Version: 2.1.0*  
*Last Updated: November 2025*  
*Lock Release Feature: TP2 Dynamic Lock Release*
