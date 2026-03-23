type PriceCallback = (price: number, source: string) => void;
type ConnectionStatus = 'connected' | 'waiting_for_trade' | 'disconnected' | 'reconnecting';
type StatusCallback = (status: ConnectionStatus) => void;

interface ServiceState {
  priceCallbacks: Set<PriceCallback>;
  statusCallbacks: Set<StatusCallback>;
  intentionallyClosed: boolean;
  lastPrice: number;
  lastPriceSource: string;
  currentStatus: ConnectionStatus;
  lastTickTime: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  startTime: number;
  consecutiveFailures: number;
  totalPolls: number;
  totalSuccesses: number;
  isPolling: boolean;
  restFallbackActive: boolean;
}

const SWISSQUOTE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';
const SWISSQUOTE_SOURCE = '🟢 Swissquote-Live';
const POLL_INTERVAL_MS = 1500;
const WATCHDOG_INTERVAL_MS = 5000;
const STALE_THRESHOLD_MS = 15000;
const BACKOFF_BASE_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const FETCH_TIMEOUT_MS = 6000;

const state: ServiceState = {
  priceCallbacks: new Set(),
  statusCallbacks: new Set(),
  intentionallyClosed: false,
  lastPrice: 0,
  lastPriceSource: 'connecting...',
  currentStatus: 'disconnected',
  lastTickTime: 0,
  pollTimer: null,
  watchdogTimer: null,
  startTime: 0,
  consecutiveFailures: 0,
  totalPolls: 0,
  totalSuccesses: 0,
  isPolling: false,
  restFallbackActive: false,
};

function notifyPrice(price: number, source: string): void {
  state.lastPrice = price;
  state.lastPriceSource = source;
  state.lastTickTime = Date.now();

  state.priceCallbacks.forEach((callback) => {
    try {
      callback(price, source);
    } catch (error) {
      console.error('❌ [GoldWS] Price callback error:', error);
    }
  });
}

function notifyStatus(status: ConnectionStatus): void {
  if (state.currentStatus === status) return;
  state.currentStatus = status;

  state.statusCallbacks.forEach((callback) => {
    try {
      callback(status);
    } catch (error) {
      console.error('❌ [GoldWS] Status callback error:', error);
    }
  });
}

function getBackoffDelay(): number {
  if (state.consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(1.5, state.consecutiveFailures - 1), MAX_BACKOFF_MS);
  return delay;
}

