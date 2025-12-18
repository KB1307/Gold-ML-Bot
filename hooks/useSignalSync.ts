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

  const saveSignalMutation = trpc.signals.saveSignal.useMutation();
  const updateSignalMutation = trpc.signals.updateSignalOutcome.useMutation();
  const saveMetricsMutation = trpc.settings.saveMetrics.useMutation();
  const saveSettingsMutation = trpc.settings.saveSettings.useMutation();
  const saveAccountSnapshotMutation = trpc.settings.saveAccountSnapshot.useMutation();

  useEffect(() => {
    if (!saveSignalMutation || !updateSignalMutation) return;
    
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
            await saveSignalMutation.mutateAsync({
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
            });
            
            lastSyncedSignalRef.current.add(signal.id);
            console.log(`✅ Synced signal: ${signal.id}`);
          } catch (error) {
            console.error(`❌ Failed to sync signal ${signal.id}:`, error);
          }
        } else if (signal.exitTime) {
          const actualOutcome = 
            signal.status === 'SL_HIT' ? 'LOSS' :
            signal.status === 'ALL_TARGETS_HIT' ? 'WIN' :
            'PARTIAL';

          try {
            await updateSignalMutation.mutateAsync({
              id: signal.id,
              status: signal.status,
              exitTime: signal.exitTime,
              targetsHit: signal.targetsHit,
              profitLoss: calculateProfitLoss(signal),
              actualOutcome,
            });
            console.log(`✅ Updated signal outcome: ${signal.id}`);
          } catch (error) {
            console.error(`❌ Failed to update signal ${signal.id}:`, error);
          }
        }
      }
    };

    if (signalHistory.length > 0) {
      syncNewSignals();
    }
  }, [signalHistory, saveSignalMutation, updateSignalMutation]);

  useEffect(() => {
    if (!saveMetricsMutation) return;
    
    const syncMetrics = async () => {
      const now = Date.now();
      if (now - lastMetricsSyncRef.current > 60000) {
        try {
          await saveMetricsMutation.mutateAsync({
            userId: 'default_user',
            metrics: performanceMetrics,
          });
          lastMetricsSyncRef.current = now;
          console.log('✅ Synced performance metrics');
        } catch (error) {
          console.error('❌ Failed to sync metrics:', error);
        }
      }
    };

    syncMetrics();
    const interval = setInterval(syncMetrics, 60000);
    return () => clearInterval(interval);
  }, [performanceMetrics, saveMetricsMutation]);

  useEffect(() => {
    if (!saveSettingsMutation) return;
    
    const syncSettings = async () => {
      const now = Date.now();
      if (now - lastSettingsSyncRef.current > 30000) {
        try {
          await saveSettingsMutation.mutateAsync({
            userId: 'default_user',
            settings,
          });
          lastSettingsSyncRef.current = now;
          console.log('✅ Synced settings');
        } catch (error) {
          console.error('❌ Failed to sync settings:', error);
        }
      }
    };

    syncSettings();
  }, [settings, saveSettingsMutation]);

  useEffect(() => {
    if (!saveAccountSnapshotMutation) return;
    
    const syncAccountBalance = async () => {
      try {
        await saveAccountSnapshotMutation.mutateAsync({
          userId: 'default_user',
          balance: accountBalance,
          equity: accountBalance,
          openPositions: signalHistory.filter(s => s.status === 'ACTIVE').length,
        });
        console.log('✅ Synced account snapshot');
      } catch (error) {
        console.error('❌ Failed to sync account balance:', error);
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
