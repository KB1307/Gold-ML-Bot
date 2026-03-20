import { Platform } from 'react-native';
import { trpcClient } from '@/lib/trpc';

type PriceCallback = (price: number, source: string) => void;
type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting' | 'fallback';
type StatusCallback = (status: ConnectionStatus) => void;

type FinnhubRestQuote = {
  c?: number | string | null;
  h?: number | string | null;
  l?: number | string | null;
  o?: number | string | null;
  pc?: number | string | null;
  t?: number | string | null;
};

type FinnhubTrade = {
  p?: number | string | null;
  s?: string | null;
  t?: number | string | null;
  v?: number | string | null;
};

type FinnhubWebSocketMessage = {
  type?: string;
  data?: FinnhubTrade[];
  msg?: string;
};

interface WebSocketServiceState {
  ws: WebSocket | null;
  closingSocket: WebSocket | null;
  isConnected: boolean;
  lastTickTime: number;
  lastMessageTime: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimerReason: string | null;
  reconnectTimerDelayMs: number | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  restFallbackTimer: ReturnType<typeof setInterval> | null;
  isRestFallbackActive: boolean;
  priceCallbacks: Set<PriceCallback>;
  statusCallbacks: Set<StatusCallback>;
  intentionallyClosed: boolean;
  lastPrice: number;
  lastPriceSource: string;
  currentStatus: ConnectionStatus;
  connectionId: number;
  connectStartedAt: number;
  lastBootstrapFetchAt: number;
  apiKey: string | null;
  pendingReconnectDelayMs: number | null;
  pendingReconnectReason: string | null;
}

const WATCHDOG_INTERVAL_MS = 1000;
const WATCHDOG_STALE_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 5000;
const REST_FALLBACK_INTERVAL_MS = 60000;
const REST_BOOTSTRAP_INTERVAL_MS = 1000;
const FINNHUB_SYMBOL = 'OANDA:XAU_USD';
const FINNHUB_LIVE_SOURCE = '🟢 Finnhub-Live';
const FINNHUB_REST_SOURCE = '🟡 Finnhub REST';
const FINNHUB_REST_FALLBACK_SOURCE = '🟡 Finnhub REST Fallback';

const state: WebSocketServiceState = {
  ws: null,
  closingSocket: null,
  isConnected: false,
  lastTickTime: 0,
  lastMessageTime: 0,
  reconnectTimer: null,
  reconnectTimerReason: null,
  reconnectTimerDelayMs: null,
  watchdogTimer: null,
  restFallbackTimer: null,
  isRestFallbackActive: false,
  priceCallbacks: new Set(),
  statusCallbacks: new Set(),
  intentionallyClosed: false,
  lastPrice: 0,
  lastPriceSource: 'connecting...',
  currentStatus: 'disconnected',
  connectionId: 0,
  connectStartedAt: 0,
  lastBootstrapFetchAt: 0,
  apiKey: null,
  pendingReconnectDelayMs: null,
  pendingReconnectReason: null,
};

function getFinnhubApiKey(): string | null {
  const publicApiKey = process.env.EXPO_PUBLIC_FINNHUB_API_KEY?.trim();
  const privateApiKey = process.env.FINNHUB_API_KEY?.trim();
  const apiKey = publicApiKey || privateApiKey || null;

  if (!apiKey) {
    console.error('❌ [GoldWS] Finnhub API key missing (checked EXPO_PUBLIC_FINNHUB_API_KEY and FINNHUB_API_KEY)');
    return null;
  }

  const keySource = publicApiKey ? 'EXPO_PUBLIC_FINNHUB_API_KEY' : 'FINNHUB_API_KEY';
  console.log(`🔑 [GoldWS] Using Finnhub key from ${keySource}`);
  return apiKey;
}

function getFinnhubWebSocketUrl(apiKey: string): string {
  return `wss://ws.finnhub.io?token=${encodeURIComponent(apiKey)}`;
}

function getFinnhubRestUrl(apiKey: string): string {
  return `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(FINNHUB_SYMBOL)}&token=${encodeURIComponent(apiKey)}`;
}

