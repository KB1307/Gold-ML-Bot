# Keep TradingView Chart Price as the Signal Driver for XAU/USD

## Overview

Make the TradingView chart price the primary live input for signal generation and live signal monitoring. Swissquote REST polling (every 1.5s, no API key required) provides a separate live market-price feed for the dashboard bubble (replacing Tiingo FX WebSocket which had persistent connectivity issues). Multiple REST fallback sources (metals.live, Tiingo REST, goldprice.org) stay available for recovery. If the TradingView bridge stalls without meaningfully updating, the app may temporarily fail over to a fresher guide tick until chart movement resumes.

---

### **Features**

- **TradingView chart-first pricing**: signal generation and active signal monitoring use the chart-fed price path when chart updates are available
- **Swissquote guide-first display with emergency failover**: Swissquote REST polling (no API key needed) powers the market-price bubble as a fast secondary indicator, but it only drives signal generation temporarily when the chart bridge is stale
- **REST/direct recovery path**: direct price refresh paths remain available for bootstrap and recovery when the engine needs a non-chart update
- **Fresh-price preference inside the engine**: the signal engine still prefers fresh external prices before making any direct fetch
- **Signal generation cadence unchanged**: the existing ML logic, confidence checks, cooldowns, and 30-second generation cadence remain intact
- **TradingView chart implementation preserved**: the existing chart stays in place, with only a lightweight price bridge added around it
- **Historical signal reconciliation**: open signals periodically re-check 1-minute price history from signal creation to now so missed TP/SL touches are recovered after pauses or stalls
- **Duplicate tick suppression**: repeated identical live ticks no longer flood engine history and flatten momentum detection

---

### **How It Works (Behind the Scenes)**

1. **TradingView price bridge** extracts live price updates from the embedded chart wrapper and forwards them into the signal path
2. **Dashboard context split** keeps chart price on the signal-driving path while storing Finnhub separately for the dashboard market-price display
3. **Signal engine freshness check** uses the latest chart-fed external price before falling back to any direct fetch path
4. **Swissquote price polling** continues updating the separate guide-price path and powers the dashboard market price bubble, but it can temporarily take over the signal-driving path when the chart bridge is alive yet stalled
5. **Live-path deduplication** suppresses repeated identical ticks so the engine keeps a cleaner momentum history instead of being flattened by chart echo noise
6. **REST bootstrap/recovery** only runs when the engine has no fresh signal-driving live price, preventing slower guide feeds from hijacking foreground signals
7. **Historical reconciliation pass** replays 1-minute bars from signal creation through the present for every open signal so missed TP/SL hits are corrected even if live monitoring pauses

---

### **What Changes**

---

### **Files Modified**

