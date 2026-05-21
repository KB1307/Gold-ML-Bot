import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine, setExternalPrice, fetchLiveGoldPriceFallback } from "@/services/signalEngine";
import { Platform } from "react-native";
import { fetchHistoricalData } from "@/lib/trpc";
import { goldWebSocketService } from "@/services/goldWebSocketService";
import { 
  registerBackgroundTask, 
  setupNotificationChannel, 
  requestNotificationPermissions,
  sendSignalNotification
} from "@/services/backgroundTaskService";
import { subscribeToChartPrice, subscribeToChartHeartbeat } from "@/services/chartPriceBridge";
import { ensureBarStoreReady, ingestTickAllTimeframes, upsertBars, getBars, getBarStoreStats, pruneOldBars, getLatestBarTimestamp } from "@/services/barStore";
import { resolveSignalWithBars } from "@/services/signalResolver";

const INDEPENDENT_POLL_INTERVAL_MS = 12000;
const INDEPENDENT_POLL_NO_PRICE_INTERVAL_MS = 5000;
const PRICE_STALE_THRESHOLD_FOR_POLL_MS = 20000;

const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 30,
  tp2Pips: 60,
  tp3Pips: 90,
  slPips: 70,
  numberOfTPs: 3,
  minConfidence: 0.68,
  enableNotifications: true,
  basePositionSize: 0.01,
  maxRiskPercentage: 2.0,
  useKellyCriterion: true,
  useDynamicSL: true,
  maxSLPips: 90,
};

const DEFAULT_METRICS: PerformanceMetrics = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  totalProfit: 0,
  totalLoss: 0,
  maxDrawdown: 0,
  currentDrawdown: 0,
  sharpeRatio: 0,
  profitFactor: 0,
  winRate: 0,
  averageWin: 0,
  averageLoss: 0,
  expectancy: 0,
};

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface SignalTrackingSnapshot {
  price: number;
  source: string;
  updatedAt: number;
}

const CHART_PRICE_PRIORITY_WINDOW_MS = 15000;
const CHART_STALL_FAILOVER_MS = 20000;
const GUIDE_PRICE_STALE_THRESHOLD_MS = 12000;
const MIN_MEANINGFUL_PRICE_CHANGE = 0.03;
const HISTORICAL_RECONCILIATION_INTERVAL_MS = 30000;
const TERMINAL_SIGNAL_STATUSES: SignalStatus[] = ["CLOSED", "SL_HIT", "SL_AFTER_BE", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT"];
const ENFORCED_MIN_SIGNAL_CONFIDENCE = 0.68;

// False-SL protection thresholds.
// A single glitch tick that pokes 0.1 pips past SL for 0 ms was closing
// trades as losses (and poisoning the 1m bar store) even when the underlying
// market never printed that price. Two independent guards now apply:
//   1. BAR-INGEST SPIKE FILTER (see commitSignalPrice) drops outlier ticks
//      BEFORE they can be written into the OHLC bar store, so the historical
//      resolver can't later "confirm" a false SL from a corrupted wick.
//   2. LIVE SL CONFIRMATION now requires a sustained breach: at least
//      SL_CONFIRMATION_MIN_PENETRATION_PIPS past SL for at least
//      SL_CONFIRMATION_MIN_DURATION_MS of elapsed time AND at least
//      SL_CONFIRMATION_MIN_TICKS independent ticks past SL.
const SL_CONFIRMATION_MIN_PENETRATION_PIPS = 1.5;
const SL_CONFIRMATION_MIN_DURATION_MS = 2500;
const SL_CONFIRMATION_MIN_TICKS = 2;
const TICK_SPIKE_REJECT_PIPS = 8.0;
const TICK_SPIKE_WINDOW_MS = 500;
// Profit-lock after TP1: replaces the previous cosmetic "breakeven" indicator
// with a real trailing stop. Once TP1 is achieved, the effective SL becomes
// entry + 15 pips (BUY) or entry - 15 pips (SELL). If price retraces to that
// level, the trade closes as SL_AFTER_BE banking TP1 + 15 pip lock (WIN).
const POST_TP1_PROFIT_LOCK_PIPS = 15;
const PIP_VALUE = 0.1;
const ACTIVE_SIGNAL_LOCK_RELEASE_MS = 45 * 60 * 1000;
const SIGNAL_GENERATION_INTERVAL_MS = 20000;

function clampSignalConfidenceThreshold(value: number): number {
  return Number(Math.min(0.98, Math.max(ENFORCED_MIN_SIGNAL_CONFIDENCE, value)).toFixed(2));
}

function sanitizeSettings(settings: Settings): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    minConfidence: clampSignalConfidenceThreshold(settings.minConfidence ?? DEFAULT_SETTINGS.minConfidence),
    maxSLPips: typeof settings.maxSLPips === 'number' && Number.isFinite(settings.maxSLPips) ? settings.maxSLPips : DEFAULT_SETTINGS.maxSLPips,
    useDynamicSL: typeof settings.useDynamicSL === 'boolean' ? settings.useDynamicSL : DEFAULT_SETTINGS.useDynamicSL,
  };
}

export function getPostTP1LockPrice(signal: TradingSignal): number {
  const delta = POST_TP1_PROFIT_LOCK_PIPS * PIP_VALUE;
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}

function getProtectedExitPrice(signal: TradingSignal, targetsHit: number): number {
  const normalizedTargetsHit = Math.max(0, Math.min(2, targetsHit));

  if (normalizedTargetsHit >= 2) {
    return Number(((signal.tp1 + signal.tp2 + signal.entryPrice) / 3).toFixed(1));
  }

  if (normalizedTargetsHit === 1) {
    // Post-TP1 protected exit = 15 pip profit lock (entry +/- 15 pips).
    // This banks TP1 runner + 15 pip lock when price retraces past the lock.
    return getPostTP1LockPrice(signal);
  }

  return signal.entryPrice;
}

export function getEffectiveExitPrice(signal: TradingSignal): number {
  switch (signal.status) {
    case "ALL_TARGETS_HIT":
    case "TP3_HIT":
      return signal.tp3;
    case "PARTIAL_WIN_SL_HIT":
      return getProtectedExitPrice(signal, Math.max(signal.targetsHit, 2));
    case "SL_AFTER_BE":
      return getProtectedExitPrice(signal, Math.max(signal.targetsHit, 1));
    case "TP2_HIT":
      return signal.exitPrice ?? getProtectedExitPrice(signal, 2);
    case "TP1_HIT":
      return signal.exitPrice ?? getProtectedExitPrice(signal, 1);
    case "SL_HIT":
      return signal.sl;
    case "CLOSED":
      return signal.exitPrice ?? signal.entryPrice;
    case "EXPIRED_MISSED_ENTRY":
      return signal.entryPrice;
    default:
      return signal.exitPrice ?? signal.entryPrice;
  }
}

export function computeSignalPnL(signal: TradingSignal, basePositionSize: number): number {
  const terminalStatuses: SignalStatus[] = [
    "ALL_TARGETS_HIT",
    "TP3_HIT",
    "PARTIAL_WIN_SL_HIT",
    "SL_AFTER_BE",
    "SL_HIT",
    "CLOSED",
    "EXPIRED_MISSED_ENTRY",
  ];
  if (!terminalStatuses.includes(signal.status)) return 0;

  const exit = getEffectiveExitPrice(signal);
  const contractSize = 100;
  const directional = signal.type === "BUY" ? exit - signal.entryPrice : signal.entryPrice - exit;
  return directional * basePositionSize * contractSize;
}

function areMarketSessionsEqual(left: MarketOutlook["sessions"], right: MarketOutlook["sessions"]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((session, index) => {
    const rightSession = right[index];
    return session.name === rightSession?.name && session.isActive === rightSession?.isActive;
  });
}

function areMarketOutlooksEqual(previousValue: MarketOutlook | null, nextValue: MarketOutlook): boolean {
  if (!previousValue) {
    return false;
  }

  return (
    previousValue.isMarketOpen === nextValue.isMarketOpen &&
    previousValue.currentSession === nextValue.currentSession &&
    previousValue.trend === nextValue.trend &&
    previousValue.volatility === nextValue.volatility &&
    previousValue.dailyPivot === nextValue.dailyPivot &&
    previousValue.r1 === nextValue.r1 &&
    previousValue.r2 === nextValue.r2 &&
    previousValue.r3 === nextValue.r3 &&
    previousValue.s1 === nextValue.s1 &&
    previousValue.s2 === nextValue.s2 &&
    previousValue.s3 === nextValue.s3 &&
    areMarketSessionsEqual(previousValue.sessions, nextValue.sessions)
  );
}

