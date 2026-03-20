# Keep TradingView Chart Price as the Signal Driver for XAU/USD

## Overview

Make the TradingView chart price the primary live input for signal generation and live signal monitoring. Tiingo WebSocket remains available as a separate live market-price feed for the dashboard bubble, while direct fetch and REST recovery paths stay available only when the engine needs a non-WebSocket refresh. If the TradingView bridge stalls without meaningfully updating, the app may temporarily fail over to a fresher guide tick until chart movement resumes.

---

### **Features**

- **TradingView chart-first pricing**: signal generation and active signal monitoring use the chart-fed price path when chart updates are available
- **Tiingo guide-first display with emergency failover**: Tiingo remains a fast secondary indicator in app state and powers the market-price bubble, but it only drives signal generation temporarily when the chart bridge is stale
- **REST/direct recovery path**: direct price refresh paths remain available for bootstrap and recovery when the engine needs a non-chart update
- **Fresh-price preference inside the engine**: the signal engine still prefers fresh external prices before making any direct fetch
- **Signal generation cadence unchanged**: the existing ML logic, confidence checks, cooldowns, and 30-second generation cadence remain intact
- **TradingView chart implementation preserved**: the existing chart stays in place, with only a lightweight price bridge added around it
- **Historical signal reconciliation**: open signals periodically re-check 1-minute price history from signal creation to now so missed TP/SL touches are recovered after pauses or stalls
- **Duplicate tick suppression**: repeated identical live ticks no longer flood engine history and flatten momentum detection

---

### **How It Works (Behind the Scenes)**

1. **TradingView price bridge** extracts live price updates from the embedded chart wrapper and forwards them into the signal path
2. **Dashboard context split** keeps chart price on the signal-driving path while storing Tiingo separately for the dashboard market-price display
3. **Signal engine freshness check** uses the latest chart-fed external price before falling back to any direct fetch path
4. **Tiingo indicator stream** continues updating the separate guide-price path and powers the dashboard market price bubble, but it can temporarily take over the signal-driving path when the chart bridge is alive yet stalled
5. **Live-path deduplication** suppresses repeated identical ticks so the engine keeps a cleaner momentum history instead of being flattened by chart echo noise
6. **REST bootstrap/recovery** only runs when the engine has no fresh signal-driving live price, preventing slower guide feeds from hijacking foreground signals
7. **Historical reconciliation pass** replays 1-minute bars from signal creation through the present for every open signal so missed TP/SL hits are corrected even if live monitoring pauses

---

### **What Changes**

---

### **Files Modified**

- [x] **TradingView chart wrapper** updated to forward chart-derived live price updates without replacing the chart itself
- [x] **Dashboard chart integration** updated so chart prices feed the shared trading context directly
- [x] **Dashboard context** updated to keep Tiingo on a separate live-display path so it powers the dashboard market price label without affecting signal generation
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
- [x] **Tiingo real-time guide feed** now uses sub-second Tiingo FX websocket pricing with Tiingo REST bootstrap and 60-second fallback recovery for the market-price bubble
- [x] **Web-safe Tiingo REST proxy recovery** now routes bootstrap and fallback REST quotes through the backend on web so browser CORS/network restrictions no longer break guide-price recovery
- [x] **TradingView render isolation** now routes chart ticks through a standalone bridge so dashboard state updates no longer force chart-container rerenders/remounts
- [x] **Persistent TradingView iframe mounting** now creates the web chart iframe once and keeps it mounted across dashboard updates so the chart stays rendered instead of reloading every few seconds
- [x] **Sandbox verification** confirmed the engine now generates signals again over the accelerated 24-hour replay