async function fetchSwissquotePrice(): Promise<{ price: number; source: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(SWISSQUOTE_URL, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`⚠️ [GoldWS] Swissquote HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      const quote = data[0];
      const spreadProfiles = quote?.spreadProfilePrices;
      if (Array.isArray(spreadProfiles) && spreadProfiles.length > 0) {
        const bid = spreadProfiles[0]?.bid;
        const ask = spreadProfiles[0]?.ask;
        if (typeof bid === 'number' && typeof ask === 'number' && bid > 1000 && ask > 1000) {
          const price = Number(((bid + ask) / 2).toFixed(2));
          return { price, source: SWISSQUOTE_SOURCE };
        }
      }
    }

    console.warn('⚠️ [GoldWS] Swissquote returned unexpected data shape');
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown';
    if (!msg.includes('abort')) {
      console.warn(`⚠️ [GoldWS] Swissquote fetch failed: ${msg}`);
    }
    return null;
  }
}

async function fetchMetalsLivePrice(): Promise<{ price: number; source: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch('https://api.metals.live/v1/spot/gold', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data?.[0]?.price) {
        const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
        if (price > 1000 && price < 10000) {
          return { price, source: '🟠 MetalsLive-Fallback' };
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS] metals.live fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchGoldPriceOrg(): Promise<{ price: number; source: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data?.items?.[0]?.xauPrice) {
        const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
        if (price > 1000 && price < 10000) {
          return { price, source: '🟠 GoldPrice-Fallback' };
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS] goldprice.org fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchTiingoRestPrice(): Promise<{ price: number; source: string } | null> {
  const apiKey = process.env.EXPO_PUBLIC_TIINGO_API_KEY?.trim() ?? '';
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(
      `https://api.tiingo.com/tiingo/fx/top?tickers=xauusd&token=${encodeURIComponent(apiKey)}`,
      { signal: controller.signal, headers: { 'Accept': 'application/json' } }
    );
    clearTimeout(timeoutId);
    if (response.ok) {
      const payload = await response.json();
      const quote = Array.isArray(payload) ? payload[0] : payload;
      const mid = typeof quote?.midPrice === 'number' ? quote.midPrice : parseFloat(String(quote?.midPrice ?? ''));
      if (Number.isFinite(mid) && mid > 1000 && mid < 10000) {
        return { price: Number(mid.toFixed(2)), source: '🟠 Tiingo-Fallback' };
      }
      const bid = typeof quote?.bidPrice === 'number' ? quote.bidPrice : parseFloat(String(quote?.bidPrice ?? ''));
      const ask = typeof quote?.askPrice === 'number' ? quote.askPrice : parseFloat(String(quote?.askPrice ?? ''));
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 1000 && ask > 1000) {
        return { price: Number(((bid + ask) / 2).toFixed(2)), source: '🟠 Tiingo-Fallback' };
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS] Tiingo REST fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchFallbackPrice(): Promise<{ price: number; source: string } | null> {
  const metalsResult = await fetchMetalsLivePrice();
  if (metalsResult) return metalsResult;

  const tiingoResult = await fetchTiingoRestPrice();
  if (tiingoResult) return tiingoResult;

  const goldPriceResult = await fetchGoldPriceOrg();
  if (goldPriceResult) return goldPriceResult;

  return null;
}

async function pollPrice(): Promise<void> {
  if (state.intentionallyClosed || state.isPolling) return;

  state.isPolling = true;
  state.totalPolls += 1;

  try {
    const result = await fetchSwissquotePrice();

    if (state.intentionallyClosed) return;

    if (result) {
      state.consecutiveFailures = 0;
      state.totalSuccesses += 1;
      state.restFallbackActive = false;
      notifyPrice(result.price, result.source);
      notifyStatus('connected');

      if (state.totalSuccesses % 40 === 0) {
        console.log(`⚡ [GoldWS] Swissquote ${result.price.toFixed(2)} | polls:${state.totalPolls} ok:${state.totalSuccesses} fails:${state.consecutiveFailures}`);
      }
      return;
    }

    state.consecutiveFailures += 1;
    console.warn(`⚠️ [GoldWS] Swissquote poll failed (streak: ${state.consecutiveFailures})`);

    if (state.consecutiveFailures >= 2) {
      state.restFallbackActive = true;
      notifyStatus('reconnecting');

      console.log('🔄 [GoldWS] Attempting fallback price sources...');
      const fallback = await fetchFallbackPrice();
      if (fallback && !state.intentionallyClosed) {
        notifyPrice(fallback.price, fallback.source);
        notifyStatus('connected');
        console.log(`✅ [GoldWS] Fallback price: ${fallback.price} from ${fallback.source}`);
      }
    } else {
      if (state.lastPrice <= 0) {
        notifyStatus('waiting_for_trade');
      }
    }
  } catch (error) {
    state.consecutiveFailures += 1;
    console.error('❌ [GoldWS] Poll error:', error);
  } finally {
    state.isPolling = false;
  }
}

function startPolling(): void {
  stopPolling();

  console.log(`🚀 [GoldWS] Starting Swissquote price polling (interval=${POLL_INTERVAL_MS}ms)...`);
  notifyStatus('reconnecting');

  void pollPrice();

  state.pollTimer = setInterval(() => {
    const delay = getBackoffDelay();
    if (delay > POLL_INTERVAL_MS && state.consecutiveFailures > 0) {
      return;
    }
    void pollPrice();
  }, POLL_INTERVAL_MS);

  startWatchdog();
}

function stopPolling(): void {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startWatchdog(): void {
  stopWatchdog();

  state.watchdogTimer = setInterval(() => {
    if (state.intentionallyClosed) return;

    const now = Date.now();
    const timeSinceLastPrice = state.lastTickTime > 0 ? now - state.lastTickTime : (state.startTime > 0 ? now - state.startTime : 0);

    if (timeSinceLastPrice > STALE_THRESHOLD_MS && state.startTime > 0) {
      console.warn(`⚠️ [GoldWS] No price for ${(timeSinceLastPrice / 1000).toFixed(1)}s — triggering immediate poll`);

      if (state.consecutiveFailures > 3) {
        stopPolling();
        const backoff = getBackoffDelay();
        console.log(`🔄 [GoldWS] Restarting polling with backoff ${(backoff / 1000).toFixed(1)}s after ${state.consecutiveFailures} failures`);

        setTimeout(() => {
          if (!state.intentionallyClosed) {
            state.consecutiveFailures = Math.max(0, state.consecutiveFailures - 2);
            startPolling();
          }
        }, backoff);
        return;
      }

      void pollPrice();
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

export const goldWebSocketService = {
  start(): void {
    if (state.pollTimer) {
      console.log('ℹ️ [GoldWS] Swissquote price service already active, skipping duplicate start');
      return;
    }

    state.intentionallyClosed = false;
    state.startTime = Date.now();
    state.consecutiveFailures = 0;
    state.totalPolls = 0;
    state.totalSuccesses = 0;
    state.restFallbackActive = false;
    console.log('🚀 [GoldWS] Starting Swissquote XAU/USD price service (no API key required)...');

    startPolling();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping Swissquote price service');
    state.intentionallyClosed = true;
    stopPolling();
    stopWatchdog();
    state.lastTickTime = 0;
    state.startTime = 0;
    state.isPolling = false;
    notifyStatus('disconnected');
  },

  onPrice(callback: PriceCallback): () => void {
    state.priceCallbacks.add(callback);

    if (state.lastPrice > 0) {
      try {
        callback(state.lastPrice, state.lastPriceSource);
      } catch (error) {
        console.error('❌ [GoldWS] Immediate price callback error:', error);
      }
    }

    return () => {
      state.priceCallbacks.delete(callback);
    };
  },

  onStatus(callback: StatusCallback): () => void {
    state.statusCallbacks.add(callback);

    try {
      callback(state.currentStatus);
    } catch (error) {
      console.error('❌ [GoldWS] Immediate status callback error:', error);
    }

    return () => {
      state.statusCallbacks.delete(callback);
    };
  },

  isConnected(): boolean {
    return state.currentStatus === 'connected';
  },

  isRestFallbackActive(): boolean {
    return state.restFallbackActive;
  },

  getLastPrice(): number {
    return state.lastPrice;
  },

  getLastPriceSource(): string {
    return state.lastPriceSource;
  },

  getStatus(): ConnectionStatus {
    return state.currentStatus;
  },

  getLastTickTime(): number {
    return state.lastTickTime;
  },
};
