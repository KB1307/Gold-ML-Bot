import type { TradingSignal, SignalStatus } from '@/types/trading';
import type { OhlcBar } from '@/services/barStore';
import { computeMaxFavourableExcursion, type MfeResult } from '@/services/maxFavourableExcursion';

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

/**
 * ITEM 1 — MINIMUM MATURITY BEFORE A SIGNAL MAY BE CALLED EXPIRED_MISSED_ENTRY.
 *
 * The EXPIRED_MISSED_ENTRY branch below previously had NO time condition: it
 * asked only "did entry get confirmed across whatever bars exist" and, if not,
 * stamped the terminal status. With `safeBarStart = createdAt + 60s`, a signal
 * four minutes old has ~4 bars, so the branch fired on evidence that cannot
 * support the conclusion (observed live: 7p9apa at barCount=4, 6k0m6n at
 * barCount=5 then 6).
 *
 * WHAT TTL DOES THE ENGINE ACTUALLY USE? There is no dedicated entry TTL. The
 * `timeToLive` field on a signal (signalEngine.ts:7456) is an estimated
 * time-to-TP3, not an entry-validity window, and nothing reads it. The only
 * real, already-live construct that defines how long a signal is considered to
 * be playing out is the 2-hour resolution window, used identically in three
 * independent places: `catchUpAndEvaluateSignals` (twoHoursInMs),
 * `auditTerminalSLSignals` (default resolutionWindowMs), and this file's own
 * sibling `fromScratch` maturity branch. Reusing that one value keeps a single
 * maturity definition in the resolver instead of inventing a second, and it is
 * deliberately conservative: it can only DELAY an expiry verdict, never create
 * one, so it cannot manufacture a win or a loss.
 */
export const ENTRY_MATURITY_MS = 2 * 60 * 60 * 1000;
/** Absolute floor so a degenerate/zero stop distance still locks something real. */
export const POST_TP1_PROFIT_LOCK_MIN_PIPS = 5;
/** The lock must always sit strictly inside TP1, never at or beyond it. */
const POST_TP1_LOCK_MAX_FRACTION_OF_TP1 = 0.9;

/**
 * OFFLINE LADDER-SWEEP HOOK (ITEM D) — NOT a ladder change.
 *
 * Exists ONLY so an offline counterfactual can re-run the REAL resolver at
 * candidate ladder settings instead of re-implementing it in a mirror. Every
 * field is optional and every default reproduces live behaviour exactly: omit
 * the object and this module behaves as it did before. Nothing in the live app
 * passes it (grep-verifiable: `ladder:` appears only under scripts/).
 */
export interface LadderOverride {
  /** Lock delta as a fraction of the TP1 distance. Takes precedence over lockFractionOfR. */
  lockFractionOfTP1?: number;
  /** Lock delta as a fraction of the realised stop distance. Live default = POST_TP1_PROFIT_LOCK_R. */
  lockFractionOfR?: number;
  /** Apply the 0.9 x TP1 ceiling. Live default = true. */
  applyLockCap?: boolean;
  /** Apply the 5-pip floor. Live default = true. */
  applyLockFloor?: boolean;
}

/**
 * Post-TP1 protected exit level: entry +/- 0.35 x realised stop distance,
 * floored at 5 pips and capped at 90% of the TP1 distance.
 */
