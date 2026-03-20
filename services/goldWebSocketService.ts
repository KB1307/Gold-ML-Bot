import { Platform } from 'react-native';
import { trpcClient } from '@/lib/trpc';

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

type TiingoPacket = unknown[];

type TiingoNumericPacketObject = Record<string, unknown>;

interface WebSocketServiceState {
  ws: WebSocket | null;
  isConnected: boolean;
  lastTickTime: number;
  lastMessageTime: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimerReason: string | null;
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
  connectStartedAt: number;
  lastBootstrapFetchAt: number;
  lastStaleFallbackAt: number;
  apiKey: string | null;
}

const HEARTBEAT_INTERVAL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 1000;
const STALE_PRICE_TIMEOUT_MS = 30000;
const SOCKET_RECYCLE_TIMEOUT_MS = 180000;
const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 1500;
const REST_FALLBACK_INTERVAL_MS = 60000;
const TIINGO_BOOTSTRAP_INTERVAL_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 50;
const TIINGO_WS_URL = 'wss://api.tiingo.com/fx';
const TIINGO_TICKER = 'xauusd';
const TIINGO_TICKER_SYMBOL = 'XAUUSD';
const TIINGO_LIVE_SOURCE = '🟢 tiingo live';
const TIINGO_REST_SOURCE = '🟡 tiingo rest';
const TIINGO_REST_FALLBACK_SOURCE = '🟡 tiingo rest fallback';

const state: WebSocketServiceState = {
  ws: null,
  isConnected: false,
  lastTickTime: 0,
  lastMessageTime: 0,
  reconnectTimer: null,
  reconnectTimerReason: null,
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
  connectStartedAt: 0,
  lastBootstrapFetchAt: 0,
  lastStaleFallbackAt: 0,
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

function isTiingoNumericPacketObject(value: unknown): value is TiingoNumericPacketObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(key => /^\d+$/.test(key));
}

function normalizeTiingoPacket(data: unknown): TiingoPacket | null {
  const candidate = Array.isArray(data) && data.length > 0 && (Array.isArray(data[0]) || isTiingoNumericPacketObject(data[0]))
    ? data[0]
    : data;

  if (Array.isArray(candidate)) {
    return candidate;
  }

  if (isTiingoNumericPacketObject(candidate)) {
    return Object.keys(candidate)
      .sort((left, right) => Number(left) - Number(right))
      .map(key => candidate[key]);
  }

  return null;
}

function getTiingoPacketText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
}

function getTiingoPacketNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value === 'string') {
    return parseFloat(value);
  }

  return Number.NaN;
}

function clearReconnectTimer(): void {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.reconnectTimerReason = null;
}

