import { fetchLiveGoldPriceFallback } from "./signalEngine";

type PriceCallback = (price: number, source: string) => void;
type StatusCallback = (status: 'connected' | 'disconnected' | 'reconnecting' | 'fallback') => void;

interface WebSocketServiceState {
  ws: WebSocket | null;
  isConnected: boolean;
  lastTickTime: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  restFallbackTimer: ReturnType<typeof setInterval> | null;
  isRestFallbackActive: boolean;
  priceCallbacks: Set<PriceCallback>;
  statusCallbacks: Set<StatusCallback>;
  reconnectAttempts: number;
  intentionallyClosed: boolean;
  lastPrice: number;
}

const HEARTBEAT_INTERVAL_MS = 10000;
const WATCHDOG_INTERVAL_MS = 5000;
const WATCHDOG_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 5000;
const REST_FALLBACK_INTERVAL_MS = 60000;
const MAX_RECONNECT_ATTEMPTS = 50;

const state: WebSocketServiceState = {
  ws: null,
  isConnected: false,
  lastTickTime: 0,
  reconnectTimer: null,
  heartbeatTimer: null,
  watchdogTimer: null,
  restFallbackTimer: null,
  isRestFallbackActive: false,
  priceCallbacks: new Set(),
  statusCallbacks: new Set(),
  reconnectAttempts: 0,
  intentionallyClosed: false,
  lastPrice: 0,
};

function getTwelveDataApiKey(): string | null {
  const publicApiKey = process.env.EXPO_PUBLIC_TWELVEDATA_API_KEY?.trim();
  const fallbackApiKey = process.env.TWELVEDATA_API_KEY?.trim();
  const apiKey = publicApiKey || fallbackApiKey || null;

  if (!apiKey) {
    console.error('❌ [GoldWS] TwelveData API key missing (checked EXPO_PUBLIC_TWELVEDATA_API_KEY and TWELVEDATA_API_KEY) — falling back to REST');
    return null;
  }

  const keySource = publicApiKey ? 'EXPO_PUBLIC_TWELVEDATA_API_KEY' : 'TWELVEDATA_API_KEY';
  console.log(`🔑 [GoldWS] Using TwelveData key from ${keySource}`);
  return apiKey;
}

function notifyPrice(price: number, source: string): void {
  state.lastPrice = price;
  state.priceCallbacks.forEach(cb => {
    try {
      cb(price, source);
    } catch (err) {
      console.error('❌ [GoldWS] Price callback error:', err);
    }
  });
}

function notifyStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'fallback'): void {
  state.statusCallbacks.forEach(cb => {
    try {
      cb(status);
    } catch (err) {
      console.error('❌ [GoldWS] Status callback error:', err);
    }
  });
}