function parseNumericValue(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return parseFloat(value);
  }

  return Number.NaN;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('networkerror') ||
    message.includes('failed to fetch') ||
    message.includes('fetch failed') ||
    message.includes('network request failed')
  );
}

function clearReconnectTimer(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.reconnectTimerReason = null;
  state.reconnectTimerDelayMs = null;
}

function notifyPrice(price: number, source: string): void {
  state.lastPrice = price;
  state.lastPriceSource = source;
  state.priceCallbacks.forEach((callback) => {
    try {
      callback(price, source);
    } catch (error) {
      console.error('❌ [GoldWS] Price callback error:', error);
    }
  });
}

function notifyStatus(status: ConnectionStatus): void {
  if (state.currentStatus === status) {
    return;
  }

  state.currentStatus = status;
  state.statusCallbacks.forEach((callback) => {
    try {
      callback(status);
    } catch (error) {
      console.error('❌ [GoldWS] Status callback error:', error);
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

async function fetchFinnhubRestProxyPrice(reason: string, sourceLabel: string): Promise<boolean> {
  try {
    console.log(`🔄 [GoldWS] Finnhub REST proxy fetch (${reason})...`);
    const payload = await trpcClient.goldPrice.getFinnhubRestPrice.query();
    const parsedPrice = typeof payload?.price === 'number' ? payload.price : Number.NaN;

    if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
      console.warn('⚠️ [GoldWS] Finnhub REST proxy returned invalid price', payload);
      return false;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] Finnhub REST proxy price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, `${sourceLabel} • proxy`);
    return true;
  } catch (error) {
    console.error(`❌ [GoldWS] Finnhub REST proxy fetch error (${reason}):`, error);
    return false;
  }
}

function killRestFallback(): void {
  if (state.restFallbackTimer) {
    clearInterval(state.restFallbackTimer);
    state.restFallbackTimer = null;
  }

  if (state.isRestFallbackActive) {
    console.log('🔄 [GoldWS] Finnhub REST fallback stopped — websocket recovered');
    state.isRestFallbackActive = false;
  }
}

async function fetchFinnhubRestPrice(reason: string, sourceLabel: string): Promise<void> {
  if (Platform.OS === 'web') {
    await fetchFinnhubRestProxyPrice(reason, sourceLabel);
    return;
  }

  const apiKey = state.apiKey ?? getFinnhubApiKey();

  if (!apiKey) {
    await fetchFinnhubRestProxyPrice(`${reason}-missing-key`, sourceLabel);
    return;
  }

  state.apiKey = apiKey;

  try {
    const url = getFinnhubRestUrl(apiKey);
    console.log(`🔄 [GoldWS] Finnhub REST fetch (${reason})...`);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.warn(`⚠️ [GoldWS] Finnhub REST fetch failed with ${response.status}: ${responseText.slice(0, 200)}`);
      await fetchFinnhubRestProxyPrice(`${reason}-http-${response.status}`, sourceLabel);
      return;
    }

    const payload = await response.json() as FinnhubRestQuote;
    const parsedPrice = parseNumericValue(payload?.c);

    if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
      console.warn('⚠️ [GoldWS] Finnhub REST fetch returned invalid payload', payload);
      await fetchFinnhubRestProxyPrice(`${reason}-invalid-payload`, sourceLabel);
      return;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] Finnhub REST price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, sourceLabel);
  } catch (error) {
    console.error(`❌ [GoldWS] Finnhub REST fetch error (${reason}):`, error);

    if (isLikelyNetworkError(error)) {
      await fetchFinnhubRestProxyPrice(`${reason}-network-recovery`, sourceLabel);
    }
  }
}

function activateRestFallback(): void {
  if (state.isRestFallbackActive) {
    return;
  }

  state.isRestFallbackActive = true;
  console.log(`⚠️ [GoldWS] Activating Finnhub REST fallback every ${(REST_FALLBACK_INTERVAL_MS / 1000).toFixed(0)}s`);
  void fetchFinnhubRestPrice('fallback-initial', FINNHUB_REST_FALLBACK_SOURCE);

  state.restFallbackTimer = setInterval(() => {
    void fetchFinnhubRestPrice('fallback-interval', FINNHUB_REST_FALLBACK_SOURCE);
  }, REST_FALLBACK_INTERVAL_MS);
}

