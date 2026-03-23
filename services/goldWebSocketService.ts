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
  backendBaseUrl: string;
}

const POLL_INTERVAL_MS = 2000;
const WATCHDOG_INTERVAL_MS = 6000;
const STALE_THRESHOLD_MS = 15000;
const BACKOFF_BASE_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const FETCH_TIMEOUT_MS = 8000;

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
  backendBaseUrl: '',
};

function resolveBackendBaseUrl(): string {
  if (state.backendBaseUrl.length > 0) return state.backendBaseUrl;

  const configured = process.env.EXPO_PUBLIC_RORK_API_BASE_URL;
  if (configured) {
    const trimmed = configured.trim().replace(/\/+$/, '');
    state.backendBaseUrl = trimmed.endsWith('/api/trpc')
      ? trimmed
      : trimmed.endsWith('/api')
        ? `${trimmed}/trpc`
        : `${trimmed}/api/trpc`;
    console.log(`🔗 [GoldWS] Backend base URL resolved: ${state.backendBaseUrl}`);
    return state.backendBaseUrl;
  }

  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    state.backendBaseUrl = `${window.location.origin}/api/trpc`;
    console.log(`🔗 [GoldWS] Backend base URL from window: ${state.backendBaseUrl}`);
    return state.backendBaseUrl;
  }

  state.backendBaseUrl = '/api/trpc';
  return state.backendBaseUrl;
}

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

async function fetchBackendLivePrice(): Promise<{ price: number; source: string } | null> {
  try {
    const baseUrl = resolveBackendBaseUrl();
    const url = `${baseUrl}/goldPrice.getLivePrice`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    console.log(`🔄 [GoldWS] Fetching live price via backend proxy...`);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`⚠️ [GoldWS] Backend proxy HTTP ${response.status}`);
      return null;
    }

    const rawBody = await response.text();
    let data: unknown = null;

    try {
      data = JSON.parse(rawBody);
    } catch {
      const firstBrace = rawBody.indexOf('{');
      const lastBrace = rawBody.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          data = JSON.parse(rawBody.slice(firstBrace, lastBrace + 1));
        } catch {
          console.warn('⚠️ [GoldWS] Backend response parse failed');
          return null;
        }
      }
    }

    if (!data || typeof data !== 'object') return null;

    const record = data as Record<string, unknown>;
    let price = 0;
    let source = 'backend-proxy';

    const resultData = record.result as Record<string, unknown> | undefined;
    if (resultData?.data) {
      const innerData = resultData.data as Record<string, unknown>;
      if (innerData?.json) {
        const json = innerData.json as Record<string, unknown>;
        price = typeof json.price === 'number' ? json.price : 0;
        source = typeof json.source === 'string' ? json.source : 'backend-proxy';
      } else {
        price = typeof innerData.price === 'number' ? innerData.price : 0;
        source = typeof innerData.source === 'string' ? innerData.source : 'backend-proxy';
      }
    } else if (typeof record.price === 'number') {
      price = record.price;
      source = typeof record.source === 'string' ? record.source : 'backend-proxy';
    }

    if (price > 1000 && price < 10000) {
      return { price: Number(price.toFixed(2)), source };
    }

    console.warn('⚠️ [GoldWS] Backend returned invalid price:', price);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown';
    if (!msg.includes('abort')) {
      console.warn(`⚠️ [GoldWS] Backend proxy fetch failed: ${msg}`);
    }
    return null;
  }
}

async function fetchBackendSpotPrice(): Promise<{ price: number; source: string } | null> {
  try {
    const baseUrl = resolveBackendBaseUrl();
    const url = `${baseUrl}/goldPrice.getSpotPrice`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const rawBody = await response.text();
    let data: unknown = null;

    try {
      data = JSON.parse(rawBody);
    } catch {
      const firstBrace = rawBody.indexOf('{');
      const lastBrace = rawBody.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          data = JSON.parse(rawBody.slice(firstBrace, lastBrace + 1));
        } catch {
          return null;
        }
      }
    }

    if (!data || typeof data !== 'object') return null;

    const record = data as Record<string, unknown>;
    let price = 0;
    let source = 'backend-spot';

    const resultData = record.result as Record<string, unknown> | undefined;
    if (resultData?.data) {
      const innerData = resultData.data as Record<string, unknown>;
      if (innerData?.json) {
        const json = innerData.json as Record<string, unknown>;
        price = typeof json.price === 'number' ? json.price : 0;
        source = typeof json.source === 'string' ? json.source : 'backend-spot';
      } else {
        price = typeof innerData.price === 'number' ? innerData.price : 0;
        source = typeof innerData.source === 'string' ? innerData.source : 'backend-spot';
      }
    } else if (typeof record.price === 'number') {
      price = record.price;
      source = typeof record.source === 'string' ? record.source : 'backend-spot';
    }

    if (price > 1000 && price < 10000) {
      return { price: Number(price.toFixed(2)), source };
    }

    return null;
  } catch {
    return null;
  }
}

async function pollPrice(): Promise<void> {
  if (state.intentionallyClosed || state.isPolling) return;

  state.isPolling = true;
  state.totalPolls += 1;

  try {
    const result = await fetchBackendLivePrice();

    if (state.intentionallyClosed) return;

    if (result) {
      state.consecutiveFailures = 0;
      state.totalSuccesses += 1;
      state.restFallbackActive = false;
      const displaySource = result.source.includes('swissquote') ? '🟢 Swissquote-Live' : `🟢 ${result.source}`;
      notifyPrice(result.price, displaySource);
      notifyStatus('connected');

      if (state.totalSuccesses % 30 === 0) {
        console.log(`⚡ [GoldWS] ${result.price.toFixed(2)} via ${result.source} | polls:${state.totalPolls} ok:${state.totalSuccesses} fails:${state.consecutiveFailures}`);
      }
      return;
    }

    state.consecutiveFailures += 1;
    console.warn(`⚠️ [GoldWS] Backend poll failed (streak: ${state.consecutiveFailures})`);

    if (state.consecutiveFailures >= 2) {
      state.restFallbackActive = true;
      notifyStatus('reconnecting');

      console.log('🔄 [GoldWS] Attempting fallback via getSpotPrice...');
      const fallback = await fetchBackendSpotPrice();
      if (fallback && !state.intentionallyClosed) {
        notifyPrice(fallback.price, `🟠 ${fallback.source} (fallback)`);
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

  console.log(`🚀 [GoldWS] Starting backend-proxied price polling (interval=${POLL_INTERVAL_MS}ms)...`);
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
      console.log('ℹ️ [GoldWS] Price service already active, skipping duplicate start');
      return;
    }

    state.intentionallyClosed = false;
    state.startTime = Date.now();
    state.consecutiveFailures = 0;
    state.totalPolls = 0;
    state.totalSuccesses = 0;
    state.restFallbackActive = false;
    state.backendBaseUrl = '';
    console.log('🚀 [GoldWS] Starting XAU/USD price service via backend proxy (CORS-safe)...');

    startPolling();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping price service');
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