export function getPostTP1LockPrice(signal: TradingSignal, override?: LadderOverride): number {
  const stopDistance = Math.abs(signal.entryPrice - signal.sl);
  const minDelta = POST_TP1_PROFIT_LOCK_MIN_PIPS * PIP;
  const tp1Distance = Math.abs(signal.tp1 - signal.entryPrice);
  const useFloor = override?.applyLockFloor ?? true;
  const useCap = override?.applyLockCap ?? true;

  let base: number;
  if (override?.lockFractionOfTP1 !== undefined) {
    base = Number.isFinite(tp1Distance) && tp1Distance > 0
      ? tp1Distance * override.lockFractionOfTP1
      : minDelta;
  } else {
    const lockR = override?.lockFractionOfR ?? POST_TP1_PROFIT_LOCK_R;
    base = Number.isFinite(stopDistance) && stopDistance > 0
      ? stopDistance * lockR
      : minDelta;
  }

  const ceiling = useCap && Number.isFinite(tp1Distance) && tp1Distance > 0
    ? tp1Distance * POST_TP1_LOCK_MAX_FRACTION_OF_TP1
    : Number.POSITIVE_INFINITY;
  const delta = Math.min(useFloor ? Math.max(base, minDelta) : base, ceiling);
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}

/**
 * ITEM 21 (NARROW / "OPTION 2") — how entry was obtained, for provenance only.
 *
 * `'zone'`          the bar actually traded through the entry band (a real fill).
 * `'levels-cross'`  the confirming bar only reached TP1/SL, never the entry band.
 *                   This is the pre-existing behaviour and is DELIBERATELY LEFT
 *                   INTACT: 11 of the 12 such signals measured did touch their
 *                   entry band on a LATER bar, i.e. they were genuinely fillable,
 *                   just later than the confirming bar.
 * `null`            no fill at all (never entered, or never fillable).
 *
 * WHY NO `'gap'` MEMBER. The original Item 21 spec asked for gap repricing. It was
 * built, gated, and REVERTED: deferring confirmation moves the confirmation BAR,
 * which re-walks the ladder from a different start and rewrote 18 of 378 outcomes
 * (two LOSS->WIN). Measured genuine gap fills = 0, so repricing bought nothing and
 * risked everything. This narrow form changes NO confirmation timing at all.
 */
export type EntryVia = 'zone' | 'levels-cross' | null;

export interface ResolverOutcome {
  newStatus: SignalStatus;
  targetsHit: number;
  exitPrice: number;
  outcomeResult: 'WIN' | 'LOSS' | null;
  breakevenReached: boolean;
  breakevenTime?: string;
  entryConfirmed: boolean;
  resolvedAtBarTs?: number;
  /** ITEM 21: provenance of the fill. Observational — never feeds the ladder. */
  entryVia?: EntryVia;
  /** ITEM 21: price the fill actually happened at, or null. NEVER 0. */
  entryFillPrice?: number | null;
  /**
   * ITEM 224 — max favourable excursion, split at the terminal bar.
   *
   * OBSERVATIONAL ONLY. It is computed AFTER the resolution loop has finished,
   * from the same evalBars the loop walked, so it cannot influence which bar
   * confirms entry, which bar resolves the ladder, or when the loop breaks —
   * the same discipline the Item 21 fillability pre-pass follows. Every field
   * above (newStatus, targetsHit, exitPrice, outcomeResult) is byte-for-byte
   * what it was before this was added.
   *
   * BEFORE-EXIT = capturable; AFTER-EXIT = counterfactual (Item 204). Undefined
   * when the signal never confirmed entry, i.e. there is no exit to split on.
   */
  maxFavourable?: MfeResult;
}

function getProtectedExitPrice(signal: TradingSignal, targetsHit: number, override?: LadderOverride): number {
  const normalizedTargetsHit = Math.max(0, Math.min(2, targetsHit));
  if (normalizedTargetsHit >= 2) {
    return Number(((signal.tp1 + signal.tp2 + signal.entryPrice) / 3).toFixed(1));
  }
  if (normalizedTargetsHit === 1) {
    // Post-TP1 protected exit = 0.35R profit lock price.
    return getPostTP1LockPrice(signal, override);
  }
  return signal.entryPrice;
}

