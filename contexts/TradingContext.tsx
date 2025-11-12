import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, Settings, MarketOutlook, PerformanceMetrics, PositionSizing } from "@/types/trading";
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
  const [currentSignal, setCurrentSignal] = useState<TradingSignal | null>(null);
  const [signalHistory, setSignalHistory] = useState<TradingSignal[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [marketOutlook, setMarketOutlook] = useState<MarketOutlook | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>(DEFAULT_METRICS);
  const [positionSizing, setPositionSizing] = useState<PositionSizing | null>(null);
  const [accountBalance, setAccountBalance] = useState<number>(10000);
  const [currentPrice, setCurrentPrice] = useState<number>(2650);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);

  useEffect(() => {
    const init = async () => {
      await signalEngine.loadPersistedLearningData();
      await loadPersistedData();
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
      } catch (error) {
        console.error('Failed to update price:', error);
      }
    };

    const priceInterval = setInterval(() => {
      updatePrice();
    }, 3000);

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
      };
    }

    const closedTrades = history.filter(s => s.status === "CLOSED" || s.status === "SL_HIT" || s.status === "ALL_TARGETS_HIT");
    
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
    };
  }, [accountBalance, settings.basePositionSize]);

  useEffect(() => {
    const metrics = calculatePerformanceMetrics(signalHistory);
    setPerformanceMetrics(metrics);
    AsyncStorage.setItem("performance_metrics", JSON.stringify(metrics));
  }, [signalHistory, calculatePerformanceMetrics]);

  const closeSignal = useCallback((signal: TradingSignal) => {
    const now = new Date();
    const closedSignal = {
      ...signal,
      status: "CLOSED" as const,
      exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    };

    setSignalHistory((prev) => {
      const updated = [closedSignal, ...prev];
      AsyncStorage.setItem("signal_history", JSON.stringify(updated));
      return updated;
    });

    setCurrentSignal(null);
    signalEngine.resetSignalLock();
  }, []);

  const updateSignalStatus = useCallback(() => {
    if (!currentSignal) return;

    const price = signalEngine.getCurrentPrice();
    let newStatus = currentSignal.status;
    let targetsHit = currentSignal.targetsHit;

    const signalAge = Date.now() - new Date(currentSignal.timestamp).getTime();
    const twoHoursInMs = 2 * 60 * 60 * 1000;

    if (signalAge > twoHoursInMs) {
      console.log(`Signal ${currentSignal.id} expired after 2 hours`);
      newStatus = "CLOSED";
      const now = new Date();
      const expiredSignal = {
        ...currentSignal,
        status: "CLOSED" as const,
        exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
      };

      setSignalHistory((prev) => {
        const updated = prev.map(s => 
          s.id === currentSignal.id ? expiredSignal : s
        );
        AsyncStorage.setItem("signal_history", JSON.stringify(updated));
        return updated;
      });

      setCurrentSignal(null);
      signalEngine.resetSignalLock();
      return;
    }

    if (currentSignal.type === "BUY") {
      if (price <= currentSignal.sl) {
        newStatus = "SL_HIT";
        targetsHit = 0;
      } else if (price >= currentSignal.tp3) {
        newStatus = "ALL_TARGETS_HIT";
        targetsHit = 3;
      } else if (price >= currentSignal.tp2) {
        newStatus = "TP2_HIT";
        targetsHit = 2;
      } else if (price >= currentSignal.tp1) {
        newStatus = "TP1_HIT";
        targetsHit = 1;
      }
    } else {
      if (price >= currentSignal.sl) {
        newStatus = "SL_HIT";
        targetsHit = 0;
      } else if (price <= currentSignal.tp3) {
        newStatus = "ALL_TARGETS_HIT";
        targetsHit = 3;
      } else if (price <= currentSignal.tp2) {
        newStatus = "TP2_HIT";
        targetsHit = 2;
      } else if (price <= currentSignal.tp1) {
        newStatus = "TP1_HIT";
        targetsHit = 1;
      }
    }

    if (newStatus !== currentSignal.status || targetsHit !== currentSignal.targetsHit) {
      const updatedSignal = { ...currentSignal, status: newStatus, targetsHit };
      setCurrentSignal(updatedSignal);

      setSignalHistory((prev) => {
        const updatedHistory = prev.map(s => 
          s.id === currentSignal.id ? updatedSignal : s
        );
        AsyncStorage.setItem("signal_history", JSON.stringify(updatedHistory));
        return updatedHistory;
      });

      if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
        const now = new Date();
        const finalSignal = {
          ...updatedSignal,
          exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        };

        setSignalHistory((prev) => {
          const updated = prev.map(s => 
            s.id === currentSignal.id ? finalSignal : s
          );
          AsyncStorage.setItem("signal_history", JSON.stringify(updated));
          return updated;
        });

        setCurrentSignal(null);
        signalEngine.resetSignalLock();
      }
    }
  }, [currentSignal]);

  const checkAndGenerateSignal = useCallback(async () => {
    const outlook = await signalEngine.getMarketOutlook();
    const now = new Date();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 SIGNAL CHECK [${now.toLocaleTimeString()}]`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Market Open: ${outlook.isMarketOpen}`);
    console.log(`Current Session: ${outlook.currentSession}`);
    console.log(`Current Signal: ${currentSignal ? `${currentSignal.type} - ${currentSignal.status}` : 'NONE'}`);
    console.log(`Min Confidence: ${(settings.minConfidence * 100).toFixed(0)}%`);
    console.log(`Account Balance: ${accountBalance}`);
    console.log(`Settings - TP1: ${settings.tp1Pips}, TP2: ${settings.tp2Pips}, TP3: ${settings.tp3Pips}, SL: ${settings.slPips}`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (!outlook.isMarketOpen) {
      console.log("❌ BLOCKED: Market is closed. No signal generation.");
      return;
    }

    if (currentSignal && currentSignal.status === "ACTIVE") {
      console.log("⚠️ BLOCKED: Active signal already exists. Skipping generation.");
      console.log(`   Current Signal ID: ${currentSignal.id}`);
      console.log(`   Signal Type: ${currentSignal.type}`);
      console.log(`   Entry Price: ${currentSignal.entryPrice}`);
      console.log(`   Current Status: ${currentSignal.status}`);
      return;
    }

    try {
      console.log(`🎯 ATTEMPTING SIGNAL GENERATION...`);
      console.log(`   Settings: minConfidence=${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   Account Balance: ${accountBalance}`);
      
      const signal = await signalEngine.generateSignal(settings, accountBalance);
      
      if (signal) {
        console.log("\n" + "=".repeat(60));
        console.log("✅ ✅ ✅ NEW SIGNAL GENERATED ✅ ✅ ✅");
        console.log("=".repeat(60));
        console.log(`Type: ${signal.type}`);
        console.log(`Entry: ${signal.entryPrice}`);
        console.log(`Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
        console.log(`TP1: ${signal.tp1} | TP2: ${signal.tp2} | TP3: ${signal.tp3}`);
        console.log(`SL: ${signal.sl}`);
        console.log("=".repeat(60) + "\n");
        
        setCurrentSignal(signal);

        setSignalHistory((prev) => {
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
        console.log("  - Signal conflict (opposite direction)\n");
      }
    } catch (error) {
      console.error("\n❌ ❌ ❌ CRITICAL ERROR IN SIGNAL GENERATION ❌ ❌ ❌");
      console.error("Error:", error);
      console.error("Stack:", error instanceof Error ? error.stack : 'No stack trace');
    }
  }, [currentSignal, settings, accountBalance]);

  const updateAllSignalsStatus = useCallback(() => {
    const price = signalEngine.getCurrentPrice();
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;

    setSignalHistory((prev) => {
      let updated = false;
      const updatedHistory = prev.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
          return signal;
        }

        const signalAge = now - new Date(signal.timestamp).getTime();
        if (signalAge > twoHoursInMs) {
          updated = true;
          const exitDate = new Date();
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          };
        }

        let newStatus = signal.status;
        let targetsHit = signal.targetsHit;

        if (signal.type === "BUY") {
          if (price <= signal.sl) {
            newStatus = "SL_HIT";
            targetsHit = 0;
            updated = true;
          } else if (price >= signal.tp3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
          } else if (price >= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            updated = true;
          }
        } else {
          if (price >= signal.sl) {
            newStatus = "SL_HIT";
            targetsHit = 0;
            updated = true;
          } else if (price <= signal.tp3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
          } else if (price <= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            updated = true;
          } else if (price <= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            updated = true;
          }
        }

        if (newStatus !== signal.status || targetsHit !== signal.targetsHit) {
          if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
            const exitDate = new Date();
            return {
              ...signal,
              status: newStatus,
              targetsHit,
              exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            };
          }
          return { ...signal, status: newStatus, targetsHit };
        }

        return signal;
      });

      if (updated) {
        AsyncStorage.setItem("signal_history", JSON.stringify(updatedHistory));
      }

      return updated ? updatedHistory : prev;
    });
  }, []);

  useEffect(() => {
    if (!currentSignal) {
      return;
    }

    const statusInterval = setInterval(() => {
      updateSignalStatus();
    }, 5000);

    return () => clearInterval(statusInterval);
  }, [currentSignal, updateSignalStatus]);

  useEffect(() => {
    const allSignalsInterval = setInterval(() => {
      updateAllSignalsStatus();
    }, 5000);

    updateAllSignalsStatus();

    return () => clearInterval(allSignalsInterval);
  }, [updateAllSignalsStatus]);

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
    setCurrentSignal(null);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(false));
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

  const manualCloseSignal = useCallback(() => {
    if (currentSignal) {
      closeSignal(currentSignal);
    }
  }, [currentSignal, closeSignal]);

  const refreshData = useCallback(async () => {
    await updateMarketOutlook();
    await signalEngine.updateCurrentPrice();
    const price = signalEngine.getCurrentPrice();
    setCurrentPrice(price);
    console.log('Data refreshed successfully');
  }, []);

  return {
    isLoggedIn,
    isLoading,
    currentSignal,
    signalHistory,
    settings,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    accountBalance,
    currentPrice,
    priceHistory,
    login,
    logout,
    updateSettings,
    deleteSignalFromHistory,
    manualCloseSignal,
    refreshData,
  };
});
