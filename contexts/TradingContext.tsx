import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine } from "@/services/signalEngine";
import { Platform } from "react-native";
import { 
  registerBackgroundTask, 
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
      
      const safetyTimeout = setTimeout(() => {
        console.error('⏰ SAFETY TIMEOUT - Force loading app');
        setIsLoading(false);
      }, 3000);
      
      try {
        console.log('📦 Loading persisted data...');
        await Promise.race([
          loadPersistedData(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
        ]).catch(error => {
          console.error('⚠️ Load failed:', error);
        });
        
        console.log('✅ Trading Context initialized');
      } catch (error) {
        console.error('❌ Init error:', error);
      } finally {
        clearTimeout(safetyTimeout);
        setIsLoading(false);
        console.log('✅ App ready');
      }
    };
    
    init();
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



  const loadPersistedData = async () => {
    try {
      console.log('🔄 Loading from storage...');
      const [savedSettings, savedHistory, loginStatus, savedMetrics, savedBalance, savedUserProfile] = await Promise.all([
        AsyncStorage.getItem("trading_settings"),
        AsyncStorage.getItem("signal_history"),
        AsyncStorage.getItem("is_logged_in"),
        AsyncStorage.getItem("performance_metrics"),
        AsyncStorage.getItem("account_balance"),
        AsyncStorage.getItem("user_profile"),
      ]);

      if (savedSettings) {
        setSettings(JSON.parse(savedSettings));
      } else {
        setSettings(DEFAULT_SETTINGS);
      }

      if (savedHistory) {
        const history = JSON.parse(savedHistory);
        const parsedHistory = history.map((s: TradingSignal) => ({
          ...s,
          timestamp: new Date(s.timestamp),
        }));
        setSignalHistory(parsedHistory);
        console.log(`✅ Loaded ${parsedHistory.length} signals`);
      } else {
        setSignalHistory([]);
      }

      if (loginStatus) {
        setIsLoggedIn(JSON.parse(loginStatus));
      } else {
        setIsLoggedIn(true);
      }

      if (savedUserProfile) {
        setUserProfile(JSON.parse(savedUserProfile));
      }

      if (savedMetrics) {
        setPerformanceMetrics(JSON.parse(savedMetrics));
      } else {
        setPerformanceMetrics(DEFAULT_METRICS);
      }

      if (savedBalance) {
        setAccountBalance(JSON.parse(savedBalance));
      } else {
        setAccountBalance(100);
      }

      console.log('✅ Data loaded');
    } catch (error) {
      console.error("❌ Load error:", error);
      setSignalHistory([]);
      setSettings(DEFAULT_SETTINGS);
      setPerformanceMetrics(DEFAULT_METRICS);
      setAccountBalance(100);
      setIsLoggedIn(true);
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
