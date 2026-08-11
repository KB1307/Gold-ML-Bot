/**
 * ITEM 38 — WIDEN-WINDOW IMPACT MEASUREMENT
 * =========================================
 *
 * MINDSET (restated verbatim):
 *  Senior Lead Quantitative Trading Engineer / Senior Institutional Gold
 *  (XAU/USD) Elite Portfolio Manager.
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECT from Supabase via anon key.
 * Rork backend = service-role WRITES only (not used here). READ-ONLY.
 *
 * WHAT THIS MEASURES:
 *  Item 35 established the audit's default resolutionWindowMs is 2h, while real
 *  TP/SL events occur out to 3h+. Before ANY fix, we must know:
 *   38a. How many status changes does each window width produce?
 *   38b. What EV/WR/PF results at each width?
 *   38c. How many bars are fetched per signal at each width (CPU/memory cost)?
 *   38d. Where does the correction curve FLATTEN (the point of diminishing
 *        returns that should set the new default)?
 *
 * PRE-REGISTERED GATES (set BEFORE seeing results, no post-hoc loosening):
 *   G1. "Flattening" = the first width W where widening to the NEXT width adds
 *       < 10% of the total corrections found at the widest width (24h).
 *   G2. A width is only recommended if its EV is stable (within 0.01R) versus
 *       the next wider width — i.e. we are not still discovering outcomes.
 *   G3. Bar-count cost is reported but is NOT a veto unless a width exceeds
 *       5000 bars/signal (a real memory concern on device).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

// ─── env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch {
      /* optional */
    }
  }
  return out;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  exit: number | null;
  id: string;
  generatedMs: number;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const exit = block.match(/exit price: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp[0],
    tp2: p.tp[1],
    tp3: p.tp[2],
    sl: p.sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 600; p++) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

/** R multiple from a resolver outcome, using the signal's own risk distance. */
function outcomeToR(sig: ParsedSignal, status: string, exitPrice: number): number | null {
  const risk = Math.abs(sig.entry - sig.sl);
  if (!(risk > 0)) return null;
  if (status === 'EXPIRED_MISSED_ENTRY' || status === 'NEVER_FILLABLE') return null;
  const raw = sig.direction === 'BUY' ? exitPrice - sig.entry : sig.entry - exitPrice;
  return raw / risk;
}

function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

