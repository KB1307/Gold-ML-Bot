/**
 * ITEM 101(d) — SHARED EV FUNCTION.
 *
 * The single source of truth for R computation and book aggregation.
 * Used by BOTH canonical scripts AND the corpus book, so the class of
 * discrepancy where one path computes GROSS and another NET cannot recur.
 *
 * NET = GROSS - costInR(risk).
 * GROSS = (exit - entry) / risk  (inverted for SELL).
 * Cost = $0.20 per trade, converted to R via the risk distance.
 *
 * The Edge Function (backend/functions/resolve-emitted-signals/index.ts)
 * duplicates these constants with source citations (Deno cannot import
 * this module). ANY change here MUST be mirrored there.
 */

export const EXECUTION_COST_PER_TRADE_USD = 0.20;
export const DOLLAR_PER_PRICE_UNIT = 1;

/** Convert the $0.20 execution cost into R units given the risk distance. */
export function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

/** Gross R (before cost). Positive = profit. */
export function computeRGross(
  direction: 'BUY' | 'SELL',
  entry: number,
  exit: number,
  risk: number,
): number {
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  return direction === 'BUY'
    ? (exit - entry) / risk
    : (entry - exit) / risk;
}

/** Net R (after cost). This is what trade_outcomes_v1.realized_r MUST store. */
export function computeRNet(
  direction: 'BUY' | 'SELL',
  entry: number,
  exit: number,
  risk: number,
): number {
  return computeRGross(direction, entry, exit, risk) - costInR(risk);
}

export interface BookEntry {
  id: string;
  rGross: number;
  rNet: number;
}

export interface BookStats {
  n: number;
  wr: number;
  evGross: number;
  evNet: number;
}

/**
 * Compute book statistics (WR, EV) from a list of entries.
 * @param useNet - if true, WR and EV use rNet; if false, rGross.
 */
export function computeBook(entries: BookEntry[], useNet: boolean): BookStats {
  const n = entries.length;
  if (n === 0) return { n: 0, wr: 0, evGross: 0, evNet: 0 };
  const rValues = entries.map((e) => (useNet ? e.rNet : e.rGross));
  const wins = rValues.filter((r) => r > 0);
  const wr = (wins.length / n) * 100;
  const evGross = entries.reduce((s, e) => s + e.rGross, 0) / n;
  const evNet = entries.reduce((s, e) => s + e.rNet, 0) / n;
  return { n, wr, evGross, evNet };
}

/**
 * Format a BookStats line for console output.
 */
export function formatBookLine(label: string, stats: BookStats): string {
  const { n, wr, evGross, evNet } = stats;
  return `  ${label.padEnd(36)} n=${String(n).padStart(3)}  WR=${wr.toFixed(2)}%  EV_gross=${evGross >= 0 ? '+' : ''}${evGross.toFixed(4)}R  EV_net=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`;
}
