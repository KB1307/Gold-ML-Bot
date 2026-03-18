import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine, setExternalPrice } from "@/services/signalEngine";
import { Platform } from "react-native";
import { trpcClient } from "@/lib/trpc";
import { goldWebSocketService } from "@/services/goldWebSocketService";
import { 
  registerBackgroundTask, 
  setupNotificationChannel, 
  requestNotificationPermissions,
  sendSignalNotification
} from "@/services/backgroundTaskService";

const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 20,
  tp2Pips: 40,
  tp3Pips: 65,
  slPips: 70,
  numberOfTPs: 3,
  minConfidence: 0.85,
  enableNotifications: true,
  basePositionSize: 0.01,
  maxRiskPercentage: 2.0,
  useKellyCriterion: true,
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

const CHART_PRICE_PRIORITY_WINDOW_MS = 15000;
const HISTORICAL_RECONCILIATION_INTERVAL_MS = 30000;
const TERMINAL_SIGNAL_STATUSES: SignalStatus[] = ["CLOSED", "SL_HIT", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT"];

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
  const [guidePrice, setGuidePrice] = useState<number>(0);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);
  const [dailyOHLCHistory, setDailyOHLCHistory] = useState<DailyOHLC[]>([]);
  const [signalUpdateTrigger, setSignalUpdateTrigger] = useState<number>(0);
  const [appLaunchTime] = useState<number>(Date.now());
  const [backgroundTaskActive, setBackgroundTaskActive] = useState<boolean>(false);
  const [priceSource, setPriceSource] = useState<string>('connecting...');
  const [guidePriceSource, setGuidePriceSource] = useState<string>('connecting...');
  const [guidePriceUpdatedAt, setGuidePriceUpdatedAt] = useState<number>(0);
  const [livePriceError, setLivePriceError] = useState<string | null>(null);
  const chartPriceHeartbeatRef = useRef<number>(0);
  const historicalReconciliationInFlightRef = useRef<boolean>(false);
  const signalHistoryRef = useRef<TradingSignal[]>([]);
  const historicalFallbackPriceRef = useRef<number>(0);

  useEffect(() => {
    const init = async () => {
      console.log('🚀 Initializing Trading Context...');
      try {
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

  const commitLivePrice = useCallback((price: number, source: string) => {
    setExternalPrice(price, source);
    setCurrentPrice(price);
    setPriceSource(source);
    setLivePriceError(null);

    const now = Date.now();
    setCurrentPriceUpdatedAt(now);
    setPriceHistory(prev => {
      const newHistory = [...prev, { timestamp: now, price }];
      const maxPoints = 60;
      if (newHistory.length > maxPoints) {
        return newHistory.slice(newHistory.length - maxPoints);
      }
      return newHistory;
    });

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

    if (origin === "chart") {
      chartPriceHeartbeatRef.current = now;
      commitLivePrice(price, source);
      return;
    }

    if (isChartFeedFresh) {
      console.log(`ℹ️ Ignoring ${source} tick because TradingView chart price is active`);
      return;
    }

    commitLivePrice(price, source);
  }, [commitLivePrice]);

  const ingestChartPrice = useCallback((price: number) => {
    applyLivePrice(price, '🟢 tradingview-chart', "chart");
  }, [applyLivePrice]);

  useEffect(() => {
    let isMounted = true;

    console.log('🔌 Starting TwelveData guide price feed...');

    const unsubPrice = goldWebSocketService.onPrice((price: number, source: string) => {
      if (!isMounted) return;
      commitGuidePrice(price, source);
    });

    const unsubStatus = goldWebSocketService.onStatus((status) => {
      if (!isMounted) return;

      console.log(`📡 TwelveData guide feed status: ${status}`);

      if (status === 'connected') {
        const lastGuidePrice = goldWebSocketService.getLastPrice();
        const lastGuidePriceSource = goldWebSocketService.getLastPriceSource();

        if (lastGuidePrice > 0) {
          commitGuidePrice(lastGuidePrice, lastGuidePriceSource);
        } else {
          setGuidePriceSource('🟢 twelvedata live');
        }
      } else if (status === 'fallback') {
        setGuidePriceSource('🟡 guide fallback');
      } else if (status === 'disconnected') {
        setGuidePriceSource('🔴 disconnected');
      } else if (status === 'reconnecting') {
        setGuidePriceSource('🔄 reconnecting...');
      }
    });

    goldWebSocketService.start();

    return () => {
      isMounted = false;
      unsubPrice();
      unsubStatus();
      goldWebSocketService.stop();
    };
  }, [commitGuidePrice]);

  useEffect(() => {
    const interval = setInterval(() => {
      void updateMarketOutlook();
    }, 5000);

    void updateMarketOutlook();

    return () => clearInterval(interval);
  }, []);

  const fetchPriceHistory = useCallback(async (fromTime: number, toTime: number): Promise<{timestamp: number, open: number, high: number, low: number, close: number}[]> => {
    try {
      console.log(`📊 Fetching historical 1-MINUTE OHLCV data (via tRPC)...`);
      console.log(`   From: ${new Date(fromTime).toISOString()}`);
      console.log(`   To: ${new Date(toTime).toISOString()}`);
      
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('fetchPriceHistory timed out after 15s')), 15000)
      );
      const bars = await Promise.race([
        trpcClient.goldPrice.getHistoricalData.query({ fromTime, toTime }),
        timeoutPromise,
      ]);
      
      console.log(`✅ Fetched ${bars.length} historical 1-MINUTE bars`);
      
      if (bars.length > 0) {
        console.log(`   First bar: ${new Date(bars[0].timestamp).toISOString()} - Close: ${bars[0].close.toFixed(2)}`);
        console.log(`   Last bar: ${new Date(bars[bars.length - 1].timestamp).toISOString()} - Close: ${bars[bars.length - 1].close.toFixed(2)}`);
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
    
    const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
    const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
    const ENTRY_TOLERANCE = 1.0;
    
    console.log(`\n🔍 STEP 1: Entry Validation (${signal.type})`);
    console.log(`   Entry Zone: ${(entryMin - ENTRY_TOLERANCE).toFixed(1)} - ${(entryMax + ENTRY_TOLERANCE).toFixed(1)}`);
    
    for (let i = 0; i < historicalBars.length; i++) {
      const bar = historicalBars[i];
      
      if (!entryConfirmed) {
        const touchedEntryZone = signal.type === "BUY" 
          ? bar.low <= (entryMax + ENTRY_TOLERANCE) && bar.high >= (entryMin - ENTRY_TOLERANCE)
          : bar.high >= (entryMin - ENTRY_TOLERANCE) && bar.low <= (entryMax + ENTRY_TOLERANCE);
        
        if (touchedEntryZone) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY CONFIRMED on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar H/L: ${bar.high.toFixed(1)}/${bar.low.toFixed(1)}`);
        }
        continue;
      }
      
      console.log(`   [Bar ${i+1}] ${new Date(bar.timestamp).toLocaleTimeString()} - H:${bar.high.toFixed(1)} L:${bar.low.toFixed(1)} C:${bar.close.toFixed(1)}`);
      
      if (signal.type === "BUY") {
        if (bar.low <= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= Original SL: ${signal.sl.toFixed(1)}`);
          currentStatus = "SL_HIT";
          exitPrice = signal.sl;
          outcomeResult = 'LOSS';
          console.log(`      📊 Result: LOSS (Original SL hit)`);
          if (breakevenReached) {
            console.log(`      📋 NOTE: Breakeven was active (indicator only) but trade closed at original SL for learning accuracy`);
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

        if (breakevenReached && bar.low <= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      } else {
        if (bar.high >= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= Original SL: ${signal.sl.toFixed(1)}`);
          currentStatus = "SL_HIT";
          exitPrice = signal.sl;
          outcomeResult = 'LOSS';
          console.log(`      📊 Result: LOSS (Original SL hit)`);
          if (breakevenReached) {
            console.log(`      📋 NOTE: Breakeven was active (indicator only) but trade closed at original SL for learning accuracy`);
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

        if (breakevenReached && bar.high >= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      }
    }
    
    if (!entryConfirmed) {
      console.log(`   ❌ ENTRY VALIDATION FAILED: Price never entered the entry zone`);
      console.log(`      Signal marked as EXPIRED_MISSED_ENTRY`);
      currentStatus = "EXPIRED_MISSED_ENTRY";
      outcomeResult = null;
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
      
      if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
        continue;
      }
      
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
          if (currentPrice <= signal.sl) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            outcomeResult = 'LOSS';
            exitPrice = signal.sl;
            shouldRecord = true;
            if (signal.breakevenReached) {
              console.log(`   📋 NOTE: Breakeven was active (indicator only) - trade closed at original SL for ML learning`);
            }
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
          if (currentPrice >= signal.sl) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            outcomeResult = 'LOSS';
            exitPrice = signal.sl;
            shouldRecord = true;
            if (signal.breakevenReached) {
              console.log(`   📋 NOTE: Breakeven was active (indicator only) - trade closed at original SL for ML learning`);
            }
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
            exitTime: (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT")
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
        const analysis = await analyzeSignalWithHistoricalData(signal, historicalBars);
        
        if (analysis.newStatus !== signal.status || analysis.targetsHit !== signal.targetsHit || analysis.breakevenReached !== signal.breakevenReached) {
          hasChanges = true;
          const exitDate = new Date();
          
          updatedHistory[i] = {
            ...signal,
            status: analysis.newStatus,
            targetsHit: analysis.targetsHit,
            breakevenReached: analysis.breakevenReached,
            breakevenTime: analysis.breakevenTime,
            exitTime: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "ALL_TARGETS_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "ALL_TARGETS_HIT")
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
        const parsedSettings = JSON.parse(savedSettings);
        setSettings(parsedSettings);
        console.log('✅ Settings loaded:', parsedSettings);
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
        
        const evaluatedHistory = await catchUpAndEvaluateSignals(parsedHistory);
        setSignalHistory(evaluatedHistory);
        
        if (JSON.stringify(evaluatedHistory) !== JSON.stringify(parsedHistory)) {
          await AsyncStorage.setItem("signal_history", JSON.stringify(evaluatedHistory));
          console.log('💾 Updated signal history saved after catch-up evaluation');
        }
        
        console.log(`✅ History loaded: ${evaluatedHistory.length} signals`);
        console.log('📊 First 2 signals:', evaluatedHistory.slice(0, 2).map((s: TradingSignal) => ({
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
      s.status === "CLOSED" || s.status === "SL_HIT" || s.status === "ALL_TARGETS_HIT" || s.status === "PARTIAL_WIN_SL_HIT"
    );
    
    const totalTrades = closedTrades.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    const profits: number[] = [];
    const losses: number[] = [];

    closedTrades.forEach(signal => {
      let pnl = 0;
      
      let exitPrice: number;
      
      if (signal.exitPrice !== undefined) {
        exitPrice = signal.exitPrice;
      } else if (signal.status === "ALL_TARGETS_HIT") {
        exitPrice = signal.tp3;
      } else if (signal.status === "SL_HIT") {
        exitPrice = signal.sl;
      } else if (signal.status === "CLOSED") {
        exitPrice = signal.entryPrice;
      } else if (signal.status === "PARTIAL_WIN_SL_HIT") {
        exitPrice = signal.tp3;
      } else {
        exitPrice = signal.entryPrice;
      }

      const contractSize = 100;
      if (signal.type === "BUY") {
        pnl = (exitPrice - signal.entryPrice) * settings.basePositionSize * contractSize;
      } else {
        pnl = (signal.entryPrice - exitPrice) * settings.basePositionSize * contractSize;
      }

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
      let pnl = 0;
      
      let exitPriceForDD: number;
      
      if (signal.exitPrice !== undefined) {
        exitPriceForDD = signal.exitPrice;
      } else if (signal.status === "ALL_TARGETS_HIT") {
        exitPriceForDD = signal.tp3;
      } else if (signal.status === "SL_HIT") {
        exitPriceForDD = signal.sl;
      } else if (signal.status === "CLOSED") {
        exitPriceForDD = signal.entryPrice;
      } else {
        exitPriceForDD = signal.entryPrice;
      }
      
      const contractSizeDD = 100;
      if (signal.type === "BUY") {
        pnl = (exitPriceForDD - signal.entryPrice) * settings.basePositionSize * contractSizeDD;
      } else {
        pnl = (signal.entryPrice - exitPriceForDD) * settings.basePositionSize * contractSizeDD;
      }

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

  useEffect(() => {
    const metrics = calculatePerformanceMetrics(signalHistory);
    setPerformanceMetrics(metrics);
    void AsyncStorage.setItem("performance_metrics", JSON.stringify(metrics));
  }, [signalHistory, calculatePerformanceMetrics]);

  const closeSignal = useCallback((signalId: string) => {
    const now = new Date();

    setSignalHistory((prev) => {
      const updated = prev.map(signal => {
        if (signal.id === signalId) {
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          };
        }
        return signal;
      });
      void AsyncStorage.setItem("signal_history", JSON.stringify(updated));
      return updated;
    });
  }, []);



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

  const signalTrackingSnapshot = useMemo(() => {
    const now = Date.now();
    const chartAgeMs = currentPriceUpdatedAt > 0 ? now - currentPriceUpdatedAt : Number.POSITIVE_INFINITY;
    const guideAgeMs = guidePriceUpdatedAt > 0 ? now - guidePriceUpdatedAt : Number.POSITIVE_INFINITY;
    const hasFreshChartPrice = currentPrice > 0 && chartAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;
    const hasFreshGuidePrice = guidePrice > 0 && guideAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;

    if (hasFreshChartPrice) {
      return {
        price: currentPrice,
        source: priceSource || '🟢 tradingview-chart',
        updatedAt: currentPriceUpdatedAt,
      };
    }

    if (hasFreshGuidePrice) {
      return {
        price: guidePrice,
        source: guidePriceSource || '🟢 twelvedata live',
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
  }, [currentPrice, currentPriceUpdatedAt, guidePrice, guidePriceSource, guidePriceUpdatedAt, priceSource]);

  useEffect(() => {
    signalHistoryRef.current = signalHistory;
  }, [signalHistory]);

  useEffect(() => {
    historicalFallbackPriceRef.current = signalTrackingSnapshot.price;
  }, [signalTrackingSnapshot.price]);

  const checkAndGenerateSignal = useCallback(async () => {
    const timeSinceLaunch = Date.now() - appLaunchTime;
    const LAUNCH_COOLDOWN_MS = 5000;
    
    if (timeSinceLaunch < LAUNCH_COOLDOWN_MS) {
      const remainingCooldown = ((LAUNCH_COOLDOWN_MS - timeSinceLaunch) / 1000).toFixed(1);
      console.log(`🛡️ LAUNCH COOLDOWN: Preventing signal generation for ${remainingCooldown}s after app start`);
      console.log(`   This prevents duplicate signals during initialization`);
      return;
    }
    
    const outlook = await signalEngine.getMarketOutlook();
    const now = new Date();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 SIGNAL CHECK [${now.toLocaleTimeString()}]`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Market Open: ${outlook.isMarketOpen}`);
    console.log(`Current Session: ${outlook.currentSession}`);
    
    const fullyActiveSignals = signalHistory.filter(s => s.status === "ACTIVE");
    
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
      const twoHoursMs = 2 * 60 * 60 * 1000;
      
      const lockReleased = activeSignal.targetsHit >= 2;
      
      const canGenerateNewSignal = (
        lockReleased || 
        signalAgeMs > twoHoursMs
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
      if (signalAgeMs > twoHoursMs) {
        console.log(`   - Signal age exceeds 2 hours (${(signalAgeMs / 1000 / 60).toFixed(1)}m)`);
      }
    }

    try {
      console.log(`🎯 ATTEMPTING SIGNAL GENERATION...`);
      console.log(`   Settings: minConfidence=${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   Account Balance: ${accountBalance}`);
      
      const signal = await signalEngine.generateSignal(settings, accountBalance, signalHistory);
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
          AsyncStorage.setItem("signal_history", JSON.stringify(updated)).then(() => {
            console.log(`💾 History saved: ${updated.length} signals persisted to AsyncStorage`);
          }).catch(err => {
            console.error('❌ Failed to save history to AsyncStorage:', err);
          });
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
  }, [settings, accountBalance, signalHistory, appLaunchTime, syncSignalPriceFromEngine]);

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

    setSignalHistory((prevHistory) => {
      let updated = false;
      let immediateUpdate = false;
      const updatedHistory = prevHistory.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
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
          console.log(`⏰ Signal ${signal.id.slice(-6)} expired after 2 hours`);
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
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

        if (signal.type === "BUY") {
          if (price <= signal.sl) {
            console.log(`🚨 ORIGINAL SL HIT: BUY signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
            if (breakevenReached) {
              console.log(`   📋 Breakeven was active (indicator only) - trade closed at original SL for ML learning accuracy`);
            }
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
          if (price >= signal.sl) {
            console.log(`🚨 ORIGINAL SL HIT: SELL signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
            if (breakevenReached) {
              console.log(`   📋 Breakeven was active (indicator only) - trade closed at original SL for ML learning accuracy`);
            }
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
          if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
            const exitDate = new Date();
            console.log(`✅ Terminal status reached: Signal ${signal.id.slice(-6)} will remain in history only`);
            
            let exitPrice: number;
            let result: 'WIN' | 'LOSS';
            
            if (newStatus === "ALL_TARGETS_HIT") {
              exitPrice = signal.tp3;
              result = "WIN";
            } else {
              exitPrice = signal.sl;
              result = "LOSS";
              if (breakevenReached) {
                console.log(`   📋 Breakeven was indicator-only. Original SL used for accurate ML outcome recording.`);
              }
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
        
        AsyncStorage.setItem("signal_history", JSON.stringify(updatedHistory)).then(() => {
          console.log(`💾 Updated history saved: ${updatedHistory.length} signals`);
          
          if (immediateUpdate) {
            console.log(`🚨 Critical update (SL/TP hit) - Force UI refresh on ${Platform.OS}`);
            setTimeout(() => {
              setSignalUpdateTrigger(prev => prev + 1);
            }, 50);
          }
        }).catch(err => {
          console.error('❌ Failed to save updated history:', err);
        });
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

      if (openSignals.length === 0) {
        return;
      }

      historicalReconciliationInFlightRef.current = true;
      console.log(`🧭 Historical reconciliation triggered (${reason}) for ${openSignals.length} open signal(s)`);

      try {
        const reconciledHistory = await catchUpAndEvaluateSignals(currentHistory, historicalFallbackPriceRef.current);

        if (!isMounted) {
          return;
        }

        const previousSerialized = JSON.stringify(currentHistory);
        const nextSerialized = JSON.stringify(reconciledHistory);

        if (previousSerialized !== nextSerialized) {
          signalHistoryRef.current = reconciledHistory;
          setSignalHistory(reconciledHistory);
          await AsyncStorage.setItem("signal_history", JSON.stringify(reconciledHistory));
          setSignalUpdateTrigger(prev => prev + 1);
          console.log('✅ Historical reconciliation applied missed TP/SL updates');
        } else {
          console.log('✅ Historical reconciliation found no missed TP/SL events');
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
  }, [catchUpAndEvaluateSignals, isLoading]);

  useEffect(() => {
    if (!isLoggedIn) {
      console.log('⚠️ User not logged in - signal generation paused');
      return;
    }

    if (isLoading) {
      console.log('⚠️ Still loading data - signal generation waiting for initialization...');
      return;
    }

    console.log('✅ Signal generation system activated - checking every 30s');
    console.log(`   Data loaded: ${signalHistory.length} signals in history`);
    console.log(`   Launch cooldown: 5 seconds (prevents duplicate signals at startup)`);
    
    const signalInterval = setInterval(() => {
      console.log('⏰ 30s interval - checking for signal generation...');
      void checkAndGenerateSignal();
    }, 30000);

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
  }, [isLoggedIn, isLoading, checkAndGenerateSignal, signalHistory.length]);

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
    await AsyncStorage.setItem("signal_history", JSON.stringify([]));
    console.log('🧹 Signal history cleared');
    console.log('✅ All signals removed from storage and UI');
  }, []);

  const updateSettings = useCallback(async (newSettings: Partial<Settings>) => {
    const updated = { ...settings, ...newSettings };
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
      void AsyncStorage.setItem("signal_history", JSON.stringify(updated));
      return updated;
    });
  }, []);

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
    priceHistory,
    dailyOHLCHistory,
    signalUpdateTrigger,
    priceSource,
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
    backgroundTaskActive,
  }), [
    accountBalance,
    backgroundTaskActive,
    clearHistory,
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
