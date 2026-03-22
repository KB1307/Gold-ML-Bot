type PriceCallback = (price: number, source: string) => void;
type ConnectionStatus = 'connected' | 'waiting_for_trade' | 'disconnected' | 'reconnecting';
type StatusCallback = (status: ConnectionStatus) => void;

interface WebSocketServiceState {
  ws: WebSocket | null;
  closingSocket: WebSocket | null;
  isConnected: boolean;
  hasReceivedTradeOnActiveConnection: boolean;
  lastTickTime: number;
  lastMessageTime: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimerReason: string | null;
  reconnectTimerDelayMs: number | null;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  connectionAliveTimer: ReturnType<typeof setTimeout> | null;
  heartbeatPingTimer: ReturnType<typeof setInterval> | null;
  priceCallbacks: Set<PriceCallback>;
  statusCallbacks: Set<StatusCallback>;
  intentionallyClosed: boolean;
  lastPrice: number;
  lastPriceSource: string;
  currentStatus: ConnectionStatus;
  connectionId: number;
  connectStartedAt: number;
  apiKey: string | null;
  isConnecting: boolean;
  pendingReconnectDelayMs: number | null;
  pendingReconnectReason: string | null;
  restFallbackTimer: ReturnType<typeof setInterval> | null;
  restFallbackActive: boolean;
  lastWsTradeTime: number;
  wsStartTime: number;
  lastHeartbeatSentAt: number;
  lastHeartbeatResponseAt: number;
  heartbeatMissCount: number;
  lastQuoteTime: number;
  quotesReceivedCount: number;
  tradesReceivedCount: number;
}

const WATCHDOG_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 15000;
const CONNECTION_ALIVE_TIMEOUT_MS = 45000;
const HEARTBEAT_PING_INTERVAL_MS = 15000;
const HEARTBEAT_RESPONSE_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 5000;
const TIINGO_FX_TICKER = 'xauusd';
const TIINGO_LIVE_SOURCE = '🟢 Tiingo-Live';
const TIINGO_WS_URL = 'wss://api.tiingo.com/fx';
const REST_FALLBACK_ACTIVATION_MS = 5000;
const REST_FALLBACK_POLL_INTERVAL_MS = 10000;
const REST_FALLBACK_SOURCE = '🟠 REST-Fallback';
const TIINGO_THRESHOLD_LEVEL = 0;

const state: WebSocketServiceState = {
  ws: null,
  closingSocket: null,
  isConnected: false,
  hasReceivedTradeOnActiveConnection: false,
  lastTickTime: 0,
  lastMessageTime: 0,
  reconnectTimer: null,
  reconnectTimerReason: null,
  reconnectTimerDelayMs: null,
  watchdogTimer: null,
  connectionAliveTimer: null,
  heartbeatPingTimer: null,
  priceCallbacks: new Set(),
  statusCallbacks: new Set(),
  intentionallyClosed: false,
  lastPrice: 0,
  lastPriceSource: 'connecting...',
  currentStatus: 'disconnected',
  connectionId: 0,
  connectStartedAt: 0,
  apiKey: null,
  isConnecting: false,
  pendingReconnectDelayMs: null,
  pendingReconnectReason: null,
  restFallbackTimer: null,
  restFallbackActive: false,
  lastWsTradeTime: 0,
  wsStartTime: 0,
  lastHeartbeatSentAt: 0,
  lastHeartbeatResponseAt: 0,
  heartbeatMissCount: 0,
  lastQuoteTime: 0,
  quotesReceivedCount: 0,
  tradesReceivedCount: 0,
};

function getTiingoApiKey(): string | null {
  const key = process.env.EXPO_PUBLIC_TIINGO_API_KEY?.trim() ?? '';
  return key.length > 0 ? key : null;
}

