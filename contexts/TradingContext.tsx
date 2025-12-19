import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine } from "@/services/signalEngine";
import { Platform } from "react-native";
import { 
  registerBackgroundTask, 
  setupNotificationChannel, 
  requestNotificationPermissions,
  sendSignalNotification,
} from "@/services/backgroundTaskService";
// import { useSignalSync } from "@/hooks/useSignalSync";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 20,
  tp2Pips: 40,
  tp3Pips: 65,
  slPips: 70,
  numberOfTPs: 3,
  minConfidence: 0.70,
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

interface UserProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
  googleId: string;
}

export const [TradingProvider, useTrading] = createContextHook(() => {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [signalHistory, setSignalHistory] = useState<TradingSignal[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [marketOutlook, setMarketOutlook] = useState<MarketOutlook | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>(DEFAULT_METRICS);
  const [positionSizing, setPositionSizing] = useState<PositionSizing | null>(null);
  const [accountBalance, setAccountBalance] = useState<number>(100);
  const [currentPrice, setCurrentPrice] = useState<number>(2650);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);
  const [dailyOHLCHistory, setDailyOHLCHistory] = useState<DailyOHLC[]>([]);
  const [signalUpdateTrigger, setSignalUpdateTrigger] = useState<number>(0);
  const [appLaunchTime] = useState<number>(Date.now());
  const [backgroundTaskActive, setBackgroundTaskActive] = useState<boolean>(false);

  // useSignalSync(signalHistory, performanceMetrics, settings, accountBalance);

  useEffect(() => {
    const init = async () => {
      console.log('🚀 Initializing Trading Context...');
      
      try {
        console.log('📦 Step 1: Loading persisted data...');
        await Promise.race([
          loadPersistedData(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Load timeout')), 8000))
        ]).catch(error => {
          console.error('⚠️ loadPersistedData failed/timeout:', error);
          setIsLoading(false);
        });
        
        console.log('📊 Step 2: Loading daily OHLC (non-blocking)...');
        const loadedDailyOHLC = await Promise.race([
          signalEngine.loadPersistedLearningData(),
          new Promise<any>((resolve) => setTimeout(() => resolve([]), 3000))
        ]).catch(() => []);
        
        if (loadedDailyOHLC?.length > 0) {
          setDailyOHLCHistory(loadedDailyOHLC);
          console.log(`✅ Loaded ${loadedDailyOHLC.length} daily OHLC records`);
        }

        if (Platform.OS !== 'web') {
          console.log('📱 Step 3: Setting up mobile features (non-blocking)...');
          setupNotificationChannel().catch(() => {});
          requestNotificationPermissions().catch(() => {});
          
          if (settings.enableNotifications) {
            registerBackgroundTask().then(registered => {
              setBackgroundTaskActive(registered);
              if (registered) {
                console.log('✅ Background tasks enabled');
              }
            }).catch(() => {});
          }
        }

        console.log('✅ Trading Context initialized');
      } catch (error) {
        console.error('❌ Initialization error:', error);
        setIsLoading(false);
      }
    };
    
    const safetyTimeout = setTimeout(() => {
      console.error('⏰ SAFETY TIMEOUT - Force loading app');
      setIsLoading(false);
    }, 10000);
    
    init().finally(() => {
      clearTimeout(safetyTimeout);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const updatePrice = async () => {
      try {
        await signalEngine.updateCurrentPrice();
        const price = signalEngine.getCurrentPrice();
        setCurrentPrice(price);
        
        const now = Date.now();
        setPriceHistory(prev => {
          const newHistory = [...prev, { timestamp: now, price }];
          const maxPoints = 60;
          if (newHistory.length > maxPoints) {
            return newHistory.slice(newHistory.length - maxPoints);
          }
          return newHistory;
        });

        const updatedOHLC = await signalEngine.updateDailyOHLC(price);
        if (updatedOHLC) {
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
        }
      } catch (error) {
        console.error('Failed to update price:', error);
      }
    };

    const priceInterval = setInterval(() => {
      updatePrice();
    }, 1000);

    updatePrice();

    return () => clearInterval(priceInterval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      updateMarketOutlook();
    }, 5000);

    updateMarketOutlook();

    return () => clearInterval(interval);
  }, []);

  const fetchPriceHistory = async (fromTime: number, toTime: number): Promise<{timestamp: number, open: number, high: number, low: number, close: number}[]> => {
    try {
      console.log(`📊 Fetching historical 1-MINUTE OHLCV data (UPGRADED)...`);
      console.log(`   From: ${new Date(fromTime).toISOString()}`);
      console.log(`   To: ${new Date(toTime).toISOString()}`);
      console.log(`   Duration: ${((toTime - fromTime) / 1000 / 60).toFixed(1)} minutes`);
      console.log(`   ⚠️ Resolution: 1-MINUTE BARS (60-second window, minimal ambiguity)`);
      
      const url = Platform.OS === 'web' 
        ? `https://corsproxy.io/?${encodeURIComponent('https://query2.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d')}`
        : 'https://query2.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=1d';
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        console.error(`❌ Failed to fetch price history: HTTP ${response.status}`);
        return [];
      }
      
      const data = await response.json();
      
      if (!data?.chart?.result?.[0]?.timestamp) {
        console.error('❌ Invalid response format from Yahoo Finance');
        return [];
      }
      
      const result = data.chart.result[0];
      const timestamps = result.timestamp;
      const quotes = result.indicators.quote[0];
      
      const bars: {timestamp: number, open: number, high: number, low: number, close: number}[] = [];
      
      for (let i = 0; i < timestamps.length; i++) {
        const barTime = timestamps[i] * 1000;
        
        if (barTime >= fromTime && barTime <= toTime) {
          const open = quotes.open[i];
          const high = quotes.high[i];
          const low = quotes.low[i];
          const close = quotes.close[i];
          
          if (open !== null && high !== null && low !== null && close !== null) {
            bars.push({
              timestamp: barTime,
              open,
              high,
              low,
              close,
            });
          }
        }
      }
      
      console.log(`✅ Fetched ${bars.length} historical 1-MINUTE bars (Upgraded Resolution)`);
      if (bars.length > 0) {
        console.log(`   First bar: ${new Date(bars[0].timestamp).toISOString()} - Close: ${bars[0].close.toFixed(2)}`);
        console.log(`   Last bar: ${new Date(bars[bars.length - 1].timestamp).toISOString()} - Close: ${bars[bars.length - 1].close.toFixed(2)}`);
        console.log(`   Bar Ambiguity Window: 60 seconds (vs. 300 seconds with 5min bars)`);
        console.log(`   Accuracy Improvement: ~83% reduction in unobservable time`);
      }
      
      return bars;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('❌ Price history fetch timeout after 10s');
      } else {
        console.error('❌ Error fetching price history:', error);
      }
      return [];
    }
  };

  const analyzeSignalWithHistoricalData = async (
    signal: TradingSignal,
    historicalBars: {timestamp: number, open: number, high: number, low: number, close: number}[]
  ): Promise<{newStatus: SignalStatus, targetsHit: number, exitPrice: number, outcomeResult: 'WIN' | 'LOSS' | null}> => {
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
    let currentSL = signal.sl;
    let tp1HitTime: number | null = null;
    
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
        if (bar.low <= currentSL) {
          console.log(`   🚨 SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= SL: ${currentSL.toFixed(1)}`);
          
          if (currentTargetsHit > 0) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            exitPrice = currentSL;
            outcomeResult = 'WIN';
            console.log(`      📊 Result: PARTIAL WIN (TP${currentTargetsHit} hit before SL)`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = currentSL;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (SL hit before any TP)`);
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
        } else if (bar.high >= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          
          currentSL = signal.entryPrice;
          console.log(`      📌 SL MOVED TO BREAKEVEN: ${currentSL.toFixed(1)} (from ${signal.sl.toFixed(1)})`);
        }
      } else {
        if (bar.high >= currentSL) {
          console.log(`   🚨 SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= SL: ${currentSL.toFixed(1)}`);
          
          if (currentTargetsHit > 0) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            exitPrice = currentSL;
            outcomeResult = 'WIN';
            console.log(`      📊 Result: PARTIAL WIN (TP${currentTargetsHit} hit before SL)`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = currentSL;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (SL hit before any TP)`);
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
        } else if (bar.low <= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          
          currentSL = signal.entryPrice;
          console.log(`      📌 SL MOVED TO BREAKEVEN: ${currentSL.toFixed(1)} (from ${signal.sl.toFixed(1)})`);
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
    };
  };

  const catchUpAndEvaluateSignals = async (history: TradingSignal[], isInitialLoad = false) => {
    console.log('\n' + '='.repeat(80));
    console.log('🔄 SIGNAL CATCH-UP EVALUATION INITIATED');
    console.log('='.repeat(80));
    console.log('   Checking for stale ACTIVE signals that need evaluation...');
    console.log('   📊 Historical Reconciliation: Checking actual market outcomes during downtime');
    if (isInitialLoad) {
      console.log('   ⚡ FAST MODE: Skipping historical reconciliation during app launch');
    }
    
    const now = Date.now();
    const currentPrice = signalEngine.getCurrentPrice();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    
    let updatedHistory = [...history];
    let hasChanges = false;
    
    for (let i = 0; i < updatedHistory.length; i++) {
      const signal = updatedHistory[i];
      
      if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
        continue;
      }
      
      const signalAge = now - new Date(signal.timestamp).getTime();
      const isExpired = signalAge > twoHoursInMs;
      
      console.log(`\n🔍 Evaluating Signal ${signal.id.slice(-6)}:`);
      console.log(`   Type: ${signal.type}`);
      console.log(`   Status: ${signal.status}`);
      console.log(`   Entry: ${signal.entryPrice.toFixed(1)}`);
      console.log(`   Age: ${(signalAge / 1000 / 60 / 60).toFixed(1)} hours ${isExpired ? '(EXPIRED)' : ''}`);
      console.log(`   TP1: ${signal.tp1.toFixed(1)} | TP2: ${signal.tp2.toFixed(1)} | TP3: ${signal.tp3.toFixed(1)}`);
      console.log(`   SL: ${signal.sl.toFixed(1)}`);
      
      if (isExpired) {
        console.log(`   ⏰ Signal expired (>2 hours) - ${isInitialLoad ? 'Skipping historical fetch (initial load)' : 'Fetching historical data to determine actual outcome...'}`);
      }
      
      if (isInitialLoad && isExpired) {
        console.log(`   ⚡ Fast mode: Marking expired signal as CLOSED without verification`);
        updatedHistory[i] = {
          ...signal,
          status: "CLOSED" as const,
          exitTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        };
        hasChanges = true;
        continue;
      }
      
      const signalTime = new Date(signal.timestamp).getTime();
      const endTime = isExpired ? Math.min(signalTime + twoHoursInMs, now) : now;
      const historicalBars = await fetchPriceHistory(signalTime, endTime);
      
      if (historicalBars.length === 0) {
        console.log(`   ⚠️ No historical data available - using ${isExpired ? 'expired status' : 'current price fallback'}`);
        
        if (isExpired) {
          console.log(`   ⏰ EXPIRED WITHOUT DATA: Marking as CLOSED (unable to verify outcome)`);
          updatedHistory[i] = {
            ...signal,
            status: "CLOSED" as const,
            exitTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          };
          hasChanges = true;
          continue;
        }
        
        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let shouldRecord = false;
        let outcomeResult: 'WIN' | 'LOSS' = 'LOSS';
        let exitPrice = currentPrice;
        
        if (signal.type === "BUY") {
          if (currentPrice <= signal.sl) {
            console.log(`   🚨 CATCH-UP (Fallback): Stop Loss hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            shouldRecord = true;
            outcomeResult = 'LOSS';
            exitPrice = signal.sl;
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
            console.log(`   🚨 CATCH-UP (Fallback): Stop Loss hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            shouldRecord = true;
            outcomeResult = 'LOSS';
            exitPrice = signal.sl;
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
        
        if (isExpired && analysis.newStatus === signal.status && !analysis.outcomeResult) {
          console.log(`   ⏰ EXPIRED: No TP/SL hit during signal lifetime - marking as EXPIRED_MISSED_ENTRY`);
          updatedHistory[i] = {
            ...signal,
            status: "EXPIRED_MISSED_ENTRY" as const,
            exitTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          };
          hasChanges = true;
        } else if (analysis.newStatus !== signal.status || analysis.targetsHit !== signal.targetsHit) {
          hasChanges = true;
          const exitDate = new Date();
          
          const statusLabel = isExpired ? 'HISTORICAL RECONCILIATION' : 'LIVE UPDATE';
          console.log(`   ✅ ${statusLabel}: ${signal.status} -> ${analysis.newStatus}`);
          
          updatedHistory[i] = {
            ...signal,
            status: analysis.newStatus,
            targetsHit: analysis.targetsHit,
            exitTime: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "ALL_TARGETS_HIT" || analysis.newStatus === "PARTIAL_WIN_SL_HIT" || analysis.newStatus === "EXPIRED_MISSED_ENTRY") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
          };
          
          if (analysis.outcomeResult) {
            console.log(`   📊 Recording ${analysis.outcomeResult} outcome for learning engine (${statusLabel})...`);
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
  };

  const loadPersistedData = async () => {
    try {
      console.log('🔄 Loading persisted data from AsyncStorage...');
      const [savedSettings, savedHistory, loginStatus, savedMetrics, savedBalance, savedUserProfile] = await Promise.all([
        AsyncStorage.getItem("trading_settings"),
        AsyncStorage.getItem("signal_history"),
        AsyncStorage.getItem("is_logged_in"),
        AsyncStorage.getItem("performance_metrics"),
        AsyncStorage.getItem("account_balance"),
        AsyncStorage.getItem("user_profile"),
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
        
        const evaluatedHistory = await catchUpAndEvaluateSignals(parsedHistory, true);
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
        console.log('⚠️ No login status found - defaulting to logged out');
        setIsLoggedIn(false);
      }

      if (savedUserProfile) {
        const parsedProfile = JSON.parse(savedUserProfile);
        setUserProfile(parsedProfile);
        console.log('✅ User profile loaded:', parsedProfile.email);
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
    setMarketOutlook(outlook);
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
      s.status === "CLOSED" || s.status === "SL_HIT" || s.status === "ALL_TARGETS_HIT"
    );
    
    const totalTrades = closedTrades.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    const profits: number[] = [];
    const losses: number[] = [];

    closedTrades.forEach(signal => {
      const currentPrice = signalEngine.getCurrentPrice();
      let pnl = 0;
      
      if (signal.type === "BUY") {
        if (signal.status === "ALL_TARGETS_HIT") {
          pnl = (signal.tp3 - signal.entryPrice) * settings.basePositionSize;
        } else if (signal.status === "SL_HIT") {
          pnl = (signal.sl - signal.entryPrice) * settings.basePositionSize;
        } else {
          pnl = (currentPrice - signal.entryPrice) * settings.basePositionSize;
        }
      } else {
        if (signal.status === "ALL_TARGETS_HIT") {
          pnl = (signal.entryPrice - signal.tp3) * settings.basePositionSize;
        } else if (signal.status === "SL_HIT") {
          pnl = (signal.entryPrice - signal.sl) * settings.basePositionSize;
        } else {
          pnl = (signal.entryPrice - currentPrice) * settings.basePositionSize;
        }
      }

      if (pnl > 0) {
        winningTrades++;
        totalProfit += pnl;
        profits.push(pnl);
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
      
      if (signal.type === "BUY") {
        if (signal.status === "ALL_TARGETS_HIT") {
          pnl = (signal.tp3 - signal.entryPrice) * settings.basePositionSize;
        } else if (signal.status === "SL_HIT") {
          pnl = (signal.sl - signal.entryPrice) * settings.basePositionSize;
        }
      } else {
        if (signal.status === "ALL_TARGETS_HIT") {
          pnl = (signal.entryPrice - signal.tp3) * settings.basePositionSize;
        } else if (signal.status === "SL_HIT") {
          pnl = (signal.entryPrice - signal.sl) * settings.basePositionSize;
        }
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
    AsyncStorage.setItem("performance_metrics", JSON.stringify(metrics));
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
      AsyncStorage.setItem("signal_history", JSON.stringify(updated));
      return updated;
    });
  }, []);



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
  }, [settings, accountBalance, signalHistory, appLaunchTime]);

  const updateAllSignalsStatus = useCallback(() => {
    const price = signalEngine.getCurrentPrice();
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    const GRACE_PERIOD_MS = 5000;
    
    console.log(`🔄 [${Platform.OS}] Checking signal status updates - Current Price: ${price.toFixed(1)}`);

    setSignalHistory((prevHistory) => {
      let updated = false;
      let immediateUpdate = false;
      const updatedHistory = prevHistory.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
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

        console.log(`🔍 Monitoring Signal ${signal.id.slice(-6)}: Type=${signal.type}, Status=${signal.status}, Targets=${targetsHit}/3, Price=${price.toFixed(1)}, TP1=${signal.tp1.toFixed(1)}, TP2=${signal.tp2.toFixed(1)}, TP3=${signal.tp3.toFixed(1)}, SL=${signal.sl.toFixed(1)}`);

        if (signal.type === "BUY") {
          if (price <= signal.sl) {
            console.log(`🚨 STOP LOSS DETECTION: BUY signal @ Entry=${signal.entryPrice.toFixed(1)}, SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)} | SL TRIGGERED (${price.toFixed(1)} <= ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
            console.log(`⚠️ ⚠️ ⚠️ SL HIT: BUY Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
          } else if (price >= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price >= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)}`);
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)}`);
          }
        } else {
          if (price >= signal.sl) {
            console.log(`🚨 STOP LOSS DETECTION: SELL signal @ Entry=${signal.entryPrice.toFixed(1)}, SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)} | SL TRIGGERED (${price.toFixed(1)} >= ${signal.sl.toFixed(1)})`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
            console.log(`⚠️ ⚠️ ⚠️ SL HIT: SELL Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
          } else if (price <= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price <= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
          } else if (price <= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
          }
        }

        if (newStatus !== signal.status || targetsHit !== signal.targetsHit) {
          if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
            const exitDate = new Date();
            console.log(`✅ Terminal status reached: Signal ${signal.id.slice(-6)} will remain in history only`);
            
            const exitPrice = newStatus === "ALL_TARGETS_HIT" ? signal.tp3 : updatedSignal.sl;
            const result = newStatus === "ALL_TARGETS_HIT" ? "WIN" : "LOSS";
            
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
              exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            };
          }
          
          if (targetsHit === 2 && signal.targetsHit < 2) {
            console.log(`🔓 LOCK RELEASED: Signal ${signal.id.slice(-6)} hit TP2 - New signals can now be generated`);
            console.log(`   This signal continues to be monitored for TP3 or SL`);
          }
          
          return { ...updatedSignal, status: newStatus, targetsHit };
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
  }, [signalUpdateTrigger]);



  useEffect(() => {
    updateAllSignalsStatus();
  }, [currentPrice, updateAllSignalsStatus]);

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
      checkAndGenerateSignal();
    }, 30000);

    console.log('🚀 Scheduling initial signal generation check (after 5s cooldown)...');
    setTimeout(() => {
      console.log('✅ Launch cooldown complete - starting signal generation');
      checkAndGenerateSignal();
    }, 5000);

    return () => {
      console.log('🛑 Signal generation system deactivated');
      clearInterval(signalInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, isLoading, checkAndGenerateSignal]);

  const login = useCallback(async (username: string) => {
    setIsLoggedIn(true);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(true));
    console.log(`User logged in: ${username}`);
  }, []);

  const logout = useCallback(async () => {
    setIsLoggedIn(false);
    setUserProfile(null);
    await AsyncStorage.multiRemove(["is_logged_in", "user_profile"]);
    console.log('User logged out');
  }, []);

  const loginWithGoogle = useCallback(async (accessToken: string) => {
    try {
      console.log('🔐 Authenticating with Google...');
      
      const response = await fetch('https://www.googleapis.com/userinfo/v2/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      
      const user = await response.json();
      
      const profile: UserProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        googleId: user.id,
      };
      
      setUserProfile(profile);
      setIsLoggedIn(true);
      
      await AsyncStorage.multiSet([
        ["user_profile", JSON.stringify(profile)],
        ["is_logged_in", JSON.stringify(true)],
      ]);
      
      console.log(`✅ User logged in: ${profile.email}`);
      return profile;
    } catch (error) {
      console.error('❌ Google login failed:', error);
      throw error;
    }
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
      AsyncStorage.setItem("signal_history", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const manualCloseSignal = useCallback((signalId: string) => {
    closeSignal(signalId);
  }, [closeSignal]);

  const refreshData = useCallback(async () => {
    await updateMarketOutlook();
    await signalEngine.updateCurrentPrice();
    const price = signalEngine.getCurrentPrice();
    setCurrentPrice(price);
    console.log('Data refreshed successfully');
  }, []);

  const triggerManualRetrain = useCallback(async (reason?: string) => {
    const result = await signalEngine.manualRetrain(reason || 'User Triggered');
    
    if (result.success) {
      const metrics = calculatePerformanceMetrics(signalHistory);
      setPerformanceMetrics(metrics);
      console.log('✅ Manual retrain completed - performance metrics refreshed');
    }
    
    return result;
  }, [signalHistory, calculatePerformanceMetrics]);

  return {
    isLoggedIn,
    isLoading,
    signalHistory,
    settings,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    accountBalance,
    currentPrice,
    priceHistory,
    dailyOHLCHistory,
    signalUpdateTrigger,
    userProfile,
    login,
    logout,
    loginWithGoogle,
    clearHistory,
    updateSettings,
    deleteSignalFromHistory,
    manualCloseSignal,
    refreshData,
    triggerManualRetrain,
    backgroundTaskActive,
  };
});
