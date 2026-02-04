import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine } from "@/services/signalEngine";
import { Platform } from "react-native";
import { trpcClient } from "@/lib/trpc";
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

export const [TradingProvider, useTrading] = createContextHook(() => {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(true);
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
    init();
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
      console.log(`📊 Fetching historical 1-MINUTE OHLCV data (via tRPC)...`);
      console.log(`   From: ${new Date(fromTime).toISOString()}`);
      console.log(`   To: ${new Date(toTime).toISOString()}`);
      
      const bars = await trpcClient.goldPrice.getHistoricalData.query({
        fromTime,
        toTime
      });
      
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
  };

  const analyzeSignalWithHistoricalData = async (
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
        const effectiveSL = breakevenReached ? signal.entryPrice : signal.sl;
        if (bar.low <= effectiveSL) {
          console.log(`   🚨 SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= Effective SL: ${effectiveSL.toFixed(1)}${breakevenReached ? ' (BREAKEVEN)' : ''}`);
          
          if (currentTargetsHit > 0) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            exitPrice = effectiveSL;
            outcomeResult = 'WIN';
            console.log(`      📊 Result: PARTIAL WIN (TP${currentTargetsHit} hit before SL)`);
          } else {
            if (breakevenReached) {
              currentStatus = "CLOSED";
              outcomeResult = 'WIN';
              exitPrice = signal.entryPrice;
              console.log(`      ⚖️ BREAKEVEN HIT: Signal closed at entry price. Protected capital.`);
            } else {
              currentStatus = "SL_HIT";
              exitPrice = effectiveSL;
              outcomeResult = 'LOSS';
              console.log(`      📊 Result: LOSS (SL hit before any TP)`);
            }
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
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN ACTIVATED: SL moved from ${signal.sl.toFixed(1)} to entry ${signal.entryPrice.toFixed(1)}`);
          console.log(`      🛡️ Position now risk-free - worst case is breakeven`);
        }
      } else {
        const effectiveSL = breakevenReached ? signal.entryPrice : signal.sl;
        if (bar.high >= effectiveSL) {
          console.log(`   🚨 SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= Effective SL: ${effectiveSL.toFixed(1)}${breakevenReached ? ' (BREAKEVEN)' : ''}`);
          
          if (currentTargetsHit > 0) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            exitPrice = effectiveSL;
            outcomeResult = 'WIN';
            console.log(`      📊 Result: PARTIAL WIN (TP${currentTargetsHit} hit before SL)`);
          } else {
            if (breakevenReached) {
              currentStatus = "CLOSED";
              outcomeResult = 'WIN';
              exitPrice = signal.entryPrice;
              console.log(`      ⚖️ BREAKEVEN HIT: Signal closed at entry price. Protected capital.`);
            } else {
              currentStatus = "SL_HIT";
              exitPrice = effectiveSL;
              outcomeResult = 'LOSS';
              console.log(`      📊 Result: LOSS (SL hit before any TP)`);
            }
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
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN ACTIVATED: SL moved from ${signal.sl.toFixed(1)} to entry ${signal.entryPrice.toFixed(1)}`);
          console.log(`      🛡️ Position now risk-free - worst case is breakeven`);
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
  };

  const catchUpAndEvaluateSignals = async (history: TradingSignal[]) => {
    console.log('\n' + '='.repeat(80));
    console.log('🔄 SIGNAL CATCH-UP EVALUATION INITIATED');
    console.log('='.repeat(80));
    console.log('   Checking for stale ACTIVE signals that need evaluation...');
    
    const now = Date.now();
    const currentPrice = signalEngine.getCurrentPrice();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    
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
        };
        hasChanges = true;
        
        await signalEngine.recordTradeOutcome(
          signal.id,
          signal.entryPrice,
          currentPrice,
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
        
        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let shouldRecord = false;
        let outcomeResult: 'WIN' | 'LOSS' = 'LOSS';
        let exitPrice = currentPrice;
        
        if (signal.type === "BUY") {
          const effectiveSL = signal.breakevenReached ? signal.entryPrice : signal.sl;
          if (currentPrice <= effectiveSL) {
            console.log(`   🚨 CATCH-UP (Fallback): Stop Loss hit @ ${currentPrice.toFixed(1)} (SL: ${effectiveSL.toFixed(1)})`);
            if (signal.breakevenReached) {
              newStatus = "CLOSED";
              outcomeResult = 'WIN';
              exitPrice = signal.entryPrice;
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
          const effectiveSL = signal.breakevenReached ? signal.entryPrice : signal.sl;
          if (currentPrice >= effectiveSL) {
            console.log(`   🚨 CATCH-UP (Fallback): Stop Loss hit @ ${currentPrice.toFixed(1)} (SL: ${effectiveSL.toFixed(1)})`);
            if (signal.breakevenReached) {
              newStatus = "CLOSED";
              outcomeResult = 'WIN';
              exitPrice = signal.entryPrice;
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
  };

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
      
      // Determine exit price based on status, trailing SL level, and available data
      let exitPrice: number;
      
      if (signal.exitPrice !== undefined) {
        exitPrice = signal.exitPrice;
      } else if (signal.status === "ALL_TARGETS_HIT") {
        exitPrice = signal.tp3;
      } else if (signal.status === "PARTIAL_WIN_SL_HIT") {
        // For partial wins, check trailing SL level first
        if (signal.trailingSLLevel === 'TP2') {
          // Trailing SL was at TP2 - full TP2 profit captured
          exitPrice = signal.tp2;
        } else if (signal.targetsHit >= 2) {
          exitPrice = signal.tp2;
        } else if (signal.targetsHit >= 1) {
          exitPrice = signal.tp1;
        } else {
          exitPrice = signal.entryPrice; // Breakeven
        }
      } else if (signal.status === "CLOSED") {
        // CLOSED status - check trailing SL level and breakeven
        if (signal.trailingSLLevel === 'TP2') {
          exitPrice = signal.tp2;
        } else if (signal.breakevenReached) {
          if (signal.targetsHit >= 2) {
            exitPrice = signal.tp2;
          } else if (signal.targetsHit >= 1) {
            exitPrice = signal.tp1;
          } else {
            exitPrice = signal.entryPrice; // True breakeven - 0 P/L
          }
        } else {
          exitPrice = signal.entryPrice; // Manual close or expired
        }
      } else if (signal.status === "SL_HIT") {
        // Check trailing SL level first, then breakeven
        if (signal.trailingSLLevel === 'TP2') {
          // Trailing SL was at TP2 - this should be PARTIAL_WIN_SL_HIT but handle anyway
          exitPrice = signal.tp2;
        } else if (signal.breakevenReached && signal.targetsHit > 0) {
          // TP was hit before SL - partial win
          if (signal.targetsHit >= 2) {
            exitPrice = signal.tp2;
          } else {
            exitPrice = signal.tp1;
          }
        } else if (signal.breakevenReached) {
          // Breakeven hit with no TP - protected capital
          exitPrice = signal.entryPrice;
        } else {
          exitPrice = signal.sl;
        }
      } else {
        exitPrice = signal.entryPrice;
      }

      // Calculate P/L based on signal type
      if (signal.type === "BUY") {
        pnl = (exitPrice - signal.entryPrice) * settings.basePositionSize;
      } else {
        pnl = (signal.entryPrice - exitPrice) * settings.basePositionSize;
      }

      // Classify as win/loss based on P/L and status
      // PARTIAL_WIN_SL_HIT and breakeven hits with targets are WINS
      const isDefiniteWin = signal.status === "ALL_TARGETS_HIT" || 
                           signal.status === "PARTIAL_WIN_SL_HIT" ||
                           (signal.breakevenReached && signal.targetsHit > 0);
      
      // Breakeven with no targets hit is neither win nor loss (0 P/L)
      const isBreakevenZero = signal.breakevenReached && signal.targetsHit === 0 && 
                              (signal.status === "CLOSED" || Math.abs(pnl) < 0.01);

      if (isDefiniteWin || pnl > 0) {
        winningTrades++;
        totalProfit += Math.max(0, pnl);
        if (pnl > 0) profits.push(pnl);
      } else if (isBreakevenZero) {
        // Breakeven with 0 P/L - count as win (capital protected)
        winningTrades++;
        console.log(`📊 Breakeven hit counted as WIN (capital protected): Signal ${signal.id.slice(-6)}`);
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
      
      // Determine exit price for drawdown calculation
      let exitPriceForDD: number;
      
      if (signal.exitPrice !== undefined) {
        exitPriceForDD = signal.exitPrice;
      } else if (signal.status === "ALL_TARGETS_HIT") {
        exitPriceForDD = signal.tp3;
      } else if (signal.status === "PARTIAL_WIN_SL_HIT") {
        // Trailing SL at TP2 means exit at TP2
        if (signal.trailingSLLevel === 'TP2') {
          exitPriceForDD = signal.tp2;
        } else if (signal.targetsHit >= 2) {
          exitPriceForDD = signal.tp2;
        } else if (signal.targetsHit >= 1) {
          exitPriceForDD = signal.tp1;
        } else {
          exitPriceForDD = signal.entryPrice;
        }
      } else if (signal.status === "CLOSED" && signal.breakevenReached) {
        if (signal.trailingSLLevel === 'TP2') {
          exitPriceForDD = signal.tp2;
        } else if (signal.targetsHit >= 2) {
          exitPriceForDD = signal.tp2;
        } else if (signal.targetsHit >= 1) {
          exitPriceForDD = signal.tp1;
        } else {
          exitPriceForDD = signal.entryPrice;
        }
      } else if (signal.status === "SL_HIT") {
        if (signal.breakevenReached && signal.targetsHit > 0) {
          if (signal.trailingSLLevel === 'TP2') {
            exitPriceForDD = signal.tp2;
          } else if (signal.targetsHit >= 2) {
            exitPriceForDD = signal.tp2;
          } else {
            exitPriceForDD = signal.tp1;
          }
        } else if (signal.breakevenReached) {
          exitPriceForDD = signal.entryPrice;
        } else {
          exitPriceForDD = signal.sl;
        }
      } else {
        exitPriceForDD = signal.entryPrice;
      }
      
      if (signal.type === "BUY") {
        pnl = (exitPriceForDD - signal.entryPrice) * settings.basePositionSize;
      } else {
        pnl = (signal.entryPrice - exitPriceForDD) * settings.basePositionSize;
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
          // Use trailing SL - moves to entry at TP1, then to TP2 at TP2
          const effectiveSL = trailingSLPrice;
          if (price <= effectiveSL) {
            console.log(`🚨 TRAILING SL TRIGGERED: BUY signal @ Entry=${signal.entryPrice.toFixed(1)}, TrailingSL=${effectiveSL.toFixed(1)} (${trailingSLLevel || 'ORIGINAL'}), Current=${price.toFixed(1)}`);
            
            // Determine outcome based on trailing SL level
            if (trailingSLLevel === 'TP2') {
              // SL was at TP2 level - this is a WIN at TP2
              newStatus = "PARTIAL_WIN_SL_HIT";
              console.log(`   🎯 TRAILING SL AT TP2: Locked in TP2 profit! Exit at ${signal.tp2.toFixed(1)}`);
            } else if (trailingSLLevel === 'TP1' || trailingSLLevel === 'ENTRY') {
              // SL was at TP1 or entry - partial win if TP was hit
              if (targetsHit > 0) {
                newStatus = "PARTIAL_WIN_SL_HIT";
                console.log(`   ✅ TP${targetsHit} was already hit - marking as PARTIAL WIN`);
              } else if (breakevenReached) {
                newStatus = "CLOSED";
                console.log(`⚖️ BREAKEVEN HIT: Signal closed at entry price. Protected capital.`);
              } else {
                newStatus = "SL_HIT";
                console.log(`⚠️ ⚠️ ⚠️ SL HIT: BUY Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)}`);
              }
            } else {
              // Original SL hit
              newStatus = "SL_HIT";
              console.log(`⚠️ ⚠️ ⚠️ SL HIT: BUY Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)}`);
            }
            
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
            // Move trailing SL to TP2 to lock in profit
            trailingSLPrice = signal.tp2;
            trailingSLLevel = 'TP2';
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`🔒 TRAILING SL MOVED TO TP2: ${signal.tp2.toFixed(1)} - TP2 profit now locked in!`);
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            // Move trailing SL to entry (breakeven)
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN ACTIVATED at ${breakevenTime} - Trailing SL moved to entry ${signal.entryPrice.toFixed(1)}`);
          }
        } else {
          // SELL signal - use trailing SL
          const effectiveSL = trailingSLPrice;
          if (price >= effectiveSL) {
            console.log(`🚨 TRAILING SL TRIGGERED: SELL signal @ Entry=${signal.entryPrice.toFixed(1)}, TrailingSL=${effectiveSL.toFixed(1)} (${trailingSLLevel || 'ORIGINAL'}), Current=${price.toFixed(1)}`);
            
            // Determine outcome based on trailing SL level
            if (trailingSLLevel === 'TP2') {
              // SL was at TP2 level - this is a WIN at TP2
              newStatus = "PARTIAL_WIN_SL_HIT";
              console.log(`   🎯 TRAILING SL AT TP2: Locked in TP2 profit! Exit at ${signal.tp2.toFixed(1)}`);
            } else if (trailingSLLevel === 'TP1' || trailingSLLevel === 'ENTRY') {
              if (targetsHit > 0) {
                newStatus = "PARTIAL_WIN_SL_HIT";
                console.log(`   ✅ TP${targetsHit} was already hit - marking as PARTIAL WIN`);
              } else if (breakevenReached) {
                newStatus = "CLOSED";
                console.log(`⚖️ BREAKEVEN HIT: Signal closed at entry price. Protected capital.`);
              } else {
                newStatus = "SL_HIT";
                console.log(`⚠️ ⚠️ ⚠️ SL HIT: SELL Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)}`);
              }
            } else {
              newStatus = "SL_HIT";
              console.log(`⚠️ ⚠️ ⚠️ SL HIT: SELL Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)}`);
            }
            
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
            // Move trailing SL to TP2 to lock in profit
            trailingSLPrice = signal.tp2;
            trailingSLLevel = 'TP2';
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`🔒 TRAILING SL MOVED TO TP2: ${signal.tp2.toFixed(1)} - TP2 profit now locked in!`);
          } else if (price <= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            // Move trailing SL to entry (breakeven)
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN ACTIVATED at ${breakevenTime} - Trailing SL moved to entry ${signal.entryPrice.toFixed(1)}`);
          }
        }

        if (newStatus !== signal.status || targetsHit !== signal.targetsHit || trailingSLPrice !== signal.trailingSLPrice) {
          if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT" || (newStatus === "CLOSED" && breakevenReached) || newStatus === "PARTIAL_WIN_SL_HIT") {
            const exitDate = new Date();
            console.log(`✅ Terminal status reached: Signal ${signal.id.slice(-6)} will remain in history only`);
            
            // Calculate exit price based on trailing SL level and status
            let exitPrice: number;
            let result: 'WIN' | 'LOSS';
            
            if (newStatus === "ALL_TARGETS_HIT") {
              exitPrice = signal.tp3;
              result = "WIN";
            } else if (newStatus === "PARTIAL_WIN_SL_HIT") {
              // For partial wins, exit at the trailing SL level
              if (trailingSLLevel === 'TP2') {
                // Trailing SL was at TP2 - locked in TP2 profit
                exitPrice = signal.tp2;
                console.log(`   🎯 TRAILING SL AT TP2: Exit at TP2 price ${exitPrice.toFixed(1)} - FULL TP2 profit captured!`);
              } else if (targetsHit >= 2) {
                exitPrice = signal.tp2;
              } else if (targetsHit >= 1) {
                exitPrice = signal.tp1;
              } else {
                exitPrice = signal.entryPrice;
              }
              result = "WIN";
              console.log(`   📈 PARTIAL WIN: Exit at ${exitPrice.toFixed(1)} (Trailing SL Level: ${trailingSLLevel || 'ENTRY'})`);
            } else if (breakevenReached) {
              // Breakeven hit - determine exit based on trailing SL level
              if (trailingSLLevel === 'TP2') {
                exitPrice = signal.tp2;
                result = "WIN";
                console.log(`   🎯 Trailing SL at TP2 hit - Exit at TP2: ${exitPrice.toFixed(1)}`);
              } else if (targetsHit >= 2) {
                exitPrice = signal.tp2;
                result = "WIN";
              } else if (targetsHit >= 1) {
                exitPrice = signal.tp1;
                result = "WIN";
              } else {
                exitPrice = signal.entryPrice;
                result = "WIN"; // Breakeven counts as WIN (0 P/L but capital protected)
              }
              console.log(`   ⚖️ BREAKEVEN: Capital protected, exit at ${exitPrice.toFixed(1)}`);
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
  }, [signalUpdateTrigger, setSignalUpdateTrigger]);



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
    login,
    logout,
    clearHistory,
    updateSettings,
    deleteSignalFromHistory,
    manualCloseSignal,
    refreshData,
    triggerManualRetrain,
    backgroundTaskActive,
  };
});
