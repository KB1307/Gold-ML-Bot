export type ChartPriceListener = (price: number, source: string) => void;
export type ChartHeartbeatListener = (isAlive: boolean, lastPriceAt: number, lastPrice: number) => void;

const chartPriceListeners = new Set<ChartPriceListener>();
const chartHeartbeatListeners = new Set<ChartHeartbeatListener>();

let lastChartPrice = 0;
let lastChartPriceAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const CHART_HEARTBEAT_INTERVAL_MS = 3000;
const CHART_ALIVE_THRESHOLD_MS = 10000;

function isValidChartPrice(price: number): boolean {
  return Number.isFinite(price) && price > 1000 && price < 10000;
}

function notifyHeartbeat(): void {
  const now = Date.now();
  const isAlive = lastChartPriceAt > 0 && (now - lastChartPriceAt) < CHART_ALIVE_THRESHOLD_MS;

  chartHeartbeatListeners.forEach((listener) => {
    try {
      listener(isAlive, lastChartPriceAt, lastChartPrice);
    } catch (error) {
      console.error('[ChartPriceBridge] Heartbeat listener error:', error);
    }
  });
}

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    notifyHeartbeat();
  }, CHART_HEARTBEAT_INTERVAL_MS);
  console.log(`[ChartPriceBridge] Heartbeat monitor started (interval=${CHART_HEARTBEAT_INTERVAL_MS}ms, threshold=${CHART_ALIVE_THRESHOLD_MS}ms)`);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

export function publishChartPrice(price: number, source: string = 'tradingview-chart'): void {
  if (!isValidChartPrice(price)) {
    console.warn(`[ChartPriceBridge] Ignoring invalid chart price: ${price}`);
    return;
  }

  const normalizedPrice = Number(price.toFixed(2));
  lastChartPrice = normalizedPrice;
  lastChartPriceAt = Date.now();

  chartPriceListeners.forEach((listener) => {
    try {
      listener(normalizedPrice, source);
    } catch (error) {
      console.error('[ChartPriceBridge] Listener error:', error);
    }
  });
}

export function subscribeToChartPrice(listener: ChartPriceListener): () => void {
  chartPriceListeners.add(listener);
  ensureHeartbeat();
  console.log(`[ChartPriceBridge] Price subscriber connected. Total: ${chartPriceListeners.size}`);

  return () => {
    chartPriceListeners.delete(listener);
    console.log(`[ChartPriceBridge] Price subscriber removed. Total: ${chartPriceListeners.size}`);
    if (chartPriceListeners.size === 0 && chartHeartbeatListeners.size === 0) {
      stopHeartbeat();
    }
  };
}

export function subscribeToChartHeartbeat(listener: ChartHeartbeatListener): () => void {
  chartHeartbeatListeners.add(listener);
  ensureHeartbeat();
  console.log(`[ChartPriceBridge] Heartbeat subscriber connected. Total: ${chartHeartbeatListeners.size}`);

  if (lastChartPriceAt > 0) {
    const now = Date.now();
    const isAlive = (now - lastChartPriceAt) < CHART_ALIVE_THRESHOLD_MS;
    try {
      listener(isAlive, lastChartPriceAt, lastChartPrice);
    } catch (error) {
      console.error('[ChartPriceBridge] Immediate heartbeat callback error:', error);
    }
  }

  return () => {
    chartHeartbeatListeners.delete(listener);
    console.log(`[ChartPriceBridge] Heartbeat subscriber removed. Total: ${chartHeartbeatListeners.size}`);
    if (chartPriceListeners.size === 0 && chartHeartbeatListeners.size === 0) {
      stopHeartbeat();
    }
  };
}

export function getChartPriceStatus(): { lastPrice: number; lastPriceAt: number; isAlive: boolean } {
  const now = Date.now();
  return {
    lastPrice: lastChartPrice,
    lastPriceAt: lastChartPriceAt,
    isAlive: lastChartPriceAt > 0 && (now - lastChartPriceAt) < CHART_ALIVE_THRESHOLD_MS,
  };
}
