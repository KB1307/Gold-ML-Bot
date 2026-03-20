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
  lastPriceSource: string;
  currentStatus: 'connected' | 'disconnected' | 'reconnecting' | 'fallback';
  connectionId: number;
  lastBootstrapFetchAt: number;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_TIMEOUT_MS = 6000;
const RECONNECT_DELAY_MS = 1500;
const REST_FALLBACK_INTERVAL_MS = 3000;
const TWELVEDATA_BOOTSTRAP_INTERVAL_MS = 1000;
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
  lastPriceSource: 'connecting...',
  currentStatus: 'disconnected',
  connectionId: 0,
  lastBootstrapFetchAt: 0,
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
  state.lastPriceSource = source;
  state.priceCallbacks.forEach(cb => {
    try {
      cb(price, source);
    } catch (err) {
      console.error('❌ [GoldWS] Price callback error:', err);
    }
  });
}

function notifyStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'fallback'): void {
  state.currentStatus = status;
  state.statusCallbacks.forEach(cb => {
    try {
      cb(status);
    } catch (err) {
      console.error('❌ [GoldWS] Status callback error:', err);
    }
  });
}

function getReadyStateLabel(readyState: number | undefined): string {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return 'CONNECTING';
    case WebSocket.OPEN:
      return 'OPEN';
    case WebSocket.CLOSING:
      return 'CLOSING';
    case WebSocket.CLOSED:
      return 'CLOSED';
    default:
      return 'UNKNOWN';
  }
}

function getEventDiagnostics(event: Event | CloseEvent | MessageEvent | undefined, socket: WebSocket | null, connectionId: number): Record<string, unknown> {
  const target = socket ?? (event?.target instanceof WebSocket ? event.target : null);
  const diagnostics: Record<string, unknown> = {
    connectionId,
    eventType: event?.type ?? 'unknown',
    readyState: target ? getReadyStateLabel(target.readyState) : 'UNKNOWN',
    url: target?.url ?? 'unknown',
    online: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
    timestamp: new Date().toISOString(),
  };

  if (event && 'code' in event) {
    diagnostics.code = event.code;
    diagnostics.reason = event.reason || 'none';
    diagnostics.wasClean = event.wasClean;
  }

  if (event && 'data' in event && typeof event.data === 'string') {
    diagnostics.data = event.data.slice(0, 200);
  }

  return diagnostics;
}

function startHeartbeat(): void {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    const socket = state.ws;
    const readyState = socket?.readyState;
    const silenceDuration = state.lastTickTime > 0 ? Date.now() - state.lastTickTime : 0;

    console.log(`💓 [GoldWS] Heartbeat check | state=${getReadyStateLabel(readyState)} | silence=${(silenceDuration / 1000).toFixed(1)}s`);

    if (!socket || (readyState !== WebSocket.OPEN && readyState !== WebSocket.CONNECTING)) {
      console.warn('⚠️ [GoldWS] Heartbeat detected inactive socket — forcing reconnect');
      activateRestFallback();
      scheduleReconnect();
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
  console.log(`⚠️ [GoldWS] WebSocket timeout — activating REST cold-standby fallback (every ${(REST_FALLBACK_INTERVAL_MS / 1000).toFixed(0)}s)`);
  notifyStatus('fallback');

  void fetchRestFallbackPrice();

  state.restFallbackTimer = setInterval(() => {
    void fetchRestFallbackPrice();
  }, REST_FALLBACK_INTERVAL_MS);
}

async function fetchTwelveDataBootstrapPrice(apiKey: string, reason: string): Promise<void> {
  const now = Date.now();
  if ((now - state.lastBootstrapFetchAt) < TWELVEDATA_BOOTSTRAP_INTERVAL_MS) {
    return;
  }

  state.lastBootstrapFetchAt = now;

  try {
    console.log(`🟢 [GoldWS] TwelveData REST bootstrap (${reason})...`);
    const response = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${encodeURIComponent(apiKey)}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`⚠️ [GoldWS] TwelveData REST bootstrap failed with ${response.status}`);
      return;
    }

    const data = await response.json() as { price?: number | string; status?: string; message?: string };
    const parsedPrice = typeof data.price === 'number'
      ? data.price
      : parseFloat(String(data.price ?? ''));

    if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
      console.warn('⚠️ [GoldWS] TwelveData REST bootstrap returned invalid price', data);
      return;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] TwelveData REST bootstrap price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, '🟢 twelvedata live');
  } catch (err) {
    console.warn(`⚠️ [GoldWS] TwelveData REST bootstrap error (${reason}):`, err);
  }
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
  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  console.log(`🔌 [GoldWS] Connecting to TwelveData WebSocket (connection ${connectionId})...`);
  notifyStatus('reconnecting');
  void fetchTwelveDataBootstrapPrice(apiKey, `connection-${connectionId}`);

  try {
    state.ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error('❌ [GoldWS] WebSocket constructor failed:', err);
    scheduleReconnect();
    return;
  }

  const socket = state.ws;

  socket.onopen = () => {
    if (state.ws !== socket) {
      console.log(`ℹ️ [GoldWS] Ignoring stale onopen for connection ${connectionId}`);
      return;
    }

    console.log(`✅ [GoldWS] WebSocket connected (connection ${connectionId})`);
    state.isConnected = true;
    state.reconnectAttempts = 0;
    state.lastTickTime = Date.now();
    notifyStatus('connected');

    const subscribeMsg = JSON.stringify({
      action: 'subscribe',
      params: { symbols: 'XAU/USD' },
    });

    try {
      socket.send(subscribeMsg);
      console.log(`📡 [GoldWS] Subscribed to XAU/USD (connection ${connectionId})`);
    } catch (err) {
      console.error('❌ [GoldWS] Subscribe send failed:', err);
    }

    startHeartbeat();
    startWatchdog();
  };

  socket.onmessage = (event: MessageEvent) => {
    if (state.ws !== socket) {
      return;
    }

    try {
      const rawData = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      const data = JSON.parse(rawData);

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

        notifyPrice(Number(parsedPrice.toFixed(2)), '🟢 twelvedata live');

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

  socket.onerror = (event: Event) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.warn('⚠️ [GoldWS] WebSocket transport issue detected; waiting for close event', diagnostics);
    state.isConnected = false;
    notifyStatus('disconnected');
  };

  socket.onclose = (event: CloseEvent) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.log('🔌 [GoldWS] WebSocket closed', diagnostics);
    state.isConnected = false;
    state.ws = null;
    stopHeartbeat();
    stopWatchdog();
    notifyStatus('disconnected');

    if (!state.intentionallyClosed) {
      activateRestFallback();
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
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      console.log('ℹ️ [GoldWS] WebSocket service already active, skipping duplicate start');
      return;
    }

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

    state.lastTickTime = 0;

    state.isConnected = false;
    notifyStatus('disconnected');
  },

  onPrice(callback: PriceCallback): () => void {
    state.priceCallbacks.add(callback);

    if (state.lastPrice > 0) {
      try {
        callback(state.lastPrice, state.lastPriceSource);
      } catch (err) {
        console.error('❌ [GoldWS] Immediate price callback error:', err);
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
    } catch (err) {
      console.error('❌ [GoldWS] Immediate status callback error:', err);
    }

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

  getLastPriceSource(): string {
    return state.lastPriceSource;
  },

  getStatus(): 'connected' | 'disconnected' | 'reconnecting' | 'fallback' {
    return state.currentStatus;
  },

  getLastTickTime(): number {
    return state.lastTickTime;
  },
};
