/**
 * WEEKEND COLD-START measurement — stand-aside rate BEFORE vs AFTER the
 * BAR_SERIES_LOOKBACK_MIN fix (50h → 72h fetch window).
 *
 * Replicates the engine's directional gate exactly (getDirectionalM5 +
 * isDirectionalLayerReady): M5 series >= 60 bars, newest bar <= 15 min old,
 * RSI(14) computable — over the REAL gold_m1_bars tape around the last Sunday
 * reopen (2026-08-30), at the live attempt cadence (generateSignal every 30s,
 * backgroundTaskService). Only market-open attempts reach the gate, so the
 * replay starts at the first post-reopen bar.
 *
 * Run: bun scripts/measure_weekend_coldstart.ts
 */
import { createClient } from '@supabase/supabase-js';
import { aggregateBars, barRSI, isBarSeriesFresh, type Bar } from '../services/barIndicators';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not set');
}

const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FROM_ISO = '2026-08-27T00:00:00+00:00'; // 72h before the earliest reopen
const TO_ISO = '2026-08-31T08:00:00+00:00';
const ATTEMPT_STEP_MS = 30_000; // backgroundTaskService: "Task will run every 30 seconds"
const M5_MIN_BARS = 60;
const M5_MAX_AGE_MS = 15 * 60 * 1000;
const OLD_LOOKBACK_MS = (200 * 15 + 120) * 60 * 1000; // pre-fix: (BAR_M15_LOOKBACK*15+120) = 52h
const NEW_LOOKBACK_MS = 72 * 60 * 60 * 1000; // post-fix: BAR_SERIES_LOOKBACK_MIN = 72h

type Row = { timestamp: string; open: number; high: number; low: number; close: number };

async function fetchRows(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let page = 0; page < 12; page++) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp,open,high,low,close')
      .gte('timestamp', FROM_ISO)
      .lte('timestamp', TO_ISO)
      .order('timestamp', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < 1000) break;
  }
  return rows;
}

/** Exact replica of getDirectionalM5() + RSI readiness on a lookback window. */
function directionalReady(m1: readonly Bar[], nowMs: number): boolean {
  const m5 = aggregateBars(m1, 5);
  if (m5.length < M5_MIN_BARS) return false;
  if (
    !isBarSeriesFresh(
      m5 as unknown as Parameters<typeof isBarSeriesFresh>[0],
      nowMs,
      M5_MAX_AGE_MS,
    )
  ) {
    return false;
  }
  return barRSI(m5 as unknown as Parameters<typeof barRSI>[0], 14) !== null;
}

function firstIndexAtOrAfter(bars: readonly Bar[], ts: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main(): Promise<void> {
  const rows = await fetchRows();
  const bars: Bar[] = rows.map(r => ({
    timestamp: new Date(r.timestamp).getTime(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
  }));
  console.log(`tape: ${rows.length} M1 rows ${FROM_ISO} -> ${TO_ISO}`);
  if (bars.length === 0) throw new Error('no rows');

  // Reopen = first bar of Sunday 2026-08-30 (Saturday has none — market closed).
  const sundayStart = Date.parse('2026-08-30T00:00:00Z');
  const reopenIdx = bars.findIndex(b => b.timestamp >= sundayStart);
  if (reopenIdx < 0) throw new Error('no Sunday reopen bar found');
  const reopen = bars[reopenIdx].timestamp;
  const end = Date.parse('2026-08-31T06:00:00Z');
  console.log(`reopen (first post-reopen bar): ${new Date(reopen).toISOString()}`);
  console.log(`gap check: last pre-gap bar ${new Date(bars[reopenIdx - 1].timestamp).toISOString()}`);
  console.log('');

  const simulate = (label: string, lookbackMs: number): { attempts: number; standAsides: number; firstReady: number | null } => {
    let attempts = 0;
    let standAsides = 0;
    let firstReady: number | null = null;
    for (let t = reopen; t <= end; t += ATTEMPT_STEP_MS) {
      attempts += 1;
      const lo = firstIndexAtOrAfter(bars, t - lookbackMs);
      const hi = firstIndexAtOrAfter(bars, t + 1); // bars strictly <= t
      const windowReady = hi > lo && directionalReady(bars.slice(lo, hi), t);
      if (windowReady) {
        if (firstReady === null) firstReady = t;
      } else {
        standAsides += 1;
      }
    }
    const rate = attempts > 0 ? (standAsides / attempts) * 100 : 0;
    const blindMin = firstReady === null ? 'never ready in window' : ((firstReady - reopen) / 60000).toFixed(0);
    console.log(
      `${label}: attempts=${attempts} standAsides=${standAsides} rate=${rate.toFixed(1)}% ` +
      `blind=${blindMin} min after reopen (first ready ${firstReady === null ? '-' : new Date(firstReady).toISOString()})`,
    );
    return { attempts, standAsides, firstReady };
  };

  console.log('--- stand-aside rate, same real tape, same 30s attempt cadence ---');
  const before = simulate('BEFORE (52h window, pre-fix) ', OLD_LOOKBACK_MS);
  const after = simulate('AFTER  (72h window, fixed)  ', NEW_LOOKBACK_MS);
  console.log('');
  const pct = (v: number, d: number) => (d > 0 ? ((v / d) * 100).toFixed(1) : 'n/a');
  console.log(`stand-aside rate: ${pct(before.standAsides, before.attempts)}% -> ${pct(after.standAsides, after.attempts)}%`);
  console.log(
    `blind period: ${
      before.firstReady === null ? 'never' : `${((before.firstReady - reopen) / 60000).toFixed(0)} min`
    } -> ${after.firstReady === null ? 'never' : `${((after.firstReady - reopen) / 60000).toFixed(0)} min`} after reopen`,
  );
  const recovered = before.standAsides - after.standAsides;
  console.log(`stand-asides recovered per weekend reopen: ${recovered} of ${before.attempts} attempts`);
}

main().catch(err => {
  console.error('MEASUREMENT FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
