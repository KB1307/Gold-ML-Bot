# SYSTEM_REVIEW.md
### XAU/USD Algorithmic Signal Intelligence Platform — Definitive Technical Review

> **Audience:** Engineering, Quant Research, Risk.
> **Scope:** Full-repository static analysis of the mobile signal-generation system (`expo/`).
> **Classification:** Internal / Institutional-grade architectural assessment.

---

## 1. Executive Summary & Architecture Overview

### 1.1 System Blueprint

This is a **client-heavy, event-driven signal advisory engine** for spot gold (`XAU/USD`), packaged as a cross-platform **React Native (Expo)** application. It is **not** an order-execution / broker-connected trading system — there is no FIX/REST order router, no position ledger held at a broker, and no real fills. It is a **decision-support / signal-broadcast platform**: it ingests live price, computes a large feature vector, runs a heuristic "attention-weighted" scoring model, emits `BUY`/`SELL` signals with TP/SL geometry, then **self-resolves** those signals against recorded price bars to produce a performance track record.

The architecture is best described as a **single-process reactive pipeline** with four concentric layers:

```
┌─────────────────────────────────────────────────────────────────────┐
│  PRESENTATION (expo/app, components)                                 │
│  Dashboard · History · Telemetry · Settings · Paywall · Auth        │
└───────────────▲─────────────────────────────────────────────────────┘
                │ (React Context / hooks)
┌───────────────┴─────────────────────────────────────────────────────┐
│  ORCHESTRATION (contexts/TradingContext.tsx — 2,897 LOC)            │
│  state, persistence, reconciliation, metrics, audit, monetization   │
└───────────────▲─────────────────────────────────────────────────────┘
                │ (singleton service calls)
┌───────────────┴─────────────────────────────────────────────────────┐
│  DOMAIN ENGINE (services/)                                           │
│  signalEngine.ts (5,533 LOC) · signalResolver.ts · barStore.ts      │
│  chartPriceBridge.ts · goldWebSocketService.ts · telegramNotifier   │
└───────────────▲─────────────────────────────────────────────────────┘
                │ (tRPC / HTTP / WebView bridge)
┌───────────────┴─────────────────────────────────────────────────────┐
│  DATA / INFRA (backend/trpc, lib/, Supabase, price vendors)         │
│  Hono + tRPC proxy · Swissquote/Finnhub/Tiingo/metals.live/etc.     │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Core Tech Stack

| Layer | Technology |
| --- | --- |
| **Language** | TypeScript (strict), targeting React Native runtime (Hermes/JSC) |
| **App framework** | Expo SDK + Expo Router (file-based navigation) |
| **State** | `@nkzw/create-context-hook` + React `useState`/`useRef`; React Query available |
| **Local persistence** | `AsyncStorage` (signals, settings, metrics, ML weights) + `expo-sqlite` (OHLC bar store) |
| **Backend** | Hono server exposing a **tRPC** router (`goldPrice`, `example`) — a price/intermarket **proxy + cache**, not a trading server |
| **Auth** | Supabase (`@supabase/supabase-js`) with Expo-persisted sessions, Google/Apple OAuth |
| **Monetization** | RevenueCat (`SubscriptionContext`), identity-synced to Supabase user ID |
| **Charting** | Embedded **TradingView** widget inside a WebView, scraped via a price bridge |
| **Notifications** | `expo-notifications` + `expo-background-fetch` / `expo-task-manager`; optional Telegram webhook |
| **Market data** | Swissquote (primary spot), Finnhub, Tiingo, metals.live, goldprice.org, frankfurter/er-api (web CORS fallbacks); Yahoo-derived historical bars via backend |

### 1.3 Component Interaction — End-to-End Data Flow

1. **Ingestion (multi-source).** The embedded TradingView chart emits live ticks → `chartPriceBridge.publishChartPrice()`. In parallel, `goldWebSocketService` polls the backend (`goldPrice.getLivePrice`) every ~2 s, and the backend tRPC proxy fans out to vendor APIs with per-API circuit-breaking (`shouldSkipApi`, `FAILURE_COOLDOWN_MS`).
2. **Bridging.** `TradingContext` subscribes to the chart bridge and the guide feed. Chart price is the **signal-driving** path; the guide feed (Swissquote) powers the dashboard bubble and acts as **stale-chart failover**.
3. **State sync.** Each accepted tick is pushed into the `SignalGenerationEngine` singleton via `pushExternalPrice()` → `syncCurrentPrice()`, which dedupes flat ticks (`MIN_PRICE_HISTORY_CHANGE = 0.03`) and ingests into `barStore` (1m/5m/1h OHLC).
4. **Feature computation.** On a ~30 s cadence, `generateSignal()` calls `calculateMarketFeatures()` → RSI, ATR, pivots, Fibonacci, order-flow proxy, volume profile, regime, S/R zones, order blocks, Quasimodo, session sweeps, intermarket (DXY/US10Y/VIX).
5. **Scoring & gating.** `enhancedTransformerAnalysis()` produces a direction + confidence; a cascade of gates (conviction, HTF veto, session floor, quality gate, structural, proximity, conflict) accepts or rejects.
6. **Emission.** An accepted signal gets entry/slippage/TP1-3/SL geometry, is persisted to history, optionally fires a local notification + Telegram alert.
7. **Resolution & audit.** `signalResolver.resolveSignalWithBars()` replays stored bars to advance each open signal; `catchUpAndEvaluateSignals()` + `auditTerminalSLSignals()` reconcile missed/false touches; performance metrics recompute over the **entire** history.

---

## 2. Signal Generation Engine

### 2.1 Ingestion & Processing

- **Live price** is class-internal state on the `SignalGenerationEngine` singleton (`currentPrice`, `priceHistory`, `highHistory`, `lowHistory`, `closeHistory`, `volumeHistory`). History arrays are capped at 100 samples.
- **Tick admission** is governed by `syncCurrentPrice()`: a tick only extends history if it moved ≥ `MIN_PRICE_HISTORY_CHANGE` (0.03) **or** ≥ `MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS` (5 s) has elapsed. This prevents "chart echo" from flattening momentum.
- **Bar construction** (`barStore.ts`) maintains 1m/5m/1h OHLC in SQLite (mobile) or in-memory (web), with retention windows (1m → 24h, 5m → 3d, 1h → 14d) and `MAX_BARS` caps. `ingestTick` updates the active bucket's H/L/C.
- **Spike defense** (per `PLAN.md`): a two-tick corroboration gate rejects lone outlier ticks before they pollute bars or bank phantom TPs.

### 2.2 Logic & Indicators (math breakdown)

The feature pipeline mixes **real** technical math with **synthetic/proxy** microstructure estimates. Key real calculations:

- **RSI(14)** — `calculateRealRSI()` over `closeHistory`.
- **ATR(14)** — `calculateRealATR()`; drives dynamic SL and zone widths.
- **Camarilla-style intraday pivots** (note: labelled Camarilla but coefficients are custom):
  ```
  pivot = (H + L + C) / 3
  range = H - L
  R1 = C + (range * 1.1)/12     S1 = C - (range * 1.1)/12
  R2 = C + (range * 1.1)/6      S2 = C - (range * 1.1)/6
  R3 = C + (range * 1.1)/4      S3 = C - (range * 1.1)/4
  ```
  H/L/C come from `getDerivedDailyOHLC()` (latest completed NY-session bar, with staleness/drift guards and a developing-day fallback).
- **Fibonacci** retracements `{0.236,0.382,0.5,0.618,0.786}` + extensions `{1.272,1.414,1.618}`.
- **Trend strength** = `|netMove| / Σ|Δ|` over last 20 samples (efficiency ratio).
- **Rolling correlations** (gold vs DXY / yields) via Pearson over aligned windows.

Synthetic/heuristic features (flagged as a risk in §5): **order flow** (bid/ask volume inferred from momentum/range), **volume profile** (price-bucket histogram of *ticks*, not true volume), **sentiment** (derived from RSI + time-of-day bias), **session sweeps**, **order blocks**, **Quasimodo** levels.

### 2.3 State Machine

A signal's lifecycle is a typed `SignalStatus` machine (`types/trading.ts`):

```
                 ┌─────────── EXPIRED_MISSED_ENTRY  (entry never filled)
                 │
   (emit) ──► ACTIVE ──► TP1_HIT ──► TP2_HIT ──► ALL_TARGETS_HIT / TP3_HIT
                 │           │           │
                 │           │           └─► PARTIAL_WIN_SL_HIT (runner retraces to entry)
                 │           └─► SL_AFTER_BE (retrace to +15-pip post-TP1 lock)
                 └─► SL_HIT (pre-TP1 stop)
   any ──► PARTIALLY_MANAGED ──► CLOSED (manual/flat)
