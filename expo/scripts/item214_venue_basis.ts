/**
 * PHASE C / C1 — ITEM 214 RE-OPENED: VENUE BASIS AS A FRACTION OF TP1.
 *
 * Item 214 was withdrawn because the venue-basis claim was quoted, not measured.
 * The earlier "external-validity caveat" grading was made when TP1 was 49 pips;
 * Item 121 shipped TP1 at 25 pips ($2.50), so the previously quoted $1.00-1.30
 * basis would be 40-52% of the entire first target. This measures it.
 *
 * CONSTRUCT: the entry stamp on every emitted signal comes from the app's price
 * feed (Capital.com / Swissquote); gold_m1_bars is the Vantage MT5 feed. For
 * each signal, take the M1 bar covering the emission minute and compute
 *   basisClose = entry − bar.close        (signed, $)
 *   basisPctTp1 = |basisClose| / |tp1 − entry| × 100
 * plus whether the entry sits INSIDE the covering bar's [low, high] range
 * (venues agreeing within that minute's movement).
 *
 * POWER (stated BEFORE the result): LIVE n≈36 (all post-snapshot), BACKFILL
 * n≈299 subject to bar coverage. A distribution is reported, not a hypothesis
 * test — the question is the MEDIAN |basis| as % of TP1 against the
 * pre-registered 20% structural threshold.
 *
 * PRE-REGISTERED VERDICT (decided before running): if median |basis| > 20% of
 * TP1 distance on the LIVE population, the fix is STRUCTURAL — rebuild the zone
 * map on the entry venue or stamp entries from Vantage. Below 20%: venue basis
 * is a real cost but not a first-order geometry error; record and move on.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  tp1: number;
  sl: number;
  source: string;
}

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

const env = loadEnv();
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('PHASE C / C1 — ITEM 214: VENUE BASIS vs TP1 — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const signals: SignalRow[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, tp1, sl, source').or("closed_market_emission.is.null,closed_market_emission.eq.false")
      .order('emitted_at', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    signals.push(...(data as SignalRow[]));
    if (data.length < page) break;
    from += page;
  }
  console.log(`emitted signals: ${signals.length}`);

  // Load ALL bars (paginated; ~55k rows for the book's span).
  const bars: Bar[] = [];
  from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .order('timestamp', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Record<string, unknown>[]) {
      bars.push({ timestamp: new Date(String(r.timestamp)).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (data.length < page) break;
    from += page;
  }
  console.log(`gold_m1_bars loaded: ${bars.length} (${new Date(bars[0]?.timestamp ?? 0).toISOString()} → ${new Date(bars[bars.length - 1]?.timestamp ?? 0).toISOString()})`);

  // ── POWER BEFORE RESULT ──
  const liveN = signals.filter(s => s.source === 'LIVE').length;
  const backN = signals.filter(s => s.source === 'BACKFILL').length;
  console.log(`\n── POWER (before result) ──`);
  console.log(`LIVE n=${liveN}, BACKFILL n=${backN} (bar coverage applied below).`);
  console.log(`Statistic: median |basis| as % of TP1 distance vs the pre-registered 20% threshold.`);
  console.log(`A systematic (signed) bias is separately reported; the threshold test is on |basis|.`);

  const barByMinute = new Map<number, Bar>();
  for (const b of bars) barByMinute.set(b.timestamp, b);

  interface Sample {
    id: string;
    source: string;
    ts: string;
    barTs: number;
    lagSec: number;
    basisClose: number;
    inRange: boolean;
    tp1Dist: number;
    slDist: number;
    pctTp1: number;
  }
  const samples: Sample[] = [];
  let unmatched = 0;

  for (const s of signals) {
    const ts = new Date(s.emitted_at).getTime();
    // Covering bar = the minute containing the emission; fall back to the
    // nearest bar within 10 minutes (weekend edges, feed gaps).
    let barTs = Math.floor(ts / 60_000) * 60_000;
    let bar = barByMinute.get(barTs);
    let lagSec = (ts - barTs) / 1000;
    if (!bar) {
      let found: Bar | undefined;
      let foundTs = 0;
      for (let d = 1; d <= 10; d++) {
        const t1 = barTs - d * 60_000;
        if (barByMinute.has(t1)) { found = barByMinute.get(t1); foundTs = t1; break; }
        const t2 = barTs + d * 60_000;
        if (barByMinute.has(t2)) { found = barByMinute.get(t2); foundTs = t2; break; }
      }
      if (!found) { unmatched++; continue; }
      bar = found;
      barTs = foundTs;
      lagSec = (ts - barTs) / 1000;
    }
    const entry = Number(s.entry);
    const tp1Dist = Math.abs(Number(s.tp1) - entry);
    const slDist = Math.abs(Number(s.sl) - entry);
    const basisClose = entry - bar.close;
    samples.push({
      id: s.signal_id,
      source: s.source,
      ts: s.emitted_at,
      barTs,
      lagSec,
      basisClose,
      inRange: entry >= bar.low - 1e-9 && entry <= bar.high + 1e-9,
      tp1Dist,
      slDist,
      pctTp1: tp1Dist > 0 ? (Math.abs(basisClose) / tp1Dist) * 100 : NaN,
    });
  }
  console.log(`matched: ${samples.length}/${signals.length} (unmatched ${unmatched}: no bar within ±10 min)`);

  const report = (name: string, pop: Sample[]): void => {
    if (pop.length === 0) { console.log(`\n${name}: n=0`); return; }
    const absBasis = pop.map(s => Math.abs(s.basisClose));
    const signed = pop.map(s => s.basisClose);
    const pcts = pop.map(s => s.pctTp1).filter(v => Number.isFinite(v));
    const tp1Dists = pop.map(s => s.tp1Dist);
    const inRange = pop.filter(s => s.inRange).length;
    console.log(`\n${name}: n=${pop.length}`);
    console.log(`  covering-bar match: exact-minute lag mean=${ (pop.reduce((a, s) => a + s.lagSec, 0) / pop.length).toFixed(1)}s; entry inside bar [low,high]: ${inRange}/${pop.length} (${((inRange / pop.length) * 100).toFixed(1)}%)`);
    console.log(`  TP1 distance ($): median=${median(tp1Dists).toFixed(2)} p10=${quantile(tp1Dists, 0.1).toFixed(2)} p90=${quantile(tp1Dists, 0.9).toFixed(2)}`);
    console.log(`  signed basis ($): mean=${(signed.reduce((a, b) => a + b, 0) / signed.length).toFixed(3)} median=${median(signed).toFixed(3)} (positive = app feed ABOVE Vantage close)`);
    console.log(`  |basis| ($): median=${median(absBasis).toFixed(3)} p90=${quantile(absBasis, 0.9).toFixed(3)} max=${Math.max(...absBasis).toFixed(3)}`);
    if (pcts.length > 0) {
      console.log(`  |basis| as % of TP1: median=${median(pcts).toFixed(1)}% p90=${quantile(pcts, 0.9).toFixed(1)}% max=${Math.max(...pcts).toFixed(1)}%`);
      const medPct = median(pcts);
      console.log(`  PRE-REGISTERED THRESHOLD (median > 20% of TP1): ${medPct > 20 ? '❌ EXCEEDED — STRUCTURAL FIX REQUIRED' : '✅ not exceeded'}`);
    }
  };

  report('LIVE (all)', samples.filter(s => s.source === 'LIVE'));
  report('BACKFILL (all)', samples.filter(s => s.source === 'BACKFILL'));
  // The shipped ladder (25/50/80 pips, Item 121) vs any older persisted ladder
  // (49/74/98): TP1 distance differs, so report the LIVE population split at
  // TP1 distance $3.00 (≈ 30 pips, separates the two ladders).
  const live = samples.filter(s => s.source === 'LIVE');
  report('LIVE · TP1 dist <= $3.00 (new 25-pip ladder era)', live.filter(s => s.tp1Dist <= 3.0));
  report('LIVE · TP1 dist >  $3.00 (older ladder era)', live.filter(s => s.tp1Dist > 3.0));

  // Extreme offenders listed for auditability
  console.log('\n── 10 largest LIVE |basis| as % of TP1 ──');
  const worst = [...live].filter(s => Number.isFinite(s.pctTp1)).sort((a, b) => b.pctTp1 - a.pctTp1).slice(0, 10);
  for (const s of worst) {
    console.log(`  ${s.ts} ${s.id} basis=${s.basisClose >= 0 ? '+' : ''}${s.basisClose.toFixed(2)}$ tp1Dist=${s.tp1Dist.toFixed(2)}$ pct=${s.pctTp1.toFixed(1)}% inBarRange=${s.inRange}`);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
