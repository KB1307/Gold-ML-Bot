type PriceCallback = (price: number, source: string) => void;
type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | 'fallback';
type StatusCallback = (status: ConnectionStatus) => void;

type TiingoRestQuote = {
  ticker?: string;
  midPrice?: number | string | null;
  bidPrice?: number | string | null;
  askPrice?: number | string | null;
  quoteTimestamp?: string;
};

type TiingoWebSocketMessage = {
  service?: string;
  messageType?: string;
  data?: unknown;
  response?: string;
  eventName?: string;
  error?: string;
  detail?: string;
};

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
  currentStatus: ConnectionStatus;
  connectionId: number;
  lastBootstrapFetchAt: number;
  apiKey: string | null;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_TIMEOUT_MS = 30000;
const RECONNECT_DELAY_MS = 1500;
const REST_FALLBACK_INTERVAL_MS = 60000;
const TIINGO_BOOTSTRAP_INTERVAL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 50;
const TIINGO_WS_URL = 'wss://api.tiingo.com/fx';
const TIINGO_TICKER = 'xauusd';
const TIINGO_LIVE_SOURCE = '🟢 tiingo live';
const TIINGO_REST_SOURCE = '🟡 tiingo rest';
const TIINGO_REST_FALLBACK_SOURCE = '🟡 tiingo rest fallback';

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
  apiKey: null,
};

function getTiingoApiKey(): string | null {
  const publicApiKey = process.env.EXPO_PUBLIC_TIINGO_API_KEY?.trim();
  const fallbackApiKey = process.env.TIINGO_API_KEY?.trim();
  const apiKey = publicApiKey || fallbackApiKey || null;

  if (!apiKey) {
    console.error('❌ [GoldWS] Tiingo API key missing (checked EXPO_PUBLIC_TIINGO_API_KEY and TIINGO_API_KEY) — falling back to REST');
    return null;
  }

  const keySource = publicApiKey ? 'EXPO_PUBLIC_TIINGO_API_KEY' : 'TIINGO_API_KEY';
  console.log(`🔑 [GoldWS] Using Tiingo key from ${keySource}`);
  return apiKey;
}

function getTiingoRestUrl(apiKey: string): string {
  return `https://api.tiingo.com/tiingo/fx/top?tickers=${TIINGO_TICKER}&token=${encodeURIComponent(apiKey)}`;
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

function notifyStatus(status: ConnectionStatus): void {
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
      console.warn('⚠️ [GoldWS] Heartbeat detected inactive Tiingo socket — forcing reconnect');
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
    console.log('🔄 [GoldWS] Tiingo REST fallback killed — WebSocket recovered');
    state.isRestFallbackActive = false;
  }
}

async function fetchTiingoRestPrice(reason: string, sourceLabel: string): Promise<void> {
  const apiKey = state.apiKey ?? getTiingoApiKey();

  if (!apiKey) {
    console.error(`❌ [GoldWS] Cannot fetch Tiingo REST price (${reason}) without API key`);
    return;
  }

  state.apiKey = apiKey;

  try {
    const url = getTiingoRestUrl(apiKey);
    console.log(`🔄 [GoldWS] Tiingo REST fetch (${reason})...`);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.warn(`⚠️ [GoldWS] Tiingo REST fetch failed with ${response.status}: ${responseText.slice(0, 200)}`);
      return;
    }

    const payload = await response.json() as unknown;
    const quote = Array.isArray(payload)
      ? payload[0] as TiingoRestQuote | undefined
      : (payload as TiingoRestQuote | undefined);

    const parsedPrice = typeof quote?.midPrice === 'number'
      ? quote.midPrice
      : parseFloat(String(quote?.midPrice ?? ''));

    if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
      console.warn('⚠️ [GoldWS] Tiingo REST fetch returned invalid price', payload);
      return;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] Tiingo REST price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, sourceLabel);
  } catch (err) {
    console.error(`❌ [GoldWS] Tiingo REST fetch error (${reason}):`, err);
  }
}

function activateRestFallback(): void {
  if (state.isRestFallbackActive) {
    return;
  }

  state.isRestFallbackActive = true;
  console.log(`⚠️ [GoldWS] Tiingo WebSocket timeout — activating REST cold-standby fallback (every ${(REST_FALLBACK_INTERVAL_MS / 1000).toFixed(0)}s)`);
  notifyStatus('fallback');

  void fetchTiingoRestPrice('fallback-initial', TIINGO_REST_FALLBACK_SOURCE);

  state.restFallbackTimer = setInterval(() => {
    void fetchTiingoRestPrice('fallback-interval', TIINGO_REST_FALLBACK_SOURCE);
  }, REST_FALLBACK_INTERVAL_MS);
}

