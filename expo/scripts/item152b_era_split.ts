/**
 * ITEM 152(b) — THE ERA QUESTION (Item 120, fifth round).
 *
 * Is the LIVE era (real-time emitted, post-launch) a different population from
 * the BACKFILL era (historical reconstruction)? Item 151 showed:
 *   LIVE     n=14  EV_net=-0.5559R
 *   BACKFILL n=388 EV_net=+0.0278R
 * but n=14 is far too small to close the question. This script makes the
 * re-measurement ONE COMMAND so it can be re-run at every checkpoint as the
 * LIVE cohort grows, and states exactly how much data is still needed.
 *
 * Outputs:
 *   (a) Era split: LIVE vs BACKFILL — n, WR, EV gross/net, 95% CI, resolved/unresolved.
 *   (b) Per-era BUY/SELL split.
 *   (c) LIVE accumulation rate + projected calendar days to n>=100 resolved.
 *   (d) Verdict at the pre-registered decision gate (n>=100, CI excludes zero).
 *
 * MEASUREMENT ONLY — no gate, no constant, no emission path is changed.
 * DATA-SOURCE: emitted_signals_v1 + trade_outcomes_v1 reads = Supabase DIRECT
 * via anon key. Uses the shared evCompute cost model (rNet = realized_r as
 * stored by the resolver; rGross = rNet + cost reversed).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import {
  computeBook,
  formatBookLine,
  type BookEntry,
} from '../lib/evCompute';

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error('Could not read .env:', e);
    process.exit(1);
  }
}
loadEnv();

const url = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Pre-registered decision gate for 152(b). */
const LIVE_MIN_N = 100;

// ── Types ─────────────────────────────────────────────────────────────────────
interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  source: string;
}

interface OutcomeRow {
  signal_id: string;
  result: string;
  realized_r: number | null;
}

// ── Fetch all pages of a table ────────────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  orderBy: string,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .order(orderBy, { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Fetch ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
    if (offset > 10000) break;
  }
  return out;
}

/** 95% CI half-width for the mean of rValues (normal approximation). */
function ciHalfWidth(rValues: number[]): number {
  const n = rValues.length;
  if (n < 2) return Number.POSITIVE_INFINITY;
  const mean = rValues.reduce((s, r) => s + r, 0) / n;
  const variance = rValues.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return 1.96 * (sd / Math.sqrt(n));
}

