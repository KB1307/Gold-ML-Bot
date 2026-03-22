import { getRuntimeFinnhubApiKey } from '@/lib/finnhub';

type PriceCallback = (price: number, source: string) => void;
type ConnectionStatus = 'connected' | 'waiting_for_trade' | 'disconnected' | 'reconnecting';
type StatusCallback = (status: ConnectionStatus) => void;

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
}

const WATCHDOG_INTERVAL_MS = 1000;
const CONNECT_TIMEOUT_MS = 15000;
const CONNECTION_ALIVE_TIMEOUT_MS = 60000;
const HEARTBEAT_PING_INTERVAL_MS = 20000;
const RECONNECT_DELAY_MS = 5000;
const FINNHUB_SYMBOL = 'OANDA:XAU_USD';
const FINNHUB_LIVE_SOURCE = '🟢 Finnhub-Live';

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
};

async function getFinnhubApiKey(): Promise<string | null> {
  const runtimeConfig = await getRuntimeFinnhubApiKey();
  const apiKey = runtimeConfig.apiKey?.trim() ?? null;

  if (!apiKey) {
    console.error(`❌ [GoldWS] Finnhub API key missing (source=${runtimeConfig.source})`);
    return null;
  }

  console.log(`🔑 [GoldWS] Using Finnhub key from ${runtimeConfig.source}`);
  return apiKey;
}

function getFinnhubWebSocketUrl(apiKey: string): string {
  return `wss://ws.finnhub.io?token=${encodeURIComponent(apiKey)}`;
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

    console.warn(`⚠️ [GoldWS] No Finnhub message received for ${(silenceDurationMs / 1000).toFixed(1)}s — reconnecting socket`);
    requestSocketRecycle('connection-alive-timeout', RECONNECT_DELAY_MS);
  }, CONNECTION_ALIVE_TIMEOUT_MS);

  console.log(`💓 [GoldWS] Connection alive timer reset (${reason}) for connection ${connectionId}`);
}

function startHeartbeatPing(socket: WebSocket, connectionId: number): void {
  stopHeartbeatPing();

  state.heartbeatPingTimer = setInterval(() => {
    if (state.intentionallyClosed || state.ws !== socket) {
      return;
    }

    if (socket.readyState !== WebSocket.OPEN) {
      console.log(`ℹ️ [GoldWS] Skipping Finnhub ping because socket state=${getReadyStateLabel(socket.readyState)} (connection ${connectionId})`);
      return;
    }

    try {
      socket.send(JSON.stringify({ type: 'ping' }));
      console.log(`🏓 [GoldWS] Sent Finnhub ping (connection ${connectionId})`);
    } catch (error) {
      console.warn(`⚠️ [GoldWS] Finnhub ping send failed (connection ${connectionId})`, error);
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
  console.log(`🔄 [GoldWS] Scheduling Finnhub reconnect in ${(delayMs / 1000).toFixed(1)}s (reason=${reason})`);
  notifyStatus('reconnecting');

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

  console.warn(`⚠️ [GoldWS] Recycling Finnhub socket (reason=${reason}, reconnectDelay=${delayMs}ms)`);
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
    const connectDuration = state.connectStartedAt > 0 ? Date.now() - state.connectStartedAt : 0;

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
        requestSocketRecycle('watchdog-connect-timeout', RECONNECT_DELAY_MS);
      }
      return;
    }

    if (socket.readyState === WebSocket.CLOSED) {
      console.warn('⚠️ [GoldWS] Watchdog detected closed Finnhub socket');
      scheduleReconnect('watchdog-closed-socket', RECONNECT_DELAY_MS);
    }
  }, WATCHDOG_INTERVAL_MS);
}