```

The **idle→pending→active** gating cascade in `generateSignal()` (in order):

1. **Market-close gate** — `isWithinDailyMarketClose()` blocks 20:59–21:59 UTC (22:59–23:59 UTC+2).
2. **Cooldown** — 30 s hard floor + dynamic regime cooldown, bypassable by trend-change / large-move *exceptions* (which still require structural validation).
3. **Confidence floors** — session-aware: `ENFORCED_MIN_SIGNAL_CONFIDENCE=0.68`, power-hour 0.65, low-liquidity 0.72, absolute floor 0.62.
4. **Counter-trend HTF veto (#2)** — fighting the daily trend adds +5% confidence premium and demands 5-min / OB / QM / sweep confirmation.
5. **EV relief / starvation relief** — controlled relaxations (EV ≥ 1.5R, or TRENDING+ADX>20 after a 90-min gap).
6. **Quality gate → structural validation → proximity filter → conflict prevention**.

---

## 3. Mechanics & Execution Layer

### 3.1 Order & Execution Flow

There is **no broker integration**. "Execution" is simulated at signal-emission time:

- **Entry** = `currentPrice` at acceptance.
- **Slippage model** — `calculateDynamicSlippage(regime, latency)` + measured bid/ask spread:
  ```
  entryWithSlippage = BUY  ? entry + (totalSlippage * 0.1)
                          : entry - (totalSlippage * 0.1)
  ```
- **Latency** is measured (`performance.now()` deltas) and surfaced as `latencyWarning` when > 100 ms.
- "Fills" are then **resolved against price bars** (`signalResolver`), not against a counterparty. This is the central architectural fact: the P&L track record is a **backtest-on-live-data simulation**, not realized trading.

### 3.2 Volume & Position Sizing

`calculatePositionSizing()` produces advisory sizing (account default $10k):

- **Confidence multiplier** — stepwise 0.75×→1.75× across the 0.72–0.92 confidence band.
- **Fractional Kelly:**
  ```
  kelly      = (winRate * PF - (1 - winRate)) / PF
  optimalPct = clamp(kelly * 0.25, 0, 0.05)        // 25% fractional, capped at 5%
  kellySize  = accountBalance * optimalPct / 1000   // lots
  ```
- **Risk cap:** `maxSize = accountBalance * (maxRiskPercentage/100) / 100`.
- **P&L math** (`computeSignalPnL`, `contractSize = 100`, `pipValue = 0.1`):
  ```
  raw       = BUY ? exit - entry : entry - exit
  clamped   = clamp(raw, -|entry - SL|, +|TP3 - entry|)   // structural envelope
  pnl       = clamped * basePositionSize * contractSize
  ```
  The clamp is a deliberate guard so a single corrupt bar cannot fabricate an impossible win/loss.

### 3.3 Risk & Position Management

- **Dynamic SL** — `slPips * atrMultiplier`, `atrMultiplier = clamp(0.6 + ATR*0.06, 0.8, 1.4)`, capped at `maxSLPips` (default 90).
- **Wick-penetration tolerance** — SL only triggers past `SL_WICK_PENETRATION_PIPS` (0.1) of slack; live path requires a *sustained* breach (per `PLAN.md`) to defeat glitch ticks.
- **Post-TP1 +15-pip profit lock** — replaces cosmetic "breakeven": BUY locks at `entry + 15 pips`, SELL at `entry - 15 pips`; retrace → `SL_AFTER_BE` (protected win).
- **Post-TP2 protection** — runner retrace to entry → `PARTIAL_WIN_SL_HIT`, exit at `(tp1 + tp2 + entry)/3`.
- **Global safety** — drawdown/Sharpe tracked in metrics; HIGH concept-drift elevates the confidence floor to 0.80 until retrain.

---

## 4. Quantitative & Self-Learning Infrastructure

There is **no neural network / XGBoost / LSTM** despite the "transformer" naming. `enhancedTransformerAnalysis()` is a **named-feature attention heuristic**: features contribute weighted "attention scores" (`Map<string, number>`) to a directional tally, smoothed and calibrated into a confidence. This is a **rule-weighted ensemble**, not learned inference.

### 4.1 Adaptive Weighting ("self-learning")

- **Outcome capture** — `recordTradeOutcome()` stores up to 100 `TradeOutcome` records with the feature context at emission, persisted to `AsyncStorage` (`trade_outcomes_learning`).
- **Walk-forward retrain** — `walkForwardOptimization()` requires ≥20 outcomes; trains over a 14-day window (fallback: last 100). Executed only in the low-liquidity window (22:00–07:00 UTC) to avoid contention.
- **Exponential decay weighting** — `weight = 0.75^daysOld`, normalized; recent days dominate (last 7 days ≈ 80–90% influence).
- **Feature weights** — `retrainModel()` derives per-feature weights from the weighted win/loss mean separation (e.g. `rsi_weight = (winRSI - lossRSI)/100`). Class-degenerate retrains fall back to neutral weighting.
- **Triggers** — scheduled (48 h), confidence degradation (< 0.68 avg winning confidence), or rolling win-rate drift.

### 4.2 Regime Detection & Drift

- **Regime** (`detectMarketRegime`) classifies `TRENDING/RANGING/VOLATILE/QUIET` from ATR, a tick-activity "volume ratio", VIX and trend strength; modulates cooldowns and conviction floors.
- **Concept-drift** monitors feature distribution + importance drift (`driftAlertLevel`, `conceptDriftScore`) feeding `getModelHealthMetrics()` (model health score, days-since-retrain, retrain recommendation).
- **Bayesian prior** — `BAYESIAN_PRIOR_ALPHA/BETA = 2/2` smooths low-sample win-rate buckets.

### 4.3 Inference Output

Confidence is recalibrated (per `PLAN.md` v2): base 0.40, realistic 0.72 floor, 0.96 cap, with penalties for synthetic data, low data quality, opposing strength and conflicting indicators; smoothing uplift capped at +3% over raw.

---

## 5. Full System Review & Vulnerability Assessment

### 5.1 Structural Bottlenecks & Risks

- **Monolithic engine file** — `signalEngine.ts` at **5,533 LOC** is a single class with dozens of responsibilities; high cognitive load, hard to unit-test in isolation, and a refactor hazard.
- **Module-level mutable singletons** — `cachedGoldPrice`, `lastFetchTime`, `intermarketHistory`, `lastPriceSource` are file-scope `let`s shared across the engine and price fetchers. In a single JS thread this avoids classic data races, but it creates **hidden global coupling** and makes the system effectively non-reentrant (the sandbox simulation and the live engine can stomp shared state).
- **Synchronous compute in the hot path** — `calculateMarketFeatures()` performs many array scans (S/R clustering iterates `priceHistory × candidateLevels`) on the JS thread; on low-end devices this can jank the UI during generation.
- **Data-source fragility** — six+ price vendors with bespoke parsers and circuit breakers. Consensus median logic (`Math.abs(p - median) < 15`) is reasonable, but **silent degradation to cache/stale/last-known** can let signals generate on aged prices (`EXTERNAL_PRICE_MAX_AGE_MS = 15 s` mitigates, but failover paths still emit on `🟠 stale`).
- **WebView price scraping** — depending on the embedded TradingView DOM for the primary signal price is brittle to vendor markup changes; the heartbeat/failover mitigates stalls but not silent format drift.
- **Persistence ceilings** — `tradeOutcomes` capped at 100 and `priceHistory` at 100 samples bound the learnable memory; long-horizon adaptation is structurally limited.

### 5.2 Mathematical / Algorithmic Flaws

- **Synthetic microstructure as signal** — order flow, volume profile and "institutional footprint" are derived from price momentum, **not real volume/tape**. Treating these as independent confirmations risks **double-counting price information** and inflating confidence (partially acknowledged via bidirectional-inflation penalties).
- **Simulation ≠ realized P&L** — resolving fills against own bars omits real-world spread variability, requotes, gaps and partial fills. The track record is an **optimistic upper bound**; do not market it as live trading performance.
- **Sharpe annualization** — `sharpe = (avgReturn/stdDev) * sqrt(252)` annualizes **per-trade** returns with a daily factor; this is dimensionally inconsistent (it implicitly assumes ~1 trade/day) and will misstate risk-adjusted return at other cadences.
- **Kelly stability** — Kelly uses `recentWinRate` and `profitFactor` from only the last 20 outcomes; with thin samples this is high-variance even at 25% fractional. The 5% hard cap is the real protection.
- **Pivot labelling** — levels are called "Camarilla" but use non-standard `1.1/12, 1.1/6, 1.1/4` divisors; correct as an intraday zoning heuristic, but the label is misleading for auditors.
- **Retrain class-degeneracy** — when a 14-day window has only wins or only losses, weight derivation falls back to neutral; in trending regimes this can starve adaptation exactly when it matters.

### 5.3 Production Readiness Score

> **Score: 68 / 100** — Feature-rich, defensively coded, with genuinely strong reconciliation/audit hygiene and disciplined gating. Held back by a monolithic engine, synthetic features presented as independent edge, simulated-vs-real P&L ambiguity, and data-source fragility.

**Top high-priority refactors (ranked):**

1. **Decompose `signalEngine.ts`** into testable modules — `FeatureService`, `RegimeService`, `ScoringModel`, `PriceFeedService`, `RiskModel` — behind interfaces, with the shared mutable globals encapsulated in an injectable state container.
2. **Separate "simulated track record" from "live performance"** in both code and UI copy; add explicit modeling of spread/slippage at resolution time so reported metrics are conservative, not optimistic.
3. **Fix the Sharpe (and expectancy) statistics** — compute per-trade expectancy in R-multiples and annualize using actual trade frequency, not a hard-coded √252.
4. **Harden the price layer** — formalize a source-quality SLA (reject signal generation on `stale`/`last-known`), add cross-source sanity bounds, and treat the TradingView scrape as one vote rather than the sole primary.
5. **De-correlate synthetic features** — either source real volume/tape or down-weight price-derived "microstructure" so confidence cannot be inflated by re-expressing the same momentum signal multiple times.

---

*Prepared from static analysis of the `expo/` workspace. No code was modified in producing this review.*