function fmtCI(half: number): string {
  if (!Number.isFinite(half)) return 'CI: n too small';
  return `±${half.toFixed(4)}R`;
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80));
  console.log('ITEM 152(b) — THE ERA QUESTION (LIVE vs BACKFILL)');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  const signals = await fetchAll<SignalRow>(
    'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, source',
    'emitted_at',
  );
  const outcomes = await fetchAll<OutcomeRow>(
    'trade_outcomes_v1',
    'signal_id, result, realized_r',
    'signal_id',
  );
  const outcomeBySignal = new Map<string, OutcomeRow>();
  for (const o of outcomes) outcomeBySignal.set(o.signal_id, o);

  console.log(`Signals: ${signals.length} | Outcomes: ${outcomes.length}\n`);

  // ── (a) Era split ───────────────────────────────────────────────────────────
  console.log('-'.repeat(80));
  console.log('(a) ERA SPLIT — canonical (realized_r not null), shared evCompute');
  console.log('-'.repeat(80));

  const eras = ['LIVE', 'BACKFILL'] as const;
  const eraEntries: Record<string, BookEntry[]> = { LIVE: [], BACKFILL: [] };
  const eraUnresolved: Record<string, number> = { LIVE: 0, BACKFILL: 0 };
  const eraEmitted: Record<string, number> = { LIVE: 0, BACKFILL: 0 };
  const eraRValues: Record<string, number[]> = { LIVE: [], BACKFILL: [] };
  const eraFirstLast: Record<string, { first: string; last: string } | null> = {
    LIVE: null,
    BACKFILL: null,
  };

  for (const sig of signals) {
    const era = sig.source === 'LIVE' ? 'LIVE' : 'BACKFILL';
    eraEmitted[era] += 1;
    const t = eraFirstLast[era];
    eraFirstLast[era] = {
      first: t ? t.first : sig.emitted_at,
      last: sig.emitted_at,
    };
    const outcome = outcomeBySignal.get(sig.signal_id);
    if (!outcome || outcome.realized_r === null) {
      eraUnresolved[era] += 1;
      continue;
    }
    const risk = Math.abs(sig.entry - sig.sl);
    if (!Number.isFinite(risk) || risk <= 0) continue;
    const rNet = outcome.realized_r; // resolver stores NET
    const rGross = rNet + 0.20 / risk; // reverse the cost to get gross
    eraEntries[era].push({ id: sig.signal_id, rGross, rNet });
    eraRValues[era].push(rNet);
  }

  for (const era of eras) {
    const stats = computeBook(eraEntries[era], true);
    console.log(formatBookLine(`${era} era:`, stats));
    const half = ciHalfWidth(eraRValues[era]);
    console.log(
      `    95% CI (EV_net): ${fmtCI(half)}  →  [${(stats.evNet - (Number.isFinite(half) ? half : 0)).toFixed(4)}R, ${(stats.evNet + (Number.isFinite(half) ? half : 0)).toFixed(4)}R]`,
    );
    console.log(
      `    emitted=${eraEmitted[era]}  resolved=${stats.n}  unresolved=${eraUnresolved[era]}`,
    );
    const fl = eraFirstLast[era];
    if (fl) console.log(`    span: ${fl.first} → ${fl.last}`);
  }

  const liveStats = computeBook(eraEntries['LIVE'], true);
  const backfillStats = computeBook(eraEntries['BACKFILL'], true);
  const liveHalf = ciHalfWidth(eraRValues['LIVE']);

  // ── (b) Per-era BUY/SELL split ──────────────────────────────────────────────
  console.log('\n' + '-'.repeat(80));
  console.log('(b) PER-ERA BUY/SELL SPLIT');
  console.log('-'.repeat(80));
  for (const era of eras) {
    const buyEntries: BookEntry[] = [];
    const sellEntries: BookEntry[] = [];
    for (const sig of signals) {
      const sigEra = sig.source === 'LIVE' ? 'LIVE' : 'BACKFILL';
      if (sigEra !== era) continue;
      const outcome = outcomeBySignal.get(sig.signal_id);
      if (!outcome || outcome.realized_r === null) continue;
      const risk = Math.abs(sig.entry - sig.sl);
      if (!Number.isFinite(risk) || risk <= 0) continue;
      const rNet = outcome.realized_r;
      const rGross = rNet + 0.20 / risk;
      (sig.direction === 'BUY' ? buyEntries : sellEntries).push({
        id: sig.signal_id,
        rGross,
        rNet,
      });
    }
    const buyStats = computeBook(buyEntries, true);
    const sellStats = computeBook(sellEntries, true);
    console.log(formatBookLine(`  ${era} BUY:`, buyStats));
    console.log(formatBookLine(`  ${era} SELL:`, sellStats));
  }

  // ── (c) LIVE accumulation rate + projection to n>=100 ───────────────────────
  console.log('\n' + '-'.repeat(80));
  console.log('(c) LIVE COHORT GROWTH — projection to the decision gate');
  console.log('-'.repeat(80));
  const liveFl = eraFirstLast['LIVE'];
  if (liveFl) {
    const firstMs = new Date(liveFl.first).getTime();
    const lastMs = new Date(liveFl.last).getTime();
    const nowMs = Date.now();
    const spanDays = Math.max((nowMs - firstMs) / 86_400_000, 0.01);
    const perDay = eraEmitted['LIVE'] / spanDays;
    const resolvedPerDay = liveStats.n / spanDays;
    const remaining = Math.max(LIVE_MIN_N - liveStats.n, 0);
    const daysToGate = resolvedPerDay > 0 ? remaining / resolvedPerDay : Number.POSITIVE_INFINITY;
    const etaDate = Number.isFinite(daysToGate)
      ? new Date(nowMs + daysToGate * 86_400_000).toISOString().slice(0, 10)
      : 'unknown';
    console.log(`  LIVE cohort live since : ${liveFl.first}`);
    console.log(`  Elapsed                : ${spanDays.toFixed(2)} days`);
    console.log(`  Emission rate          : ${perDay.toFixed(2)} LIVE signals/day`);
    console.log(`  Resolution rate        : ${resolvedPerDay.toFixed(2)} resolved/day`);
    console.log(`  Resolved now           : ${liveStats.n} / ${LIVE_MIN_N} needed`);
    console.log(
      `  Projected time to gate : ${Number.isFinite(daysToGate) ? `${daysToGate.toFixed(1)} days (ETA ${etaDate})` : 'resolution stalled — check the resolver'}`,
    );
  } else {
    console.log('  No LIVE signals found.');
  }

  // ── (d) Verdict at the pre-registered gate ──────────────────────────────────
  console.log('\n' + '-'.repeat(80));
  console.log('(d) VERDICT');
  console.log('-'.repeat(80));
  console.log(`  Decision gate (pre-registered): LIVE resolved n >= ${LIVE_MIN_N}`);
  console.log(`  LIVE resolved n = ${liveStats.n}`);
  if (liveStats.n < LIVE_MIN_N) {
    console.log(
      `  VERDICT: OPEN — underpowered (${liveStats.n}/${LIVE_MIN_N}). ` +
        `Current LIVE EV_net=${liveStats.evNet >= 0 ? '+' : ''}${liveStats.evNet.toFixed(4)}R ` +
        `is NOT quotable as evidence of era difference.`,
    );
    console.log(
      `  BACKFILL reference: EV_net=${backfillStats.evNet >= 0 ? '+' : ''}${backfillStats.evNet.toFixed(4)}R (n=${backfillStats.n}).`,
    );
  } else {
    const ciLo = liveStats.evNet - liveHalf;
    const ciHi = liveStats.evNet + liveHalf;
    const excludesZero = ciLo > 0 || ciHi < 0;
    console.log(
      `  LIVE EV_net=${liveStats.evNet >= 0 ? '+' : ''}${liveStats.evNet.toFixed(4)}R  95% CI [${ciLo.toFixed(4)}R, ${ciHi.toFixed(4)}R]`,
    );
    console.log(
      excludesZero
        ? `  VERDICT: CLOSED — LIVE era edge is definitively ${liveStats.evNet > 0 ? 'POSITIVE' : 'NEGATIVE'}.`
        : '  VERDICT: CLOSED — LIVE era edge is INDETERMINATE (CI includes zero).',
    );
  }
  console.log(
    '\n  NOTE: this script changes nothing. It is the standing checkpoint instrument',
    '  for 152(b) — re-run it at every review until the gate closes.',
  );
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
