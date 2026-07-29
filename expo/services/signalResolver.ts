import type { TradingSignal, SignalStatus } from '@/types/trading';
import type { OhlcBar } from '@/services/barStore';

export const SL_WICK_PENETRATION_PIPS = 0.1;
const PIP = 0.1;

/**
 * PHASE 2 follow-up (open item 2): the post-TP1 profit lock is now expressed as
 * a fraction of the REALISED stop distance instead of a fixed 15 pips.
 *
 * Under the 1.4R re-scope the ladder is 0.70R / 1.05R / 1.40R and stops must
 * clear 1.2 x ATR, so stop distance now varies a lot with volatility. A fixed
 * 15-pip lock was silently regime-dependent against that ladder: at a 20-pip
 * stop it locked 0.75R (above TP1 at 0.70R, i.e. unreachable and effectively
 * disabled), while at an 80-pip stop it locked only 0.19R - handing back most
 * of an already-banked 0.56R TP1 runner. 0.35R is exactly half of TP1, so the
 * lock is scope-invariant: it always protects half the banked first target.
 */
export const POST_TP1_PROFIT_LOCK_R = 0.35;
/** Absolute floor so a degenerate/zero stop distance still locks something real. */
export const POST_TP1_PROFIT_LOCK_MIN_PIPS = 5;
/** The lock must always sit strictly inside TP1, never at or beyond it. */
const POST_TP1_LOCK_MAX_FRACTION_OF_TP1 = 0.9;

/**
 * Post-TP1 protected exit level: entry +/- 0.35 x realised stop distance,
 * floored at 5 pips and capped at 90% of the TP1 distance.
 */
export function getPostTP1LockPrice(signal: TradingSignal): number {
  const stopDistance = Math.abs(signal.entryPrice - signal.sl);
  const minDelta = POST_TP1_PROFIT_LOCK_MIN_PIPS * PIP;
  const rBased = Number.isFinite(stopDistance) && stopDistance > 0
    ? stopDistance * POST_TP1_PROFIT_LOCK_R
    : minDelta;
  const tp1Distance = Math.abs(signal.tp1 - signal.entryPrice);
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0
    ? tp1Distance * POST_TP1_LOCK_MAX_FRACTION_OF_TP1
    : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(rBased, minDelta), ceiling);
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}

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
    // Post-TP1 protected exit = 0.35R profit lock price.
    return getPostTP1LockPrice(signal);
  }
  return signal.entryPrice;
}