async function fetchRestFallbackPrice(): Promise<{ price: number; source: string } | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(
      'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
      { signal: controller.signal, headers: { 'Accept': 'application/json' } }
    );
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const quote = data[0];
        const bid = quote?.spreadProfilePrices?.[0]?.bid;
        const ask = quote?.spreadProfilePrices?.[0]?.ask;
        if (bid && ask && typeof bid === 'number' && typeof ask === 'number' && bid > 1000) {
          const price = Number(((bid + ask) / 2).toFixed(2));
          console.log(`✅ [GoldWS-REST] Swissquote price: ${price}`);
          return { price, source: 'Swissquote-REST' };
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS-REST] Swissquote fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }

  const apiKey = getTiingoApiKey();
  if (apiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
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
          console.log(`✅ [GoldWS-REST] Tiingo REST fallback price: ${mid.toFixed(2)}`);
          return { price: Number(mid.toFixed(2)), source: 'Tiingo-REST' };
        }
        const bid = typeof quote?.bidPrice === 'number' ? quote.bidPrice : parseFloat(String(quote?.bidPrice ?? ''));
        const ask = typeof quote?.askPrice === 'number' ? quote.askPrice : parseFloat(String(quote?.askPrice ?? ''));
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 1000 && ask > 1000) {
          const avgPrice = Number(((bid + ask) / 2).toFixed(2));
          console.log(`✅ [GoldWS-REST] Tiingo REST fallback bid/ask price: ${avgPrice}`);
          return { price: avgPrice, source: 'Tiingo-REST' };
        }
      }
    } catch (e) {
      console.warn('⚠️ [GoldWS-REST] Tiingo REST fallback failed:', e instanceof Error ? e.message : 'Unknown');
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch('https://api.metals.live/v1/spot/gold', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data?.[0]?.price) {
        const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
        if (price > 1000 && price < 10000) {
          console.log(`✅ [GoldWS-REST] metals.live fallback price: ${price}`);
          return { price, source: 'MetalsLive-REST' };
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS-REST] metals.live fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch('https://data-asg.goldprice.org/dbXRates/USD', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (response.ok) {
      const data = await response.json();
      if (data?.items?.[0]?.xauPrice) {
        const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
        if (price > 1000 && price < 10000) {
          console.log(`✅ [GoldWS-REST] goldprice.org fallback price: ${price}`);
          return { price, source: 'GoldPrice-REST' };
        }
      }
    }
  } catch (e) {
    console.warn('⚠️ [GoldWS-REST] goldprice.org fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }

  console.warn('❌ [GoldWS-REST] All REST fallback sources failed');
  return null;
}

function stopRestFallback(): void {
  if (state.restFallbackTimer) {
    clearInterval(state.restFallbackTimer);
    state.restFallbackTimer = null;
  }
  if (state.restFallbackActive) {
    state.restFallbackActive = false;
    console.log('🛑 [GoldWS-REST] REST fallback polling stopped');
  }
}

function startRestFallbackIfNeeded(): void {
  if (state.intentionallyClosed) {
    return;
  }

  if (state.isConnected && state.hasReceivedTradeOnActiveConnection) {
    stopRestFallback();
    return;
  }

  if (state.restFallbackTimer) {
    return;
  }

  const timeSinceStart = state.wsStartTime > 0 ? Date.now() - state.wsStartTime : 0;
  const timeSinceLastWsTrade = state.lastWsTradeTime > 0 ? Date.now() - state.lastWsTradeTime : timeSinceStart;

  if (timeSinceLastWsTrade < REST_FALLBACK_ACTIVATION_MS && timeSinceStart < REST_FALLBACK_ACTIVATION_MS) {
    return;
  }

  console.log(`🔄 [GoldWS-REST] Activating REST fallback polling (WS silent for ${(timeSinceLastWsTrade / 1000).toFixed(1)}s)`);
  state.restFallbackActive = true;

  const pollOnce = async () => {
    if (state.intentionallyClosed) {
      stopRestFallback();
      return;
    }

    if (state.isConnected && state.hasReceivedTradeOnActiveConnection) {
      console.log('✅ [GoldWS-REST] WebSocket recovered — stopping REST fallback');
      stopRestFallback();
      return;
    }

    const result = await fetchRestFallbackPrice();
    if (result && !state.intentionallyClosed) {
      if (state.isConnected && state.hasReceivedTradeOnActiveConnection) {
        console.log('ℹ️ [GoldWS-REST] WS recovered during REST fetch — discarding REST price');
        stopRestFallback();
        return;
      }
      notifyPrice(result.price, `${REST_FALLBACK_SOURCE} (${result.source})`);
    }
  };

  void pollOnce();

  state.restFallbackTimer = setInterval(() => {
    void pollOnce();
  }, REST_FALLBACK_POLL_INTERVAL_MS);
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

function getEventDiagnostics(
  event: Event | CloseEvent | MessageEvent | undefined,
  socket: WebSocket | null,
  connectionId: number,
): Record<string, unknown> {
  const target = socket ?? (event?.target instanceof WebSocket ? event.target : null);
  const diagnostics: Record<string, unknown> = {
    connectionId,
    eventType: event?.type ?? 'unknown',
    readyState: target ? getReadyStateLabel(target.readyState) : 'UNKNOWN',
    url: target?.url ? '[redacted-tiingo-ws]' : 'unknown',
    online: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
    timestamp: new Date().toISOString(),
  };

  if (event && 'code' in event) {
    diagnostics.code = event.code;
    diagnostics.reason = event.reason || 'none';
    diagnostics.wasClean = event.wasClean;
  }

  return diagnostics;
}

function stopWatchdog(): void {
  if (state.watchdogTimer) {
    clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
  }
}

function stopConnectionAliveTimer(): void {
  if (state.connectionAliveTimer) {
    clearTimeout(state.connectionAliveTimer);
    state.connectionAliveTimer = null;
  }
}

function stopHeartbeatPing(): void {
  if (state.heartbeatPingTimer) {
    clearInterval(state.heartbeatPingTimer);
    state.heartbeatPingTimer = null;
  }
}

function resetConnectionAliveTimer(connectionId: number, reason: string): void {
  stopConnectionAliveTimer();

  if (state.intentionallyClosed) {
    return;
  }

  state.connectionAliveTimer = setTimeout(() => {
    if (state.intentionallyClosed) {
      return;
    }

    const socket = state.ws;

    if (!socket) {
      console.warn(`⚠️ [GoldWS] Connection alive timer expired without an active socket (connection ${connectionId})`);
      scheduleReconnect('alive-timeout-missing-socket', RECONNECT_DELAY_MS);
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      console.warn(`⚠️ [GoldWS] Connection alive timer expired while socket state=${getReadyStateLabel(socket.readyState)} (connection ${connectionId})`);
      requestSocketRecycle('alive-timeout-non-open-socket', RECONNECT_DELAY_MS);
      return;
    }

    const silenceDurationMs = state.lastMessageTime > 0
      ? Date.now() - state.lastMessageTime
      : CONNECTION_ALIVE_TIMEOUT_MS;

    console.warn(`⚠️ [GoldWS] No Tiingo message received for ${(silenceDurationMs / 1000).toFixed(1)}s — reconnecting socket`);
    requestSocketRecycle('connection-alive-timeout', RECONNECT_DELAY_MS);
  }, CONNECTION_ALIVE_TIMEOUT_MS);

  console.log(`💓 [GoldWS] Connection alive timer reset (${reason}) for connection ${connectionId}`);
}

function startHeartbeatPing(socket: WebSocket, connectionId: number): void {
  stopHeartbeatPing();
  state.lastHeartbeatSentAt = 0;
  state.lastHeartbeatResponseAt = Date.now();
  state.heartbeatMissCount = 0;

  state.heartbeatPingTimer = setInterval(() => {
    if (state.intentionallyClosed || state.ws !== socket) {
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      console.log(`ℹ️ [GoldWS] Skipping Tiingo ping because socket state=${getReadyStateLabel(socket.readyState)} (connection ${connectionId})`);
      return;
    }

    if (state.lastHeartbeatSentAt > 0 && state.lastHeartbeatResponseAt < state.lastHeartbeatSentAt) {
      const waitMs = Date.now() - state.lastHeartbeatSentAt;
      if (waitMs > HEARTBEAT_RESPONSE_TIMEOUT_MS) {
        state.heartbeatMissCount += 1;
        console.warn(`⚠️ [GoldWS] Heartbeat response missed #${state.heartbeatMissCount} (waited ${(waitMs / 1000).toFixed(1)}s) (connection ${connectionId})`);

        if (state.heartbeatMissCount >= 2) {
          console.warn(`🚨 [GoldWS] ${state.heartbeatMissCount} consecutive heartbeat misses — recycling socket (connection ${connectionId})`);
          requestSocketRecycle('heartbeat-response-timeout', RECONNECT_DELAY_MS);
          return;
        }
      }
    }

    try {
      state.lastHeartbeatSentAt = Date.now();
      socket.send(JSON.stringify({ eventName: 'heartbeat' }));
      console.log(`🏓 [GoldWS] Sent Tiingo heartbeat #${state.heartbeatMissCount > 0 ? 'retry' : 'ok'} (connection ${connectionId})`);
    } catch (error) {
      console.warn(`⚠️ [GoldWS] Tiingo heartbeat send failed (connection ${connectionId})`, error);
      requestSocketRecycle('heartbeat-ping-failed', RECONNECT_DELAY_MS);
    }
  }, HEARTBEAT_PING_INTERVAL_MS);
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
  console.log(`🔄 [GoldWS] Scheduling Tiingo reconnect in ${(delayMs / 1000).toFixed(1)}s (reason=${reason})`);
  notifyStatus('reconnecting');
  startRestFallbackIfNeeded();

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectTimerReason = null;
    state.reconnectTimerDelayMs = null;
    void connect();
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

  console.warn(`⚠️ [GoldWS] Recycling Tiingo socket (reason=${reason}, reconnectDelay=${delayMs}ms)`);
  state.closingSocket = socket;
  state.pendingReconnectDelayMs = delayMs;
  state.pendingReconnectReason = reason;
  state.ws = null;
  state.isConnected = false;
  state.hasReceivedTradeOnActiveConnection = false;
  stopHeartbeatPing();
  stopConnectionAliveTimer();
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
    console.warn('⚠️ [GoldWS] Failed closing Tiingo socket during recycle:', error);
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
    const connectDuration = state.connectStartedAt > 0 ? Date.now() - state.connectStartedAt : 0;

    if (!socket) {
      if (!state.closingSocket) {
        console.warn('⚠️ [GoldWS] Watchdog found no active Tiingo socket');
        scheduleReconnect('watchdog-missing-socket', RECONNECT_DELAY_MS);
      }
      return;
    }

    if (socket.readyState === WebSocket.CONNECTING) {
      if (connectDuration > CONNECT_TIMEOUT_MS) {
        console.warn(`⚠️ [GoldWS] Tiingo socket stuck CONNECTING for ${(connectDuration / 1000).toFixed(1)}s`);
        requestSocketRecycle('watchdog-connect-timeout', RECONNECT_DELAY_MS);
      }
      return;
    }

    if (socket.readyState === WebSocket.CLOSED) {
      console.warn('⚠️ [GoldWS] Watchdog detected closed Tiingo socket');
      scheduleReconnect('watchdog-closed-socket', RECONNECT_DELAY_MS);
    }

    startRestFallbackIfNeeded();
  }, WATCHDOG_INTERVAL_MS);
}

function parseTiingoQuotePrice(data: unknown[]): number | null {
  if (!Array.isArray(data) || data.length < 8) {
    return null;
  }

  const rawMid = data[3];
  const midPrice = typeof rawMid === 'number' ? rawMid : typeof rawMid === 'string' ? parseFloat(rawMid) : NaN;
  if (Number.isFinite(midPrice) && midPrice > 1000 && midPrice < 10000) {
    return Number(midPrice.toFixed(2));
  }

  const rawBid = data[5];
  const bidPrice = typeof rawBid === 'number' ? rawBid : typeof rawBid === 'string' ? parseFloat(rawBid) : NaN;
  const rawAsk = data[7];
  const askPrice = typeof rawAsk === 'number' ? rawAsk : typeof rawAsk === 'string' ? parseFloat(rawAsk) : NaN;

  if (Number.isFinite(bidPrice) && Number.isFinite(askPrice) && bidPrice > 1000 && askPrice > 1000) {
    return Number(((bidPrice + askPrice) / 2).toFixed(2));
  }

  if (Number.isFinite(bidPrice) && bidPrice > 1000) {
    return Number(bidPrice.toFixed(2));
  }

  if (Number.isFinite(askPrice) && askPrice > 1000) {
    return Number(askPrice.toFixed(2));
  }

  return null;
}

function parseTiingoTradePrice(data: unknown[]): number | null {
  if (!Array.isArray(data) || data.length < 4) {
    return null;
  }

  const rawPrice = data[3];
  const price = typeof rawPrice === 'number' ? rawPrice : typeof rawPrice === 'string' ? parseFloat(rawPrice) : NaN;
  if (Number.isFinite(price) && price > 1000 && price < 10000) {
    return Number(price.toFixed(2));
  }

  return null;
}

async function connect(): Promise<void> {
  if (state.intentionallyClosed) {
    console.log('🛑 [GoldWS] Connection intentionally closed, skipping reconnect');
    return;
  }

  if (state.isConnecting) {
    console.log('ℹ️ [GoldWS] Tiingo websocket connection already in progress');
    return;
  }

  if (state.closingSocket) {
    console.log('ℹ️ [GoldWS] Waiting for previous Tiingo socket to terminate before reconnecting');
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

  state.isConnecting = true;
  notifyStatus('reconnecting');

  const apiKey = getTiingoApiKey();
  state.apiKey = apiKey;

  if (state.intentionallyClosed) {
    state.isConnecting = false;
    return;
  }

  if (state.ws || state.closingSocket) {
    console.log('ℹ️ [GoldWS] Tiingo socket state changed while loading API key, skipping stale connect attempt');
    state.isConnecting = false;
    return;
  }

  if (!apiKey) {
    console.error('❌ [GoldWS] Tiingo API key missing (EXPO_PUBLIC_TIINGO_API_KEY not set)');
    state.isConnecting = false;
    state.isConnected = false;
    notifyStatus('disconnected');
    startRestFallbackIfNeeded();
    return;
  }

  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  state.connectStartedAt = Date.now();
  state.lastMessageTime = 0;
  state.lastTickTime = 0;
  state.hasReceivedTradeOnActiveConnection = false;
  console.log(`🔌 [GoldWS] Connecting to Tiingo FX WebSocket (connection ${connectionId})...`);

  let socket: WebSocket;
  try {
    socket = new WebSocket(TIINGO_WS_URL);
  } catch (error) {
    state.isConnecting = false;
    console.error('❌ [GoldWS] Tiingo WebSocket constructor failed:', error);
    scheduleReconnect('constructor-failed', RECONNECT_DELAY_MS);
    return;
  }

  state.ws = socket;

  socket.onopen = () => {
    if (state.ws !== socket) {
      console.log(`ℹ️ [GoldWS] Ignoring stale Tiingo onopen for connection ${connectionId}`);
      return;
    }

    console.log(`✅ [GoldWS] Tiingo FX WebSocket connected (connection ${connectionId})`);
    state.isConnecting = false;
    state.isConnected = true;
    state.connectStartedAt = 0;
    state.lastMessageTime = Date.now();

    const subscribeMessage = {
      eventName: 'subscribe',
      authorization: apiKey,
      eventData: {
        thresholdLevel: TIINGO_THRESHOLD_LEVEL,
        tickers: [TIINGO_FX_TICKER],
      },
    };

    try {
      socket.send(JSON.stringify(subscribeMessage));
      console.log(`📡 [GoldWS] Subscribed to ${TIINGO_FX_TICKER} on Tiingo FX (connection ${connectionId})`);
    } catch (error) {
      console.error('❌ [GoldWS] Tiingo subscribe send failed:', error);
      requestSocketRecycle('subscribe-send-failed', RECONNECT_DELAY_MS);
      return;
    }

    startWatchdog();
    startHeartbeatPing(socket, connectionId);
    resetConnectionAliveTimer(connectionId, 'socket-open');
    notifyStatus('waiting_for_trade');
  };

  socket.onmessage = (event: MessageEvent) => {
    if (state.ws !== socket) {
      return;
    }

    const rawData = typeof event.data === 'string' ? event.data : String(event.data ?? '');
    state.lastMessageTime = Date.now();
    resetConnectionAliveTimer(connectionId, 'incoming-message');

    try {
      const message = JSON.parse(rawData) as Record<string, unknown>;
      const messageType = message.messageType as string | undefined;
      const response = message.response as Record<string, unknown> | undefined;

      if (messageType === 'I') {
        console.log(`ℹ️ [GoldWS] Tiingo info message:`, response?.message ?? rawData.slice(0, 200));
        if (!state.hasReceivedTradeOnActiveConnection) {
          notifyStatus('waiting_for_trade');
        }
        return;
      }

      if (messageType === 'H') {
        state.lastHeartbeatResponseAt = Date.now();
        state.heartbeatMissCount = 0;
        const rttMs = state.lastHeartbeatSentAt > 0 ? Date.now() - state.lastHeartbeatSentAt : 0;
        console.log(`💓 [GoldWS] Heartbeat response received (RTT=${rttMs}ms, connection ${connectionId})`);
        if (!state.hasReceivedTradeOnActiveConnection) {
          notifyStatus('waiting_for_trade');
        }
        return;
      }

      if (messageType === 'E') {
        console.error(`❌ [GoldWS] Tiingo error message:`, response?.message ?? rawData.slice(0, 300));
        return;
      }

      if (messageType === 'A') {
        const data = message.data as unknown[];
        if (!Array.isArray(data) || data.length < 2) {
          console.warn('⚠️ [GoldWS] Tiingo A-message missing data array');
          return;
        }

        const updateType = data[0] as string;
        const ticker = typeof data[1] === 'string' ? data[1].toLowerCase() : '';

        if (ticker !== TIINGO_FX_TICKER) {
          return;
        }

        let parsedPrice: number | null = null;
        let updateLabel = updateType;

        if (updateType === 'Q') {
          parsedPrice = parseTiingoQuotePrice(data);
          state.quotesReceivedCount += 1;
          state.lastQuoteTime = Date.now();
          updateLabel = 'Q';
        } else if (updateType === 'T') {
          parsedPrice = parseTiingoTradePrice(data);
          state.tradesReceivedCount += 1;
          updateLabel = 'T';
        }

        if (parsedPrice === null) {
          console.warn(`⚠️ [GoldWS] Could not parse Tiingo ${updateType} price`, { connectionId, data: data.slice(0, 8) });
          return;
        }

        state.lastTickTime = Date.now();
        state.lastWsTradeTime = Date.now();
        state.hasReceivedTradeOnActiveConnection = true;
        notifyPrice(parsedPrice, `${TIINGO_LIVE_SOURCE} (${updateLabel})`);
        notifyStatus('connected');
        stopRestFallback();

        if (state.quotesReceivedCount % 30 === 0 || updateType === 'T') {
          console.log(`⚡ [GoldWS] Tiingo ${updateLabel} ${parsedPrice.toFixed(2)} | ticker=${ticker} | Q:${state.quotesReceivedCount} T:${state.tradesReceivedCount}`);
        }
        return;
      }

      console.log(`ℹ️ [GoldWS] Tiingo unknown messageType=${messageType}:`, rawData.slice(0, 200));
    } catch (error) {
      console.warn('⚠️ [GoldWS] Failed to parse Tiingo websocket message:', error);
      if (!state.hasReceivedTradeOnActiveConnection) {
        notifyStatus('waiting_for_trade');
      }
    }
  };

  socket.onerror = (event: Event) => {
    if (state.ws !== socket) {
      return;
    }

    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.warn('⚠️ [GoldWS] Tiingo websocket error', diagnostics);
    state.isConnecting = false;
    state.isConnected = false;
    state.hasReceivedTradeOnActiveConnection = false;
    stopHeartbeatPing();
    stopConnectionAliveTimer();
    requestSocketRecycle('transport-error', RECONNECT_DELAY_MS);
  };

  socket.onclose = (event: CloseEvent) => {
    const isActiveSocket = state.ws === socket;
    const isClosingSocket = state.closingSocket === socket;
    const diagnostics = getEventDiagnostics(event, socket, connectionId);
    console.log('🔌 [GoldWS] Tiingo WebSocket closed', diagnostics);

    if (isActiveSocket) {
      state.ws = null;
    }

    if (isClosingSocket) {
      state.closingSocket = null;
    }

    state.isConnecting = false;
    state.isConnected = false;
    state.connectStartedAt = 0;
    state.hasReceivedTradeOnActiveConnection = false;
    stopWatchdog();
    stopHeartbeatPing();
    stopConnectionAliveTimer();

    if (state.intentionallyClosed) {
      notifyStatus('disconnected');
      return;
    }

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
    if (state.ws || state.closingSocket || state.reconnectTimer || state.isConnecting) {
      console.log('ℹ️ [GoldWS] Tiingo websocket service already active, skipping duplicate start');
      return;
    }

    state.intentionallyClosed = false;
    state.wsStartTime = Date.now();
    console.log('🚀 [GoldWS] Starting Tiingo FX websocket service for XAU/USD...');

    console.log('🔄 [GoldWS] Fetching immediate REST price while WebSocket connects...');
    void fetchRestFallbackPrice().then((result) => {
      if (result && !state.intentionallyClosed && state.lastPrice <= 0) {
        console.log(`✅ [GoldWS] Immediate REST bootstrap price: ${result.price} from ${result.source}`);
        notifyPrice(result.price, `🟠 ${result.source} (bootstrap)`);
      }
    }).catch(() => {});

    void connect();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping Tiingo websocket service');
    state.intentionallyClosed = true;
    stopRestFallback();
    stopWatchdog();
    stopHeartbeatPing();
    stopConnectionAliveTimer();
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
        console.warn('⚠️ [GoldWS] Error closing Tiingo socket:', error);
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
        console.warn('⚠️ [GoldWS] Error closing pending Tiingo socket:', error);
      }
    }

    state.lastTickTime = 0;
    state.lastMessageTime = 0;
    state.connectStartedAt = 0;
    state.isConnecting = false;
    state.isConnected = false;
    state.hasReceivedTradeOnActiveConnection = false;
    state.wsStartTime = 0;
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