- [x] **TradingView chart wrapper** updated to forward chart-derived live price updates without replacing the chart itself
- [x] **Dashboard chart integration** updated so chart prices feed the shared trading context directly
- [x] **Dashboard context** updated to keep Finnhub on a separate live-display path so it powers the dashboard market price label without affecting signal generation
- [x] **State-level chart/guide split** now stores TradingView freshness independently from the active engine price so guide-feed updates cannot accidentally displace chart-first signal driving
- [x] **Signal engine** updated to keep preferring fresh signal-driving live prices instead of forcing slow direct refreshes during normal signal generation
- [x] **WebSocket service path** retained for guide pricing and recovery support rather than foreground signal generation
- [x] **REST/direct recovery path** retained for bootstrap and recovery only
- [x] **Historical signal reconciliation** added so open signals are re-evaluated against 1-minute price history from creation to now and terminal exits persist exitPrice correctly
- [x] **Sandbox signal simulation runner** added so the signal engine can be exercised in isolation over an accelerated 24-hour replay
- [x] **Signal conviction tuning** relaxed the engine’s hard rejection thresholds so valid setups are no longer starved by overly strict strength/confidence gates
- [x] **Structural runway tuning** updated the primary-trend barrier check so trades are filtered by realistic TP3 clearance instead of an overly aggressive 3x TP2 runway requirement
- [x] **Low-timeframe trend sensitivity** now adapts to live volatility instead of requiring an unrealistically large fixed momentum move before trend alignment is recognized
- [x] **Chart-stall failover** now promotes a fresher live guide tick when the TradingView bridge stops meaningfully moving, preventing foreground signal generation from freezing on stale chart echoes
- [x] **Duplicate live tick suppression** now prevents repeated identical price samples from saturating engine history and flattening momentum detection
- [x] **TP2 breakeven protection** now closes signals as protected partial wins instead of losses when two targets were banked before the runner reversed
- [x] **Swissquote primary price feed** replaced Tiingo FX websocket with Swissquote REST polling (every 1.5s, no API key required) for the dashboard market-price bubble, with automatic fallback to metals.live, Tiingo REST, and goldprice.org when Swissquote is unavailable
- [x] **Tiingo → Swissquote migration** removed all Tiingo websocket code and Finnhub references; the price service now polls `forex-data-feed.swissquote.com` directly with exponential backoff on failures and watchdog-based recovery
- [x] **TradingView render isolation** now routes chart ticks through a standalone bridge so dashboard state updates no longer force chart-container rerenders/remounts
- [x] **Persistent TradingView iframe mounting** now creates the web chart iframe once and keeps it mounted across dashboard updates so the chart stays rendered instead of reloading every few seconds
- [x] **Daily market-status pivot refresh** now rebuilds completed NY-session OHLC bars from historical minute data and derives dashboard support/resistance from a fresh completed trading-day bar instead of stale rollover snapshots
- [x] **Daily intraday support/resistance zoning** now uses tighter completed-day zone anchors for the dashboard/outlook so levels match the signal bot’s intraday frequency instead of wider long-range spacing
- [x] **Confidence recalibration (v2)** replaced the artificial 90% floor with a realistic 72% minimum, rewrote the confidence formula to start lower (0.40 base vs 0.55), removed bidirectional inflation from non-directional features (fibonacci, volume nodes, liquidity session, volatile regime), added penalties for synthetic data, low data quality, opposing signal strength, and conflicting indicators, capped smoothing uplift at +3% above raw, and capped max confidence at 96%
- [x] **Sandbox verification** confirmed the engine now generates signals again over the accelerated 24-hour replay
- [x] **Supabase auth client wiring** now initializes a typed Supabase client with persisted Expo-compatible sessions and OAuth callback handling
- [x] **Settings account center** now includes email sign-in, create-account, Google sign-in, and Apple sign-in actions directly inside the settings page
- [x] **RevenueCat user identity sync** now logs RevenueCat into the authenticated Supabase user ID so tiered pricing can follow the signed-in user across sessions
- [x] **Type validation for auth integration** confirmed the new auth and subscription wiring passes strict TypeScript checks
- [x] **Supabase smoke test tooling** now creates a throwaway auth user, saves auth metadata, and exposes an in-app verification action in settings

---

## Addendum: Stop false Take-Profit recordings (all 3 TP “touched” off one phantom tick)

### What was going wrong

The earlier work hardened the **stop-loss** side but left the **take-profit** side exposed to the exact same failure, which surfaced on the 05:42 BUY signal (recorded as all 3 TPs hit / runner at breakeven when price never reached TP1):

1. **The spike filter had a low-liquidity hole.** It stopped rejecting outlier ticks entirely once the feed went quiet for 30s, and its tolerance grew without limit as the gap widened (a 25s gap allowed a ~150 pip jump). During thin pre-London hours (05:42 local = 03:42 UTC) gold ticks arrive far apart, so a single phantom spike sailed straight through — instantly banking a false ALL_TARGETS_HIT off one tick **and** poisoning the 1-minute bar the audit trusts.
2. **Take-profit had no confirmation at all.** Unlike the stop-loss (which now needs a sustained breach), a single tick at/above TP3 immediately banked all three targets.
3. **The audit could not undo it.** The bar resolver was seeded from the stored status and could only ratchet *forward*, so a falsely-recorded ALL_TARGETS_HIT was frozen — even a clean-bar re-check left it as a win.

### What I changed

- [x] Replaced the holey spike filter with a **two-tick spike gate** used by both the bar-ingest path and the live signal evaluator: a large jump is held until a **second independent tick** corroborates the new level, so a lone glitch that leaps and reverts is dropped — with no risk of a stuck feed (a genuine gap is accepted on the next corroborating tick). The tolerance no longer grows without limit, and the 30-second “stop rejecting” hole is gone.
- [x] This single gate protects **both** failure modes at once: a phantom tick can no longer bank a false TP **and** can no longer be written into the 1m/5m/1h bars, so the audit stays truthful.
- [x] **Manual Audit now re-derives each terminal signal’s outcome from scratch** against the freshly fetched authoritative bars, instead of only ratcheting forward. This lets it **undo** a falsely-recorded ALL_TARGETS_HIT (the 05:42 signal and any like it) and collapse it to its true outcome — SL, protected partial, or a flat neutral close — feeding the corrected record to the learning engine.
- [x] Verified tick-for-tick: the resolver harness now covers a false ALL_TARGETS_HIT being corrected while a genuine win is preserved. **Result: 22/22 assertions passed.** Project type-checks pass.

### To correct the existing 05:42 signal
Tap **Manual Audit** (top-right of History). It force-fetches clean 1-minute bars from the data provider and re-resolves from scratch, so the false win flips to its true outcome and the performance numbers recompute from the corrected history.