async function fetchTiingoRestProxyPrice(reason: string, sourceLabel: string): Promise<boolean> {
  try {
    console.log(`🔄 [GoldWS] Tiingo REST proxy fetch (${reason})...`);
    const payload = await trpcClient.goldPrice.getTiingoRestPrice.query();
    const parsedPrice = typeof payload?.price === 'number' ? payload.price : Number.NaN;

    if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
      console.warn('⚠️ [GoldWS] Tiingo REST proxy returned invalid price', payload);
      return false;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] Tiingo REST proxy price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, `${sourceLabel} • proxy`);
    return true;
  } catch (error) {
    console.error(`❌ [GoldWS] Tiingo REST proxy fetch error (${reason}):`, error);
    return false;
  }
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
  if (state.currentStatus === status) {
    return;
  }

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
    const now = Date.now();
    const silenceDuration = state.lastTickTime > 0 ? now - state.lastTickTime : 0;
    const connectDuration = state.connectStartedAt > 0 ? now - state.connectStartedAt : 0;

    console.log(`💓 [GoldWS] Heartbeat check | state=${getReadyStateLabel(readyState)} | silence=${(silenceDuration / 1000).toFixed(1)}s | connecting=${(connectDuration / 1000).toFixed(1)}s`);

    if (!socket) {
      console.warn('⚠️ [GoldWS] Heartbeat detected missing Tiingo socket — scheduling reconnect');
      scheduleReconnect('heartbeat-missing-socket');
      return;
    }

    if (readyState === WebSocket.CONNECTING) {
      if (connectDuration > CONNECT_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Tiingo socket stuck CONNECTING for ${(connectDuration / 1000).toFixed(1)}s — recycling connection`);
        try {
          socket.close();
        } catch (err) {
          console.warn('⚠️ [GoldWS] Failed to close hung Tiingo socket:', err);
          scheduleReconnect('heartbeat-connect-timeout-force');
        }
      }
      return;
    }

    if (readyState === WebSocket.CLOSING) {
      console.log('ℹ️ [GoldWS] Heartbeat sees Tiingo socket closing — waiting for close event');
      return;
    }

    if (readyState === WebSocket.CLOSED) {
      console.warn('⚠️ [GoldWS] Heartbeat detected closed Tiingo socket — scheduling reconnect');
      scheduleReconnect('heartbeat-closed-socket');
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
  if (Platform.OS === 'web') {
    await fetchTiingoRestProxyPrice(reason, sourceLabel);
    return;
  }

  const apiKey = state.apiKey ?? getTiingoApiKey();

  if (!apiKey) {
    console.error(`❌ [GoldWS] Cannot fetch Tiingo REST price (${reason}) without API key`);
    await fetchTiingoRestProxyPrice(`${reason}-missing-key`, sourceLabel);
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
      await fetchTiingoRestProxyPrice(`${reason}-http-${response.status}`, sourceLabel);
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
      await fetchTiingoRestProxyPrice(`${reason}-invalid-payload`, sourceLabel);
      return;
    }

    const roundedPrice = Number(parsedPrice.toFixed(2));
    console.log(`✅ [GoldWS] Tiingo REST price: ${roundedPrice.toFixed(2)} (${reason})`);
    notifyPrice(roundedPrice, sourceLabel);
  } catch (err) {
    console.error(`❌ [GoldWS] Tiingo REST fetch error (${reason}):`, err);

    if (isLikelyNetworkError(err)) {
      await fetchTiingoRestProxyPrice(`${reason}-network-recovery`, sourceLabel);
    }
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
    const socket = state.ws;
    const now = Date.now();
    const silenceDuration = state.lastTickTime > 0 ? now - state.lastTickTime : 0;
    const connectDuration = state.connectStartedAt > 0 ? now - state.connectStartedAt : 0;

    if (!socket) {
      if (state.lastTickTime > 0 && silenceDuration > STALE_PRICE_TIMEOUT_MS) {
        activateRestFallback();
      }
      scheduleReconnect('watchdog-missing-socket');
      return;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      if (connectDuration > CONNECT_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Watchdog: Tiingo socket stuck CONNECTING for ${(connectDuration / 1000).toFixed(1)}s`);
        try {
          socket.close();
        } catch (err) {
          console.warn('⚠️ [GoldWS] Failed to close connecting Tiingo socket:', err);
          scheduleReconnect('watchdog-connect-timeout-force');
        }
      }
      return;
    }

    if (state.lastTickTime > 0 && silenceDuration > STALE_PRICE_TIMEOUT_MS) {
      if (state.lastStaleFallbackAt === 0 || (now - state.lastStaleFallbackAt) >= STALE_PRICE_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Watchdog: No Tiingo price tick for ${(silenceDuration / 1000).toFixed(1)}s — keeping socket open and switching guide price to REST fallback`);
        state.lastStaleFallbackAt = now;
      }

      activateRestFallback();

      if (socket.readyState === WebSocket.OPEN && silenceDuration > SOCKET_RECYCLE_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Watchdog: No Tiingo price tick for ${(silenceDuration / 1000).toFixed(1)}s while socket stayed OPEN — recycling connection`);
        try {
          socket.close();
        } catch (err) {
          console.warn('⚠️ [GoldWS] Failed to close stale Tiingo socket:', err);
          scheduleReconnect('watchdog-stale-open-socket');
        }
        return;
      }
    }

    if (socket.readyState === WebSocket.CLOSED) {
      scheduleReconnect('watchdog-closed-socket');
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

  clearReconnectTimer();

  const apiKey = getTiingoApiKey();
  state.apiKey = apiKey;

  if (!apiKey) {
    activateRestFallback();
    notifyStatus('fallback');
    return;
  }

  if (state.ws) {
    try {
      state.ws.onopen = null;
      state.ws.onmessage = null;
      state.ws.onerror = null;
      state.ws.onclose = null;
      if (
        state.ws.readyState === WebSocket.OPEN ||
        state.ws.readyState === WebSocket.CONNECTING ||
        state.ws.readyState === WebSocket.CLOSING
      ) {
        state.ws.close();
      }
    } catch (e) {
      console.warn('⚠️ [GoldWS] Error closing old socket:', e);
    }
    state.ws = null;
  }

  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  state.connectStartedAt = Date.now();
  state.lastMessageTime = 0;
  console.log(`🔌 [GoldWS] Connecting to Tiingo WebSocket (connection ${connectionId})...`);
  notifyStatus(state.isRestFallbackActive ? 'fallback' : 'reconnecting');

  const shouldBootstrapPrice = state.lastPrice <= 0 || state.lastTickTime <= 0 || (Date.now() - state.lastTickTime) >= STALE_PRICE_TIMEOUT_MS;
  if (shouldBootstrapPrice) {
    void fetchTiingoBootstrapPrice(`connection-${connectionId}`);
  } else {
    console.log(`ℹ️ [GoldWS] Skipping Tiingo bootstrap REST fetch for connection ${connectionId} because cached guide price is still fresh`);
  }

  try {
    state.ws = new WebSocket(TIINGO_WS_URL);
  } catch (err) {
    console.error('❌ [GoldWS] WebSocket constructor failed:', err);
    scheduleReconnect('constructor-failed');
    return;
  }

  const socket = state.ws;

  socket.onopen = () => {
    if (state.ws !== socket) {
      console.log(`ℹ️ [GoldWS] Ignoring stale onopen for connection ${connectionId}`);
      return;
    }

    clearReconnectTimer();
    console.log(`✅ [GoldWS] Tiingo WebSocket connected (connection ${connectionId})`);
    state.isConnected = true;
    state.reconnectAttempts = 0;
    state.connectStartedAt = Date.now();
    state.lastMessageTime = Date.now();
    state.lastTickTime = Date.now();
    state.lastStaleFallbackAt = 0;
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
      console.log(`📡 [GoldWS] Subscribed to ${TIINGO_TICKER_SYMBOL} on Tiingo (connection ${connectionId})`);
    } catch (err) {
      console.error('❌ [GoldWS] Subscribe send failed:', err);
      activateRestFallback();
      scheduleReconnect('subscribe-send-failed');
      return;
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
      state.lastMessageTime = Date.now();

      if (data.messageType === 'A') {
        const packet = normalizeTiingoPacket(data.data);

        if (!packet) {
          console.warn('⚠️ [GoldWS] Tiingo messageType A did not include a normalizable payload', data);
          return;
        }

        const updateType = getTiingoPacketText(packet[0])?.toUpperCase() ?? '';
        const packetTicker = getTiingoPacketText(packet[1])?.toUpperCase() ?? '';
        const rawPrice = packet[5];
        const parsedPrice = getTiingoPacketNumber(rawPrice);

        if (updateType && updateType !== 'Q') {
          console.log('ℹ️ [GoldWS] Ignoring non-quote Tiingo packet', { connectionId, updateType, packetTicker });
          return;
        }

        if (packetTicker && packetTicker !== TIINGO_TICKER_SYMBOL) {
          console.log('ℹ️ [GoldWS] Ignoring Tiingo packet for different ticker', { connectionId, packetTicker });
          return;
        }

        if (Number.isNaN(parsedPrice) || parsedPrice <= 1000 || parsedPrice > 10000) {
          console.warn('⚠️ [GoldWS] Invalid Tiingo mid price', {
            connectionId,
            rawPrice,
            packet,
          });
          return;
        }

        const roundedPrice = Number(parsedPrice.toFixed(2));
        state.lastTickTime = state.lastMessageTime;
        state.lastStaleFallbackAt = 0;
        killRestFallback();
        notifyStatus('connected');
        notifyPrice(roundedPrice, TIINGO_LIVE_SOURCE);

        if (state.lastTickTime % 10000 < 2000) {
          console.log(`📈 [GoldWS] ${TIINGO_TICKER_SYMBOL}: ${roundedPrice.toFixed(2)}`);
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
        activateRestFallback();
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
    console.warn('⚠️ [GoldWS] Tiingo WebSocket transport issue detected', diagnostics);

    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      state.isConnected = false;
      activateRestFallback();
      scheduleReconnect('transport-error');
    }
  };

  socket.onclose = (event: CloseEvent) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.log('🔌 [GoldWS] Tiingo WebSocket closed', diagnostics);
    state.isConnected = false;
    state.ws = null;
    state.connectStartedAt = 0;
    state.lastMessageTime = 0;
    stopHeartbeat();
    stopWatchdog();

    if (!state.intentionallyClosed) {
      activateRestFallback();
      scheduleReconnect(`close-${event.code}`);
      return;
    }

    notifyStatus('disconnected');
  };
}