function stdev(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

const WIN_STATUSES = new Set([
  'ALL_TARGETS_HIT',
  'TP3_HIT',
  'TP2_HIT',
  'TP1_HIT',
  'PARTIAL_WIN_SL_HIT',
  'SL_AFTER_BE',
]);

interface WidthResult {
  label: string;
  windowMs: number;
  resolved: number;
  ev: number;
  wr: number;
  pf: number;
  sd: number;
  totalBars: number;
  avgBarsPerSignal: number;
  maxBarsForOneSignal: number;
  statusCounts: Map<string, number>;
  /** signal index -> status at this width */
  statusByIdx: Map<number, string>;
  /** signal index -> R at this width */
  rByIdx: Map<number, number>;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 38 — WIDEN-WINDOW IMPACT MEASUREMENT (2h / 4h / 8h / 12h / 24h)');
  console.log('MINDSET 8 rules apply. READ-ONLY. No engine code touched. Nothing ships.');
  console.log('='.repeat(80));
  console.log('\nPRE-REGISTERED GATES (fixed before any result was seen):');
  console.log('  G1 FLATTEN: first width where the NEXT width adds <10% of total-24h corrections.');
  console.log('  G2 EV STABILITY: recommended width must have EV within 0.01R of the next wider width.');
  console.log('  G3 COST: bar count reported; only a veto if >5000 bars/signal.');

  // ── fetch export ──
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let gotExport = false;
  for (const path of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`\n  Export fetched: ${text.length} bytes`);
      gotExport = true;
      break;
    }
  }
  if (!gotExport) {
    console.log('\n  BLOCKER: export could not be fetched. STOP. Nothing measured.');
    return;
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Export signals parsed: ${signals.length}`);

  const widths: { label: string; ms: number }[] = [
    { label: '2h', ms: 2 * 3600_000 },
    { label: '4h', ms: 4 * 3600_000 },
    { label: '8h', ms: 8 * 3600_000 },
    { label: '12h', ms: 12 * 3600_000 },
    { label: '24h', ms: 24 * 3600_000 },
  ];

  // Fetch ONE superset of bars per signal (24h) then slice per width. This is
  // exactly what the audit would see at each width, without 5x the network.
  console.log('\n── Fetching 24h bar superset per signal (this is the slow part) ──');
  const barsBySignal = new Map<number, OhlcBar[]>();
  const maxWindow = 24 * 3600_000;
  let fetched = 0;
  for (const s of signals) {
    if (!Number.isFinite(s.generatedMs) || s.tp.length < 3 || !(s.sl > 0)) continue;
    const bars = await fetchBars(client, s.generatedMs, s.generatedMs + maxWindow);
    if (bars.length > 0) barsBySignal.set(s.index, bars);
    fetched++;
    if (fetched % 50 === 0) console.log(`   ...${fetched}/${signals.length} signals fetched`);
  }
  console.log(`  Signals with >=1 bar in 24h window: ${barsBySignal.size}`);

  // ── resolve at each width ──
  const results: WidthResult[] = [];
  for (const w of widths) {
    const statusCounts = new Map<string, number>();
    const statusByIdx = new Map<number, string>();
    const rByIdx = new Map<number, number>();
    const rs: number[] = [];
    let totalBars = 0;
    let maxBars = 0;

    for (const s of signals) {
      const superset = barsBySignal.get(s.index);
      if (!superset) continue;
      const cutoff = s.generatedMs + w.ms;
      const bars = superset.filter((b) => b.timestamp <= cutoff);
      if (bars.length === 0) continue;
      totalBars += bars.length;
      if (bars.length > maxBars) maxBars = bars.length;

      const sig = toTradingSignal(s);
      const outcome = resolveSignalWithBars(sig, bars, {
        fromScratch: true,
        evalNowMs: cutoff,
      });
      statusByIdx.set(s.index, outcome.newStatus);
      statusCounts.set(outcome.newStatus, (statusCounts.get(outcome.newStatus) ?? 0) + 1);
      const r = outcomeToR(s, outcome.newStatus, outcome.exitPrice);
      if (r !== null && Number.isFinite(r)) {
        rByIdx.set(s.index, r);
        rs.push(r);
      }
    }

    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r <= 0);
    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    const nSig = statusByIdx.size;

    results.push({
      label: w.label,
      windowMs: w.ms,
      resolved: rs.length,
      ev: mean(rs),
      wr: rs.length > 0 ? (wins.length / rs.length) * 100 : NaN,
      pf: grossLoss > 0 ? grossWin / grossLoss : NaN,
      sd: stdev(rs),
      totalBars,
      avgBarsPerSignal: nSig > 0 ? totalBars / nSig : NaN,
      maxBarsForOneSignal: maxBars,
      statusCounts,
      statusByIdx,
      rByIdx,
    });
  }

  // ── 38a/38b: results table ──
  console.log('\n' + '='.repeat(80));
  console.log('38a/38b — RESOLVED OUTCOMES AND PERFORMANCE AT EACH WINDOW WIDTH');
  console.log('='.repeat(80));
  console.log('  width  n_resolved       EV      WR       PF      SD');
  console.log('  ' + '─'.repeat(60));
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(6)} ${String(r.resolved).padStart(10)}  ${(r.ev >= 0 ? '+' : '') + r.ev.toFixed(4)}R  ${r.wr.toFixed(1)}%  ${r.pf.toFixed(3)}  ${r.sd.toFixed(4)}`,
    );
  }

  // ── 38c: bar cost ──
  console.log('\n' + '='.repeat(80));
  console.log('38c — BAR FETCH COST PER SIGNAL AT EACH WIDTH');
  console.log('='.repeat(80));
  console.log('  width   total_bars   avg_bars/signal   max_bars_one_signal');
  console.log('  ' + '─'.repeat(60));
  for (const r of results) {
    console.log(
      `  ${r.label.padEnd(6)} ${String(r.totalBars).padStart(11)}   ${r.avgBarsPerSignal.toFixed(1).padStart(15)}   ${String(r.maxBarsForOneSignal).padStart(19)}`,
    );
  }
  const widest = results[results.length - 1];
  console.log(`\n  G3 COST GATE (>5000 bars/signal = veto): max observed = ${widest.maxBarsForOneSignal} bars`);
  console.log(`  G3 verdict: ${widest.maxBarsForOneSignal > 5000 ? 'VETO — memory concern' : 'PASS — no width exceeds the cost ceiling'}`);

  // ── status changes vs 2h baseline ──
  const baseline = results[0];
  console.log('\n' + '='.repeat(80));
  console.log('38a — STATUS CHANGES VERSUS THE 2h BASELINE (what widening actually corrects)');
  console.log('='.repeat(80));
  console.log('  width   changed_vs_2h   newly_WIN   newly_LOSS   still_CLOSED');
  console.log('  ' + '─'.repeat(66));
  const changesByWidth = new Map<string, number>();
  for (const r of results) {
    let changed = 0;
    let newlyWin = 0;
    let newlyLoss = 0;
    let stillClosed = 0;
    for (const [idx, st] of r.statusByIdx) {
      const base = baseline.statusByIdx.get(idx);
      if (base === undefined) continue;
      if (st !== base) {
        changed++;
        const wasWin = WIN_STATUSES.has(base);
        const isWin = WIN_STATUSES.has(st);
        if (!wasWin && isWin) newlyWin++;
        if (wasWin && !isWin) newlyLoss++;
      }
      if (st === 'CLOSED') stillClosed++;
    }
    changesByWidth.set(r.label, changed);
    console.log(
      `  ${r.label.padEnd(6)} ${String(changed).padStart(13)}   ${String(newlyWin).padStart(9)}   ${String(newlyLoss).padStart(10)}   ${String(stillClosed).padStart(12)}`,
    );
  }

  // ── 38d: flattening analysis (G1) ──
  console.log('\n' + '='.repeat(80));
  console.log('38d — WHERE DOES THE CORRECTION CURVE FLATTEN? (Gate G1 + G2)');
  console.log('='.repeat(80));
  const totalAtWidest = changesByWidth.get(widest.label) ?? 0;
  console.log(`  Total corrections at widest (${widest.label}) vs 2h baseline: ${totalAtWidest}`);
  console.log('\n  width -> next   incremental_corrections   as_%_of_total_24h   EV_delta_to_next');
  console.log('  ' + '─'.repeat(78));
  let flattenWidth: string | null = null;
  for (let i = 0; i < results.length - 1; i++) {
    const cur = results[i];
    const nxt = results[i + 1];
    const inc = (changesByWidth.get(nxt.label) ?? 0) - (changesByWidth.get(cur.label) ?? 0);
    const pct = totalAtWidest > 0 ? (inc / totalAtWidest) * 100 : 0;
    const evDelta = nxt.ev - cur.ev;
    console.log(
      `  ${(cur.label + ' -> ' + nxt.label).padEnd(15)} ${String(inc).padStart(23)}   ${pct.toFixed(1).padStart(17)}%   ${(evDelta >= 0 ? '+' : '') + evDelta.toFixed(4)}R`,
    );
    if (flattenWidth === null && pct < 10) {
      flattenWidth = cur.label;
    }
  }
  console.log(`\n  G1 FLATTEN VERDICT: correction curve flattens at ${flattenWidth ?? 'NOT WITHIN TESTED RANGE (still climbing at 24h)'}`);
  if (flattenWidth !== null) {
    const fi = results.findIndex((r) => r.label === flattenWidth);
    if (fi >= 0 && fi < results.length - 1) {
      const evStable = Math.abs(results[fi + 1].ev - results[fi].ev) <= 0.01;
      console.log(
        `  G2 EV STABILITY at ${flattenWidth}: |EV(${results[fi + 1].label}) - EV(${flattenWidth})| = ${Math.abs(results[fi + 1].ev - results[fi].ev).toFixed(4)}R -> ${evStable ? 'PASS' : 'FAIL (still discovering outcomes)'}`,
      );
    }
  }

  // ── status distribution per width ──
  console.log('\n' + '='.repeat(80));
  console.log('STATUS DISTRIBUTION AT EACH WIDTH (full breakdown)');
  console.log('='.repeat(80));
  const allStatuses = new Set<string>();
  for (const r of results) for (const k of r.statusCounts.keys()) allStatuses.add(k);
  const statusList = [...allStatuses].sort();
  console.log('  status'.padEnd(24) + results.map((r) => r.label.padStart(7)).join(''));
  console.log('  ' + '─'.repeat(24 + results.length * 7));
  for (const st of statusList) {
    console.log(
      '  ' + st.padEnd(22) + results.map((r) => String(r.statusCounts.get(st) ?? 0).padStart(7)).join(''),
    );
  }

  // ── the specific Item 35 seven ──
  console.log('\n' + '='.repeat(80));
  console.log('CROSS-CHECK — the 7 Item-35 CLOSED signals: at which width does each correct?');
  console.log('='.repeat(80));
  const item35Idx = [15, 16, 18, 19, 22, 32, 232];
  console.log('  idx   ' + results.map((r) => r.label.padStart(20)).join(''));
  console.log('  ' + '─'.repeat(6 + results.length * 20));
  for (const idx of item35Idx) {
    const row = results.map((r) => (r.statusByIdx.get(idx) ?? 'no-bars').padStart(20)).join('');
    console.log(`  ${String(idx).padEnd(6)}${row}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 38 measurement complete. Nothing was written. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
