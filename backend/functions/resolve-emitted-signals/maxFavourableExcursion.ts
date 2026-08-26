// ITEM 224 — MAX FAVOURABLE EXCURSION, SPLIT AT THE EXIT BOUNDARY (EDGE IMPL).
//
// Mirrors expo/services/maxFavourableExcursion.ts. Deno cannot import the client
// module, so the formula is duplicated here with the source cited — the same
// convention already used for POST_TP1_PROFIT_LOCK_R (index.ts:76) and
// EXECUTION_COST_PER_TRADE_USD (index.ts:51). ANY change to the client module
// must be mirrored here, and expo/scripts/item224_mfe_round.ts asserts the two
// agree EXACTLY on both synthetic fixtures and >=30 real resolved signals.
//
// This file is deliberately DEPENDENCY-FREE so both runtimes can load it: Deno
// imports it from index.ts, and the bun-run parity script imports the very same
// file. Parity is therefore checked against the code that actually ships, not
// against a re-typed copy of it.
//
// WHY FOUR NUMBERS. The resolvers take the ADVERSE side inside any single bar
// (index.ts:410-470 checks the lock BEFORE the targets), and record nothing at
// all after the terminal bar. Splitting at the terminal bar keeps the two
// questions apart:
//   BEFORE-EXIT = CAPTURABLE (what another exit rule could have banked).
//   AFTER-EXIT  = COUNTERFACTUAL (Item 204 continuation; the position was shut).
// Both are ordering-independent max/touched scans, so they carry none of the
// same-bar sequence guessing that makes the two resolvers' terminal LABELS
// legitimately differ. That label divergence is documented and NOT fixed here.
//
// NO NEUTRALISING CLAMP: no floor, no clamp, no Math.max against a constant.
// Every Math.max folds over observed bar extremes only, so a real excursion can
// never be lifted to a synthetic minimum. Zero means zero.

export interface EdgeMfeBar {
  timestamp: number;
  high: number;
  low: number;
}

export interface EdgeMfeInput {
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Terminal bar timestamp: <= is BEFORE-EXIT, > is AFTER-EXIT. */
  terminalBarTs: number;
}

export interface EdgeMfeResult {
  targetReachedBeforeExit: number;
  excursionBeforeExitR: number;
  targetAfterExit: number;
  excursionAfterExitR: number;
}

/**
 * Compute both pairs from the bars handed in. The CALLER owns the window (the
 * pinned safeBarStart -> 8h horizon), so this cannot widen the basis silently.
 *
 * R basis = |entry - sl| (the realized_r denominator). GROSS of execution cost:
 * these describe price travel, not a bookable result, so netting a per-trade
 * cost out of them would be a category error.
 */
export function computeEdgeMaxFavourableExcursion(
  input: EdgeMfeInput,
  bars: EdgeMfeBar[],
): EdgeMfeResult {
  const risk = Math.abs(input.entry - input.sl);
  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      targetReachedBeforeExit: 0,
      excursionBeforeExitR: 0,
      targetAfterExit: 0,
      excursionAfterExitR: 0,
    };
  }

  const isBuy = input.direction === "BUY";
  const levels: number[] = [Number(input.tp1), Number(input.tp2), Number(input.tp3)];

  // Split the bars first, then reduce each side independently. Structurally
  // different from the client's single-pass branch, deliberately: two genuinely
  // separate implementations make the parity assertion worth something.
  const before: EdgeMfeBar[] = [];
  const after: EdgeMfeBar[] = [];
  for (const bar of bars) {
    if (bar.timestamp <= input.terminalBarTs) before.push(bar);
    else after.push(bar);
  }

  const reduce = (side: EdgeMfeBar[]): { target: number; r: number } => {
    let target = 0;
    let best: number | null = null;
    for (const bar of side) {
      const favourable = isBuy ? Number(bar.high) : Number(bar.low);
      if (!Number.isFinite(favourable)) continue;
      const excursion = isBuy ? favourable - input.entry : input.entry - favourable;
      if (best === null || excursion > best) best = excursion;
      for (let i = levels.length - 1; i >= 0; i -= 1) {
        const hit = isBuy ? Number(bar.high) >= levels[i] : Number(bar.low) <= levels[i];
        if (hit) {
          if (i + 1 > target) target = i + 1;
          break;
        }
      }
    }
    return { target, r: best === null ? 0 : Number((best / risk).toFixed(4)) };
  };

  const b = reduce(before);
  const a = reduce(after);
  return {
    targetReachedBeforeExit: b.target,
    excursionBeforeExitR: b.r,
    targetAfterExit: a.target,
    excursionAfterExitR: a.r,
  };
}