export const [TradingProvider, useTrading] = createContextHook(() => {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(true);
  const [signalHistory, setSignalHistory] = useState<TradingSignal[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [marketOutlook, setMarketOutlook] = useState<MarketOutlook | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>(DEFAULT_METRICS);
  const [positionSizing, setPositionSizing] = useState<PositionSizing | null>(null);
  const [accountBalance, setAccountBalance] = useState<number>(100);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [currentPriceUpdatedAt, setCurrentPriceUpdatedAt] = useState<number>(0);
  const [chartPrice, setChartPrice] = useState<number>(0);
  const [chartPriceUpdatedAt, setChartPriceUpdatedAt] = useState<number>(0);
  const [guidePrice, setGuidePrice] = useState<number>(0);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);
  const [dailyOHLCHistory, setDailyOHLCHistory] = useState<DailyOHLC[]>([]);
  const [signalUpdateTrigger, setSignalUpdateTrigger] = useState<number>(0);
  const [appLaunchTime] = useState<number>(Date.now());
  const [backgroundTaskActive, setBackgroundTaskActive] = useState<boolean>(false);
  const [priceSource, setPriceSource] = useState<string>('connecting...');
  const [chartPriceSource, setChartPriceSource] = useState<string>('connecting...');
  const [guidePriceSource, setGuidePriceSource] = useState<string>('connecting...');
  const [guidePriceUpdatedAt, setGuidePriceUpdatedAt] = useState<number>(0);
  const [livePriceError, setLivePriceError] = useState<string | null>(null);
  const chartPriceHeartbeatRef = useRef<number>(0);
  const lastChartPriceRef = useRef<number>(0);
  const chartPriceLastMeaningfulMoveRef = useRef<number>(0);
  const historicalReconciliationInFlightRef = useRef<boolean>(false);
  const signalHistoryRef = useRef<TradingSignal[]>([]);
  const signalTrackingSnapshotRef = useRef<SignalTrackingSnapshot>({
    price: 0,
    source: '🔴 no live price',
    updatedAt: 0,
  });
  const historicalFallbackPriceRef = useRef<number>(0);
  const guidePriceRef = useRef<number>(0);
  const guidePriceUpdatedAtRef = useRef<number>(0);
  const wsConnectedRef = useRef<boolean>(false);
  // Per-signal SL breach tracking (in-memory). Key = signal.id.
  // Tracks when price first broke the SL; we only confirm SL_HIT after the
  // required duration AND minimum penetration are satisfied.
  const slBreachTrackerRef = useRef<Map<string, { firstBreachAt: number; maxPenetrationPips: number; lastPrice: number; tickCount: number }>>(new Map());
  // Last accepted signal-tracking price/time, used for spike rejection.
  const lastAcceptedTickRef = useRef<{ price: number; at: number }>({ price: 0, at: 0 });
  // Last accepted BAR-ingest price/time, used to reject outlier ticks before
  // they poison the OHLC bar store (which audits rely on).
  const lastAcceptedBarTickRef = useRef<{ price: number; at: number }>({ price: 0, at: 0 });
  // Debounced AsyncStorage writer for signal_history. High-frequency tick-driven
  // updaters (status monitor, reconciliation interval) were each writing the
  // entire history JSON on every change. We coalesce those writes into a single
  // flush ~400ms later so the UI thread isn't blocked by repeated stringify+IO.
  const pendingHistoryWriteRef = useRef<TradingSignal[] | null>(null);
  const historyWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushHistoryWrite = useCallback(async (): Promise<void> => {
    const payload = pendingHistoryWriteRef.current;
    if (!payload) return;
    pendingHistoryWriteRef.current = null;
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
      historyWriteTimerRef.current = null;
    }
    try {
      await AsyncStorage.setItem('signal_history', JSON.stringify(payload));
    } catch (err) {
      console.error('❌ Failed to persist signal history (debounced):', err);
    }
  }, []);
  const persistSignalHistory = useCallback((history: TradingSignal[], options?: { immediate?: boolean }) => {
    pendingHistoryWriteRef.current = history;
    if (options?.immediate) {
      void flushHistoryWrite();
      return;
    }
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
    }
    historyWriteTimerRef.current = setTimeout(() => {
      historyWriteTimerRef.current = null;
      void flushHistoryWrite();
    }, 400);
  }, [flushHistoryWrite]);

  useEffect(() => {
    const init = async () => {
      console.log('🚀 Initializing Trading Context...');
      try {
        await ensureBarStoreReady();
        await pruneOldBars();
        try {
          const stats = await getBarStoreStats();
          console.log('🗄️ [BarStore] stats at init:', stats);
        } catch (err) {
          console.warn('⚠️ [BarStore] stats lookup failed:', err);
        }
        const loadedDailyOHLC = await signalEngine.loadPersistedLearningData();
        await loadPersistedData();
        if (loadedDailyOHLC && loadedDailyOHLC.length > 0) {
          setDailyOHLCHistory(loadedDailyOHLC);
        }

        if (Platform.OS !== 'web') {
          console.log('📱 Setting up mobile features...');
          await setupNotificationChannel();
          await requestNotificationPermissions();
          
          if (settings.enableNotifications) {
            const registered = await registerBackgroundTask();
            setBackgroundTaskActive(registered);
            
            if (registered) {
              console.log('✅ Background signal generation active');
              console.log('   - App will generate signals even when closed');
              console.log('   - Push notifications enabled');
            }
          }
        }

        console.log('✅ Trading Context initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize Trading Context:', error);
        setIsLoading(false);
      }
    };
    void init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitSignalPrice = useCallback((price: number, source: string, options?: { markChartFresh?: boolean }) => {
    setExternalPrice(price, source);
    setCurrentPrice(price);
    setPriceSource(source);
    setLivePriceError(null);

    const now = Date.now();
    setCurrentPriceUpdatedAt(now);

    if (options?.markChartFresh) {
      setChartPrice(price);
      setChartPriceSource(source);
      setChartPriceUpdatedAt(now);
    }

    setPriceHistory(prev => {
      const newHistory = [...prev, { timestamp: now, price }];
      const maxPoints = 60;
      if (newHistory.length > maxPoints) {
        return newHistory.slice(newHistory.length - maxPoints);
      }
      return newHistory;
    });

    // BAR-INGEST SPIKE FILTER: reject outlier ticks BEFORE they get written
    // into the OHLC bar store. A single glitchy tick that jumped >8 pips in
    // <500ms was contaminating the 1m bar's high/low, which then made the
    // historical resolver "confirm" false SL wicks during the audit. We drop
    // those ticks from the bar store while still allowing them to update the
    // on-screen price (no user-visible regression).
    const barLast = lastAcceptedBarTickRef.current;
    let allowBarIngest = true;
    if (barLast.price > 0 && barLast.at > 0) {
      const dtMsBar = now - barLast.at;
      const gapPipsBar = Math.abs(price - barLast.price) / PIP_VALUE;
      if (dtMsBar < TICK_SPIKE_WINDOW_MS && gapPipsBar > TICK_SPIKE_REJECT_PIPS) {
        console.warn(`🛡️ [BarStore] Dropping spike tick ${price.toFixed(1)} (${gapPipsBar.toFixed(1)} pips in ${dtMsBar}ms from ${barLast.price.toFixed(1)}) - not ingesting into bars to avoid corrupting audits`);
        allowBarIngest = false;
      }
    }
    if (allowBarIngest) {
      lastAcceptedBarTickRef.current = { price, at: now };
      void ingestTickAllTimeframes(price, now).catch(err => {
        console.warn('⚠️ [BarStore] tick ingest failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
      });
    }

    signalEngine.updateDailyOHLC(price).then(updatedOHLC => {
      if (!updatedOHLC) return;
      setDailyOHLCHistory(prev => {
        const existingIndex = prev.findIndex(d => d.date === updatedOHLC.date);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = updatedOHLC;
          return updated;
        }
        const newHistory = [...prev, updatedOHLC];
        if (newHistory.length > 30) {
          return newHistory.slice(-30);
        }
        return newHistory;
      });
    }).catch(err => {
      console.warn('⚠️ Daily OHLC update failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
    });
  }, []);

  const commitGuidePrice = useCallback((price: number, source: string) => {
    guidePriceRef.current = price;
    guidePriceUpdatedAtRef.current = Date.now();
    setGuidePrice(price);
    setGuidePriceSource(source);
    setGuidePriceUpdatedAt(Date.now());
  }, []);

  const applyLivePrice = useCallback((price: number, source: string, origin: "chart" | "feed") => {
    if (price <= 1000 || price > 10000 || Number.isNaN(price)) {
      console.warn(`⚠️ Ignoring invalid ${origin} price: ${price}`);
      return;
    }

    const now = Date.now();
    const isChartFeedFresh = chartPriceHeartbeatRef.current > 0 && (now - chartPriceHeartbeatRef.current) < CHART_PRICE_PRIORITY_WINDOW_MS;
    const chartFeedLooksStalled = chartPriceLastMeaningfulMoveRef.current > 0 && (now - chartPriceLastMeaningfulMoveRef.current) >= CHART_STALL_FAILOVER_MS;

    if (origin === "chart") {
      chartPriceHeartbeatRef.current = now;

      if (lastChartPriceRef.current <= 0 || Math.abs(price - lastChartPriceRef.current) >= MIN_MEANINGFUL_PRICE_CHANGE) {
        chartPriceLastMeaningfulMoveRef.current = now;
      }

      lastChartPriceRef.current = price;
      commitSignalPrice(price, source, { markChartFresh: true });
      return;
    }

    if (isChartFeedFresh && !chartFeedLooksStalled) {
      console.log(`ℹ️ Ignoring ${source} tick because TradingView chart price is active`);
      return;
    }

    if (isChartFeedFresh && chartFeedLooksStalled) {
      console.warn(`⚠️ Promoting ${source} tick because TradingView chart price appears stalled`);
      commitSignalPrice(price, `${source} • chart-failover`);
      return;
    }

    commitSignalPrice(price, source);
  }, [commitSignalPrice]);

  const ingestChartPrice = useCallback((price: number, source: string = 'tradingview-chart') => {
    const normalizedSource = source.startsWith('🟢') ? source : `🟢 ${source}`;
    applyLivePrice(price, normalizedSource, "chart");

    const now = Date.now();
    const lastGuidePriceAt = guidePriceUpdatedAtRef.current;
    const lastGuidePrice = guidePriceRef.current;
    const guideFeedStale = lastGuidePriceAt <= 0 || (now - lastGuidePriceAt) > GUIDE_PRICE_STALE_THRESHOLD_MS;
    const guidePriceZero = lastGuidePrice <= 0;
    const wsDown = !wsConnectedRef.current;

    if (guidePriceZero || guideFeedStale || wsDown) {
      console.log(`📊 [GuidePrice] Promoting chart price ${price.toFixed(2)} to guide (${guidePriceZero ? 'no guide price' : guideFeedStale ? `stale ${((now - lastGuidePriceAt) / 1000).toFixed(1)}s` : 'WS down'})`);
      commitGuidePrice(price, normalizedSource);
    }
  }, [applyLivePrice, commitGuidePrice]);

  useEffect(() => {
    console.log('📈 Subscribing to TradingView chart price bridge...');
    const unsubscribe = subscribeToChartPrice((price: number, source: string) => {
      ingestChartPrice(price, source);
    });

    return () => {
      console.log('📉 Unsubscribing from TradingView chart price bridge...');
      unsubscribe();
    };
  }, [ingestChartPrice]);

  useEffect(() => {
    let isMounted = true;

    console.log('🔌 Starting Swissquote live price feed...');

    const unsubPrice = goldWebSocketService.onPrice((price: number, source: string) => {
      if (!isMounted) return;
      wsConnectedRef.current = true;
      commitGuidePrice(price, source);
      applyLivePrice(price, source, 'feed');
    });

    const unsubStatus = goldWebSocketService.onStatus((status) => {
      if (!isMounted) return;

      console.log(`📡 Price feed status: ${status}`);

      if (status === 'connected') {
        wsConnectedRef.current = true;
        const lastGuidePrice = goldWebSocketService.getLastPrice();
        const lastGuidePriceSource = goldWebSocketService.getLastPriceSource();

        if (lastGuidePrice > 0) {
          commitGuidePrice(lastGuidePrice, lastGuidePriceSource);
        } else {
          setGuidePriceSource('🟢 Swissquote-Live');
        }
      } else if (status === 'waiting_for_trade') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0) {
          setGuidePriceSource('🟠 Waiting for Data');
        }
      } else if (status === 'disconnected') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0) {
          setGuidePriceSource('🔴 Disconnected');
        }
      } else if (status === 'reconnecting') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0 && !goldWebSocketService.isRestFallbackActive()) {
          setGuidePriceSource('🔴 Reconnecting...');
        }
      }
    });

    goldWebSocketService.start();

    return () => {
      isMounted = false;
      wsConnectedRef.current = false;
      unsubPrice();
      unsubStatus();
      goldWebSocketService.stop();
    };
  }, [commitGuidePrice, applyLivePrice]);

  useEffect(() => {
    const CHART_GUIDE_PROMOTION_INTERVAL_MS = 5000;
    const timer = setInterval(() => {
      const now = Date.now();
      const chartPx = lastChartPriceRef.current;
      const chartFresh = chartPriceHeartbeatRef.current > 0 && (now - chartPriceHeartbeatRef.current) < 15000;
      const guidePx = guidePriceRef.current;
      const guideAt = guidePriceUpdatedAtRef.current;
      const guideStale = guideAt <= 0 || (now - guideAt) > GUIDE_PRICE_STALE_THRESHOLD_MS;
      const wsUp = wsConnectedRef.current;

      if (chartPx > 1000 && chartFresh && (guidePx <= 0 || (guideStale && !wsUp))) {
        console.log(`🔄 [GuidePromoTimer] Promoting chart price ${chartPx.toFixed(2)} to guide (guidePx=${guidePx.toFixed(2)}, guideStale=${guideStale}, wsUp=${wsUp})`);
        commitGuidePrice(chartPx, '🟢 TradingView (auto)');
      }
    }, CHART_GUIDE_PROMOTION_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [commitGuidePrice]);

  useEffect(() => {
    const unsubHeartbeat = subscribeToChartHeartbeat((isAlive, lastPriceAt, _lastPrice) => {
      if (!isAlive && lastPriceAt > 0) {
        const staleSec = ((Date.now() - lastPriceAt) / 1000).toFixed(1);
        console.log(`💔 [ChartHeartbeat] Chart feed stale for ${staleSec}s — Tiingo feed is active backup`);
      }
    });

    return () => {
      unsubHeartbeat();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void updateMarketOutlook();
    }, 5000);

    void updateMarketOutlook();

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let isMounted = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveSuccesses = 0;

    const runIndependentPricePoll = async () => {
      if (!isMounted) return;

      const now = Date.now();
      const guidePx = guidePriceRef.current;
      const guideAt = guidePriceUpdatedAtRef.current;
      const chartPx = lastChartPriceRef.current;
      const chartAt = chartPriceHeartbeatRef.current;
      const guideAge = guideAt > 0 ? now - guideAt : Number.POSITIVE_INFINITY;
      const chartAge = chartAt > 0 ? now - chartAt : Number.POSITIVE_INFINITY;
      const hasFreshPrice = (guidePx > 0 && guideAge < PRICE_STALE_THRESHOLD_FOR_POLL_MS) ||
                            (chartPx > 0 && chartAge < PRICE_STALE_THRESHOLD_FOR_POLL_MS);

      if (hasFreshPrice && consecutiveSuccesses > 2) {
        schedulePoll(INDEPENDENT_POLL_INTERVAL_MS);
        return;
      }

      const pollLabel = guidePx <= 0 ? 'no-price' : guideAge > PRICE_STALE_THRESHOLD_FOR_POLL_MS ? `stale-${(guideAge / 1000).toFixed(0)}s` : 'routine';
      console.log(`🔄 [IndependentPoll] Fetching price (reason=${pollLabel}, guidePx=${guidePx.toFixed(2)}, guideAge=${guideAge === Number.POSITIVE_INFINITY ? '∞' : (guideAge / 1000).toFixed(1) + 's'})`);

      try {
        const result = await fetchLiveGoldPriceFallback();
        if (!isMounted) return;

        if (result.price > 0) {
          consecutiveSuccesses++;
          const freshSource = `🟢 ${result.source.replace(/🟢 |🟠 |🟡 |🔴 /g, '')} (poll)`;
          console.log(`✅ [IndependentPoll] Got price: ${result.price.toFixed(2)} from ${freshSource}`);

          commitGuidePrice(result.price, freshSource);
          applyLivePrice(result.price, freshSource, 'feed');
        } else {
          consecutiveSuccesses = 0;
          console.warn('⚠️ [IndependentPoll] All price sources returned 0');
        }
      } catch (err) {
        consecutiveSuccesses = 0;
        console.warn('⚠️ [IndependentPoll] Price fetch failed:', err instanceof Error ? err.message : 'Unknown');
      }

      const nextInterval = guidePriceRef.current <= 0
        ? INDEPENDENT_POLL_NO_PRICE_INTERVAL_MS
        : INDEPENDENT_POLL_INTERVAL_MS;
      schedulePoll(nextInterval);
    };

    const schedulePoll = (delayMs: number) => {
      if (!isMounted) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        void runIndependentPricePoll();
      }, delayMs);
    };

    console.log('🛡️ [IndependentPoll] Starting independent price safety net (first poll in 3s)');
    schedulePoll(3000);

    return () => {
      isMounted = false;
      if (pollTimer) clearTimeout(pollTimer);
      console.log('🛑 [IndependentPoll] Stopped independent price safety net');
    };
  }, [commitGuidePrice, applyLivePrice]);

  const fetchPriceHistory = useCallback(async (fromTime: number, toTime: number): Promise<{timestamp: number, open: number, high: number, low: number, close: number}[]> => {
    try {
      console.log(`📊 Fetching historical 1-MINUTE OHLCV data...`);
      console.log(`   From: ${new Date(fromTime).toISOString()}`);
      console.log(`   To: ${new Date(toTime).toISOString()}`);

      const localBars = await getBars('1m', fromTime, toTime);
      const latestLocalTs = localBars.length > 0 ? localBars[localBars.length - 1].timestamp : null;
      const now = Date.now();
      const localCoversWindow = latestLocalTs !== null && (toTime - latestLocalTs) <= 90_000 && localBars.length > 0;
      if (localCoversWindow) {
        console.log(`✅ [BarStore] Serving ${localBars.length} 1-min bars from sqlite ring buffer (covers window)`);
        return localBars;
      }

      const bars = await fetchHistoricalData({
        fromTime,
        toTime,
        timeoutMs: 15000,
      });

      console.log(`✅ Fetched ${bars.length} historical 1-MINUTE bars (remote)`);

      if (bars.length > 0) {
        console.log(`   First bar: ${new Date(bars[0].timestamp).toISOString()} - Close: ${bars[0].close.toFixed(2)}`);
        console.log(`   Last bar: ${new Date(bars[bars.length - 1].timestamp).toISOString()} - Close: ${bars[bars.length - 1].close.toFixed(2)}`);
        void upsertBars('1m', bars).catch(err => {
          console.warn('⚠️ [BarStore] persisting fetched bars failed:', err instanceof Error ? err.message : 'Unknown');
        });
        if (latestLocalTs !== null && bars.length > 0) {
          void getLatestBarTimestamp('1m').then(newestTs => {
            console.log(`🗄️ [BarStore] merged remote bars; newest local ts now ${newestTs ? new Date(newestTs).toISOString() : 'n/a'}`);
          });
        }
      }

      return bars;
    } catch (error) {
      console.error('❌ Error fetching price history:', error);
      return [];
    }
  }, []);

  const analyzeSignalWithHistoricalData = useCallback(async (
    signal: TradingSignal,
    historicalBars: {timestamp: number, open: number, high: number, low: number, close: number}[]
  ): Promise<{newStatus: SignalStatus, targetsHit: number, exitPrice: number, outcomeResult: 'WIN' | 'LOSS' | null, breakevenReached?: boolean, breakevenTime?: string}> => {
    console.log(`\n📊 UPGRADED SEQUENTIAL ANALYSIS (1-Min Bars)`);
    console.log(`   Signal ID: ${signal.id.slice(-6)}`);
    console.log(`   Signal Type: ${signal.type}`);
    console.log(`   Entry Range: ${signal.entryPrice.toFixed(1)} - ${signal.entryPriceWithSlippage.toFixed(1)}`);
    console.log(`   TP1: ${signal.tp1.toFixed(1)} | TP2: ${signal.tp2.toFixed(1)} | TP3: ${signal.tp3.toFixed(1)}`);
    console.log(`   SL: ${signal.sl.toFixed(1)}`);
    console.log(`   Current Targets Hit: ${signal.targetsHit}`);
    console.log(`   Historical Bars: ${historicalBars.length} (1-minute resolution)`);
    
    let currentStatus = signal.status;
    let currentTargetsHit = signal.targetsHit;
    let exitPrice = signal.entryPrice;
    let outcomeResult: 'WIN' | 'LOSS' | null = null;
    let entryConfirmed = false;
    let tp1HitTime: number | null = null;
    let breakevenReached = signal.breakevenReached || false;
    let breakevenTime = signal.breakevenTime;

    // CRITICAL FIX: Filter out bars that overlap the signal creation time.
    // A 1-minute bar with timestamp 11:08:00 covers 11:08:00 - 11:08:59. If the
    // signal was created at 11:08:30, any pre-signal wick inside that bar's
    // high/low would falsely trigger an SL hit "1 minute after" the signal.
    // We skip the partial bar that contains (or precedes) the signal timestamp
    // and only evaluate bars that fully start AFTER the signal was generated.
    const signalCreatedAtMs = signal.createdAt ?? new Date(signal.timestamp).getTime();
    const oneMinuteMs = 60 * 1000;
    const safeBarStart = signalCreatedAtMs + oneMinuteMs;
    const originalBarCount = historicalBars.length;
    historicalBars = historicalBars.filter(b => b.timestamp >= safeBarStart);
    if (originalBarCount !== historicalBars.length) {
      console.log(`   🛡️ Filtered ${originalBarCount - historicalBars.length} bar(s) that overlap signal creation time (${new Date(signalCreatedAtMs).toISOString()})`);
      console.log(`      Only evaluating bars with timestamp >= ${new Date(safeBarStart).toISOString()}`);
    }

    const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
    const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
    const ENTRY_TOLERANCE = 1.0;
    const EXTENDED_ENTRY_TOLERANCE = 3.0;
    
    if (signal.targetsHit >= 1 || signal.status === "TP1_HIT" || signal.status === "TP2_HIT" || signal.status === "TP3_HIT" || signal.status === "ALL_TARGETS_HIT") {
      entryConfirmed = true;
      console.log(`   ✅ ENTRY AUTO-CONFIRMED: signal already reached TP${signal.targetsHit} - entry was obviously filled`);
    }
    
    console.log(`\n🔍 STEP 1: Entry Validation (${signal.type})`);
    console.log(`   Entry Zone (strict): ${(entryMin - ENTRY_TOLERANCE).toFixed(1)} - ${(entryMax + ENTRY_TOLERANCE).toFixed(1)}`);
    console.log(`   Entry Zone (extended): ${(entryMin - EXTENDED_ENTRY_TOLERANCE).toFixed(1)} - ${(entryMax + EXTENDED_ENTRY_TOLERANCE).toFixed(1)}`);
    
    for (let i = 0; i < historicalBars.length; i++) {
      const bar = historicalBars[i];
      
      if (!entryConfirmed) {
        const touchedEntryZone = signal.type === "BUY" 
          ? bar.low <= (entryMax + ENTRY_TOLERANCE) && bar.high >= (entryMin - ENTRY_TOLERANCE)
          : bar.high >= (entryMin - ENTRY_TOLERANCE) && bar.low <= (entryMax + ENTRY_TOLERANCE);
        
        const tpReachedFromEntry = signal.type === "BUY"
          ? bar.high >= signal.tp1
          : bar.low <= signal.tp1;
        
        const slReachedFromEntry = signal.type === "BUY"
          ? bar.low <= signal.sl
          : bar.high >= signal.sl;
        
        const crossedEntryByExtendedZone = signal.type === "BUY"
          ? bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE) && bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE)
          : bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE) && bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE);
        
        if (touchedEntryZone) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY CONFIRMED on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar H/L: ${bar.high.toFixed(1)}/${bar.low.toFixed(1)}`);
        } else if (tpReachedFromEntry || slReachedFromEntry) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY AUTO-CONFIRMED on bar ${i + 1}: price reached ${tpReachedFromEntry ? 'TP1' : 'SL'} so must have traversed entry zone`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
        } else if (crossedEntryByExtendedZone) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY CONFIRMED (extended ±${EXTENDED_ENTRY_TOLERANCE} tolerance) on bar ${i + 1} - gapped fill`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar H/L: ${bar.high.toFixed(1)}/${bar.low.toFixed(1)}`);
        } else {
          continue;
        }
      }
      
      console.log(`   [Bar ${i+1}] ${new Date(bar.timestamp).toLocaleTimeString()} - H:${bar.high.toFixed(1)} L:${bar.low.toFixed(1)} C:${bar.close.toFixed(1)}`);
      
      if (signal.type === "BUY") {
        if (bar.low <= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= Original SL: ${signal.sl.toFixed(1)}`);

          if (currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ✅ Managed runner protected after TP2 - closing as partial win at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
          } else if (breakevenReached || currentTargetsHit >= 1) {
            currentStatus = "SL_AFTER_BE";
            currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ⚖️ SL HIT AFTER BREAKEVEN - no capital loss, TP1 banked @ ${exitPrice.toFixed(1)}`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = signal.sl;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (Original SL hit before breakeven)`);
          }

          break;
        }
        
        if (bar.high >= signal.tp3 && currentTargetsHit < 3) {
          console.log(`   🎯🎯🎯 TP3 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP3: ${signal.tp3.toFixed(1)}`);
          currentStatus = "ALL_TARGETS_HIT";
          currentTargetsHit = 3;
          exitPrice = signal.tp3;
          outcomeResult = 'WIN';
          console.log(`      📊 Result: FULL WIN (All targets hit)`);
          break;
        } else if (bar.high >= signal.tp2 && currentTargetsHit < 2) {
          console.log(`   🎯🎯 TP2 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP2: ${signal.tp2.toFixed(1)}`);
          currentStatus = "TP2_HIT";
          currentTargetsHit = 2;
          exitPrice = signal.tp2;
          console.log(`      🔓 Lock released - Can generate new signals`);
          console.log(`      📋 Breakeven indicator active at entry - trade continues to TP3 or original SL`);
        } else if (bar.high >= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN INDICATOR: Notifier triggered at entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
          console.log(`      🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
        }

        if (currentTargetsHit >= 2 && bar.low <= signal.entryPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT";
          currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
          outcomeResult = 'WIN';
          console.log(`      ✅ TP2 runner returned to breakeven - closing as protected partial win @ ${exitPrice.toFixed(1)}`);
          break;
        }

        if (breakevenReached && bar.low <= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      } else {
        if (bar.high >= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= Original SL: ${signal.sl.toFixed(1)}`);

          if (currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ✅ Managed runner protected after TP2 - closing as partial win at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
          } else if (breakevenReached || currentTargetsHit >= 1) {
            currentStatus = "SL_AFTER_BE";
            currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ⚖️ SL HIT AFTER BREAKEVEN - no capital loss, TP1 banked @ ${exitPrice.toFixed(1)}`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = signal.sl;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (Original SL hit before breakeven)`);
          }

          break;
        }
        
        if (bar.low <= signal.tp3 && currentTargetsHit < 3) {
          console.log(`   🎯🎯🎯 TP3 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP3: ${signal.tp3.toFixed(1)}`);
          currentStatus = "ALL_TARGETS_HIT";
          currentTargetsHit = 3;
          exitPrice = signal.tp3;
          outcomeResult = 'WIN';
          console.log(`      📊 Result: FULL WIN (All targets hit)`);
          break;
        } else if (bar.low <= signal.tp2 && currentTargetsHit < 2) {
          console.log(`   🎯🎯 TP2 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP2: ${signal.tp2.toFixed(1)}`);
          currentStatus = "TP2_HIT";
          currentTargetsHit = 2;
          exitPrice = signal.tp2;
          console.log(`      🔓 Lock released - Can generate new signals`);
          console.log(`      📋 Breakeven indicator active at entry - trade continues to TP3 or original SL`);
        } else if (bar.low <= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN INDICATOR: Notifier triggered at entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
          console.log(`      🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
        }

        if (currentTargetsHit >= 2 && bar.high >= signal.entryPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT";
          currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
          outcomeResult = 'WIN';
          console.log(`      ✅ TP2 runner returned to breakeven - closing as protected partial win @ ${exitPrice.toFixed(1)}`);
          break;
        }

        if (breakevenReached && bar.high >= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      }
    }
    
    if (!entryConfirmed) {
      const anyTargetHit = currentTargetsHit > 0
        || currentStatus === "TP1_HIT"
        || currentStatus === "TP2_HIT"
        || currentStatus === "TP3_HIT"
        || currentStatus === "ALL_TARGETS_HIT"
        || currentStatus === "PARTIAL_WIN_SL_HIT"
        || currentStatus === "SL_AFTER_BE";
      
      if (anyTargetHit) {
        console.log(`   ⚠️ Entry not flagged within zone but signal already reached targets - keeping status ${currentStatus}`);
      } else {
        console.log(`   ❌ ENTRY VALIDATION FAILED: Price never entered the entry zone`);
        console.log(`      Signal marked as EXPIRED_MISSED_ENTRY`);
        currentStatus = "EXPIRED_MISSED_ENTRY";
        outcomeResult = null;
      }
    }
    
    console.log(`\n✅ Analysis Complete:`);
    console.log(`   Final Status: ${currentStatus}`);
    console.log(`   Targets Hit: ${currentTargetsHit}/3`);
    console.log(`   Exit Price: ${exitPrice.toFixed(1)}`);
    console.log(`   Outcome: ${outcomeResult || 'N/A'}`);
    if (tp1HitTime) {
      console.log(`   TP1 Hit Time: ${new Date(tp1HitTime).toLocaleTimeString()}`);
    }
    
    return {
      newStatus: currentStatus,
      targetsHit: currentTargetsHit,
      exitPrice,
      outcomeResult,
      breakevenReached,
      breakevenTime,
    };
  }, []);

  const catchUpAndEvaluateSignals = useCallback(async (history: TradingSignal[], fallbackPrice?: number) => {
    console.log('\n' + '='.repeat(80));
    console.log('🔄 SIGNAL CATCH-UP EVALUATION INITIATED');
    console.log('='.repeat(80));
    console.log('   Checking for stale ACTIVE signals that need evaluation...');
    
    const now = Date.now();
    const currentFallbackPrice = fallbackPrice ?? signalEngine.getCurrentPrice();
    const currentPrice = currentFallbackPrice;
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    
    if (currentFallbackPrice <= 0) {
      console.log('⚠️ Catch-up evaluation running without live fallback price - historical bars only');
    }
    
    let updatedHistory = [...history];
    let hasChanges = false;
    
    for (let i = 0; i < updatedHistory.length; i++) {
      const signal = updatedHistory[i];
      
      if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "SL_AFTER_BE" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
        continue;
      }

      // Clear any in-flight SL breach tracker while we do the authoritative
      // historical reconciliation - the historical path is truthful and must
      // not be short-circuited by stale tick-level breach state.
      slBreachTrackerRef.current.delete(signal.id);

      const signalAge = now - new Date(signal.timestamp).getTime();
      console.log(`\n🔍 Evaluating Signal ${signal.id.slice(-6)}:`);
      console.log(`   Type: ${signal.type}`);
      console.log(`   Status: ${signal.status}`);
      console.log(`   Entry: ${signal.entryPrice.toFixed(1)}`);
      console.log(`   Age: ${(signalAge / 1000 / 60 / 60).toFixed(1)} hours`);
      console.log(`   TP1: ${signal.tp1.toFixed(1)} | TP2: ${signal.tp2.toFixed(1)} | TP3: ${signal.tp3.toFixed(1)}`);
      console.log(`   SL: ${signal.sl.toFixed(1)}`);
      
      if (signalAge > twoHoursInMs) {
        console.log(`   ⏰ Signal expired (>2 hours) - marking as CLOSED`);
        updatedHistory[i] = {
          ...signal,
          status: "CLOSED" as const,
          exitTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          exitPrice: currentFallbackPrice > 0 ? currentFallbackPrice : signal.entryPrice,
        };
        hasChanges = true;
        
        await signalEngine.recordTradeOutcome(
          signal.id,
          signal.entryPrice,
          currentFallbackPrice > 0 ? currentFallbackPrice : signal.entryPrice,
          'LOSS',
          {} as any,
          undefined,
          signalAge
        ).catch(err => {
          console.error(`Failed to record expired signal outcome:`, err);
        });
        continue;
      }
      
      const signalTime = new Date(signal.timestamp).getTime();
      const historicalBars = await fetchPriceHistory(signalTime, now);
      
      if (historicalBars.length === 0) {
        console.log(`   ⚠️ No historical data available - using current price fallback`);

        if (currentFallbackPrice <= 0) {
          console.log(`   ⏳ No fallback live price available - leaving signal unchanged until next reconciliation`);
          continue;
        }
        
        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let shouldRecord = false;
        let outcomeResult: 'WIN' | 'LOSS' = 'LOSS';
        let exitPrice = currentPrice;
        
        if (signal.type === "BUY") {
          if (targetsHit >= 2 && currentPrice <= signal.entryPrice) {
            console.log(`   ✅ CATCH-UP (Fallback): TP2 runner returned to entry @ ${currentPrice.toFixed(1)} - closing as protected partial win`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            outcomeResult = 'WIN';
            exitPrice = getProtectedExitPrice(signal, targetsHit);
            shouldRecord = true;
          } else if (currentPrice <= signal.sl - SL_CONFIRMATION_MIN_PENETRATION_PIPS) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)}) - penetration ${(signal.sl - currentPrice).toFixed(2)} pips meets confirmation threshold`);
            if (targetsHit >= 2) {
              newStatus = "PARTIAL_WIN_SL_HIT";
              targetsHit = Math.max(targetsHit, 2);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ✅ Managed runner was already breakeven-protected after TP2 - recording partial win @ ${exitPrice.toFixed(1)}`);
            } else if (signal.breakevenReached || targetsHit >= 1) {
              newStatus = "SL_AFTER_BE";
              targetsHit = Math.max(targetsHit, 1);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ⚖️ SL AFTER BREAKEVEN - no capital loss (TP1 banked) @ ${exitPrice.toFixed(1)}`);
            } else {
              newStatus = "SL_HIT";
              outcomeResult = 'LOSS';
              exitPrice = signal.sl;
            }
            shouldRecord = true;
          } else if (currentPrice >= signal.tp3) {
            console.log(`   🎯 CATCH-UP (Fallback): All targets hit @ ${currentPrice.toFixed(1)} (TP3: ${signal.tp3.toFixed(1)})`);
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            shouldRecord = true;
            outcomeResult = 'WIN';
            exitPrice = signal.tp3;
          } else if (currentPrice >= signal.tp2 && targetsHit < 2) {
            console.log(`   🎯 CATCH-UP (Fallback): TP2 hit @ ${currentPrice.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            newStatus = "TP2_HIT";
            targetsHit = 2;
          } else if (currentPrice >= signal.tp1 && targetsHit < 1) {
            console.log(`   🎯 CATCH-UP (Fallback): TP1 hit @ ${currentPrice.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            newStatus = "TP1_HIT";
            targetsHit = 1;
          }
        } else {
          if (targetsHit >= 2 && currentPrice >= signal.entryPrice) {
            console.log(`   ✅ CATCH-UP (Fallback): TP2 runner returned to entry @ ${currentPrice.toFixed(1)} - closing as protected partial win`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            outcomeResult = 'WIN';
            exitPrice = getProtectedExitPrice(signal, targetsHit);
            shouldRecord = true;
          } else if (currentPrice >= signal.sl + SL_CONFIRMATION_MIN_PENETRATION_PIPS) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)}) - penetration ${(currentPrice - signal.sl).toFixed(2)} pips meets confirmation threshold`);
            if (targetsHit >= 2) {
              newStatus = "PARTIAL_WIN_SL_HIT";
              targetsHit = Math.max(targetsHit, 2);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ✅ Managed runner was already breakeven-protected after TP2 - recording partial win @ ${exitPrice.toFixed(1)}`);
            } else if (signal.breakevenReached || targetsHit >= 1) {
              newStatus = "SL_AFTER_BE";
              targetsHit = Math.max(targetsHit, 1);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ⚖️ SL AFTER BREAKEVEN - no capital loss (TP1 banked) @ ${exitPrice.toFixed(1)}`);
            } else {
              newStatus = "SL_HIT";
              outcomeResult = 'LOSS';
              exitPrice = signal.sl;
            }
            shouldRecord = true;
          } else if (currentPrice <= signal.tp3) {
            console.log(`   🎯 CATCH-UP (Fallback): All targets hit @ ${currentPrice.toFixed(1)} (TP3: ${signal.tp3.toFixed(1)})`);
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            shouldRecord = true;
            outcomeResult = 'WIN';
            exitPrice = signal.tp3;
          } else if (currentPrice <= signal.tp2 && targetsHit < 2) {
            console.log(`   🎯 CATCH-UP (Fallback): TP2 hit @ ${currentPrice.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            newStatus = "TP2_HIT";
            targetsHit = 2;
          } else if (currentPrice <= signal.tp1 && targetsHit < 1) {
            console.log(`   🎯 CATCH-UP (Fallback): TP1 hit @ ${currentPrice.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            newStatus = "TP1_HIT";
            targetsHit = 1;
          }
        }
        
        if (newStatus !== signal.status || targetsHit !== signal.targetsHit) {
          hasChanges = true;
          const exitDate = new Date();
          
          updatedHistory[i] = {
            ...signal,
            status: newStatus,
            targetsHit,
            exitTime: (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT")
              ? exitPrice
              : signal.exitPrice,
          };
          
          if (shouldRecord) {
            console.log(`   📊 Recording ${outcomeResult} outcome for learning engine...`);
            await signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              exitPrice,
              outcomeResult,
              {} as any,
              undefined,
              signalAge
            ).catch(err => {
              console.error(`Failed to record catch-up outcome:`, err);
            });
          }
        } else {
          console.log(`   ✅ Signal still valid - no changes needed`);
        }
      } else {
        const barResolution = resolveSignalWithBars(signal, historicalBars, { logPrefix: `   [Resolver ${signal.id.slice(-6)}]` });
        const legacy = await analyzeSignalWithHistoricalData(signal, historicalBars);
        // Bar-based resolver is the AUTHORITATIVE source of truth because it
        // walks 1-minute bars tick-by-tick (by wick) from the signal creation
        // time forward and respects SL-before-TP ordering. The legacy path is
        // retained only for diagnostic logging. If the bar resolver and legacy
        // disagree on the final status we ALWAYS trust the bar resolver —
        // including the case where legacy reports a TP hit but bars show the
        // SL was actually hit first (false TP win) or vice versa.
        const legacyDiffers = legacy.newStatus !== barResolution.newStatus
          || legacy.targetsHit !== barResolution.targetsHit
          || Math.abs((legacy.exitPrice ?? 0) - (barResolution.exitPrice ?? 0)) > 0.05;
        const analysis = {
          newStatus: barResolution.newStatus,
          targetsHit: barResolution.targetsHit,
          exitPrice: barResolution.exitPrice,
          outcomeResult: barResolution.outcomeResult,
          breakevenReached: barResolution.breakevenReached,
          breakevenTime: barResolution.breakevenTime,
        };
        if (legacyDiffers) {
          console.log(`   🔧 Bar resolver overrode legacy: legacy=${legacy.newStatus}(tgt ${legacy.targetsHit}) -> bars=${barResolution.newStatus}(tgt ${barResolution.targetsHit})`);
        }
        if (analysis.newStatus !== signal.status) {
          console.log(`   📝 Signal ${signal.id.slice(-6)} status change: ${signal.status} -> ${analysis.newStatus} (bar-resolved, tick-by-wick on 1m)`);
        }
        
        if (analysis.newStatus !== signal.status || analysis.targetsHit !== signal.targetsHit || analysis.breakevenReached !== signal.breakevenReached) {
          hasChanges = true;
          const exitDate = new Date();
          
          updatedHistory[i] = {
            ...signal,
            status: analysis.newStatus,
            targetsHit: analysis.targetsHit,
            breakevenReached: analysis.breakevenReached,
            breakevenTime: analysis.breakevenTime,
            exitTime: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "SL_AFTER_BE" || analysis.newStatus === "ALL_TARGETS_HIT" || analysis.newStatus === "PARTIAL_WIN_SL_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "SL_AFTER_BE" || analysis.newStatus === "ALL_TARGETS_HIT" || analysis.newStatus === "PARTIAL_WIN_SL_HIT")
              ? analysis.exitPrice
              : signal.exitPrice,
          };
          
          if (analysis.outcomeResult) {
            console.log(`   📊 Recording ${analysis.outcomeResult} outcome for learning engine...`);
            await signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              analysis.exitPrice,
              analysis.outcomeResult,
              {} as any,
              undefined,
              signalAge
            ).catch(err => {
              console.error(`Failed to record catch-up outcome:`, err);
            });
          }
        } else {
          console.log(`   ✅ Signal still valid - no changes needed`);
        }
      }
    }
    
    console.log('\n' + '='.repeat(80));
    if (hasChanges) {
      console.log('✅ CATCH-UP COMPLETE: Signal statuses updated');
      console.log(`   Updated signals will be saved to AsyncStorage`);
    } else {
      console.log('✅ CATCH-UP COMPLETE: All signals were up-to-date');
    }
    console.log('='.repeat(80) + '\n');
    
    return updatedHistory;
  }, [analyzeSignalWithHistoricalData, fetchPriceHistory]);

  const auditTerminalSLSignals = useCallback(async (history: TradingSignal[], opts: { force?: boolean } = {}): Promise<TradingSignal[]> => {
    console.log('\n' + '='.repeat(80));
    console.log('🔬 FULL OUTCOME AUDIT: re-evaluating every terminal signal against 1-min bars (catches false SL AND false TP)');
    console.log('='.repeat(80));

    // v5 expands the audit in two critical ways beyond v4:
    //   1. NEVER apply a permanent one-shot audit lock to signals that may
    //      still benefit from additional 1m bars (i.e. signals < 24h old,
    //      which is our sqlite ring-buffer retention). This means if a false
    //      TP3 was recorded because the live tick monitor missed the SL-side
    //      wick, every subsequent audit pass will keep rechecking until the
    //      bar-based resolver converges. v4's lock caused wrong-direction
    //      outcomes (BUY recorded as TP3 but actually SL, SELL recorded as
    //      SL but actually TP) to be frozen after the first unsuccessful audit.
    //   2. DO NOT mark a signal audited when no bars were available — that
    //      silently locked in whatever the live monitor committed.
    const SL_AUDIT_VERSION = 'v5-rolling-full-outcome-audit';
    const force = opts.force === true;
    if (force) {
      console.log('🧨 MANUAL AUDIT: force=true - clearing audit locks and re-evaluating every terminal signal from scratch');
    }
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
    let corrected = 0;
    const updated: TradingSignal[] = [];

    for (const signal of history) {
      const isTerminal = TERMINAL_SIGNAL_STATUSES.includes(signal.status);
      const signalAgeMs = now - new Date(signal.timestamp).getTime();
      const alreadyAudited = (signal as TradingSignal & { slAuditVersion?: string }).slAuditVersion === SL_AUDIT_VERSION;
      // Bars retention is 24h. If the signal is older and already audited, we
      // cannot do better than the prior pass - safe to skip to save CPU.
      // force=true (manual audit) bypasses both the audit lock and the 24h skip.
      const tooOldForBars = signalAgeMs > twentyFourHoursInMs;
      if (!isTerminal || (!force && alreadyAudited && tooOldForBars)) {
        updated.push(signal);
        continue;
      }

      const signalTs = new Date(signal.timestamp).getTime();
      const fromTime = signalTs;
      const toTime = Math.min(now, signalTs + twoHoursInMs);

      console.log(`\n🔍 Auditing ${signal.id.slice(-6)} (${signal.type}, status=${signal.status}) entry=${signal.entryPrice.toFixed(1)} SL=${signal.sl.toFixed(1)} TP1=${signal.tp1.toFixed(1)} TP3=${signal.tp3.toFixed(1)}${alreadyAudited ? ' [RE-AUDIT]' : ''}`);

      // When force=true (manual audit), bypass the local sqlite cache and
      // fetch authoritative bars from the remote data provider. This prevents
      // previously-poisoned local bars from re-confirming a false SL hit.
      let bars: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
      if (force) {
        try {
          console.log(`   🌐 [Audit force] Fetching authoritative remote bars (bypassing local cache)...`);
          bars = await fetchHistoricalData({ fromTime, toTime, timeoutMs: 15000 });
          if (bars.length > 0) {
            void upsertBars('1m', bars).catch(err => {
              console.warn('   ⚠️ [Audit force] failed to re-seed local bars:', err instanceof Error ? err.message : 'Unknown');
            });
            console.log(`   ✅ [Audit force] got ${bars.length} authoritative remote bars`);
          } else {
            console.log(`   ⚠️ [Audit force] remote returned 0 bars - falling back to local cache`);
            bars = await fetchPriceHistory(fromTime, toTime);
          }
        } catch (err) {
          console.warn(`   ⚠️ [Audit force] remote fetch failed, falling back to local:`, err instanceof Error ? err.message : 'Unknown');
          bars = await fetchPriceHistory(fromTime, toTime);
        }
      } else {
        bars = await fetchPriceHistory(fromTime, toTime);
      }
      if (bars.length === 0) {
        // IMPORTANT: do NOT mark audited - we want to retry once bars arrive.
        console.log(`   ⚠️ No 1-min bars returned - leaving signal unchanged, will retry next audit pass`);
        updated.push(signal);
        continue;
      }

      const barOutcome = resolveSignalWithBars(signal, bars, { logPrefix: `   [Audit ${signal.id.slice(-6)}]` });
      // Bar resolver is authoritative for the audit too. Legacy evaluation is
      // kept only for diagnostic comparison.
      const legacyOutcome = await analyzeSignalWithHistoricalData(signal, bars);
      const analysis = {
        newStatus: barOutcome.newStatus,
        targetsHit: barOutcome.targetsHit,
        exitPrice: barOutcome.exitPrice,
        outcomeResult: barOutcome.outcomeResult,
        breakevenReached: barOutcome.breakevenReached,
        breakevenTime: barOutcome.breakevenTime,
      };
      if (legacyOutcome.newStatus !== barOutcome.newStatus) {
        console.log(`   🔍 Legacy vs bars disagreement during audit: legacy=${legacyOutcome.newStatus} bars=${barOutcome.newStatus} — trusting bars`);
      }

      const winStatuses: SignalStatus[] = ['ALL_TARGETS_HIT', 'TP3_HIT', 'TP2_HIT', 'TP1_HIT', 'PARTIAL_WIN_SL_HIT', 'SL_AFTER_BE'];
      const originalOutcomeWasLoss = signal.status === 'SL_HIT';
      const originalOutcomeWasWin = winStatuses.includes(signal.status);
      const newOutcomeIsWin = winStatuses.includes(analysis.newStatus);
      const newOutcomeIsLoss = analysis.newStatus === 'SL_HIT';
      const statusChanged = analysis.newStatus !== signal.status;
      const targetsChanged = analysis.targetsHit !== signal.targetsHit;

      if (statusChanged || targetsChanged) {
        corrected++;
        const exitDate = new Date();
        const patched: TradingSignal = {
          ...signal,
          status: analysis.newStatus,
          targetsHit: analysis.targetsHit,
          breakevenReached: analysis.breakevenReached ?? signal.breakevenReached,
          breakevenTime: analysis.breakevenTime ?? signal.breakevenTime,
          exitPrice: analysis.exitPrice,
          exitTime: signal.exitTime ?? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        };
        (patched as TradingSignal & { slAuditVersion?: string }).slAuditVersion = SL_AUDIT_VERSION;
        updated.push(patched);

        console.log(`   🔧 CORRECTED: ${signal.status} -> ${analysis.newStatus} (targets ${signal.targetsHit} -> ${analysis.targetsHit})`);
        console.log(`      exitPrice ${signal.exitPrice?.toFixed(1) ?? 'n/a'} -> ${analysis.exitPrice.toFixed(1)}`);

        if (originalOutcomeWasLoss && newOutcomeIsWin) {
          console.log(`   🧠 Submitting corrected WIN outcome to learning engine (was false SL)`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'WIN',
            {} as any,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected WIN outcome:', err));
        } else if (originalOutcomeWasWin && newOutcomeIsLoss) {
          console.log(`   🧠 Submitting corrected LOSS outcome to learning engine (was false TP)`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'LOSS',
            {} as any,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected LOSS outcome:', err));
        } else if (!originalOutcomeWasLoss && newOutcomeIsLoss) {
          console.log(`   🧠 Submitting corrected LOSS outcome to learning engine`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'LOSS',
            {} as any,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected LOSS outcome:', err));
        }
      } else {
        console.log(`   ✅ Audit confirms original status - marking audited`);
        updated.push({ ...signal, slAuditVersion: SL_AUDIT_VERSION } as TradingSignal);
      }
    }

    console.log(`\n✅ FALSE-SL AUDIT COMPLETE: ${corrected} signal(s) corrected`);
    console.log('='.repeat(80) + '\n');
    return updated;
  }, [analyzeSignalWithHistoricalData, fetchPriceHistory]);

  const calculatePerformanceMetrics = useCallback((history: TradingSignal[]) => {
    if (history.length === 0) {
      const healthMetrics = signalEngine.getModelHealthMetrics();
      return {
        ...DEFAULT_METRICS,
        modelHealthScore: healthMetrics.modelHealthScore,
        featureCorrelationStatus: healthMetrics.featureCorrelationStatus,
        confidenceDegradation: healthMetrics.confidenceDegradation,
        conceptDriftScore: healthMetrics.conceptDriftScore,
        featureImportanceDrift: healthMetrics.featureImportanceDrift,
        driftAlertLevel: healthMetrics.driftAlertLevel,
        daysSinceRetrain: healthMetrics.daysSinceRetrain,
        retrainingRecommended: healthMetrics.retrainingRecommended,
      };
    }

    const closedTrades = history.filter(s => 
      s.status === "CLOSED" || s.status === "SL_HIT" || s.status === "SL_AFTER_BE" || s.status === "ALL_TARGETS_HIT" || s.status === "PARTIAL_WIN_SL_HIT"
    );
    
    const totalTrades = closedTrades.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    const profits: number[] = [];
    const losses: number[] = [];

    closedTrades.forEach(signal => {
      const pnl = computeSignalPnL(signal, settings.basePositionSize);

      if (signal.status === "ALL_TARGETS_HIT" || pnl > 0) {
        winningTrades++;
        totalProfit += Math.max(0, pnl);
        if (pnl > 0) profits.push(pnl);
      } else if (signal.status === "CLOSED" && Math.abs(pnl) < 0.01) {
        console.log(`📊 Expired/manual close with ~0 P/L: Signal ${signal.id.slice(-6)}`);
      } else {
        losingTrades++;
        totalLoss += Math.abs(pnl);
        losses.push(Math.abs(pnl));
      }
    });

    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const averageWin = profits.length > 0 ? totalProfit / profits.length : 0;
    const averageLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;
    const expectancy = totalTrades > 0 ? (totalProfit - totalLoss) / totalTrades : 0;

    let runningBalance = accountBalance;
    let peak = accountBalance;
    let maxDrawdown = 0;
    
    closedTrades.forEach(signal => {
      const pnl = computeSignalPnL(signal, settings.basePositionSize);

      runningBalance += pnl;
      if (runningBalance > peak) {
        peak = runningBalance;
      }
      const drawdown = ((peak - runningBalance) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    });

    const currentDrawdown = runningBalance < peak ? ((peak - runningBalance) / peak) * 100 : 0;

    const returns = profits.concat(losses.map(l => -l));
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1 
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    const healthMetrics = signalEngine.getModelHealthMetrics();

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalLoss: parseFloat(totalLoss.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      currentDrawdown: parseFloat(currentDrawdown.toFixed(2)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      winRate: parseFloat(winRate.toFixed(2)),
      averageWin: parseFloat(averageWin.toFixed(2)),
      averageLoss: parseFloat(averageLoss.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      modelHealthScore: healthMetrics.modelHealthScore,
      featureCorrelationStatus: healthMetrics.featureCorrelationStatus,
      confidenceDegradation: healthMetrics.confidenceDegradation,
      conceptDriftScore: healthMetrics.conceptDriftScore,
      featureImportanceDrift: healthMetrics.featureImportanceDrift,
      driftAlertLevel: healthMetrics.driftAlertLevel,
      daysSinceRetrain: healthMetrics.daysSinceRetrain,
      retrainingRecommended: healthMetrics.retrainingRecommended,
    };
  }, [accountBalance, settings.basePositionSize]);

  const runManualAudit = useCallback(async (): Promise<{ corrected: number; total: number }> => {
    console.log('🛠️ MANUAL AUDIT triggered from UI');
    const current = signalHistoryRef.current;
    const terminalCount = current.filter(s => TERMINAL_SIGNAL_STATUSES.includes(s.status)).length;
    // Strip any prior audit locks so every terminal signal is re-evaluated against fresh bars.
    const stripped = current.map(s => {
      const copy: TradingSignal & { slAuditVersion?: string } = { ...s };
      delete copy.slAuditVersion;
      return copy as TradingSignal;
    });
    const reconciled = await catchUpAndEvaluateSignals(stripped);
    const audited = await auditTerminalSLSignals(reconciled, { force: true });
    let corrected = 0;
    for (let i = 0; i < current.length; i++) {
      const before = current[i];
      const after = audited.find(a => a.id === before.id);
      if (!after) continue;
      if (after.status !== before.status || after.targetsHit !== before.targetsHit) {
        corrected++;
      }
    }
    signalHistoryRef.current = audited;
    setSignalHistory(audited);
    persistSignalHistory(audited, { immediate: true });
    setSignalUpdateTrigger(prev => prev + 1);
    const metrics = calculatePerformanceMetrics(audited);
    setPerformanceMetrics(metrics);
    await AsyncStorage.setItem('performance_metrics', JSON.stringify(metrics));
    console.log(`🛠️ MANUAL AUDIT complete: ${corrected} of ${terminalCount} terminal signals corrected`);
    return { corrected, total: terminalCount };
  }, [auditTerminalSLSignals, catchUpAndEvaluateSignals, calculatePerformanceMetrics]);

  const loadPersistedData = async () => {
    try {
      console.log('🔄 Loading persisted data from AsyncStorage...');
      const [savedSettings, savedHistory, loginStatus, savedMetrics, savedBalance] = await Promise.all([
        AsyncStorage.getItem("trading_settings"),
        AsyncStorage.getItem("signal_history"),
        AsyncStorage.getItem("is_logged_in"),
        AsyncStorage.getItem("performance_metrics"),
        AsyncStorage.getItem("account_balance"),
      ]);

      console.log('📦 Raw saved history from storage:', savedHistory);

      if (savedSettings) {
        const rawParsedSettings = JSON.parse(savedSettings) as Settings;
        const parsedSettings = sanitizeSettings(rawParsedSettings);
        setSettings(parsedSettings);
        console.log('✅ Settings loaded:', parsedSettings);

        if (parsedSettings.minConfidence !== rawParsedSettings.minConfidence) {
          await AsyncStorage.setItem("trading_settings", JSON.stringify(parsedSettings));
          console.log(`🔒 Raised persisted minimum confidence to enforced floor ${(ENFORCED_MIN_SIGNAL_CONFIDENCE * 100).toFixed(0)}%`);
        }
      } else {
        console.log('⚠️ No saved settings found - using defaults');
        setSettings(DEFAULT_SETTINGS);
      }

      if (savedHistory) {
        const history = JSON.parse(savedHistory);
        const parsedHistory = history.map((s: TradingSignal) => ({
          ...s,
          timestamp: new Date(s.timestamp),
        }));
        
        signalHistoryRef.current = parsedHistory;
        setSignalHistory(parsedHistory);
        const evaluatedHistory = await catchUpAndEvaluateSignals(parsedHistory);
        const auditedHistory = await auditTerminalSLSignals(evaluatedHistory);
        signalHistoryRef.current = auditedHistory;
        setSignalHistory(auditedHistory);

        if (JSON.stringify(auditedHistory) !== JSON.stringify(parsedHistory)) {
          persistSignalHistory(auditedHistory, { immediate: true });
          console.log('💾 Updated signal history saved after catch-up + false-SL audit');
        }
        
        console.log(`✅ History loaded: ${auditedHistory.length} signals`);
        console.log('📊 First 2 signals:', auditedHistory.slice(0, 2).map((s: TradingSignal) => ({
          id: s.id.slice(-6),
          type: s.type,
          status: s.status,
          entry: s.entryPrice
        })));
      } else {
        console.log('⚠️ No saved history found in AsyncStorage');
        setSignalHistory([]);
      }

      if (loginStatus) {
        const parsedLoginStatus = JSON.parse(loginStatus);
        setIsLoggedIn(parsedLoginStatus);
        console.log('✅ Login status loaded:', parsedLoginStatus);
      } else {
        console.log('⚠️ No login status found - defaulting to logged in');
        setIsLoggedIn(true);
      }

      if (savedMetrics) {
        const parsedMetrics = JSON.parse(savedMetrics);
        setPerformanceMetrics(parsedMetrics);
        console.log('✅ Metrics loaded');
      } else {
        console.log('⚠️ No saved metrics found - using defaults');
        setPerformanceMetrics(DEFAULT_METRICS);
      }

      if (savedBalance) {
        const parsedBalance = JSON.parse(savedBalance);
        setAccountBalance(parsedBalance);
        console.log('✅ Balance loaded:', parsedBalance);
      } else {
        console.log('⚠️ No saved balance found - using default: 100');
        setAccountBalance(100);
      }

      console.log('✅ All persisted data loaded successfully');
    } catch (error) {
      console.error("❌ Failed to load persisted data:", error);
      setSignalHistory([]);
      setSettings(DEFAULT_SETTINGS);
      setPerformanceMetrics(DEFAULT_METRICS);
      setAccountBalance(100);
      setIsLoggedIn(true);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 100));
      setIsLoading(false);
      console.log('✅ Loading complete - UI will render now');
      console.log(`🛡️ Launch cooldown active: Signal generation will wait 5 seconds to prevent race conditions`);
    }
  };

  const updateMarketOutlook = async () => {
    const outlook = await signalEngine.getMarketOutlook();

    setMarketOutlook((previousValue) => {
      if (areMarketOutlooksEqual(previousValue, outlook)) {
        return previousValue;
      }

      console.log('📊 Market outlook changed — updating dashboard state');
      return outlook;
    });
  };

  useEffect(() => {
    const metrics = calculatePerformanceMetrics(signalHistory);
    setPerformanceMetrics(metrics);
    void AsyncStorage.setItem("performance_metrics", JSON.stringify(metrics));
  }, [signalHistory, calculatePerformanceMetrics]);

  const closeSignal = useCallback((signalId: string) => {
    const now = new Date();
    const livePrice = signalEngine.getCurrentPrice();

    setSignalHistory((prev) => {
      const updated = prev.map(signal => {
        if (signal.id === signalId) {
          const resolvedExitPrice = signal.exitPrice ?? (livePrice > 0 ? livePrice : signal.entryPrice);
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            exitPrice: resolvedExitPrice,
          };
        }
        return signal;
      });
      persistSignalHistory(updated, { immediate: true });
      return updated;
    });
  }, [persistSignalHistory]);



  const syncSignalPriceFromEngine = useCallback((nextPrice?: number) => {
    const enginePrice = nextPrice ?? signalEngine.getCurrentPrice();
    const engineSource = signalEngine.getPriceSource();

    if (enginePrice > 0) {
      setCurrentPrice(enginePrice);
      setCurrentPriceUpdatedAt(Date.now());
      setPriceSource(engineSource);
      setLivePriceError(null);
    }
  }, []);

  const signalTrackingSnapshot = useMemo<SignalTrackingSnapshot>(() => {
    const now = Date.now();
    const chartAgeMs = chartPriceUpdatedAt > 0 ? now - chartPriceUpdatedAt : Number.POSITIVE_INFINITY;
    const chartMovementAgeMs = chartPriceLastMeaningfulMoveRef.current > 0
      ? now - chartPriceLastMeaningfulMoveRef.current
      : Number.POSITIVE_INFINITY;
    const guideAgeMs = guidePriceUpdatedAt > 0 ? now - guidePriceUpdatedAt : Number.POSITIVE_INFINITY;
    const hasFreshChartPrice = chartPrice > 0 && chartAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;
    const hasFreshGuidePrice = guidePrice > 0 && guideAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;
    const chartFeedLooksStalled = hasFreshChartPrice && chartMovementAgeMs >= CHART_STALL_FAILOVER_MS;

    if (hasFreshChartPrice && !chartFeedLooksStalled) {
      return {
        price: chartPrice,
        source: chartPriceSource || '🟢 tradingview-chart',
        updatedAt: chartPriceUpdatedAt,
      };
    }

    if (chartFeedLooksStalled && hasFreshGuidePrice) {
      return {
        price: guidePrice,
        source: `${guidePriceSource || '🟢 Tiingo-Live'} • chart-failover`,
        updatedAt: guidePriceUpdatedAt,
      };
    }

    if (hasFreshGuidePrice) {
      return {
        price: guidePrice,
        source: guidePriceSource || '🟢 Tiingo-Live',
        updatedAt: guidePriceUpdatedAt,
      };
    }

    const enginePrice = signalEngine.getCurrentPrice();
    const engineSource = signalEngine.getPriceSource();

    if (enginePrice > 0) {
      return {
        price: enginePrice,
        source: engineSource || '🟡 engine-cache',
        updatedAt: currentPriceUpdatedAt,
      };
    }

    return {
      price: 0,
      source: '🔴 no live price',
      updatedAt: 0,
    };
  }, [chartPrice, chartPriceSource, chartPriceUpdatedAt, currentPriceUpdatedAt, guidePrice, guidePriceSource, guidePriceUpdatedAt]);

  useEffect(() => {
    signalHistoryRef.current = signalHistory;
  }, [signalHistory]);

  useEffect(() => {
    signalTrackingSnapshotRef.current = signalTrackingSnapshot;
    historicalFallbackPriceRef.current = signalTrackingSnapshot.price;
  }, [signalTrackingSnapshot]);

  const checkAndGenerateSignal = useCallback(async () => {
    const timeSinceLaunch = Date.now() - appLaunchTime;
    const LAUNCH_COOLDOWN_MS = 5000;
    const currentSignalTrackingSnapshot = signalTrackingSnapshotRef.current;
    const currentSignalHistory = signalHistoryRef.current;
    
    if (timeSinceLaunch < LAUNCH_COOLDOWN_MS) {
      const remainingCooldown = ((LAUNCH_COOLDOWN_MS - timeSinceLaunch) / 1000).toFixed(1);
      console.log(`🛡️ LAUNCH COOLDOWN: Preventing signal generation for ${remainingCooldown}s after app start`);
      console.log(`   This prevents duplicate signals during initialization`);
      return;
    }

    if (currentSignalTrackingSnapshot.price > 0) {
      if (currentSignalTrackingSnapshot.source.includes('chart-failover')) {
        console.warn(`⚠️ Signal generation running on chart failover price ${currentSignalTrackingSnapshot.price.toFixed(2)} from ${currentSignalTrackingSnapshot.source}`);
      }

      setExternalPrice(currentSignalTrackingSnapshot.price, currentSignalTrackingSnapshot.source);
      syncSignalPriceFromEngine(currentSignalTrackingSnapshot.price);
    } else {
      console.warn('⚠️ [SignalGen] No tracking price available — force-fetching via REST...');
      try {
        const fallback = await fetchLiveGoldPriceFallback();
        if (fallback.price > 0) {
          console.log(`✅ [SignalGen] Force-fetched price: ${fallback.price.toFixed(2)} from ${fallback.source}`);
          setExternalPrice(fallback.price, fallback.source);
          syncSignalPriceFromEngine(fallback.price);
          commitGuidePrice(fallback.price, `🟢 ${fallback.source.replace(/🟢 |🟠 |🟡 |🔴 /g, '')} (signal-force)`);
        } else {
          const refreshedEnginePrice = await signalEngine.updateCurrentPrice();
          syncSignalPriceFromEngine(refreshedEnginePrice);
        }
      } catch (err) {
        console.warn('⚠️ [SignalGen] Force-fetch failed:', err instanceof Error ? err.message : 'Unknown');
        const refreshedEnginePrice = await signalEngine.updateCurrentPrice();
        syncSignalPriceFromEngine(refreshedEnginePrice);
      }
    }
    
    const outlook = await signalEngine.getMarketOutlook();
    const now = new Date();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 SIGNAL CHECK [${now.toLocaleTimeString()}]`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Market Open: ${outlook.isMarketOpen}`);
    console.log(`Current Session: ${outlook.currentSession}`);
    
    const fullyActiveSignals = currentSignalHistory.filter((signal) => (
      signal.status === "ACTIVE" && signal.confidence >= ENFORCED_MIN_SIGNAL_CONFIDENCE
    ));
    
    console.log(`Active Signals: ${fullyActiveSignals.length}`);
    fullyActiveSignals.forEach(s => {
      const signalAge = (Date.now() - new Date(s.timestamp).getTime()) / 1000 / 60;
      console.log(`  - ${s.type} @ ${s.entryPrice} (Age: ${signalAge.toFixed(1)}m, Targets: ${s.targetsHit}/3)`);
    });
    
    console.log(`Min Confidence: ${(settings.minConfidence * 100).toFixed(0)}%`);
    console.log(`Account Balance: ${accountBalance}`);
    console.log(`Settings - TP1: ${settings.tp1Pips}, TP2: ${settings.tp2Pips}, TP3: ${settings.tp3Pips}, SL: ${settings.slPips}`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (!outlook.isMarketOpen) {
      console.log("❌ BLOCKED: Market is closed. No signal generation.");
      return;
    }

    if (fullyActiveSignals.length > 0) {
      const activeSignal = fullyActiveSignals[0];
      const signalAgeMs = Date.now() - new Date(activeSignal.timestamp).getTime();
      const activeSignalLockReleaseMs = ACTIVE_SIGNAL_LOCK_RELEASE_MS;
      
      const lockReleased = activeSignal.targetsHit >= 2;
      
      const canGenerateNewSignal = (
        lockReleased || 
        signalAgeMs > activeSignalLockReleaseMs
      );
      
      if (!canGenerateNewSignal) {
        console.log("❌ BLOCKED: Active signal exists and lock not released.");
        console.log(`   Active Signal: ${activeSignal.type} @ ${activeSignal.entryPrice}`);
        console.log(`   Targets Hit: ${activeSignal.targetsHit}/3 (Lock releases at TP2)`);
        console.log(`   Age: ${(signalAgeMs / 1000 / 60).toFixed(1)} minutes`);
        console.log(`   💡 New signal allowed when: TP2+ hit, SL hit, or 2+ hours elapsed`);
        return;
      }
      
      console.log(`✅ Lock released - New signal generation allowed:`);
      if (lockReleased) {
        console.log(`   - TP2 hit (${activeSignal.targetsHit}/3 targets) - Lock released`);
        console.log(`   - Previous signal continues to be monitored until terminal status`);
      }
      if (signalAgeMs > activeSignalLockReleaseMs) {
        console.log(`   - Signal age exceeds ${(ACTIVE_SIGNAL_LOCK_RELEASE_MS / 1000 / 60).toFixed(0)} minutes (${(signalAgeMs / 1000 / 60).toFixed(1)}m)`);
      }
    }

    try {
      console.log(`🎯 ATTEMPTING SIGNAL GENERATION...`);
      console.log(`   Settings: minConfidence=${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   Account Balance: ${accountBalance}`);
      
      const signal = await signalEngine.generateSignal(settings, accountBalance, currentSignalHistory);
      syncSignalPriceFromEngine();
      
      if (signal) {
        setSignalHistory((prev) => {
          console.log("\n" + "=".repeat(60));
          console.log("✅ ✅ ✅ NEW SIGNAL GENERATED ✅ ✅ ✅");
          console.log("=".repeat(60));
          console.log(`Type: ${signal.type}`);
          console.log(`Entry: ${signal.entryPrice}`);
          console.log(`Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
          console.log(`TP1: ${signal.tp1} | TP2: ${signal.tp2} | TP3: ${signal.tp3}`);
          console.log(`SL: ${signal.sl}`);
          console.log(`📊 Signal added to dashboard AND history immediately`);
          console.log("=".repeat(60) + "\n");
          
          const updated = [signal, ...prev];
          persistSignalHistory(updated, { immediate: true });
          console.log(`💾 History save scheduled: ${updated.length} signals queued for AsyncStorage`);
          return updated;
        });

        if (Platform.OS !== 'web' && settings.enableNotifications) {
          sendSignalNotification(signal).catch(err => {
            console.error('❌ Failed to send notification:', err);
          });
        }

        const sizing = signalEngine.calculatePositionSizing(signal.confidence, settings, accountBalance);
        setPositionSizing(sizing);
        console.log("📊 Position sizing calculated:", sizing);
        console.log(`💰 Fractional Kelly: ${sizing.fractionalKelly * 100}% | Optimal: ${sizing.optimalKellyPercentage}% of Account`);
      } else {
        console.log("\n⚠️ ⚠️ ⚠️ SIGNAL GENERATION RETURNED NULL ⚠️ ⚠️ ⚠️");
        console.log("Check the detailed logs above for the specific rejection reason.");
        console.log("Common reasons:");
        console.log("  - Confidence below threshold");
        console.log("  - Dynamic cooldown still active");
        console.log("  - Macro event suppression");
        console.log("  - Signal conflict (opposite direction)");
        console.log("  - Price proximity filter (too close to existing signal)\n");
      }
    } catch (error) {
      console.error("\n❌ ❌ ❌ CRITICAL ERROR IN SIGNAL GENERATION ❌ ❌ ❌");
      console.error("Error:", error);
      console.error("Stack:", error instanceof Error ? error.stack : 'No stack trace');
    }
  }, [settings, accountBalance, appLaunchTime, syncSignalPriceFromEngine, commitGuidePrice]);

  const updateAllSignalsStatus = useCallback(() => {
    const price = signalTrackingSnapshot.price;
    const signalPriceSource = signalTrackingSnapshot.source;
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    const GRACE_PERIOD_MS = 5000;
    
    if (price <= 0) {
      console.log('⏳ Skipping signal status update - no valid price yet');
      return;
    }
    
    console.log(`🔄 [${Platform.OS}] Checking signal status updates - Tracking Price: ${price.toFixed(1)} from ${signalPriceSource}`);

    // SPIKE FILTER: reject clearly-outlier ticks (feed glitches) that jump >8 pips
    // from the last accepted tracking price within <500ms. These readings were
    // the root cause of false SL hits recorded "1 minute after" signal creation.
    const lastAccepted = lastAcceptedTickRef.current;
    if (lastAccepted.price > 0 && lastAccepted.at > 0) {
      const dtMs = now - lastAccepted.at;
      const gapPips = Math.abs(price - lastAccepted.price);
      if (dtMs < TICK_SPIKE_WINDOW_MS && gapPips > TICK_SPIKE_REJECT_PIPS) {
        console.warn(`🛡️ SPIKE REJECTED: tick ${price.toFixed(1)} jumped ${gapPips.toFixed(1)} pips in ${dtMs}ms from last accepted ${lastAccepted.price.toFixed(1)} - not evaluating signals on this tick`);
        return;
      }
    }
    lastAcceptedTickRef.current = { price, at: now };

    setSignalHistory((prevHistory) => {
      let updated = false;
      let immediateUpdate = false;
      const updatedHistory = prevHistory.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "SL_AFTER_BE" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
          return signal;
        }

        const signalAge = now - new Date(signal.timestamp).getTime();
        const signalCreationAge = signal.createdAt ? now - signal.createdAt : signalAge;
        
        if (signalCreationAge < GRACE_PERIOD_MS) {
          console.log(`⏸️ Signal ${signal.id.slice(-6)} in grace period (${(signalCreationAge / 1000).toFixed(1)}s < 5s) - skipping SL/TP check`);
          return signal;
        }
        if (signalAge > twoHoursInMs) {
          updated = true;
          const exitDate = new Date();
          const livePrice = signalEngine.getCurrentPrice();
          console.log(`⏰ Signal ${signal.id.slice(-6)} expired after 2 hours`);
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            exitPrice: signal.exitPrice ?? (livePrice > 0 ? livePrice : signal.entryPrice),
          };
        }

        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let updatedSignal = signal;
        let breakevenReached = signal.breakevenReached || false;
        let breakevenTime = signal.breakevenTime;

        let trailingSLPrice = signal.trailingSLPrice || signal.sl;
        let trailingSLLevel = signal.trailingSLLevel || undefined;

        console.log(`🔍 Monitoring Signal ${signal.id.slice(-6)}: Type=${signal.type}, Status=${signal.status}, Targets=${targetsHit}/3, Price=${price.toFixed(1)}, TP1=${signal.tp1.toFixed(1)}, TP2=${signal.tp2.toFixed(1)}, TP3=${signal.tp3.toFixed(1)}, SL=${signal.sl.toFixed(1)}, TrailingSL=${trailingSLPrice.toFixed(1)} (${trailingSLLevel || 'ORIGINAL'}), Breakeven=${breakevenReached}`);

        // Effective SL level: after TP1 we switch to the 15-pip profit lock;
        // after TP2 we switch to entry (existing behavior).
        const hasTP1 = (signal.targetsHit >= 1) || signal.breakevenReached === true;
        const hasTP2 = signal.targetsHit >= 2;
        const postTP1Lock = getPostTP1LockPrice(signal);
        const effectiveSLPrice = hasTP2
          ? signal.entryPrice
          : hasTP1
            ? postTP1Lock
            : signal.sl;

        // SL-hit confirmation helper: returns true only if the breach of the
        // EFFECTIVE SL level is genuine (sustained duration + penetration +
        // multiple independent ticks). This prevents a single glitchy tick
        // from closing the trade.
        const confirmSLHit = (refPrice: number): boolean => {
          const penetrationPips = signal.type === "BUY"
            ? (refPrice - price) / PIP_VALUE
            : (price - refPrice) / PIP_VALUE;
          if (penetrationPips < 0) {
            if (slBreachTrackerRef.current.has(signal.id)) {
              console.log(`🛡️ SL breach for ${signal.id.slice(-6)} reset - price recovered above/below effective SL ${refPrice.toFixed(1)}`);
              slBreachTrackerRef.current.delete(signal.id);
            }
            return false;
          }
          const existing = slBreachTrackerRef.current.get(signal.id);
          if (!existing) {
            slBreachTrackerRef.current.set(signal.id, {
              firstBreachAt: now,
              maxPenetrationPips: penetrationPips,
              lastPrice: price,
              tickCount: 1,
            });
            console.log(`🛡️ SL BREACH DETECTED (pending confirmation): ${signal.id.slice(-6)} penetration=${penetrationPips.toFixed(2)} pips @ ${price.toFixed(1)} vs effective SL ${refPrice.toFixed(1)} - need ${SL_CONFIRMATION_MIN_DURATION_MS}ms + ${SL_CONFIRMATION_MIN_PENETRATION_PIPS} pips + ${SL_CONFIRMATION_MIN_TICKS} ticks`);
            return false;
          }
          existing.maxPenetrationPips = Math.max(existing.maxPenetrationPips, penetrationPips);
          existing.lastPrice = price;
          existing.tickCount += 1;
          const elapsed = now - existing.firstBreachAt;
          const confirmed = elapsed >= SL_CONFIRMATION_MIN_DURATION_MS
            && existing.maxPenetrationPips >= SL_CONFIRMATION_MIN_PENETRATION_PIPS
            && existing.tickCount >= SL_CONFIRMATION_MIN_TICKS;
          if (!confirmed) {
            console.log(`🛡️ SL breach ongoing for ${signal.id.slice(-6)}: elapsed=${elapsed}ms (need ${SL_CONFIRMATION_MIN_DURATION_MS}), maxPen=${existing.maxPenetrationPips.toFixed(2)}p (need ${SL_CONFIRMATION_MIN_PENETRATION_PIPS}), ticks=${existing.tickCount} (need ${SL_CONFIRMATION_MIN_TICKS})`);
            return false;
          }
          console.log(`✅ SL HIT CONFIRMED for ${signal.id.slice(-6)}: sustained ${elapsed}ms, pen ${existing.maxPenetrationPips.toFixed(2)}p, ${existing.tickCount} ticks (effective SL ${refPrice.toFixed(1)})`);
          slBreachTrackerRef.current.delete(signal.id);
          return true;
        };

        if (signal.type === "BUY") {
          if (hasTP2 && price <= signal.entryPrice && confirmSLHit(signal.entryPrice)) {
            console.log(`✅ TP2 runner returned to entry: BUY signal ${signal.id.slice(-6)} closing as protected partial win @ ${price.toFixed(1)}`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            updated = true;
            immediateUpdate = true;
          } else if (hasTP1 && !hasTP2 && price <= postTP1Lock && confirmSLHit(postTP1Lock)) {
            console.log(`⚖️ 15-PIP PROFIT LOCK HIT: BUY signal ${signal.id.slice(-6)} retraced to entry+15 (${postTP1Lock.toFixed(1)}) after TP1 - banking lock @ ${price.toFixed(1)}`);
            newStatus = "SL_AFTER_BE";
            targetsHit = Math.max(targetsHit, 1);
            updated = true;
            immediateUpdate = true;
          } else if (!hasTP1 && price <= signal.sl && confirmSLHit(signal.sl)) {
            console.log(`🚨 ORIGINAL SL HIT (CONFIRMED): BUY signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
          } else if (price >= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price >= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`📋 BREAKEVEN INDICATOR at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade continues to TP3 or original SL)`);
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN INDICATOR activated at ${breakevenTime} - entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
            console.log(`🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
          }

          if (breakevenReached && price <= signal.entryPrice && price > signal.sl && targetsHit < 3) {
            console.log(`📋 BREAKEVEN NOTIFICATION: BUY Signal ${signal.id.slice(-6)} price at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
          }
        } else {
          if (hasTP2 && price >= signal.entryPrice && confirmSLHit(signal.entryPrice)) {
            console.log(`✅ TP2 runner returned to entry: SELL signal ${signal.id.slice(-6)} closing as protected partial win @ ${price.toFixed(1)}`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            updated = true;
            immediateUpdate = true;
          } else if (hasTP1 && !hasTP2 && price >= postTP1Lock && confirmSLHit(postTP1Lock)) {
            console.log(`⚖️ 15-PIP PROFIT LOCK HIT: SELL signal ${signal.id.slice(-6)} retraced to entry-15 (${postTP1Lock.toFixed(1)}) after TP1 - banking lock @ ${price.toFixed(1)}`);
            newStatus = "SL_AFTER_BE";
            targetsHit = Math.max(targetsHit, 1);
            updated = true;
            immediateUpdate = true;
          } else if (!hasTP1 && price >= signal.sl && confirmSLHit(signal.sl)) {
            console.log(`🚨 ORIGINAL SL HIT (CONFIRMED): SELL signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
          } else if (price <= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price <= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`📋 BREAKEVEN INDICATOR at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade continues to TP3 or original SL)`);
          } else if (price <= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN INDICATOR activated at ${breakevenTime} - entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
            console.log(`🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
          }

          if (breakevenReached && price >= signal.entryPrice && price < signal.sl && targetsHit < 3) {
            console.log(`📋 BREAKEVEN NOTIFICATION: SELL Signal ${signal.id.slice(-6)} price at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
          }
        }

        if (newStatus !== signal.status || targetsHit !== signal.targetsHit || trailingSLPrice !== signal.trailingSLPrice) {
          if (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT") {
            const exitDate = new Date();
            console.log(`✅ Terminal status reached: Signal ${signal.id.slice(-6)} will remain in history only`);
            
            let exitPrice: number;
            let result: 'WIN' | 'LOSS';
            
            if (newStatus === "ALL_TARGETS_HIT") {
              exitPrice = signal.tp3;
              result = "WIN";
            } else if (newStatus === "PARTIAL_WIN_SL_HIT") {
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              result = "WIN";
              console.log(`   ✅ TP1/TP2 partials banked, runner stopped at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
            } else if (newStatus === "SL_AFTER_BE") {
              exitPrice = getProtectedExitPrice(signal, Math.max(targetsHit, 1));
              result = "WIN";
              console.log(`   ⚖️ SL hit AFTER breakeven - TP1 banked, no capital loss recorded as WIN @ ${exitPrice.toFixed(1)}`);
            } else {
              exitPrice = signal.sl;
              result = "LOSS";
            }
            
            signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              exitPrice,
              result,
              {} as any,
              undefined,
              now - new Date(signal.timestamp).getTime()
            ).catch(err => {
              console.error(`Failed to record trade outcome for ${signal.id}:`, err);
            });
            
            // Proposal #7: Reset cooldown on resolution so opposite-direction signals aren't blocked
            signalEngine.resetSignalLock();
            
            console.log(`📊 Learning System: Recorded ${result} outcome for signal ${signal.id.slice(-6)}`);
            
            return {
              ...updatedSignal,
              status: newStatus,
              targetsHit,
              breakevenReached,
              breakevenTime,
              trailingSLPrice,
              trailingSLLevel,
              exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
              exitPrice,
            };
          }
          
          if (targetsHit === 2 && signal.targetsHit < 2) {
            console.log(`🔓 LOCK RELEASED: Signal ${signal.id.slice(-6)} hit TP2 - New signals can now be generated`);
            console.log(`   This signal continues to be monitored for TP3 or SL`);
          }
          
          return { ...updatedSignal, status: newStatus, targetsHit, breakevenReached, breakevenTime, trailingSLPrice, trailingSLLevel };
        }

        return signal;
      });

      if (updated) {
        console.log(`✅ Signal status updated - triggering UI refresh (trigger: ${signalUpdateTrigger + 1})`);
        console.log(`📱 Platform: ${Platform.OS} | Immediate: ${immediateUpdate}`);
        
        setSignalUpdateTrigger(prev => prev + 1);
        
        persistSignalHistory(updatedHistory, { immediate: immediateUpdate });
        if (immediateUpdate) {
          console.log(`🚨 Critical update (SL/TP hit) - Force UI refresh on ${Platform.OS}`);
          setTimeout(() => {
            setSignalUpdateTrigger(prev => prev + 1);
          }, 50);
        }
      }

      return updated ? updatedHistory : prevHistory;
    });
  }, [signalTrackingSnapshot, signalUpdateTrigger, setSignalUpdateTrigger]);

  useEffect(() => {
    updateAllSignalsStatus();
  }, [signalTrackingSnapshot.price, signalTrackingSnapshot.updatedAt, updateAllSignalsStatus]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const signalMonitorInterval = setInterval(() => {
      updateAllSignalsStatus();
    }, 5000);

    return () => {
      clearInterval(signalMonitorInterval);
    };
  }, [isLoading, updateAllSignalsStatus]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    let isMounted = true;

    const runHistoricalReconciliation = async (reason: string) => {
      if (historicalReconciliationInFlightRef.current) {
        console.log(`⏳ Historical reconciliation already running - skipping ${reason}`);
        return;
      }

      const currentHistory = signalHistoryRef.current;
      const openSignals = currentHistory.filter(signal => !TERMINAL_SIGNAL_STATUSES.includes(signal.status));
      const now = Date.now();
      const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
      const recentTerminals = currentHistory.filter(signal => {
        if (!TERMINAL_SIGNAL_STATUSES.includes(signal.status)) return false;
        const signalTs = new Date(signal.timestamp).getTime();
        return (now - signalTs) <= twentyFourHoursInMs;
      });

      if (openSignals.length === 0 && recentTerminals.length === 0) {
        return;
      }

      historicalReconciliationInFlightRef.current = true;
      console.log(`🧭 Historical reconciliation triggered (${reason}) for ${openSignals.length} open + ${recentTerminals.length} recent-terminal signal(s)`);

      try {
        // 1. Reconcile open signals (catch-up detects TP/SL hits the live tick
        //    monitor may have missed).
        const reconciledHistory = await catchUpAndEvaluateSignals(currentHistory, historicalFallbackPriceRef.current);

        if (!isMounted) {
          return;
        }

        // 2. Re-audit every terminal signal from the last 24h against 1m bars.
        //    This catches the reverse failure mode: the live tick monitor
        //    committed a wrong-direction terminal (e.g. BUY → TP3 when price
        //    actually went straight to SL) because it missed ticks on the
        //    SL side. The bar-based resolver is authoritative and will flip
        //    these back to the correct status.
        const auditedHistory = await auditTerminalSLSignals(reconciledHistory);

        if (!isMounted) {
          return;
        }

        const previousSerialized = JSON.stringify(currentHistory);
        const nextSerialized = JSON.stringify(auditedHistory);

        if (previousSerialized !== nextSerialized) {
          signalHistoryRef.current = auditedHistory;
          setSignalHistory(auditedHistory);
          persistSignalHistory(auditedHistory, { immediate: true });
          setSignalUpdateTrigger(prev => prev + 1);
          console.log('✅ Historical reconciliation + audit applied missed/wrong TP/SL updates');
        } else {
          console.log('✅ Historical reconciliation + audit found no missed/wrong TP/SL events');
        }
      } catch (error) {
        console.error('❌ Historical reconciliation failed:', error);
      } finally {
        historicalReconciliationInFlightRef.current = false;
      }
    };

    void runHistoricalReconciliation('startup');

    const historicalReconciliationInterval = setInterval(() => {
      void runHistoricalReconciliation('interval');
    }, HISTORICAL_RECONCILIATION_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(historicalReconciliationInterval);
    };
  }, [catchUpAndEvaluateSignals, auditTerminalSLSignals, isLoading]);

  useEffect(() => {
    if (!isLoggedIn) {
      console.log('⚠️ User not logged in - signal generation paused');
      return;
    }

    if (isLoading) {
      console.log('⚠️ Still loading data - signal generation waiting for initialization...');
      return;
    }

    console.log(`✅ Signal generation system activated - checking every ${(SIGNAL_GENERATION_INTERVAL_MS / 1000).toFixed(0)}s`);
    console.log(`   Data loaded: ${signalHistoryRef.current.length} signals in history`);
    console.log(`   Launch cooldown: 5 seconds (prevents duplicate signals at startup)`);
    
    const signalInterval = setInterval(() => {
      console.log(`⏰ ${(SIGNAL_GENERATION_INTERVAL_MS / 1000).toFixed(0)}s interval - checking for signal generation...`);
      void checkAndGenerateSignal();
    }, SIGNAL_GENERATION_INTERVAL_MS);

    console.log('🚀 Scheduling initial signal generation check (after 5s cooldown)...');
    const initialSignalCheckTimeout = setTimeout(() => {
      console.log('✅ Launch cooldown complete - starting signal generation');
      void checkAndGenerateSignal();
    }, 5000);

    return () => {
      console.log('🛑 Signal generation system deactivated');
      clearInterval(signalInterval);
      clearTimeout(initialSignalCheckTimeout);
    };
  }, [isLoggedIn, isLoading, checkAndGenerateSignal]);

  const login = useCallback(async (username: string) => {
    setIsLoggedIn(true);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(true));
    console.log(`User logged in: ${username}`);
  }, []);

  const logout = useCallback(async () => {
    setIsLoggedIn(false);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(false));
  }, []);

  const clearHistory = useCallback(async () => {
    setSignalHistory([]);
    // Cancel any pending debounced write so it can't resurrect cleared history.
    pendingHistoryWriteRef.current = [];
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
      historyWriteTimerRef.current = null;
    }
    await AsyncStorage.setItem("signal_history", JSON.stringify([]));
    console.log('🧹 Signal history cleared');
    console.log('✅ All signals removed from storage and UI');
  }, []);

  const updateSettings = useCallback(async (newSettings: Partial<Settings>) => {
    const updated = sanitizeSettings({ ...settings, ...newSettings });
    setSettings(updated);
    await AsyncStorage.setItem("trading_settings", JSON.stringify(updated));

    if (Platform.OS !== 'web' && 'enableNotifications' in newSettings) {
      if (newSettings.enableNotifications) {
        const registered = await registerBackgroundTask();
        setBackgroundTaskActive(registered);
        console.log('✅ Background task enabled');
      } else {
        setBackgroundTaskActive(false);
        console.log('⚠️ Background task disabled');
      }
    }
  }, [settings]);

  const deleteSignalFromHistory = useCallback(async (signalId: string) => {
    setSignalHistory((prev) => {
      const updated = prev.filter((s) => s.id !== signalId);
      persistSignalHistory(updated, { immediate: true });
      return updated;
    });
  }, [persistSignalHistory]);

  const manualCloseSignal = useCallback((signalId: string) => {
    closeSignal(signalId);
  }, [closeSignal]);

  const refreshData = useCallback(async () => {
    await updateMarketOutlook();

    let price = signalEngine.getCurrentPrice();
    if (price <= 0) {
      price = await signalEngine.updateCurrentPrice();
    }

    if (price > 0) {
      syncSignalPriceFromEngine(price);
    }

    console.log(`Data refreshed successfully | price=${price.toFixed(2)} | source=${signalEngine.getPriceSource()}`);
  }, [syncSignalPriceFromEngine]);

  const triggerManualRetrain = useCallback(async (reason?: string) => {
    const result = await signalEngine.manualRetrain(reason || 'User Triggered');
    
    if (result.success) {
      const metrics = calculatePerformanceMetrics(signalHistory);
      setPerformanceMetrics(metrics);
      console.log('✅ Manual retrain completed - performance metrics refreshed');
    }
    
    return result;
  }, [signalHistory, calculatePerformanceMetrics]);

  return useMemo(() => ({
    isLoggedIn,
    isLoading,
    signalHistory,
    settings,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    accountBalance,
    currentPrice,
    signalTrackingPrice: signalTrackingSnapshot.price,
    signalTrackingSource: signalTrackingSnapshot.source,
    signalTrackingUpdatedAt: signalTrackingSnapshot.updatedAt,
    guidePrice,
    chartPrice,
    priceHistory,
    dailyOHLCHistory,
    signalUpdateTrigger,
    priceSource,
    chartPriceSource,
    guidePriceSource,
    guidePriceUpdatedAt,
    livePriceError,
    ingestChartPrice,
    login,
    logout,
    clearHistory,
    updateSettings,
    deleteSignalFromHistory,
    manualCloseSignal,
    refreshData,
    triggerManualRetrain,
    runManualAudit,
    backgroundTaskActive,
  }), [
    accountBalance,
    backgroundTaskActive,
    clearHistory,
    chartPrice,
    chartPriceSource,
    currentPrice,
    dailyOHLCHistory,
    deleteSignalFromHistory,
    guidePrice,
    guidePriceSource,
    guidePriceUpdatedAt,
    isLoading,
    isLoggedIn,
    ingestChartPrice,
    livePriceError,
    login,
    logout,
    manualCloseSignal,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    priceHistory,
    priceSource,
    refreshData,
    runManualAudit,
    settings,
    signalHistory,
    signalTrackingSnapshot.price,
    signalTrackingSnapshot.source,
    signalTrackingSnapshot.updatedAt,
    signalUpdateTrigger,
    triggerManualRetrain,
    updateSettings,
  ]);
});