function startHeartbeat(): void {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ action: 'heartbeat' }));
        console.log('💓 [GoldWS] Heartbeat sent');
      } catch (err) {
        console.warn('⚠️ [GoldWS] Heartbeat send failed:', err);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function killRestFallback(): void {
  if (state.restFallbackTimer) {
    clearInterval(state.restFallbackTimer);
    state.restFallbackTimer = null;
  }
  if (state.isRestFallbackActive) {
    console.log('🔄 [GoldWS] REST fallback killed — WebSocket recovered');
    state.isRestFallbackActive = false;
  }
}

function activateRestFallback(): void {
  if (state.isRestFallbackActive) return;

  state.isRestFallbackActive = true;
  console.log('⚠️ [GoldWS] WebSocket timeout — activating REST cold-standby fallback (every 60s)');
  notifyStatus('fallback');

  void fetchRestFallbackPrice();

  state.restFallbackTimer = setInterval(() => {
    void fetchRestFallbackPrice();
  }, REST_FALLBACK_INTERVAL_MS);
}

async function fetchRestFallbackPrice(): Promise<void> {
  try {
    console.log('🔄 [GoldWS] REST fallback fetch...');

    const result = await fetchLiveGoldPriceFallback();

    if (result.price > 0) {
      console.log(`✅ [GoldWS] REST fallback price: ${result.price} (${result.source})`);
      notifyPrice(result.price, `🟡 fallback-${result.source}`);
    } else {
      console.warn('⚠️ [GoldWS] REST fallback returned zero price');
    }
  } catch (err) {
    console.error('❌ [GoldWS] REST fallback error:', err);
  }
}

function startWatchdog(): void {
  stopWatchdog();
  state.watchdogTimer = setInterval(() => {
    const now = Date.now();
    const silenceDuration = now - state.lastTickTime;

    if (state.lastTickTime > 0 && silenceDuration > WATCHDOG_TIMEOUT_MS) {
      console.warn(`⚠️ [GoldWS] Watchdog: No tick for ${(silenceDuration / 1000).toFixed(1)}s`);
      activateRestFallback();
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog(): void {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

function connect(): void {
  if (state.intentionallyClosed) {
    console.log('🛑 [GoldWS] Connection intentionally closed, not reconnecting');
    return;
  }

  const apiKey = getTwelveDataApiKey();
  if (!apiKey) {
    activateRestFallback();
    return;
  }

  if (state.ws) {
    try {
      state.ws.onopen = null;
      state.ws.onmessage = null;
      state.ws.onerror = null;
      state.ws.onclose = null;
      if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
        state.ws.close();
      }
    } catch (e) {
      console.warn('⚠️ [GoldWS] Error closing old socket:', e);
    }
    state.ws = null;
  }

  const wsUrl = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${apiKey}`;
  console.log('🔌 [GoldWS] Connecting to TwelveData WebSocket...');
  notifyStatus('reconnecting');

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('❌ [GoldWS] WebSocket constructor failed:', err);
    scheduleReconnect();
    return;
  }

  state.ws.onopen = () => {
    console.log('✅ [GoldWS] WebSocket connected');
    state.isConnected = true;
    state.reconnectAttempts = 0;
    state.lastTickTime = Date.now();
    notifyStatus('connected');

    const subscribeMsg = JSON.stringify({
      action: 'subscribe',
      params: { symbols: 'XAU/USD' },
    });

    try {
      state.ws?.send(subscribeMsg);
      console.log('📡 [GoldWS] Subscribed to XAU/USD');
    } catch (err) {
      console.error('❌ [GoldWS] Subscribe send failed:', err);
    }

    startHeartbeat();
    startWatchdog();
  };

  state.ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(typeof event.data === 'string' ? event.data : '');

      if (data.event === 'price' && data.symbol === 'XAU/USD') {
        const parsedPrice = typeof data.price === 'number'
          ? data.price
          : parseFloat(String(data.price ?? ''));

        if (isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
          console.warn(`⚠️ [GoldWS] Invalid price tick: ${data.price}`);
          return;
        }

        state.lastTickTime = Date.now();

        killRestFallback();

        notifyPrice(parsedPrice, '🟢 twelvedata-ws');

        if (state.lastTickTime % 10000 < 2000) {
          console.log(`📈 [GoldWS] XAU/USD: ${parsedPrice.toFixed(3)}`);
        }
      } else if (data.event === 'subscribe-status') {
        console.log(`📡 [GoldWS] Subscription status: ${data.status}`);
        if (data.status === 'ok') {
          console.log('✅ [GoldWS] XAU/USD subscription confirmed');
        }
      } else if (data.event === 'heartbeat') {
        state.lastTickTime = Date.now();
      } else if (data.status === 'error') {
        console.error(`❌ [GoldWS] Server error: ${data.message || JSON.stringify(data)}`);
      }
    } catch (err) {
      console.warn('⚠️ [GoldWS] Failed to parse message:', err);
    }
  };

  state.ws.onerror = (event: Event) => {
    console.error('❌ [GoldWS] WebSocket error:', event);
    state.isConnected = false;
  };

  state.ws.onclose = (event: CloseEvent) => {
    console.log(`🔌 [GoldWS] WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);
    state.isConnected = false;
    stopHeartbeat();
    notifyStatus('disconnected');

    if (!state.intentionallyClosed) {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
  }

  state.reconnectAttempts++;

  if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ [GoldWS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — staying on REST fallback`);
    activateRestFallback();
    return;
  }

  const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, Math.min(state.reconnectAttempts - 1, 5)), 30000);
  console.log(`🔄 [GoldWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  state.reconnectTimer = setTimeout(() => {
    connect();
  }, delay);
}

export const goldWebSocketService = {
  start(): void {
    state.intentionallyClosed = false;
    state.reconnectAttempts = 0;
    connect();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping WebSocket service');
    state.intentionallyClosed = true;
    stopHeartbeat();
    stopWatchdog();
    killRestFallback();

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    if (state.ws) {
      try {
        state.ws.onopen = null;
        state.ws.onmessage = null;
        state.ws.onerror = null;
        state.ws.onclose = null;
        if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
          state.ws.close();
        }
      } catch (e) {
        console.warn('⚠️ [GoldWS] Error closing socket:', e);
      }
      state.ws = null;
    }

    state.isConnected = false;
    notifyStatus('disconnected');
  },

  onPrice(callback: PriceCallback): () => void {
    state.priceCallbacks.add(callback);
    return () => {
      state.priceCallbacks.delete(callback);
    };
  },

  onStatus(callback: StatusCallback): () => void {
    state.statusCallbacks.add(callback);
    return () => {
      state.statusCallbacks.delete(callback);
    };
  },

  isConnected(): boolean {
    return state.isConnected;
  },

  isRestFallbackActive(): boolean {
    return state.isRestFallbackActive;
  },

  getLastPrice(): number {
    return state.lastPrice;
  },

  getLastTickTime(): number {
    return state.lastTickTime;
  },
};
