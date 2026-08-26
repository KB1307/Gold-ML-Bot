/**
 * ITEM 224 — MAX FAVOURABLE EXCURSION, SPLIT AT THE EXIT BOUNDARY (CLIENT IMPL).
 *
 * WHAT DEFECT THIS MEASURES. Both resolvers deliberately take the ADVERSE side
 * inside a single bar, because one OHLC bar does not carry tick order:
 *   - client signalResolver.ts:293-318 — when the SL-side level sits closer to
 *     the bar open, the adverse terminal is taken and the target touched in that
 *     SAME bar is discarded (`currentTargetsHit` forced to 1/2);
 *   - client signalResolver.ts:345-361 — after banking a target, a same-bar
 *     retrace to lock/entry ends the trade and any HIGHER target touched later
 *     in that bar is discarded;
 *   - edge resolve-emitted-signals/index.ts:410-470 — the lock is checked BEFORE
 *     the targets within each bar, so the adverse side always wins.
 * On top of that, everything after the terminal bar was never recorded at all.
 * That conservative rule is CORRECT for R accounting and is NOT changed here.
 * These four numbers simply stop the discarded information being unrecoverable.
 *
 * THE BOUNDARY IS THE TERMINAL BAR, INCLUSIVE ON THE BEFORE SIDE.
 *   BEFORE-EXIT = CAPTURABLE. What a different exit rule could actually have
 *                 banked while the position was still open.
 *   AFTER-EXIT  = COUNTERFACTUAL. The position was already closed, so this is
 *                 continuation evidence (Item 204's 105/151 = 69.5%), never
 *                 realisable P&L. Callers must never quote it as capturable.
 *
 * ORDERING-INDEPENDENT BY CONSTRUCTION. Every output is a max / highest-touched
 * scan over completed bars. Nothing here guesses intra-bar sequence. That is
 * exactly why this can be made byte-identical to the edge implementation even
 * though the two resolvers' terminal LABELS legitimately differ on same-bar
 * ambiguity — a divergence class that is documented and NOT addressed here.
 *
 * NO NEUTRALISING CLAMP. There is no floor, no Math.max against a constant and
 * no clamp anywhere in this module: the only Math.max calls fold over observed
 * bar extremes, so a real excursion can never be raised to a synthetic minimum.
 * A signal that never moved favourably reports exactly 0/0, which is a finding.
 */

/** Minimal bar shape. Deliberately structural so both runtimes can satisfy it. */
export interface MfeBar {
  timestamp: number;
  high: number;
  low: number;
}

export interface MfeInput {
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /**
   * Timestamp of the bar the resolver called terminal. Bars at or before this
   * are BEFORE-EXIT; bars strictly after it are AFTER-EXIT. When the resolver
   * produced no terminal bar (CLOSED at window end), pass the last evaluated
   * bar's timestamp — then the after-exit pair is legitimately empty (0/0).
   */
  terminalBarTs: number;
}

export interface MfeResult {
  targetReachedBeforeExit: number;
  excursionBeforeExitR: number;
  targetAfterExit: number;
  excursionAfterExitR: number;
}

/** Highest target index (0..3) whose level is contained in the bar's range. */
function touchedTarget(input: MfeInput, bar: MfeBar): number {
  const isBuy = input.direction === 'BUY';
  const reached = (level: number): boolean =>
    isBuy ? bar.high >= level : bar.low <= level;
  if (reached(input.tp3)) return 3;
  if (reached(input.tp2)) return 2;
  if (reached(input.tp1)) return 1;
  return 0;
}

/**
 * Compute both pairs in ONE scan over the bars handed in.
 *
 * The caller owns the window: `bars` must already be the pinned evaluation
 * window (safeBarStart = emitted + 60s through the 8h resolution horizon), so
 * this function cannot silently widen or narrow the measurement basis.
 *
 * R basis = |entry − sl|, the same risk denominator realized_r uses, and the
 * excursions are GROSS of execution cost — they describe price travel, not a
 * bookable result, so subtracting a per-trade cost from them would be a
 * category error.
 */
export function computeMaxFavourableExcursion(input: MfeInput, bars: MfeBar[]): MfeResult {
  const risk = Math.abs(input.entry - input.sl);
  const empty: MfeResult = {
    targetReachedBeforeExit: 0,
    excursionBeforeExitR: 0,
    targetAfterExit: 0,
    excursionAfterExitR: 0,
  };
  if (!Number.isFinite(risk) || risk <= 0) return empty;

  const isBuy = input.direction === 'BUY';
  let targetBefore = 0;
  let targetAfter = 0;
  let bestBefore: number | null = null;
  let bestAfter: number | null = null;

  for (const bar of bars) {
    const favourable = isBuy ? bar.high : bar.low;
    if (!Number.isFinite(favourable)) continue;
    const excursion = isBuy ? favourable - input.entry : input.entry - favourable;
    const isBefore = bar.timestamp <= input.terminalBarTs;
    const target = touchedTarget(input, bar);
    if (isBefore) {
      if (target > targetBefore) targetBefore = target;
      if (bestBefore === null || excursion > bestBefore) bestBefore = excursion;
    } else {
      if (target > targetAfter) targetAfter = target;
      if (bestAfter === null || excursion > bestAfter) bestAfter = excursion;
    }
  }

  // A negative best excursion is REAL (price never traded favourably at all)
  // and is reported as-is; only the "no bars on this side" case is 0.
  const toR = (v: number | null): number => (v === null ? 0 : Number((v / risk).toFixed(4)));
  return {
    targetReachedBeforeExit: targetBefore,
    excursionBeforeExitR: toR(bestBefore),
    targetAfterExit: targetAfter,
    excursionAfterExitR: toR(bestAfter),
  };
}