export function resolveSignalWithBars(
  signal: TradingSignal,
  bars: OhlcBar[],
  opts: {
    slWickPenetrationPips?: number;
    logPrefix?: string;
    fromScratch?: boolean;
    evalNowMs?: number;
    /** Offline ladder-sweep hook only (ITEM D). Omit for live behaviour. */
    ladder?: LadderOverride;
  } = {},
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

  /**
   * ITEM 21: was the entry credited from the STORED status rather than derived
   * from price action in this call? If so this call has no evidence about
   * fillability (the bar that filled it may predate the window we were handed),
   * so the never-fillable reclassification below MUST NOT fire.
   */
  const entrySeededFromStoredStatus = !fromScratch && entryConfirmed;
  let entryVia: EntryVia = entrySeededFromStoredStatus ? 'zone' : null;
  let entryFillPrice: number | null = entrySeededFromStoredStatus ? signal.entryPrice : null;

  const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
  const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
  const ENTRY_TOL = 1.0;
  const EXTENDED_ENTRY_TOL = 3.0;

  const isBuy = signal.type === 'BUY';
  const slTriggerPrice = isBuy ? signal.sl - slSlack : signal.sl + slSlack;

  const postTP1Lock = getPostTP1LockPrice(signal, opts.ladder);

  /**
   * ITEM 21 (NARROW) — did ANY evaluated bar trade through the entry band?
   *
   * Computed as a PRE-PASS over every evaluated bar, deliberately OUTSIDE the
   * resolution loop, so it cannot influence which bar confirms entry, which bar
   * resolves the ladder, or when the loop breaks. The resolution loop below is
   * byte-for-byte the pre-Item-21 logic.
   *
   * The widest tolerance the confirmation logic itself accepts
   * (EXTENDED_ENTRY_TOL) is used, so this can only ever be MORE permissive than
   * the fill test — it fires only when the band was never reachable AT ALL.
   *
   * SYMMETRY (Item 21e): this test is side-agnostic by construction — one
   * expression for BUY and SELL, no per-direction branch — so it cannot correct
   * winners more aggressively than losers and cannot manufacture a worse EV.
   */
  const everTouchedEntryBand = evalBars.some(
    b => b.low <= (entryMax + EXTENDED_ENTRY_TOL) && b.high >= (entryMin - EXTENDED_ENTRY_TOL),
  );

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
        // Provenance ONLY. The condition above is unchanged, so confirmation
        // timing and the ladder walk are identical to pre-Item-21.
        entryVia = (touchedZone || touchedExtended) ? 'zone' : 'levels-cross';
        entryFillPrice = signal.entryPrice;
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

  /**
   * ITEM 21 (NARROW / "OPTION 2") — NEVER_FILLABLE reclassification.
   *
   * Fires ONLY when entry was credited by a TP1/SL levels-cross AND no evaluated
   * bar ever traded through the entry band. Such a signal was booked a result on
   * a position that could not have existed. It is relabelled and removed from EV;
   * it is never a win and never a loss.
   *
   * Deliberate limits, so this can only touch the measured defect:
   *  - it changes NO confirmation timing and NO ladder walk (pre-pass only);
   *  - it never fires on a seeded (stored-status) confirmation, which carries no
   *    fillability evidence in this call;
   *  - it requires ENTRY_MATURITY_MS, the same maturity floor Item 1 put on
   *    EXPIRED_MISSED_ENTRY, so a young signal whose first bar spikes through TP1
   *    is never stamped with an irreversible terminal early;
   *  - direction-symmetric, so it cannot manufacture a falsely worse EV.
   */
  const fillabilityEvalNow = opts.evalNowMs ?? Date.now();
  if (
    entryConfirmed &&
    !entrySeededFromStoredStatus &&
    !everTouchedEntryBand &&
    evalBars.length > 0 &&
    fillabilityEvalNow - signalCreatedAtMs >= ENTRY_MATURITY_MS
  ) {
    console.log(
      `${prefix} 🚫 NEVER_FILLABLE: levels were reached but no bar of ${evalBars.length} ever traded ` +
      `the entry band [${(entryMin - EXTENDED_ENTRY_TOL).toFixed(1)}, ${(entryMax + EXTENDED_ENTRY_TOL).toFixed(1)}] ` +
      `— discarding ${currentStatus}/${currentTargetsHit} (was ${outcomeResult ?? 'null'}), excluded from EV`,
    );
    currentStatus = 'NEVER_FILLABLE';
    currentTargetsHit = 0;
    exitPrice = signal.entryPrice;
    outcomeResult = null;
    breakevenReached = false;
    breakevenTime = undefined;
    entryConfirmed = false;
    entryVia = null;
    entryFillPrice = null;
  }

  if (!entryConfirmed && currentStatus !== 'NEVER_FILLABLE') {
    const anyTargetHit =
      currentTargetsHit > 0 ||
      currentStatus === 'TP1_HIT' ||
      currentStatus === 'TP2_HIT' ||
      currentStatus === 'TP3_HIT' ||
      currentStatus === 'ALL_TARGETS_HIT' ||
      currentStatus === 'PARTIAL_WIN_SL_HIT' ||
      currentStatus === 'SL_AFTER_BE';
    if (!anyTargetHit) {
      // ITEM 1(b): a signal may only be declared EXPIRED_MISSED_ENTRY once it is
      // at least as old as ENTRY_MATURITY_MS. Before that it is simply not yet
      // expired — it keeps whatever non-terminal status it already had, and a
      // later pass with more bars decides.
      const expiryEvalNow = opts.evalNowMs ?? Date.now();
      const ageMs = expiryEvalNow - signalCreatedAtMs;
      if (ageMs >= ENTRY_MATURITY_MS) {
        currentStatus = 'EXPIRED_MISSED_ENTRY';
        outcomeResult = null;
      } else {
        console.log(
          `${prefix} ⏳ Entry not confirmed yet, but signal is only ${(ageMs / 60000).toFixed(1)}m old ` +
          `(< ${(ENTRY_MATURITY_MS / 60000).toFixed(0)}m maturity, ${evalBars.length} bars) — holding ${currentStatus}, NOT expiring`,
        );
      }
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
    const matured = evalNow - signalCreatedAtMs >= ENTRY_MATURITY_MS;
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

  /**
   * ITEM 224 — the discarded information, recorded.
   *
   * The branches at :293-318 and :345-361 above deliberately take the ADVERSE
   * side inside a single bar (an OHLC bar carries no tick order), so a target
   * touched in the terminal bar is dropped from `currentTargetsHit`; and nothing
   * after the terminal bar was ever recorded at all. That conservative rule is
   * CORRECT for R accounting and is untouched. This measures what it discards.
   *
   * The boundary is the terminal bar. With no terminal bar event (matured /
   * CLOSED at window end) the last evaluated bar is the boundary, which makes
   * the after-exit pair legitimately empty rather than silently borrowing the
   * before-exit window. NEVER_FILLABLE / unconfirmed entries get undefined:
   * there was no position, so there is no excursion to attribute to one.
   */
  const mfeBoundaryTs = resolvedAtBarTs
    ?? (evalBars.length > 0 ? evalBars[evalBars.length - 1].timestamp : signalCreatedAtMs);
  const maxFavourable = entryConfirmed && evalBars.length > 0
    ? computeMaxFavourableExcursion(
      {
        direction: isBuy ? 'BUY' : 'SELL',
        entry: signal.entryPrice,
        sl: signal.sl,
        tp1: signal.tp1,
        tp2: signal.tp2,
        tp3: signal.tp3,
        terminalBarTs: mfeBoundaryTs,
      },
      evalBars,
    )
    : undefined;

  return {
    newStatus: currentStatus,
    targetsHit: currentTargetsHit,
    exitPrice,
    outcomeResult,
    breakevenReached,
    breakevenTime,
    entryConfirmed,
    resolvedAtBarTs,
    entryVia,
    entryFillPrice,
    maxFavourable,
  };
}
