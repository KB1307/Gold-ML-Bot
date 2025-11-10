import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, Settings, MarketOutlook, PerformanceMetrics, PositionSizing } from "@/types/trading";
import { signalEngine } from "@/services/signalEngine";

const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 15,
  tp2Pips: 30,
  tp3Pips: 100,
  slPips: 120,
  numberOfTPs: 3,
  minConfidence: 0.70,
  enableNotifications: true,
  basePositionSize: 1.0,
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
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
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
      exitTime: `${now.getUTCHours().toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`,
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

    if (currentSignal.type === "BUY") {
      if (price <= currentSignal.sl) {
        newStatus = "SL_HIT";
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

    if (newStatus !== currentSignal.status) {
      const updatedSignal = { ...currentSignal, status: newStatus, targetsHit };
      setCurrentSignal(updatedSignal);

      if (newStatus === "SL_HIT" || newStatus === "ALL_TARGETS_HIT") {
        const now = new Date();
        const closedSignal = {
          ...updatedSignal,
          status: "CLOSED" as const,
          exitTime: `${now.getUTCHours().toString().padStart(2, "0")}:${now.getUTCMinutes().toString().padStart(2, "0")}`,
        };

        setSignalHistory((prev) => {
          const updated = [closedSignal, ...prev];
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
    
    if (!outlook.isMarketOpen) {
      console.log("Market is closed. No signal generation.");
      return;
    }

    if (currentSignal && currentSignal.status === "ACTIVE") {
      console.log("Active signal already exists. Skipping generation.");
      return;
    }

    try {
      const signal = await signalEngine.generateSignal(settings, accountBalance);
      
      if (signal) {
        console.log("New signal generated:", signal);
        setCurrentSignal(signal);

        const sizing = signalEngine.calculatePositionSizing(signal.confidence, settings, accountBalance);
        setPositionSizing(sizing);
        console.log("Position sizing calculated:", sizing);
        console.log(`💰 Fractional Kelly: ${sizing.fractionalKelly * 100}% | Optimal: ${sizing.optimalKellyPercentage}% of Account`);
      }
    } catch (error) {
      console.error("Failed to generate signal:", error);
    }
  }, [currentSignal, settings, accountBalance]);

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
    if (!isLoggedIn) {
      return;
    }

    const signalInterval = setInterval(() => {
      checkAndGenerateSignal();
    }, 30000);

    checkAndGenerateSignal();

    return () => clearInterval(signalInterval);
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
  };
});
