# Fix signals, history, live price, and OAuth logos + full audit

## Progress

### 1. Live price — Swissquote as primary
- [x] Swissquote already top-priority in `goldPrice.getLivePrice` (verified)
- [x] Backend polling watchdog already in place (`goldWebSocketService.ts`)
- [x] Yahoo / TwelveData / goldprice.org / metals.live kept as backups

### 2. Historical data — combined approach
- [x] Backend Yahoo → TwelveData → Tiingo chain verified (goldPrice.ts)
- [x] Client direct fallback + Swissquote synthetic bar fallback verified (lib/trpc.ts)
- [x] Every historical fetch guarded with AbortController + try/catch — no throws to UI

### 3. Signal generation — quality-first, 5+/day target
- [x] Kept 62% absolute floor, tightened entry validation with new `evaluateQualityGate`:
  - Volume ratio minimum per regime
  - QUIET regime + weak strength blocked
  - RANGING regime requires confirmed S/R reaction
  - Unconfirmed S/R reactions require ≥80% confidence
  - RSI extremes blocked outside trending regimes
  - ATR minimum to ensure targets are reachable
- [x] Removed duplicate early cooldown check (replaced with simple 45s min gate)
- [x] Tightened dynamic cooldown (base 90s, min 45s, max 180s)
- [x] Starvation relief still active (unchanged)

### 4. History tab — show active + closed signals
- [x] Hydrate `signalHistoryRef` + `setSignalHistory` BEFORE running catch-up reconciliation so UI shows signals immediately on cold start
- [x] History screen reads from same `useTrading` context (single source of truth, already was)

### 5. Chart stability
- [x] TradingView HTML already memoized with stable instance id (`SHARED_CHART_INSTANCE_ID`) — verified no remount per price tick

### 6. Google / Apple sign-in logos
- [x] Created `components/BrandLogos.tsx` with authentic Google multi-color "G" and white Apple SVGs via `react-native-svg`
- [x] Replaced generic icons in `AccountSettingsCard.tsx`
- [x] White Google button, black Apple button per brand guidelines

### 7. Full codebase audit
- [x] Deleted `scripts/__sandbox__/signalEngine.sandbox.ts` (3900+ line stale duplicate)
- [x] Verified Swissquote fetchers in signalEngine/trpc/goldPrice are each purpose-specific (client live, client synthetic history, backend live) — not true duplicates
- [x] Removed duplicate cooldown gate in `generateSignal`
