/**
 * ITEM 82 / B6 — THE SINGLE EXECUTION-COST CONSTANT.
 *
 * WHY THIS FILE EXISTS. F-4 found that no `$0.20` spread constant existed anywhere
 * in the tree. The only execution-cost figure was
 * `EXECUTION_COST_PER_TRADE_USD = 0.05` at signalEngine.ts:457, commented
 * "broker-confirmed XAU spread" — and an audit of its consumers found exactly ONE:
 * a `console.log` at signalEngine.ts:7795. It printed a cost-adjusted TP3 and
 * threw the number away. It never entered a single EV, R-multiple or PnL
 * computation.
 *
 * That matters because `realized_r` — the column every book in this project is
 * computed from — is produced FRICTIONLESS by both resolvers:
 *   services/signalResolver.ts            R = (exit - entry) / |entry - sl|
 *   backend/functions/resolve-emitted-signals/index.ts:181  same form
 * Neither subtracts a spread. So every EV figure this project has ever quoted is
 * a GROSS figure reported as though it were net.
 *
 * THE NUMBER. $0.20 round-trip is the project's closed figure. It is a CLOSED
 * INPUT, not a measurement: `scripts/analyzeExecutionCostSensitivity.ts` states
 * up front that no durable store in this system holds a single observed bid/ask
 * reading, so the true spread is unmeasured. `signalEngine.ts` does accumulate
 * `spreadHistory` from live quotes at runtime (signalEngine.ts:1274, :8881) but
 * that array is process-only and is never persisted, so it cannot be audited
 * after the fact. Treat $0.20 as an assumption with a known provenance, and use
 * `costInR()` to show the burden explicitly rather than burying it.
 *
 * SCOPE. This constant is the ONE place execution cost is defined. Anything that
 * computes an EV, an R-multiple or a PnL must read it from here.
 */

/**
 * Round-trip execution cost in USD per trade (spread + slippage allowance).
 *
 * Project-closed value. Was 0.05 at signalEngine.ts:457 before Item 82 / B6.
 */
export const EXECUTION_COST_PER_TRADE_USD = 0.2;

/**
 * The prior value, kept ONLY so a before/after book can be recomputed and the
 * restatement audited. Nothing in the live path may read this.
 */
export const LEGACY_EXECUTION_COST_PER_TRADE_USD = 0.05;

/**
 * Convert a dollar execution cost into R for one signal.
 *
 * The burden is NOT constant in R: risk-per-trade varies with the realised stop
 * distance, so a $0.20 cost is a heavier drag on a tight-stop signal than on a
 * wide-stop one. It therefore has to be computed per signal and averaged, never
 * applied as a single book-level R deduction.
 *
 * @param riskUsd Absolute dollar risk of the trade, i.e. |entry - sl| in price
 *   terms multiplied by the position's dollars-per-price-unit. Must be > 0.
 * @param costUsd Round-trip cost in USD. Defaults to the project constant.
 * @returns Cost expressed in R, or 0 when riskUsd is not usable (a degenerate
 *   stop distance must not manufacture an infinite cost).
 */
export function costInR(riskUsd: number, costUsd: number = EXECUTION_COST_PER_TRADE_USD): number {
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return costUsd / riskUsd;
}

/**
 * Net an already-computed gross R by the execution cost for that same trade.
 *
 * @param grossR Frictionless realised R, as both resolvers produce it.
 * @param riskUsd Absolute dollar risk of the trade.
 * @param costUsd Round-trip cost in USD. Defaults to the project constant.
 */
export function netR(grossR: number, riskUsd: number, costUsd: number = EXECUTION_COST_PER_TRADE_USD): number {
  return grossR - costInR(riskUsd, costUsd);
}
