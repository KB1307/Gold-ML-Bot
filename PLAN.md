# Replace REST Polling with WebSocket Live Price Feed for XAU/USD

## Overview

Switch the gold price data source from REST API polling (every 10 seconds) to a persistent WebSocket connection using TwelveData, with a cold-standby REST fallback if the WebSocket goes silent.

---

### **Features**

- **Live WebSocket price feed**: The app connects to TwelveData's WebSocket and receives XAU/USD price ticks in real-time (~1 second frequency)
- **Automatic reconnection**: If the WebSocket drops, it automatically reconnects after 5 seconds
- **Heartbeat health check**: A 10-second heartbeat monitor verifies socket health and forces reconnect/fallback when the transport becomes inactive
- **Cold-standby REST fallback**: If no WebSocket message arrives for 30 seconds, the existing REST polling activates at a low frequency (once per 60 seconds) as a placeholder
- **Instant recovery**: When the WebSocket reconnects and delivers its first tick, REST polling is immediately killed to prevent duplicate data
- **Price source indicator**: The dashboard shows "🟢 twelvedata-ws" when live, or the REST source name when in fallback mode
- **Signal generation unchanged**: Signal checks still run every 30 seconds on their existing interval — the WebSocket only feeds price data more frequently
- **ML logic untouched**: No changes to the machine learning, signal analysis, breakeven, or TradingView chart logic

---

### **How It Works (Behind the Scenes)**

1. **New WebSocket service** created that manages the TwelveData connection lifecycle (connect, subscribe to XAU/USD, heartbeat health checks, reconnect)
2. **Price update loop replaced**: The current 10-second REST polling interval in the dashboard is replaced by the WebSocket's `onmessage` handler pushing prices directly into the signal engine
3. **Watchdog timer**: A 30-second watchdog monitors WebSocket health — if no tick arrives, REST fallback activates; once WebSocket recovers, REST is killed
4. **Existing REST fetch functions** are kept intact but demoted to "failover-only" duty — they only activate when the WebSocket is confirmed down
5. **Price precision**: All incoming prices parsed with `parseFloat()` and formatted to 2 decimal places for XAU/USD tick accuracy

---

### **What Changes**

---

### **Files Modified**

- [x] **New service file** for WebSocket connection management (connect, subscribe, heartbeat, reconnect, watchdog)
- [x] **Price engine integration** updated to receive prices from WebSocket instead of REST polling
- [x] **Dashboard context** updated to use WebSocket-driven price updates with REST cold-standby fallback
- [x] **Environment variable** `EXPO_PUBLIC_TWELVEDATA_API_KEY` used for the WebSocket connection string
- [x] **Root layout web boot guard** added to avoid duplicate provider/render hydration issues in the web preview
- [x] **TradingView chart wrapper** stabilized to avoid DOM teardown errors on web while keeping the same chart source

