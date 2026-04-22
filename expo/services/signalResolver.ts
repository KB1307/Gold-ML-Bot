import type { TradingSignal, SignalStatus } from '@/types/trading';
import type { OhlcBar } from '@/services/barStore';

export const SL_WICK_PENETRATION_PIPS = 0.1;
const PIP = 0.1;

export interface ResolverOutcome {
  newStatus: SignalStatus;
  targetsHit: number;
  exitPrice: number;
  outcomeResult: 'WIN' | 'LOSS' | null;
  breakevenReached: boolean;
  breakevenTime?: string;
  entryConfirmed: boolean;
  resolvedAtBarTs?: number;
}

function getProtectedExitPrice(signal: TradingSignal, targetsHit: number): number {
  const normalizedTargetsHit = Math.max(0, Math.min(2, targetsHit));
  if (normalizedTargetsHit >= 2) {
    return Number(((signal.tp1 + signal.tp2 + signal.entryPrice) / 3).toFixed(1));
  }
  if (normalizedTargetsHit === 1) {
    return Number(((signal.tp1 + signal.entryPrice + signal.entryPrice) / 3).toFixed(1));
  }
  return signal.entryPrice;
}

export function resolveSignalWithBars(
  signal: TradingSignal,
  bars: OhlcBar[],
  opts: { slWickPenetrationPips?: number; logPrefix?: string } = {},
): ResolverOutcome {
  const wickPen = opts.slWickPenetrationPips ?? SL_WICK_PENETRATION_PIPS;
  const slSlack = wickPen * PIP;
  const prefix = opts.logPrefix ?? `   [Resolver ${signal.id.slice(-6)}]`;

  const signalCreatedAtMs = signal.createdAt ?? new Date(signal.timestamp).getTime();
  const safeBarStart = signalCreatedAtMs + 60 * 1000;
  const evalBars = bars.filter(b => b.timestamp >= safeBarStart);

  let currentStatus: SignalStatus = signal.status;
  let currentTargetsHit = signal.targetsHit;
  let exitPrice = signal.entryPrice;
  let outcomeResult: 'WIN' | 'LOSS' | null = null;
  let entryConfirmed =
    signal.targetsHit >= 1 ||
    signal.status === 'TP1_HIT' ||
    signal.status === 'TP2_HIT' ||
    signal.status === 'TP3_HIT' ||
    signal.status === 'ALL_TARGETS_HIT';
  let breakevenReached = signal.breakevenReached || false;
  let breakevenTime = signal.breakevenTime;
  let resolvedAtBarTs: number | undefined;

  const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
  const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
  const ENTRY_TOL = 1.0;
  const EXTENDED_ENTRY_TOL = 3.0;

  const isBuy = signal.type === 'BUY';
  const slTriggerPrice = isBuy ? signal.sl - slSlack : signal.sl + slSlack;

  for (const bar of evalBars) {
    if (!entryConfirmed) {
      const touchedZone = isBuy
        ? bar.low <= (entryMax + ENTRY_TOL) && bar.high >= (entryMin - ENTRY_TOL)
        : bar.high >= (entryMin - ENTRY_TOL) && bar.low <= (entryMax + ENTRY_TOL);
      const crossedTp1 = isBuy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;
      const crossedSl = isBuy ? bar.low <= signal.sl : bar.high >= signal.sl;
      const touchedExtended = isBuy
        ? bar.low <= (entryMax + EXTENDED_ENTRY_TOL) && bar.high >= (entryMin - EXTENDED_ENTRY_TOL)
        : bar.high >= (entryMin - EXTENDED_ENTRY_TOL) && bar.low <= (entryMax + EXTENDED_ENTRY_TOL);
      if (touchedZone || crossedTp1 || crossedSl || touchedExtended) {
        entryConfirmed = true;
      } else {
        continue;
      }
    }

    const slHit = isBuy ? bar.low <= slTriggerPrice : bar.high >= slTriggerPrice;
    const tp3Hit = isBuy ? bar.high >= signal.tp3 : bar.low <= signal.tp3;
    const tp2Hit = isBuy ? bar.high >= signal.tp2 : bar.low <= signal.tp2;
    const tp1Hit = isBuy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;

    if (slHit) {
      if (currentTargetsHit >= 2) {
        currentStatus = 'PARTIAL_WIN_SL_HIT';
        currentTargetsHit = Math.max(currentTargetsHit, 2);
        exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
        outcomeResult = 'WIN';
      } else if (breakevenReached || currentTargetsHit >= 1) {
        currentStatus = 'SL_AFTER_BE';
        currentTargetsHit = Math.max(currentTargetsHit, 1);
        exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
        outcomeResult = 'WIN';
      } else {
        currentStatus = 'SL_HIT';
        exitPrice = signal.sl;
        outcomeResult = 'LOSS';
      }
      resolvedAtBarTs = bar.timestamp;
      console.log(`${prefix} 🚨 SL wick-through on bar @ ${new Date(bar.timestamp).toISOString()} → ${currentStatus}`);
      break;
    }

    if (tp3Hit && currentTargetsHit < 3) {
      currentStatus = 'ALL_TARGETS_HIT';
      currentTargetsHit = 3;
      exitPrice = signal.tp3;
      outcomeResult = 'WIN';
      resolvedAtBarTs = bar.timestamp;
      break;
    } else if (tp2Hit && currentTargetsHit < 2) {
      currentStatus = 'TP2_HIT';
      currentTargetsHit = 2;
      exitPrice = signal.tp2;
    } else if (tp1Hit && currentTargetsHit < 1) {
      currentStatus = 'TP1_HIT';
      currentTargetsHit = 1;
      exitPrice = signal.tp1;
      breakevenReached = true;
      breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }

    if (currentTargetsHit >= 2 && currentTargetsHit < 3) {
      const touchedEntry = isBuy ? bar.low <= signal.entryPrice : bar.high >= signal.entryPrice;
      if (touchedEntry) {
        currentStatus = 'PARTIAL_WIN_SL_HIT';
        exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
        outcomeResult = 'WIN';
        resolvedAtBarTs = bar.timestamp;
        break;
      }
    }
  }

  if (!entryConfirmed) {
    const anyTargetHit =
      currentTargetsHit > 0 ||
      currentStatus === 'TP1_HIT' ||
      currentStatus === 'TP2_HIT' ||
      currentStatus === 'TP3_HIT' ||
      currentStatus === 'ALL_TARGETS_HIT' ||
      currentStatus === 'PARTIAL_WIN_SL_HIT' ||
      currentStatus === 'SL_AFTER_BE';
    if (!anyTargetHit) {
      currentStatus = 'EXPIRED_MISSED_ENTRY';
      outcomeResult = null;
    }
  }

  return {
    newStatus: currentStatus,
    targetsHit: currentTargetsHit,
    exitPrice,
    outcomeResult,
    breakevenReached,
    breakevenTime,
    entryConfirmed,
    resolvedAtBarTs,
  };
}