async function fetchFinnhubBootstrapPrice(reason: string): Promise<void> {
  const now = Date.now();
  if ((now - state.lastBootstrapFetchAt) < REST_BOOTSTRAP_INTERVAL_MS) {
    return;
  }

  state.lastBootstrapFetchAt = now;
  await fetchFinnhubRestPrice(`bootstrap-${reason}`, FINNHUB_REST_SOURCE);
}

function stopWatchdog(): void {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

function scheduleReconnect(reason: string, delayMs: number = RECONNECT_DELAY_MS): void {
  if (state.intentionallyClosed) {
    return;
  }

  if (state.closingSocket) {
    state.pendingReconnectDelayMs = delayMs;
    state.pendingReconnectReason = reason;
    return;
  }

  if (state.reconnectTimer) {
    const currentDelay = state.reconnectTimerDelayMs ?? RECONNECT_DELAY_MS;
    if (currentDelay <= delayMs) {
      console.log(`ℹ️ [GoldWS] Reconnect already scheduled (${state.reconnectTimerReason ?? 'unknown'}) in ${(currentDelay / 1000).toFixed(1)}s`);
      return;
    }

    clearReconnectTimer();
  }

  state.reconnectTimerReason = reason;
  state.reconnectTimerDelayMs = delayMs;
  console.log(`🔄 [GoldWS] Scheduling Finnhub reconnect in ${(delayMs / 1000).toFixed(1)}s (reason=${reason})`);
  notifyStatus('reconnecting');

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectTimerReason = null;
    state.reconnectTimerDelayMs = null;
    connect();
  }, delayMs);
}

function requestSocketRecycle(reason: string, delayMs: number): void {
  if (state.intentionallyClosed) {
    return;
  }

  const socket = state.ws;

  if (!socket) {
    scheduleReconnect(reason, delayMs);
    return;
  }

  if (state.closingSocket === socket) {
    const currentDelay = state.pendingReconnectDelayMs ?? RECONNECT_DELAY_MS;
    if (delayMs < currentDelay) {
      state.pendingReconnectDelayMs = delayMs;
      state.pendingReconnectReason = reason;
    }
    return;
  }

  console.warn(`⚠️ [GoldWS] Recycling Finnhub socket (reason=${reason}, reconnectDelay=${delayMs}ms)`);
  state.closingSocket = socket;
  state.pendingReconnectDelayMs = delayMs;
  state.pendingReconnectReason = reason;
  state.ws = null;
  state.isConnected = false;
  notifyStatus('reconnecting');

  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;

  try {
    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING ||
      socket.readyState === WebSocket.CLOSING
    ) {
      socket.close();
      return;
    }
  } catch (error) {
    console.warn('⚠️ [GoldWS] Failed closing Finnhub socket during recycle:', error);
  }

  if (state.closingSocket === socket) {
    state.closingSocket = null;
  }

  const reconnectReason = state.pendingReconnectReason ?? reason;
  const reconnectDelay = state.pendingReconnectDelayMs ?? delayMs;
  state.pendingReconnectReason = null;
  state.pendingReconnectDelayMs = null;
  scheduleReconnect(reconnectReason, reconnectDelay);
}