async function fetchTiingoBootstrapPrice(reason: string): Promise<void> {
  const now = Date.now();
  if ((now - state.lastBootstrapFetchAt) < TIINGO_BOOTSTRAP_INTERVAL_MS) {
    return;
  }

  state.lastBootstrapFetchAt = now;
  await fetchTiingoRestPrice(`bootstrap-${reason}`, TIINGO_REST_SOURCE);
}

function startWatchdog(): void {
  stopWatchdog();
  state.watchdogTimer = setInterval(() => {
    const now = Date.now();
    const silenceDuration = now - state.lastTickTime;

    if (state.lastTickTime > 0 && silenceDuration > WATCHDOG_TIMEOUT_MS) {
      console.warn(`⚠️ [GoldWS] Watchdog: No Tiingo tick for ${(silenceDuration / 1000).toFixed(1)}s`);
      activateRestFallback();

      const socket = state.ws;
      state.lastTickTime = now;

      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        console.warn('⚠️ [GoldWS] Recycling stale Tiingo socket after watchdog timeout');
        try {
          socket.close();
        } catch (err) {
          console.warn('⚠️ [GoldWS] Failed to close stale Tiingo socket:', err);
          scheduleReconnect();
        }
      } else {
        scheduleReconnect();
      }
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

  const apiKey = getTiingoApiKey();
  state.apiKey = apiKey;

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

  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  console.log(`🔌 [GoldWS] Connecting to Tiingo WebSocket (connection ${connectionId})...`);
  notifyStatus('reconnecting');
  void fetchTiingoBootstrapPrice(`connection-${connectionId}`);

  try {
    state.ws = new WebSocket(TIINGO_WS_URL);
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

    console.log(`✅ [GoldWS] Tiingo WebSocket connected (connection ${connectionId})`);
    state.isConnected = true;
    state.reconnectAttempts = 0;
    state.lastTickTime = Date.now();
    notifyStatus('connected');

    const subscribeMsg = JSON.stringify({
      eventName: 'subscribe',
      authorization: apiKey,
      eventData: {
        thresholdLevel: 5,
        tickers: [TIINGO_TICKER],
      },
    });

    try {
      socket.send(subscribeMsg);
      console.log(`📡 [GoldWS] Subscribed to ${TIINGO_TICKER.toUpperCase()} on Tiingo (connection ${connectionId})`);
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
      const data = JSON.parse(rawData) as TiingoWebSocketMessage;

      if (data.messageType === 'A') {
        const packet = Array.isArray(data.data)
          ? (Array.isArray(data.data[0]) ? data.data[0] : data.data)
          : null;

        if (!packet) {
          console.warn('⚠️ [GoldWS] Tiingo messageType A did not include an array payload', data);
          return;
        }

        const rawPrice = packet[5];
        const parsedPrice = parseFloat(String(rawPrice ?? ''));

        if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
          console.warn(`⚠️ [GoldWS] Invalid Tiingo mid price: ${String(rawPrice)}`);
          return;
        }

        const roundedPrice = Number(parseFloat(String(rawPrice)).toFixed(2));
        state.lastTickTime = Date.now();
        killRestFallback();
        notifyPrice(roundedPrice, TIINGO_LIVE_SOURCE);

        if (state.lastTickTime % 10000 < 2000) {
          console.log(`📈 [GoldWS] ${TIINGO_TICKER.toUpperCase()}: ${roundedPrice.toFixed(2)}`);
        }
        return;
      }

      if (data.response || data.eventName) {
        console.log('📡 [GoldWS] Tiingo control message:', {
          connectionId,
          response: data.response,
          eventName: data.eventName,
          service: data.service,
        });
        return;
      }

      if (data.error || data.detail) {
        console.error('❌ [GoldWS] Tiingo server error:', data.error ?? data.detail);
        return;
      }

      console.log('ℹ️ [GoldWS] Tiingo non-price message received:', data);
    } catch (err) {
      console.warn('⚠️ [GoldWS] Failed to parse Tiingo message:', err);
    }
  };

  socket.onerror = (event: Event) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.warn('⚠️ [GoldWS] Tiingo WebSocket transport issue detected; waiting for close event', diagnostics);
    state.isConnected = false;
    notifyStatus('disconnected');
  };

  socket.onclose = (event: CloseEvent) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.log('🔌 [GoldWS] Tiingo WebSocket closed', diagnostics);
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
    console.error(`❌ [GoldWS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — staying on Tiingo REST fallback`);
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

  getStatus(): ConnectionStatus {
    return state.currentStatus;
  },

  getLastTickTime(): number {
    return state.lastTickTime;
  },
};
