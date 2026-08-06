/**
 * EXECUTION-COST SENSITIVITY (READ-ONLY)
 * ======================================
 *
 * The book's cost model is a single hardcoded constant,
 * `EXECUTION_COST_PER_TRADE_USD = 0.05`, commented "broker-confirmed XAU
 * spread". This script exists to answer one question honestly: what does the
 * measured record actually say about that number, and how does the book's
 * expectancy move if the real cost is larger?
 *
 * WHAT IT MEASURES (all from real rows, no synthesis):
 *  1. Realised R per resolved signal, computed DIRECTLY from the record's own
 *     exit price and stop distance: R = (exit - entry) / |entry - sl|, signed by
 *     direction. No status->R lookup table, so a PARTIAL_WIN_SL_HIT or an
 *     early CLOSED is counted at what it actually paid, not at what its label
 *     implies.
 *  2. Per-signal cost in R for a GIVEN dollar cost: cost_R = costUsd / risk$.
 *     Because risk$ varies per signal (real stop distances span the sample), the
 *     cost burden is NOT constant in R and has to be averaged per signal.
 *  3. Book EV in R at a ladder of hypothesised round-trip costs, and the
 *     breakeven cost — the dollar cost at which the book's EV reaches zero.
 *
 * WHAT IT CANNOT MEASURE, STATED UP FRONT: the real spread. No durable store in
 * this system holds a single observed bid/ask reading (verified separately), so
 * every non-zero cost column below is a HYPOTHESIS, not a measurement. Only the
 * $0 column and the breakeven figure are measured facts about the book.
 */

import { readFileSync } from 'node:fs';

interface ParsedSignal {
  index: number;
  type: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  status: string;
  exit: number | null;
  generated: string;
}

/** Statuses excluded from EV by the system's own definition (see types/trading.ts). */
const EXCLUDED_STATUSES = new Set(['ACTIVE', 'EXPIRED_MISSED_ENTRY', 'NEVER_FILLABLE']);

function parseExport(path: string): ParsedSignal[] {
  const text = readFileSync(path, 'utf8');
  const section = text.split('SECTION 2')[0];
  const blocks = section.split(/\n\[(\d+)\] /).slice(1);
  const out: ParsedSignal[] = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const index = parseInt(blocks[i], 10);
    const body = blocks[i + 1];
    const head = /^(BUY|SELL) @ ([\d.]+)\s+—\s+status: (\S+)/.exec(body);
    if (!head) continue;
    const sl = /SL: ([\d.]+)/.exec(body);
    const exit = /exit price: ([\d.]+)/.exec(body);
    const gen = /generated: (\S+)/.exec(body);
    if (!sl) continue;
    out.push({
      index,
      type: head[1] as 'BUY' | 'SELL',
      entry: parseFloat(head[2]),
      sl: parseFloat(sl[1]),
      status: head[3],
      exit: exit ? parseFloat(exit[1]) : null,
      generated: gen?.[1] ?? 'unknown',
    });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}

function main(): void {
  const path = process.argv[2] ?? '/tmp/diagnostics_export.txt';
  const all = parseExport(path);
  console.log(`Parsed ${all.length} signal blocks from ${path}`);

  const resolved = all.filter(
    (s) => !EXCLUDED_STATUSES.has(s.status) && s.exit !== null && Math.abs(s.entry - s.sl) > 0,
  );
  console.log(`Resolved & EV-eligible (exit price present, non-zero risk): ${resolved.length}`);
  const statusCounts = new Map<string, number>();
  all.forEach((s) => statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1));
  console.log(`Status distribution: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);

  const rows = resolved.map((s) => {
    const risk = Math.abs(s.entry - s.sl);
    const signed = s.type === 'BUY' ? (s.exit as number) - s.entry : s.entry - (s.exit as number);
    return { ...s, risk, grossR: signed / risk };
  });

  const risks = rows.map((r) => r.risk);
  const grossRs = rows.map((r) => r.grossR);
  const grossEv = grossRs.reduce((a, b) => a + b, 0) / rows.length;

  console.log('\n--- REAL STOP-DISTANCE DISTRIBUTION (this is what a fixed $ cost is divided by) ---');
  console.log(`risk$ per trade: min $${Math.min(...risks).toFixed(2)}  p10 $${percentile(risks, 10).toFixed(2)}  median $${median(risks).toFixed(2)}  p90 $${percentile(risks, 90).toFixed(2)}  max $${Math.max(...risks).toFixed(2)}`);

  console.log('\n--- BOOK EV IN R AT HYPOTHESISED ROUND-TRIP COSTS ---');
  console.log('cost is applied per trade as costUsd / risk$ for THAT trade (real stop distances).');
  console.log('pips shown at the engine\'s own pipValue = 0.1.');
  const header = 'cost$    pips   mean cost (R)   net EV (R)   net EV ($ per 1oz)   PF(net)';
  console.log(header);
  const costs = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.5];
  for (const cost of costs) {
    const netRs = rows.map((r) => r.grossR - cost / r.risk);
    const meanCostR = rows.reduce((a, r) => a + cost / r.risk, 0) / rows.length;
    const netEv = netRs.reduce((a, b) => a + b, 0) / rows.length;
    const netDollars = rows.reduce((a, r, i) => a + netRs[i] * r.risk, 0) / rows.length;
    const wins = netRs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(netRs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    const pf = losses > 0 ? wins / losses : Infinity;
    console.log(
      `$${cost.toFixed(2)}   ${(cost / 0.1).toFixed(1)}    ${meanCostR.toFixed(4)}          ${netEv >= 0 ? '+' : ''}${netEv.toFixed(4)}      ${netDollars >= 0 ? '+' : ''}$${netDollars.toFixed(3)}              ${pf.toFixed(3)}`,
    );
  }

  // Breakeven cost: solve mean(grossR) = mean(cost/risk) -> cost = grossEv / mean(1/risk)
  const meanInvRisk = rows.reduce((a, r) => a + 1 / r.risk, 0) / rows.length;
  const breakevenCost = grossEv / meanInvRisk;
  console.log('\n--- BREAKEVEN COST (measured, not hypothesised) ---');
  console.log(`gross EV: ${grossEv >= 0 ? '+' : ''}${grossEv.toFixed(4)}R over ${rows.length} resolved signals`);
  console.log(`mean(1/risk$): ${meanInvRisk.toFixed(4)}`);
  console.log(`=> the book's EV reaches ZERO at a round-trip cost of $${breakevenCost.toFixed(3)} (${(breakevenCost / 0.1).toFixed(2)} pips) per trade`);
  console.log(`   the model currently assumes $0.05 (0.50 pips).`);

  // Same figures split by direction, since SELL is currently suppressed.
  for (const dir of ['BUY', 'SELL'] as const) {
    const sub = rows.filter((r) => r.type === dir);
    if (sub.length === 0) continue;
    const ev = sub.reduce((a, r) => a + r.grossR, 0) / sub.length;
    const invRisk = sub.reduce((a, r) => a + 1 / r.risk, 0) / sub.length;
    console.log(`   ${dir} only (n=${sub.length}): gross EV ${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R, breakeven cost $${(ev / invRisk).toFixed(3)} (${(ev / invRisk / 0.1).toFixed(2)} pips)`);
  }
}

main();
