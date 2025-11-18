import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine } from "@/services/signalEngine";

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

  useEffect(() => {
    const init = async () => {
      const loadedDailyOHLC = await signalEngine.loadPersistedLearningData();
      await loadPersistedData();
      if (loadedDailyOHLC && loadedDailyOHLC.length > 0) {
        setDailyOHLCHistory(loadedDailyOHLC);
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
      const [savedSettings, savedHistory, loginStatus, savedMetrics, savedBalance] = await Promise.all([
        AsyncStorage.getItem("trading_settings"),
        AsyncStorage.getItem("signal_history"),
        AsyncStorage.getItem("is_logged_in"),
        AsyncStorage.getItem("performance_metrics"),
        AsyncStorage.getItem("account_balance"),
      ]);

      if (savedSettings) {
        setSettings(JSON.parse(savedSettings));
      }

      if (savedHistory) {
        const history = JSON.parse(savedHistory);
        setSignalHistory(history.map((s: TradingSignal) => ({
          ...s,
          timestamp: new Date(s.timestamp),
        })));
      }

      if (loginStatus) {
        setIsLoggedIn(JSON.parse(loginStatus));
      }

      if (savedMetrics) {
        setPerformanceMetrics(JSON.parse(savedMetrics));
      }

      if (savedBalance) {
        setAccountBalance(JSON.parse(savedBalance));
      }
    } catch (error) {
      console.error("Failed to load persisted data:", error);
    } finally {
      setIsLoading(false);
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
      const currentPrice = signalEngine.getCurrentPrice();
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
          AsyncStorage.setItem("signal_history", JSON.stringify(updated));
          return updated;
        });

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
  }, [settings, accountBalance, signalHistory]);

  const updateAllSignalsStatus = useCallback(() => {
    const price = signalEngine.getCurrentPrice();
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    const GRACE_PERIOD_MS = 5000;

    setSignalHistory((prevHistory) => {
      let updated = false;
      const updatedHistory = prevHistory.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
          return signal;
        }

        const signalAge = now - new Date(signal.timestamp).getTime();
        const signalCreationAge = signal.createdAt ? now - signal.createdAt : signalAge;
        
        if (signalCreationAge < GRACE_PERIOD_MS) {
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
            newStatus = "SL_HIT";
            updated = true;
            console.log(`⚠️ ⚠️ ⚠️ SL HIT: BUY Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
          } else if (price >= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price >= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
          }
        } else {
          if (price >= signal.sl) {
            newStatus = "SL_HIT";
            updated = true;
            console.log(`⚠️ ⚠️ ⚠️ SL HIT: SELL Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (SL: ${signal.sl.toFixed(1)})`);
          } else if (price <= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price <= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
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
        AsyncStorage.setItem("signal_history", JSON.stringify(updatedHistory));
        setSignalUpdateTrigger(prev => prev + 1);
      }

      return updated ? updatedHistory : prevHistory;
    });
  }, [setSignalUpdateTrigger]);



  useEffect(() => {
    updateAllSignalsStatus();
  }, [currentPrice, updateAllSignalsStatus]);

  useEffect(() => {
    if (!isLoggedIn) {
      console.log('⚠️ User not logged in - signal generation paused');
      return;
    }

    console.log('✅ Signal generation system activated - checking every 30s');
    
    const signalInterval = setInterval(() => {
      console.log('⏰ 30s interval - checking for signal generation...');
      checkAndGenerateSignal();
    }, 30000);

    console.log('🚀 Initial signal generation check...');
    checkAndGenerateSignal();

    return () => {
      console.log('🛑 Signal generation system deactivated');
      clearInterval(signalInterval);
    };
  }, [isLoggedIn, checkAndGenerateSignal]);

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
  };
});