function scheduleReconnect(reason: string): void {
  if (state.intentionallyClosed) {
    return;
  }

  if (state.reconnectTimer) {
    if (state.reconnectTimerReason !== reason) {
      console.log(`ℹ️ [GoldWS] Reconnect already scheduled (${state.reconnectTimerReason ?? 'unknown'}) — skipping ${reason}`);
    }
    return;
  }

  state.reconnectAttempts++;

  if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ [GoldWS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — staying on Tiingo REST fallback`);
    activateRestFallback();
    notifyStatus('fallback');
    return;
  }

  const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, Math.min(state.reconnectAttempts - 1, 5)), 30000);
  state.reconnectTimerReason = reason;
  console.log(`🔄 [GoldWS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, reason=${reason})...`);
  notifyStatus(state.isRestFallbackActive ? 'fallback' : 'reconnecting');

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectTimerReason = null;
    connect();
  }, delay);
}

export const goldWebSocketService = {
  start(): void {
    if (
      state.ws &&
      (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.CLOSING)
    ) {
      console.log('ℹ️ [GoldWS] WebSocket service already active, skipping duplicate start');
      return;
    }

    if (state.reconnectTimer) {
      console.log(`ℹ️ [GoldWS] Reconnect already scheduled (${state.reconnectTimerReason ?? 'unknown'}), skipping duplicate start`);
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
    clearReconnectTimer();

    if (state.ws) {
      try {
        state.ws.onopen = null;
        state.ws.onmessage = null;
        state.ws.onerror = null;
        state.ws.onclose = null;
        if (
          state.ws.readyState === WebSocket.OPEN ||
          state.ws.readyState === WebSocket.CONNECTING ||
          state.ws.readyState === WebSocket.CLOSING
        ) {
          state.ws.close();
        }
      } catch (e) {
        console.warn('⚠️ [GoldWS] Error closing socket:', e);
      }
      state.ws = null;
    }

    state.lastTickTime = 0;
    state.lastMessageTime = 0;
    state.connectStartedAt = 0;
    state.lastStaleFallbackAt = 0;
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
