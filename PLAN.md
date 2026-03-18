# Prioritize TradingView Chart Price for XAU/USD Signal Generation

## Overview

Make the TradingView chart price the primary live input for signal generation while the dashboard chart is active. TwelveData WebSocket remains the standby feed, and REST stays as the last-resort fallback only when no fresh live price is available.

---

### **Features**

- **TradingView chart-first pricing**: signal generation and live signal monitoring use the chart-fed price when the chart is actively publishing updates
- **WebSocket standby mode**: TwelveData still runs in the background and fills gaps whenever the chart feed goes stale or is unavailable
- **REST emergency fallback**: REST fetches remain available for bootstrap or recovery, but they no longer lead normal foreground signal generation
- **Fresh-price preference inside the engine**: the signal engine now prefers recent external live prices before making any direct fetch
- **Signal generation cadence unchanged**: the existing ML logic, confidence checks, cooldowns, and 30-second generation cadence remain intact
- **TradingView chart implementation preserved**: the existing chart stays in place, with only a lightweight price bridge added around it

---

### **How It Works (Behind the Scenes)**

1. **TradingView price bridge** extracts live price updates from the embedded chart wrapper and forwards them into the app state
2. **Dashboard context prioritization** accepts chart prices first and ignores slower TwelveData ticks while the chart feed is fresh
3. **Signal engine freshness check** uses the latest cached external price before falling back to any direct fetch path
4. **WebSocket failover** continues supplying prices when the chart is not active or stops producing fresh updates
5. **REST bootstrap/recovery** only runs when no fresh live price exists, preventing slow polling from hijacking foreground signals

---

### **What Changes**

---

### **Files Modified**

- [x] **TradingView chart wrapper** updated to forward chart-derived live price updates without replacing the chart itself
- [x] **Dashboard chart integration** updated so chart prices feed the shared trading context directly
- [x] **Dashboard context** updated to prioritize chart prices over TwelveData while the chart feed is fresh
- [x] **Signal engine** updated to prefer fresh external live prices instead of forcing slow direct refreshes during normal signal generation
- [x] **WebSocket service path** retained as standby/failover instead of being the primary foreground signal source
- [x] **REST fallback path** retained for bootstrap and recovery only
