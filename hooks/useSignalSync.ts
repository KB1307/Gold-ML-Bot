import { useEffect, useRef } from 'react';
import { trpc } from '@/lib/trpc';
import { TradingSignal } from '@/types/trading';

export function useSignalSync(
  signalHistory: TradingSignal[],
  performanceMetrics: any,
  settings: any,
  accountBalance: number
) {
  const lastSyncedSignalRef = useRef<Set<string>>(new Set());
  const lastMetricsSyncRef = useRef<number>(0);
  const lastSettingsSyncRef = useRef<number>(0);
  const isSyncEnabled = useRef<boolean>(false);

  const saveSignalMutation = trpc.signals.saveSignal.useMutation({
    onError: (error) => {
      console.log('🔕 Backend sync disabled (not critical for app operation)');
      isSyncEnabled.current = false;
    },
  });
  const updateSignalMutation = trpc.signals.updateSignalOutcome.useMutation({
    onError: () => { isSyncEnabled.current = false; },
  });
  const saveMetricsMutation = trpc.settings.saveMetrics.useMutation({
    onError: () => { isSyncEnabled.current = false; },
  });
  const saveSettingsMutation = trpc.settings.saveSettings.useMutation({
    onError: () => { isSyncEnabled.current = false; },
  });
  const saveAccountSnapshotMutation = trpc.settings.saveAccountSnapshot.useMutation({
    onError: () => { isSyncEnabled.current = false; },
  });

  useEffect(() => {
    if (!saveSignalMutation || !updateSignalMutation || !isSyncEnabled.current) return;
    
    const syncNewSignals = async () => {
      for (const signal of signalHistory) {
        if (!lastSyncedSignalRef.current.has(signal.id)) {
          const actualOutcome = 
            signal.status === 'SL_HIT' ? 'LOSS' :
            signal.status === 'ALL_TARGETS_HIT' ? 'WIN' :
            signal.status === 'TP1_HIT' || signal.status === 'TP2_HIT' ? 'PARTIAL' :
            undefined;

          const profitLoss = calculateProfitLoss(signal);

          try {
            await Promise.race([
              saveSignalMutation.mutateAsync({
                ...signal,
                timestamp: signal.timestamp.toISOString(),
                topFeatures: signal.topFeatures || [],
                profitLoss,
                actualOutcome,
                marketConditions: {
                  session: 'UNKNOWN',
                  volatility: 0,
                  trend: 'NEUTRAL',
                },
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 5000))
            ]);
            
            lastSyncedSignalRef.current.add(signal.id);
          } catch {
            isSyncEnabled.current = false;
          }
        } else if (signal.exitTime) {
          const actualOutcome = 
            signal.status === 'SL_HIT' ? 'LOSS' :
            signal.status === 'ALL_TARGETS_HIT' ? 'WIN' :
            'PARTIAL';

          try {
            await Promise.race([
              updateSignalMutation.mutateAsync({
                id: signal.id,
                status: signal.status,
                exitTime: signal.exitTime,
                targetsHit: signal.targetsHit,
                profitLoss: calculateProfitLoss(signal),
                actualOutcome,
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 5000))
            ]);
          } catch {
            isSyncEnabled.current = false;
          }
        }
      }
    };

    if (signalHistory.length > 0) {
      syncNewSignals();
    }
  }, [signalHistory, saveSignalMutation, updateSignalMutation]);

  useEffect(() => {
    if (!saveMetricsMutation || !isSyncEnabled.current) return;
    
    const syncMetrics = async () => {
      const now = Date.now();
      if (now - lastMetricsSyncRef.current > 60000) {
        try {
          await Promise.race([
            saveMetricsMutation.mutateAsync({
              userId: 'default_user',
              metrics: performanceMetrics,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 5000))
          ]);
          lastMetricsSyncRef.current = now;
        } catch {
          isSyncEnabled.current = false;
        }
      }
    };

    syncMetrics();
    const interval = setInterval(syncMetrics, 60000);
    return () => clearInterval(interval);
  }, [performanceMetrics, saveMetricsMutation]);

  useEffect(() => {
    if (!saveSettingsMutation || !isSyncEnabled.current) return;
    
    const syncSettings = async () => {
      const now = Date.now();
      if (now - lastSettingsSyncRef.current > 30000) {
        try {
          await Promise.race([
            saveSettingsMutation.mutateAsync({
              userId: 'default_user',
              settings,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 5000))
          ]);
          lastSettingsSyncRef.current = now;
        } catch {
          isSyncEnabled.current = false;
        }
      }
    };

    syncSettings();
  }, [settings, saveSettingsMutation]);

  useEffect(() => {
    if (!saveAccountSnapshotMutation || !isSyncEnabled.current) return;
    
    const syncAccountBalance = async () => {
      try {
        await Promise.race([
          saveAccountSnapshotMutation.mutateAsync({
            userId: 'default_user',
            balance: accountBalance,
            equity: accountBalance,
            openPositions: signalHistory.filter(s => s.status === 'ACTIVE').length,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 5000))
        ]);
      } catch {
        isSyncEnabled.current = false;
      }
    };

    const interval = setInterval(syncAccountBalance, 300000);
    return () => clearInterval(interval);
  }, [accountBalance, signalHistory, saveAccountSnapshotMutation]);
}

function calculateProfitLoss(signal: TradingSignal): number {
  const pipValue = 10;
  let totalPips = 0;

  if (signal.status === 'TP1_HIT') {
    totalPips = (signal.type === 'BUY' ? 
      (signal.tp1 - signal.entryPriceWithSlippage) : 
      (signal.entryPriceWithSlippage - signal.tp1)) * (1 / 3);
  } else if (signal.status === 'TP2_HIT') {
    totalPips = (signal.type === 'BUY' ? 
      (signal.tp1 - signal.entryPriceWithSlippage) : 
      (signal.entryPriceWithSlippage - signal.tp1)) * (1 / 3) +
      (signal.type === 'BUY' ? 
        (signal.tp2 - signal.entryPriceWithSlippage) : 
        (signal.entryPriceWithSlippage - signal.tp2)) * (1 / 3);
  } else if (signal.status === 'ALL_TARGETS_HIT' || signal.status === 'TP3_HIT') {
    totalPips = (signal.type === 'BUY' ? 
      (signal.tp1 - signal.entryPriceWithSlippage) : 
      (signal.entryPriceWithSlippage - signal.tp1)) * (1 / 3) +
      (signal.type === 'BUY' ? 
        (signal.tp2 - signal.entryPriceWithSlippage) : 
        (signal.entryPriceWithSlippage - signal.tp2)) * (1 / 3) +
      (signal.type === 'BUY' ? 
        (signal.tp3 - signal.entryPriceWithSlippage) : 
        (signal.entryPriceWithSlippage - signal.tp3)) * (1 / 3);
  } else if (signal.status === 'SL_HIT') {
    totalPips = signal.type === 'BUY' ? 
      (signal.sl - signal.entryPriceWithSlippage) : 
      (signal.entryPriceWithSlippage - signal.sl);
  }

  return totalPips * pipValue;
}