export function resolveSignalWithBars(
  signal: TradingSignal,
  bars: OhlcBar[],
  opts: { slWickPenetrationPips?: number; logPrefix?: string; fromScratch?: boolean; evalNowMs?: number } = {},
): ResolverOutcome {
  const wickPen = opts.slWickPenetrationPips ?? SL_WICK_PENETRATION_PIPS;
  const slSlack = wickPen * PIP;
  const prefix = opts.logPrefix ?? `   [Resolver ${signal.id.slice(-6)}]`;
  // fromScratch re-derives the ENTIRE outcome purely from price action and
  // ignores the stored status/targetsHit. The default (forward-seeded) mode can
  // only ratchet a signal FORWARD, so it can never undo a falsely-recorded
  // terminal — e.g. an ALL_TARGETS_HIT banked off a phantom spike when price
  // never actually reached TP1. The manual/force audit uses fromScratch against
  // authoritative remote bars (Yahoo / TwelveData) so those false wins/losses get corrected.
  const fromScratch = opts.fromScratch === true;

  const signalCreatedAtMs = signal.createdAt ?? new Date(signal.timestamp).getTime();
  const safeBarStart = signalCreatedAtMs + 60 * 1000;
  const evalBars = bars.filter(b => b.timestamp >= safeBarStart);

  let currentStatus: SignalStatus = fromScratch ? 'ACTIVE' : signal.status;
  let currentTargetsHit = fromScratch ? 0 : signal.targetsHit;
  let exitPrice = signal.entryPrice;
  let outcomeResult: 'WIN' | 'LOSS' | null = null;
  let entryConfirmed = fromScratch
    ? false
    : (signal.targetsHit >= 1 ||
      signal.status === 'TP1_HIT' ||
      signal.status === 'TP2_HIT' ||
      signal.status === 'TP3_HIT' ||
      signal.status === 'ALL_TARGETS_HIT');
  let breakevenReached = fromScratch ? false : (signal.breakevenReached || false);
  let breakevenTime = fromScratch ? undefined : signal.breakevenTime;
  let resolvedAtBarTs: number | undefined;

  const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
  const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
  const ENTRY_TOL = 1.0;
  const EXTENDED_ENTRY_TOL = 3.0;

  const isBuy = signal.type === 'BUY';
  const slTriggerPrice = isBuy ? signal.sl - slSlack : signal.sl + slSlack;

  const postTP1Lock = getPostTP1LockPrice(signal);

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

    const hasTP1 = currentTargetsHit >= 1 || breakevenReached;
    const hasTP2 = currentTargetsHit >= 2;

    // Pre-TP1: original SL with the wick-penetration slack applies.
    // Post-TP1: trailing 0.35R profit lock replaces the original SL.
    // Post-TP2: entry-level protective stop (existing behaviour).
    const origSlHit = isBuy ? bar.low <= slTriggerPrice : bar.high >= slTriggerPrice;
    const lockHit = hasTP1 && !hasTP2
      ? (isBuy ? bar.low <= postTP1Lock : bar.high >= postTP1Lock)
      : false;
    const entryHitAfterTP2 = hasTP2
      ? (isBuy ? bar.low <= signal.entryPrice : bar.high >= signal.entryPrice)
      : false;

    const tp3Hit = isBuy ? bar.high >= signal.tp3 : bar.low <= signal.tp3;
    const tp2Hit = isBuy ? bar.high >= signal.tp2 : bar.low <= signal.tp2;
    const tp1Hit = isBuy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;

    // SAME-BAR AMBIGUITY GUARD: a single OHLC bar only gives us open/high/low/
    // close, not the true tick-by-tick path. When a bar's range spans BOTH the
    // currently-applicable SL-type level AND a still-unbanked TP level, the old
    // code always resolved the SL side first regardless of which was actually
    // touched first on the real chart - silently discarding a genuine TP hit
    // (or protected exit) in favor of a false loss (e.g. a SELL that really ran
    // to TP2 within that minute got reported as SL_HIT). We approximate real
    // order using proximity to the bar's open: price is assumed to travel away
    // from open continuously, so whichever level sits closer to open was
    // reached first.
    let newTargetsHitThisBar = currentTargetsHit;
    let newTargetLevelThisBar: number | null = null;
    if (tp3Hit && currentTargetsHit < 3) {
      newTargetsHitThisBar = 3;
      newTargetLevelThisBar = signal.tp3;
    } else if (tp2Hit && currentTargetsHit < 2) {
      newTargetsHitThisBar = 2;
      newTargetLevelThisBar = signal.tp2;
    } else if (tp1Hit && currentTargetsHit < 1) {
      newTargetsHitThisBar = 1;
      newTargetLevelThisBar = signal.tp1;
    }

    const slBreachedPreState = (!hasTP1 && origSlHit) || (hasTP1 && !hasTP2 && lockHit) || (hasTP2 && entryHitAfterTP2);
    const slBreachLevel = hasTP2 ? signal.entryPrice : (hasTP1 ? postTP1Lock : slTriggerPrice);

    if (newTargetLevelThisBar !== null && slBreachedPreState) {
      const targetDist = Math.abs(bar.open - newTargetLevelThisBar);
      const slDist = Math.abs(bar.open - slBreachLevel);

      if (slDist <= targetDist) {
        // SL-side level sits closer to open -> assume it was hit first; the
        // target reached later in this same bar never actually banks.
        if (hasTP2) {
          currentStatus = 'PARTIAL_WIN_SL_HIT';
          currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
          outcomeResult = 'WIN';
        } else if (hasTP1) {
          currentStatus = 'SL_AFTER_BE';
          currentTargetsHit = Math.max(currentTargetsHit, 1);
          exitPrice = postTP1Lock;
          outcomeResult = 'WIN';
        } else {
          currentStatus = 'SL_HIT';
          exitPrice = signal.sl;
          outcomeResult = 'LOSS';
        }
        resolvedAtBarTs = bar.timestamp;
        console.log(`${prefix} 🔀 Same-bar ambiguity @ ${new Date(bar.timestamp).toISOString()}: SL-side level ${slBreachLevel.toFixed(1)} (${slDist.toFixed(2)} from open) closer than target ${newTargetLevelThisBar.toFixed(1)} (${targetDist.toFixed(2)}) → ${currentStatus}`);
        break;
      }

      // Target level sits closer to open -> bank it first, then check whether
      // the NEW effective SL-type level was ALSO breached later in this same bar.
      currentTargetsHit = newTargetsHitThisBar;
      exitPrice = newTargetLevelThisBar;
      currentStatus = newTargetsHitThisBar === 3 ? 'ALL_TARGETS_HIT' : newTargetsHitThisBar === 2 ? 'TP2_HIT' : 'TP1_HIT';
      if (newTargetsHitThisBar === 1) {
        breakevenReached = true;
        breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      }
      console.log(`${prefix} 🔀 Same-bar ambiguity @ ${new Date(bar.timestamp).toISOString()}: target ${newTargetLevelThisBar.toFixed(1)} (${targetDist.toFixed(2)} from open) closer than SL-side ${slBreachLevel.toFixed(1)} (${slDist.toFixed(2)}) → banking ${currentStatus} first`);

      if (newTargetsHitThisBar === 3) {
        outcomeResult = 'WIN';
        resolvedAtBarTs = bar.timestamp;
        break;
      }

      const hasTP2After = newTargetsHitThisBar >= 2;
      const postLockHitAfter = !hasTP2After
        ? (isBuy ? bar.low <= postTP1Lock : bar.high >= postTP1Lock)
        : false;
      const entryHitAfter = hasTP2After
        ? (isBuy ? bar.low <= signal.entryPrice : bar.high >= signal.entryPrice)
        : false;

      if (hasTP2After && entryHitAfter) {
        currentStatus = 'PARTIAL_WIN_SL_HIT';
        currentTargetsHit = Math.max(currentTargetsHit, 2);
        exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
        outcomeResult = 'WIN';
        resolvedAtBarTs = bar.timestamp;
        console.log(`${prefix} ⚖️ Same bar: runner also retraced to entry after banking target → PARTIAL_WIN_SL_HIT @ ${exitPrice.toFixed(1)}`);
        break;
      }
      if (!hasTP2After && postLockHitAfter) {
        currentStatus = 'SL_AFTER_BE';
        currentTargetsHit = Math.max(currentTargetsHit, 1);
        exitPrice = postTP1Lock;
        outcomeResult = 'WIN';
        resolvedAtBarTs = bar.timestamp;
        console.log(`${prefix} ⚖️ Same bar: also retraced to profit lock after banking TP1 → SL_AFTER_BE @ ${exitPrice.toFixed(1)}`);
        break;
      }
      // Target banked, no further same-bar reversal - continue scanning forward.
      continue;
    }

    // No same-bar ambiguity - original sequential resolution applies unchanged.
    if (!hasTP1 && origSlHit) {
      currentStatus = 'SL_HIT';
      exitPrice = signal.sl;
      outcomeResult = 'LOSS';
      resolvedAtBarTs = bar.timestamp;
      console.log(`${prefix} 🚨 Pre-TP1 SL wick-through on bar @ ${new Date(bar.timestamp).toISOString()} → SL_HIT`);
      break;
    }

    if (hasTP2 && entryHitAfterTP2) {
      currentStatus = 'PARTIAL_WIN_SL_HIT';
      currentTargetsHit = Math.max(currentTargetsHit, 2);
      exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
      outcomeResult = 'WIN';
      resolvedAtBarTs = bar.timestamp;
      console.log(`${prefix} ⚖️ Post-TP2 runner retraced to entry on bar @ ${new Date(bar.timestamp).toISOString()} → PARTIAL_WIN_SL_HIT @ ${exitPrice.toFixed(1)}`);
      break;
    }

    if (hasTP1 && !hasTP2 && lockHit) {
      currentStatus = 'SL_AFTER_BE';
      currentTargetsHit = Math.max(currentTargetsHit, 1);
      exitPrice = postTP1Lock;
      outcomeResult = 'WIN';
      resolvedAtBarTs = bar.timestamp;
      console.log(`${prefix} ⚖️ Post-TP1 ${POST_TP1_PROFIT_LOCK_R}R profit lock hit on bar @ ${new Date(bar.timestamp).toISOString()} → SL_AFTER_BE @ ${exitPrice.toFixed(1)}`);
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
  } else if (
    fromScratch &&
    (currentStatus === 'ACTIVE' || currentStatus === 'TP1_HIT' || currentStatus === 'TP2_HIT')
  ) {
    // Entry filled but the bars never produced a terminal event. For a force
    // audit (a terminal, fully-matured signal) collapse it to its TRUE neutral
    // or protected outcome instead of leaving a stale non-terminal status. This
    // is what corrects a false ALL_TARGETS_HIT whose price action shows no real
    // target was ever reached.
    const evalNow = opts.evalNowMs ?? Date.now();
    const matured = evalNow - signalCreatedAtMs >= 2 * 60 * 60 * 1000;
    if (matured) {
      // STEP 3 FIX (confirmed resolvedAtBarTs gap): this "matured, no terminal bar
      // event fired" branch never set resolvedAtBarTs before this fix, so it fell
      // through to whatever the calling code substitutes for a missing bar
      // timestamp (new Date() at whenever reconciliation happened to run) -- the
      // exact bug confirmed by two unrelated signals sharing one identical exit
      // timestamp. There is no genuine terminal-bar EVENT here (nothing in the
      // real bars actually crossed a level -- that's WHY we're in this branch at
      // all), so the most honest real timestamp available is the last REAL bar we
      // actually evaluated -- the same bar already used for this branch's CLOSED
      // exitPrice fallback below -- not the wall-clock moment this function runs.
      resolvedAtBarTs = evalBars.length > 0 ? evalBars[evalBars.length - 1].timestamp : signalCreatedAtMs;
      if (currentTargetsHit >= 2) {
        currentStatus = 'PARTIAL_WIN_SL_HIT';
        exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
        outcomeResult = 'WIN';
        console.log(`${prefix} 🧮 fromScratch: TP1+TP2 banked, runner matured → PARTIAL_WIN_SL_HIT @ ${exitPrice.toFixed(1)}`);
      } else if (currentTargetsHit >= 1) {
        currentStatus = 'SL_AFTER_BE';
        exitPrice = getPostTP1LockPrice(signal);
        outcomeResult = 'WIN';
        console.log(`${prefix} 🧮 fromScratch: TP1 banked, runner matured above lock → SL_AFTER_BE @ ${exitPrice.toFixed(1)}`);
      } else {
        currentStatus = 'CLOSED';
        exitPrice = evalBars.length > 0 ? evalBars[evalBars.length - 1].close : signal.entryPrice;
        outcomeResult = null;
        console.log(`${prefix} 🧮 fromScratch: entry filled but NO TP/SL printed → CLOSED flat @ ${exitPrice.toFixed(1)} (was ${signal.status})`);
      }
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