async function connect(): Promise<void> {
  if (state.intentionallyClosed) {
    console.log('🛑 [GoldWS] Connection intentionally closed, skipping reconnect');
    return;
  }

  if (state.isConnecting) {
    console.log('ℹ️ [GoldWS] Finnhub websocket connection already in progress');
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

  state.isConnecting = true;
  notifyStatus('reconnecting');

  const apiKey = await getFinnhubApiKey();
  state.apiKey = apiKey;

  if (state.intentionallyClosed) {
    state.isConnecting = false;
    return;
  }

  if (state.ws || state.closingSocket) {
    console.log('ℹ️ [GoldWS] Finnhub socket state changed while loading API key, skipping stale connect attempt');
    state.isConnecting = false;
    return;
  }

  if (!apiKey) {
    state.isConnecting = false;
    state.isConnected = false;
    notifyStatus('disconnected');
    return;
  }

  const connectionId = state.connectionId + 1;
  state.connectionId = connectionId;
  state.connectStartedAt = Date.now();
  state.lastMessageTime = 0;
  state.lastTickTime = 0;
  state.hasReceivedTradeOnActiveConnection = false;
  console.log(`🔌 [GoldWS] Connecting to Finnhub WebSocket (connection ${connectionId})...`);

  let socket: WebSocket;
  try {
    socket = new WebSocket(getFinnhubWebSocketUrl(apiKey));
  } catch (error) {
    state.isConnecting = false;
    console.error('❌ [GoldWS] Finnhub WebSocket constructor failed:', error);
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
    state.isConnecting = false;
    state.isConnected = true;
    state.connectStartedAt = 0;
    state.lastMessageTime = Date.now();

    try {
      socket.send(JSON.stringify({ type: 'subscribe', symbol: FINNHUB_SYMBOL }));
      console.log(`📡 [GoldWS] Subscribed to ${FINNHUB_SYMBOL} on Finnhub (connection ${connectionId})`);
    } catch (error) {
      console.error('❌ [GoldWS] Finnhub subscribe send failed:', error);
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
    console.log(`💬 [GoldWS] Finnhub message received (connection ${connectionId}): ${rawData.slice(0, 200)}`);

    try {
      const data = JSON.parse(rawData) as FinnhubWebSocketMessage;

      if (data.type !== 'trade') {
        if (!state.hasReceivedTradeOnActiveConnection) {
          notifyStatus('waiting_for_trade');
        }
        console.log('ℹ️ [GoldWS] Finnhub control/heartbeat message:', data);
        return;
      }

      if (!Array.isArray(data.data) || data.data.length === 0) {
        console.warn('⚠️ [GoldWS] Finnhub trade message missing data array', data);
        if (!state.hasReceivedTradeOnActiveConnection) {
          notifyStatus('waiting_for_trade');
        }
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
      state.hasReceivedTradeOnActiveConnection = true;
      notifyPrice(roundedPrice, FINNHUB_LIVE_SOURCE);
      notifyStatus('connected');

      if (Number.isFinite(latencyMs)) {
        console.log(`⚡ [GoldWS] Finnhub trade ${roundedPrice.toFixed(2)} | latency=${latencyMs}ms | symbol=${tradeSymbol || FINNHUB_SYMBOL}`);
      } else {
        console.log(`⚡ [GoldWS] Finnhub trade ${roundedPrice.toFixed(2)} | latency=unknown | symbol=${tradeSymbol || FINNHUB_SYMBOL}`);
      }
    } catch (error) {
      console.warn('⚠️ [GoldWS] Failed to parse Finnhub websocket message:', error);
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
    console.warn('⚠️ [GoldWS] Finnhub websocket error', diagnostics);
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
    console.log('🔌 [GoldWS] Finnhub WebSocket closed', diagnostics);

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
      console.log('ℹ️ [GoldWS] Finnhub websocket service already active, skipping duplicate start');
      return;
    }

    state.intentionallyClosed = false;
    void connect();
  },

  stop(): void {
    console.log('🛑 [GoldWS] Stopping Finnhub websocket service');
    state.intentionallyClosed = true;
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
    state.isConnecting = false;
    state.isConnected = false;
    state.hasReceivedTradeOnActiveConnection = false;
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
    return false;
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
