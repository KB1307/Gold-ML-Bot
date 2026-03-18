# Keep TradingView Chart Price as the Signal Driver for XAU/USD

## Overview

Make the TradingView chart price the primary live input for signal generation and live signal monitoring. TwelveData WebSocket remains available as a separate live market-price feed for the dashboard bubble, while direct fetch and REST recovery paths stay available only when the engine needs a non-WebSocket refresh.

---

### **Features**

- **TradingView chart-first pricing**: signal generation and active signal monitoring use the chart-fed price path when chart updates are available
- **TwelveData guide-only feed**: TwelveData remains available as a fast secondary indicator in app state, but it does not drive signal generation
- **REST/direct recovery path**: direct price refresh paths remain available for bootstrap and recovery when the engine needs a non-chart update
- **Fresh-price preference inside the engine**: the signal engine still prefers fresh external prices before making any direct fetch
- **Signal generation cadence unchanged**: the existing ML logic, confidence checks, cooldowns, and 30-second generation cadence remain intact
- **TradingView chart implementation preserved**: the existing chart stays in place, with only a lightweight price bridge added around it

---

### **How It Works (Behind the Scenes)**

1. **TradingView price bridge** extracts live price updates from the embedded chart wrapper and forwards them into the signal path
2. **Dashboard context split** keeps chart price on the signal-driving path while storing TwelveData separately for the dashboard market-price display
3. **Signal engine freshness check** uses the latest chart-fed external price before falling back to any direct fetch path
4. **TwelveData indicator stream** continues updating the separate guide-price path and powers the dashboard market price bubble without influencing signal generation
5. **REST bootstrap/recovery** only runs when the engine has no fresh signal-driving live price, preventing slower guide feeds from hijacking foreground signals

---

### **What Changes**

---

### **Files Modified**

- [x] **TradingView chart wrapper** updated to forward chart-derived live price updates without replacing the chart itself
- [x] **Dashboard chart integration** updated so chart prices feed the shared trading context directly
- [x] **Dashboard context** updated to keep TwelveData on a separate live-display path so it powers the dashboard market price label without affecting signal generation
- [x] **Signal engine** updated to keep preferring fresh signal-driving live prices instead of forcing slow direct refreshes during normal signal generation
- [x] **WebSocket service path** retained for guide pricing and recovery support rather than foreground signal generation
- [x] **REST/direct recovery path** retained for bootstrap and recovery only