function startWatchdog(): void {
  stopWatchdog();
  state.watchdogTimer = setInterval(() => {
    if (state.intentionallyClosed) {
      return;
    }

    const socket = state.ws;
    const now = Date.now();
    const silenceDuration = state.lastTickTime > 0 ? now - state.lastTickTime : 0;
    const connectDuration = state.connectStartedAt > 0 ? now - state.connectStartedAt : 0;

    if (!socket) {
      if (!state.closingSocket) {
        console.warn('⚠️ [GoldWS] Watchdog found no active Finnhub socket');
        scheduleReconnect('watchdog-missing-socket', RECONNECT_DELAY_MS);
      }
      return;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      if (connectDuration > CONNECT_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Finnhub socket stuck CONNECTING for ${(connectDuration / 1000).toFixed(1)}s`);
        activateRestFallback();
        requestSocketRecycle('watchdog-connect-timeout', RECONNECT_DELAY_MS);
      }
      return;
    }

    if (socket.readyState === WebSocket.CLOSED) {
      console.warn('⚠️ [GoldWS] Watchdog detected closed Finnhub socket');
      scheduleReconnect('watchdog-closed-socket', RECONNECT_DELAY_MS);
      return;
    }

    if (silenceDuration > WATCHDOG_STALE_TIMEOUT_MS) {
      console.warn(`⚠️ [GoldWS] No Finnhub trade for ${(silenceDuration / 1000).toFixed(1)}s — forcing immediate reconnect`);
      activateRestFallback();
      notifyStatus('reconnecting');
      requestSocketRecycle('watchdog-no-trade', 0);
    }
  }, WATCHDOG_INTERVAL_MS);
}

function connect(): void {
  if (state.intentionallyClosed) {
    console.log('🛑 [GoldWS] Connection intentionally closed, skipping reconnect');
    return;
  }

  if (state.closingSocket) {
    console.log('ℹ️ [GoldWS] Waiting for previous Finnhub socket to terminate before reconnecting');
    return;
  }

  clearReconnectTimer();

  if (state.ws) {
    if (
      state.ws.readyState === WebSocket.OPEN ||
      state.ws.readyState === WebSocket.CONNECTING ||
      state.ws.readyState === WebSocket.CLOSING
    ) {
      requestSocketRecycle('zombie-protection', RECONNECT_DELAY_MS);
      return;
    }

    state.ws = null;
  }

  const apiKey = getFinnhubApiKey();
  state.apiKey = apiKey;

  if (!apiKey) {
    activateRestFallback();
    notifyStatus('fallback');
    return;
  }

  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  state.connectStartedAt = Date.now();
  state.lastMessageTime = 0;
  state.lastTickTime = 0;
  console.log(`🔌 [GoldWS] Connecting to Finnhub WebSocket (connection ${connectionId})...`);
  notifyStatus('reconnecting');

  const shouldBootstrapPrice = state.lastPrice <= 0;
  if (shouldBootstrapPrice) {
    void fetchFinnhubBootstrapPrice(`connection-${connectionId}`);
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(getFinnhubWebSocketUrl(apiKey));
  } catch (error) {
    console.error('❌ [GoldWS] Finnhub WebSocket constructor failed:', error);
    activateRestFallback();
    scheduleReconnect('constructor-failed', RECONNECT_DELAY_MS);
    return;
  }

  state.ws = socket;

  socket.onopen = () => {
    if (state.ws !== socket) {
      console.log(`ℹ️ [GoldWS] Ignoring stale Finnhub onopen for connection ${connectionId}`);
      return;
    }

    console.log(`✅ [GoldWS] Finnhub WebSocket connected (connection ${connectionId})`);
    state.isConnected = true;
    state.connectStartedAt = Date.now();
    state.lastMessageTime = Date.now();
    notifyStatus('connected');

    try {
      socket.send(JSON.stringify({ type: 'subscribe', symbol: FINNHUB_SYMBOL }));
      console.log(`📡 [GoldWS] Subscribed to ${FINNHUB_SYMBOL} on Finnhub (connection ${connectionId})`);
    } catch (error) {
      console.error('❌ [GoldWS] Finnhub subscribe send failed:', error);
      activateRestFallback();
      requestSocketRecycle('subscribe-send-failed', RECONNECT_DELAY_MS);
      return;
    }

    startWatchdog();
  };

  socket.onmessage = (event: MessageEvent) => {
    if (state.ws !== socket) {
      return;
    }

    try {
      const rawData = typeof event.data === 'string' ? event.data : String(event.data ?? '');
      const data = JSON.parse(rawData) as FinnhubWebSocketMessage;
      state.lastMessageTime = Date.now();

      if (data.type !== 'trade') {
        console.log('ℹ️ [GoldWS] Finnhub control message:', data);
        return;
      }

      if (!Array.isArray(data.data) || data.data.length === 0) {
        console.warn('⚠️ [GoldWS] Finnhub trade message missing data array', data);
        return;
      }

      const latestTrade = data.data[data.data.length - 1];
      const tradeSymbol = typeof latestTrade?.s === 'string' ? latestTrade.s : '';

      if (tradeSymbol && tradeSymbol !== FINNHUB_SYMBOL) {
        console.log('ℹ️ [GoldWS] Ignoring Finnhub trade for different symbol', { connectionId, tradeSymbol });
        return;
      }

      const parsedPrice = parseNumericValue(latestTrade?.p);
      if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
        console.warn('⚠️ [GoldWS] Invalid Finnhub trade price', { connectionId, latestTrade });
        return;
      }

      const roundedPrice = Number(parseFloat(String(parsedPrice)).toFixed(2));
      const tradeTimestamp = parseNumericValue(latestTrade?.t);
      const latencyMs = Number.isFinite(tradeTimestamp) && tradeTimestamp > 0
        ? Date.now() - tradeTimestamp
        : Number.NaN;

      state.lastTickTime = Date.now();
      killRestFallback();
      notifyStatus('connected');
      notifyPrice(roundedPrice, FINNHUB_LIVE_SOURCE);

      if (Number.isFinite(latencyMs)) {
        console.log(`⚡ [GoldWS] Finnhub trade ${roundedPrice.toFixed(2)} | latency=${latencyMs}ms | symbol=${tradeSymbol || FINNHUB_SYMBOL}`);
      } else {
        console.log(`⚡ [GoldWS] Finnhub trade ${roundedPrice.toFixed(2)} | latency=unknown | symbol=${tradeSymbol || FINNHUB_SYMBOL}`);
      }
    } catch (error) {
      console.warn('⚠️ [GoldWS] Failed to parse Finnhub websocket message:', error);
    }
  };

  socket.onerror = (event: Event) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.warn('⚠️ [GoldWS] Finnhub websocket error', diagnostics);
    state.isConnected = false;
    activateRestFallback();
    requestSocketRecycle('transport-error', RECONNECT_DELAY_MS);
  };

  socket.onclose = (event: CloseEvent) => {
    const isActiveSocket = state.ws === socket;
    const isClosingSocket = state.closingSocket === socket;
    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.log('🔌 [GoldWS] Finnhub WebSocket closed', diagnostics);

    if (isActiveSocket) {
      state.ws = null;
    }

    if (isClosingSocket) {
      state.closingSocket = null;
    }

    state.isConnected = false;
    state.connectStartedAt = 0;
    stopWatchdog();

    if (state.intentionallyClosed) {
      notifyStatus('disconnected');
      return;
    }

    activateRestFallback();

    if (isClosingSocket) {
      const reconnectReason = state.pendingReconnectReason ?? `close-${event.code}`;
      const reconnectDelay = state.pendingReconnectDelayMs ?? RECONNECT_DELAY_MS;
      state.pendingReconnectReason = null;
      state.pendingReconnectDelayMs = null;
      scheduleReconnect(reconnectReason, reconnectDelay);
      return;
    }

    scheduleReconnect(`close-${event.code}`, RECONNECT_DELAY_MS);
  };
}

export const goldWebSocketService = {
  start(): void {
    if (state.ws || state.closingSocket || state.reconnectTimer) {
      console.log('ℹ️ [GoldWS] Finnhub websocket service already active, skipping duplicate start');
      return;
    }

    state.intentionallyClosed = false;
    connect();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping Finnhub websocket service');
    state.intentionallyClosed = true;
    stopWatchdog();
    killRestFallback();
    clearReconnectTimer();
    state.pendingReconnectDelayMs = null;
    state.pendingReconnectReason = null;

    if (state.ws) {
      try {
        const socket = state.ws;
        state.ws = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.CLOSING
        ) {
          socket.close();
        }
      } catch (error) {
        console.warn('⚠️ [GoldWS] Error closing Finnhub socket:', error);
      }
    }

    if (state.closingSocket) {
      try {
        const socket = state.closingSocket;
        state.closingSocket = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING ||
          socket.readyState === WebSocket.CLOSING
        ) {
          socket.close();
        }
      } catch (error) {
        console.warn('⚠️ [GoldWS] Error closing pending Finnhub socket:', error);
      }
    }

    state.lastTickTime = 0;
    state.lastMessageTime = 0;
    state.connectStartedAt = 0;
    state.isConnected = false;
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
