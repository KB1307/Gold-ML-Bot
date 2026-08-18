/**
 * ITEM 116 + 118 MEASUREMENT.
 *
 * 116(b): Re-measure the OB filter against the WIRED implementation —
 *         computeMarketStructure() over BARS with mitigation tracking, using the
 *         EXACT parameters the live filter now uses (OB_PROXIMITY_ATR=3,
 *         OB_FILTER_MIN_BARS=21, no top-10-by-strength truncation, mitigation
 *         honoured). Confirms the effect survives on the construct that runs.
 *         Also measures the OLD tick-shaped construct (4h window, top-10 by
 *         strength, NO mitigation) for a like-for-like comparison, so we can say
 *         whether the two constructs even agree on which signals to reject.
 *
 * 118: Re-derive DEDUP_TIME_WINDOW_MS from the gap distribution of GENUINE
 *      DUPLICATE CLUSTERS, not from all same-direction pairs. Then measure
 *      emission impact of 1390 min vs the re-derived value vs cluster-guard-only.
 *
 * DATA-SOURCE RULE: all reads Supabase DIRECT via anon key.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeRNet, costInR } from '../lib/evCompute';
import { computeMarketStructure, findNearbyUnmitigatedOBs } from '../services/marketStructure';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

const PIP_VALUE = 0.1;

/** Live constants under test — mirrored from signalEngine.ts. */
const OB_PROXIMITY_ATR = 3;
const OB_FILTER_MIN_BARS = 21;
const DEDUP_CLUSTER_BAND_ATR = 1.5;
const LIVE_DEDUP_TIME_WINDOW_MIN = 1390;

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return env;
};

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  const dir = String(row.direction) === 'SELL' ? 'SELL' : 'BUY';
  const entry = Number(row.entry);
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: dir,
    entryPrice: entry,
    entryPriceWithSlippage: entry,
    tp1: Number(row.tp1 ?? 0), tp2: Number(row.tp2 ?? 0), tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1),
    atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'), rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''), hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null, attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'), ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false, breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBars(client: ReturnType<typeof createClient>): Promise<{ bars: Bar[]; toMs: number }> {
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const fromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const toMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return { bars: out, toMs };
}

interface Row {
  id: string;
  dir: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  risk: number;
  rNet: number;
  isWin: boolean;
  status: string;
  sigTs: number;
  atr: number;
  /** WIRED construct: bar-derived, mitigation honoured, no truncation. */
  obWired: boolean;
  obWiredAbstain: boolean;
  obWiredTotal: number;
  obWiredUnmitigated: number;
  /** OLD construct: tick-shaped proxy — 4h window, top-10 by strength, NO mitigation. */
  obOld: boolean;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}

function twoPropZ(x1: number, n1: number, x2: number, n2: number): { z: number; p: number } {
  if (n1 === 0 || n2 === 0) return { z: 0, p: 1 };
  const p1 = x1 / n1, p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { z, p };
}

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - prob : prob;
}

function stats(rows: Row[]): { n: number; wr: number; ev: number; pf: number } {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: 0, ev: 0, pf: 0 };
  const wins = rows.filter(r => r.isWin).length;
  const ev = rows.reduce((s, r) => s + r.rNet, 0) / n;
  const gp = rows.filter(r => r.rNet > 0).reduce((s, r) => s + r.rNet, 0);
  const gl = Math.abs(rows.filter(r => r.rNet < 0).reduce((s, r) => s + r.rNet, 0));
  return { n, wr: (wins / n) * 100, ev, pf: gl > 0 ? gp / gl : 0 };
}

async function main(): Promise<void> {
  const line = '='.repeat(92);
  console.log(`\n${line}`);
  console.log('ITEM 116 + 118 MEASUREMENT');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log('  Fetching emitted_signals_v1 (anon, DIRECT)...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`  ${allSignals.length} signals`);

  console.log('  Fetching gold_m1_bars (anon, DIRECT)...');
  const { bars: allBars, toMs: barsToMs } = await fetchAllBars(client);
  console.log(`  ${allBars.length} bars, tape end ${new Date(barsToMs).toISOString()}`);

  const rows: Row[] = [];
  let skippedNoAtr = 0;
  let skippedUnresolved = 0;

  for (const raw of allSignals) {
    const sig = toTradingSignal(raw);
    const atr = Number(raw.atr ?? 0);
    if (!Number.isFinite(atr) || atr <= 0) { skippedNoAtr += 1; continue; }
    const sigTs = sig.createdAt as number;

    let res: ReturnType<typeof resolveSignalWithBars> | null = null;
    try { res = resolveSignalWithBars(sig, allBars, { fromScratch: true, evalNowMs: barsToMs }); } catch { res = null; }
    if (!res || !res.newStatus || res.newStatus === 'ACTIVE') { skippedUnresolved += 1; continue; }

    const risk = Math.abs(sig.entryPrice - sig.sl) / PIP_VALUE;
    if (risk <= 0) { skippedNoAtr += 1; continue; }
    const rNet = computeRNet(sig.type as 'BUY' | 'SELL', sig.entryPrice, res.exitPrice ?? sig.entryPrice, risk);
    const isWin = rNet > 0;

    // --- WIRED construct: bars BEFORE the signal, mitigation honoured, no truncation.
    // Mirrors buildStructureBars() + hasNearbyUnmitigatedOB() exactly.
    const priorBars = allBars.filter(b => b.timestamp <= sigTs);
    const structBars = priorBars.slice(-1440); // 24h of m1 bars — the measured window
    let obWired = false;
    let obWiredAbstain = false;
    let obWiredTotal = 0;
    let obWiredUnmitigated = 0;
    if (structBars.length < OB_FILTER_MIN_BARS) {
      obWiredAbstain = true;
      obWired = true; // filter abstains → passes
    } else {
      const structure = computeMarketStructure(structBars, 5);
      obWiredTotal = structure.orderBlocks.length;
      obWiredUnmitigated = structure.orderBlocks.filter(o => !o.mitigated).length;
      const nearby = findNearbyUnmitigatedOBs(structure, sig.entryPrice, atr, OB_PROXIMITY_ATR);
      obWired = nearby.length > 0;
    }

    // --- OLD construct: tick-shaped proxy. 4h window, top-10 BY STRENGTH, NO mitigation.
    // Reproduces detectOrderBlocks()'s shape on bar data so the two constructs are
    // comparable on the same population.
    const fourHoursAgo = sigTs - 4 * 60 * 60 * 1000;
    let obOld = false;
    if (structBars.length >= OB_FILTER_MIN_BARS) {
      const structureOld = computeMarketStructure(structBars, 5);
      const recentAll = structureOld.orderBlocks
        .filter(o => o.endTime > fourHoursAgo)
        .map(o => ({ ...o, strength: Math.abs(o.high - o.low) }))
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 10);
      obOld = recentAll.some(o => {
        const dist = Math.min(Math.abs(o.high - sig.entryPrice), Math.abs(o.low - sig.entryPrice));
        return dist <= atr * OB_PROXIMITY_ATR;
      });
    } else {
      obOld = true;
    }

    rows.push({
      id: sig.id, dir: sig.type as 'BUY' | 'SELL', entry: sig.entryPrice, sl: sig.sl,
      risk, rNet, isWin, status: String(res.newStatus), sigTs, atr,
      obWired, obWiredAbstain, obWiredTotal, obWiredUnmitigated, obOld,
    });
  }

  console.log(`\n  POWER: n=${rows.length} resolved (skipped: no-ATR ${skippedNoAtr}, unresolved ${skippedUnresolved})`);
  console.log(`  Execution cost: ${costInR(5.85).toFixed(4)}R at avg risk $5.85`);

  // ==================================================================
  // ITEM 116(b) — RE-MEASURE ON THE WIRED CONSTRUCT
  // ==================================================================
  console.log(`\n${line}`);
  console.log('ITEM 116(b) — OB FILTER RE-MEASURED ON THE WIRED CONSTRUCT');
  console.log(line);
  console.log('FUNCTION : marketStructure.computeMarketStructure() + findNearbyUnmitigatedOBs()');
  console.log('DATA SRC : gold_m1_bars (BARS), 24h window, mitigation honoured, NO truncation');
  console.log(`PARAMS   : OB_PROXIMITY_ATR=${OB_PROXIMITY_ATR}, OB_FILTER_MIN_BARS=${OB_FILTER_MIN_BARS}`);
  console.log('');

  const abstained = rows.filter(r => r.obWiredAbstain);
  const wiredPresent = rows.filter(r => r.obWired && !r.obWiredAbstain);
  const wiredAbsent = rows.filter(r => !r.obWired && !r.obWiredAbstain);

  console.log(`  Abstained (bars < ${OB_FILTER_MIN_BARS}): n=${abstained.length}`);
  const sWP = stats(wiredPresent);
  const sWA = stats(wiredAbsent);
  console.log('');
  console.log('  ARM (WIRED / BARS + MITIGATION)         n      WR       EV_net      PF');
  console.log('  ' + '-'.repeat(70));
  console.log(`  OB-present (KEEP)                    ${String(sWP.n).padStart(4)}   ${sWP.wr.toFixed(2)}%   ${sWP.ev >= 0 ? '+' : ''}${sWP.ev.toFixed(4)}R   ${sWP.pf.toFixed(3)}`);
  console.log(`  OB-absent  (REJECT)                  ${String(sWA.n).padStart(4)}   ${sWA.wr.toFixed(2)}%   ${sWA.ev >= 0 ? '+' : ''}${sWA.ev.toFixed(4)}R   ${sWA.pf.toFixed(3)}`);

  const zW = twoPropZ(wiredPresent.filter(r => r.isWin).length, sWP.n, wiredAbsent.filter(r => r.isWin).length, sWA.n);
  console.log('');
  console.log(`  Two-proportion z-test: z=${zW.z.toFixed(3)}, p=${zW.p.toFixed(4)}`);
  console.log(`  OB-absent arm power: n=${sWA.n} ${sWA.n >= 30 ? '(>= 30, ADEQUATE)' : '(< 30, UNDERPOWERED)'}`);

  const sFullNoFilter = stats(rows);
  const sFullWithFilter = stats(rows.filter(r => r.obWired));
  console.log('');
  console.log(`  Full book WITHOUT filter : n=${sFullNoFilter.n} WR=${sFullNoFilter.wr.toFixed(2)}% EV=${sFullNoFilter.ev >= 0 ? '+' : ''}${sFullNoFilter.ev.toFixed(4)}R PF=${sFullNoFilter.pf.toFixed(3)}`);
  console.log(`  Full book WITH    filter : n=${sFullWithFilter.n} WR=${sFullWithFilter.wr.toFixed(2)}% EV=${sFullWithFilter.ev >= 0 ? '+' : ''}${sFullWithFilter.ev.toFixed(4)}R PF=${sFullWithFilter.pf.toFixed(3)}`);
  console.log(`  Filter effect            : dEV=${(sFullWithFilter.ev - sFullNoFilter.ev) >= 0 ? '+' : ''}${(sFullWithFilter.ev - sFullNoFilter.ev).toFixed(4)}R  dPF=${(sFullWithFilter.pf - sFullNoFilter.pf) >= 0 ? '+' : ''}${(sFullWithFilter.pf - sFullNoFilter.pf).toFixed(3)}`);
  console.log(`  Emission cost            : rejects ${sFullNoFilter.n - sFullWithFilter.n}/${sFullNoFilter.n} = ${(((sFullNoFilter.n - sFullWithFilter.n) / Math.max(sFullNoFilter.n, 1)) * 100).toFixed(1)}%`);

  const gateW = zW.p < 0.05 && sWA.n >= 30 && sWA.ev < sWP.ev;
  console.log('');
  console.log(`  GATE (p<0.05 AND n>=30 AND absent worse): ${gateW ? 'PASS — effect SURVIVES on the wired construct' : 'FAIL — effect does NOT survive'}`);

  // --- Construct agreement: do old and new even reject the same signals?
  console.log(`\n${line}`);
  console.log('ITEM 116(a) COROLLARY — DO THE TWO CONSTRUCTS AGREE?');
  console.log(line);
  const oldAbsent = rows.filter(r => !r.obOld);
  const bothAbsent = rows.filter(r => !r.obOld && !r.obWired);
  const onlyOld = rows.filter(r => !r.obOld && r.obWired);
  const onlyWired = rows.filter(r => r.obOld && !r.obWired);
  console.log(`  OLD construct (ticks-shaped: 4h, top-10, NO mitigation) rejects : n=${oldAbsent.length}`);
  console.log(`  WIRED construct (bars, 24h, mitigation, no truncation) rejects  : n=${wiredAbsent.length}`);
  console.log(`  BOTH reject (agreement)                                        : n=${bothAbsent.length}`);
  console.log(`  ONLY OLD rejects (wired would have PASSED)                     : n=${onlyOld.length}`);
  console.log(`  ONLY WIRED rejects (old would have PASSED)                     : n=${onlyWired.length}`);
  const union = oldAbsent.length + onlyWired.length;
  const agreement = union > 0 ? (bothAbsent.length / union) * 100 : 100;
  console.log(`  Jaccard agreement on the reject set                            : ${agreement.toFixed(1)}%`);
  const sOldAbsent = stats(oldAbsent);
  console.log(`  OLD-reject arm EV : n=${sOldAbsent.n} WR=${sOldAbsent.wr.toFixed(2)}% EV=${sOldAbsent.ev >= 0 ? '+' : ''}${sOldAbsent.ev.toFixed(4)}R`);
  console.log(`  WIRED-reject arm EV: n=${sWA.n} WR=${sWA.wr.toFixed(2)}% EV=${sWA.ev >= 0 ? '+' : ''}${sWA.ev.toFixed(4)}R`);
  console.log('  => If agreement is low, the two constructs are NOT interchangeable and the');
  console.log('     Item 114 measurement genuinely did not authorise what shipped.');

  // ==================================================================
  // ITEM 118 — DEDUP FROM GENUINE DUPLICATE CLUSTERS
  // ==================================================================
  console.log(`\n${line}`);
  console.log('ITEM 118 — DEDUP_TIME_WINDOW_MS RE-DERIVED FROM DUPLICATE CLUSTERS');
  console.log(line);
  console.log('118(a) CLUSTER DEFINITION (explicit):');
  console.log('  A GENUINE DUPLICATE CLUSTER is a maximal set of >= 2 signals where every');
  console.log('  member shares ALL THREE of:');
  console.log(`    (1) SAME DIRECTION           — identical BUY/SELL`);
  console.log(`    (2) SAME ZONE CLUSTER        — entries within DEDUP_CLUSTER_BAND_ATR=${DEDUP_CLUSTER_BAND_ATR} ATR`);
  console.log('    (3) OVERLAPPING LADDER       — [min(entry,tp3), max(entry,tp3)] intervals intersect');
  console.log('  Members are chained transitively in emission order (single-linkage).');
  console.log('  This is what the dedup guard EXISTS to suppress. All same-direction pairs');
  console.log('  (the n=3813 population used in Item 113b) is the WRONG denominator: most');
  console.log('  such pairs are legitimately distinct setups hours apart at different levels.');
  console.log('');

  // Build clusters (single-linkage chain in emission order)
  const sorted = [...rows].sort((a, b) => a.sigTs - b.sigTs);
  const sigLadder = new Map<string, { lo: number; hi: number }>();
  for (const raw of allSignals) {
    const id = String(raw.signal_id ?? '');
    const e = Number(raw.entry);
    const t3 = Number(raw.tp3 ?? e);
    if (!Number.isFinite(e)) continue;
    sigLadder.set(id, { lo: Math.min(e, t3), hi: Math.max(e, t3) });
  }

  const clusterOf = new Map<string, number>();
  let nextCluster = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (!a) continue;
    if (clusterOf.has(a.id)) continue;
    const cid = nextCluster++;
    clusterOf.set(a.id, cid);
    // chain forward
    let frontier = [a];
    while (frontier.length > 0) {
      const next: Row[] = [];
      for (const f of frontier) {
        const fl = sigLadder.get(f.id);
        for (let j = 0; j < sorted.length; j++) {
          const b = sorted[j];
          if (!b || clusterOf.has(b.id)) continue;
          if (b.dir !== f.dir) continue;
          const band = Math.max(f.atr, b.atr, 0.01) * DEDUP_CLUSTER_BAND_ATR;
          if (Math.abs(b.entry - f.entry) > band) continue;
          const bl = sigLadder.get(b.id);
          if (fl && bl) {
            const overlaps = fl.lo <= bl.hi && bl.lo <= fl.hi;
            if (!overlaps) continue;
          }
          clusterOf.set(b.id, cid);
          next.push(b);
        }
      }
      frontier = next;
    }
  }

  const clusters = new Map<number, Row[]>();
  for (const r of sorted) {
    const cid = clusterOf.get(r.id);
    if (cid === undefined) continue;
    const list = clusters.get(cid) ?? [];
    list.push(r);
    clusters.set(cid, list);
  }
  const multi = [...clusters.values()].filter(c => c.length >= 2);
  const singletons = [...clusters.values()].filter(c => c.length === 1);

  console.log(`  Total clusters           : ${clusters.size}`);
  console.log(`  DUPLICATE clusters (>=2) : ${multi.length}`);
  console.log(`  Singletons (no duplicate): ${singletons.length}`);
  console.log(`  Signals inside duplicate clusters: ${multi.reduce((s, c) => s + c.length, 0)}/${sorted.length}`);
  console.log(`  Largest cluster size     : ${multi.reduce((m, c) => Math.max(m, c.length), 0)}`);

  // Internal CONSECUTIVE gaps within duplicate clusters
  const internalGapsMin: number[] = [];
  const clusterSpansMin: number[] = [];
  for (const c of multi) {
    const cs = [...c].sort((a, b) => a.sigTs - b.sigTs);
    for (let i = 1; i < cs.length; i++) {
      const prev = cs[i - 1], cur = cs[i];
      if (!prev || !cur) continue;
      internalGapsMin.push((cur.sigTs - prev.sigTs) / 60000);
    }
    const first = cs[0], last = cs[cs.length - 1];
    if (first && last) clusterSpansMin.push((last.sigTs - first.sigTs) / 60000);
  }
  internalGapsMin.sort((a, b) => a - b);
  clusterSpansMin.sort((a, b) => a - b);

  console.log('');
  console.log(`118(a) CLUSTER-INTERNAL CONSECUTIVE GAP DISTRIBUTION (n=${internalGapsMin.length} gaps):`);
  if (internalGapsMin.length > 0) {
    for (const q of [0.25, 0.5, 0.75, 0.9, 0.95, 0.99]) {
      console.log(`    p${String(q * 100).padStart(2)} = ${quantile(internalGapsMin, q).toFixed(1)} min`);
    }
    console.log(`    max = ${(internalGapsMin[internalGapsMin.length - 1] ?? 0).toFixed(1)} min`);
    console.log(`    mean= ${(internalGapsMin.reduce((s, v) => s + v, 0) / internalGapsMin.length).toFixed(1)} min`);
  } else {
    console.log('    NO INTERNAL GAPS — no duplicate clusters found under this definition.');
  }
  console.log('');
  console.log(`  CLUSTER SPAN distribution (n=${clusterSpansMin.length} clusters):`);
  if (clusterSpansMin.length > 0) {
    for (const q of [0.5, 0.95]) console.log(`    p${String(q * 100).padStart(2)} span = ${quantile(clusterSpansMin, q).toFixed(1)} min`);
    console.log(`    max span = ${(clusterSpansMin[clusterSpansMin.length - 1] ?? 0).toFixed(1)} min`);
  }

  // 118(b) re-derivation
  const p95Internal = internalGapsMin.length > 0 ? quantile(internalGapsMin, 0.95) : 0;
  const p99Internal = internalGapsMin.length > 0 ? quantile(internalGapsMin, 0.99) : 0;
  const derived = Math.ceil(p95Internal / 5) * 5;
  console.log('');
  console.log('118(b) RE-DERIVATION:');
  console.log(`  p95 of cluster-INTERNAL gaps = ${p95Internal.toFixed(1)} min  (p99 = ${p99Internal.toFixed(1)} min)`);
  console.log(`  => DEDUP_TIME_WINDOW_MS = ${derived} min (p95 rounded up to 5-min granularity)`);
  console.log(`  Rationale: the window's job is to catch DUPLICATES. p95 of the gaps that`);
  console.log(`  actually occur INSIDE duplicate clusters covers 95% of real duplicate`);
  console.log(`  re-emissions. The prior ${LIVE_DEDUP_TIME_WINDOW_MIN} min came from p95 of ALL same-direction`);
  console.log(`  pairs, which suppresses 95% of LEGITIMATE distinct setups too.`);

  // 118(c) emission impact
  console.log('');
  console.log('118(c) EMISSION IMPACT — three configurations:');
  const simulateDedup = (windowMin: number, useClusterGuard: boolean): number => {
    const emitted: Row[] = [];
    for (const r of sorted) {
      let blocked = false;
      for (const e of emitted) {
        if (e.dir !== r.dir) continue;
        const band = Math.max(e.atr, r.atr, 0.01);
        if (useClusterGuard) {
          // PRIMARY: same zone cluster, regardless of elapsed time
          if (Math.abs(r.entry - e.entry) <= band * DEDUP_CLUSTER_BAND_ATR) { blocked = true; break; }
        }
        if (windowMin > 0) {
          const gapMin = (r.sigTs - e.sigTs) / 60000;
          if (gapMin <= windowMin && Math.abs(r.entry - e.entry) <= band * 4.0) { blocked = true; break; }
        }
      }
      if (!blocked) emitted.push(r);
    }
    return emitted.length;
  };

  const spanDays = sorted.length > 1
    ? ((sorted[sorted.length - 1]?.sigTs ?? 0) - (sorted[0]?.sigTs ?? 0)) / 86400000
    : 1;
  const rawPerDay = sorted.length / Math.max(spanDays, 1);

  const cfgs: { label: string; win: number; guard: boolean }[] = [
    { label: `LIVE time window (${LIVE_DEDUP_TIME_WINDOW_MIN} min) + cluster guard`, win: LIVE_DEDUP_TIME_WINDOW_MIN, guard: true },
    { label: `RE-DERIVED window (${derived} min) + cluster guard`, win: derived, guard: true },
    { label: 'CLUSTER GUARD ALONE (no time window)', win: 0, guard: true },
    { label: 'NEITHER (no dedup at all)', win: 0, guard: false },
  ];
  console.log(`  Book span: ${spanDays.toFixed(1)} days, ${sorted.length} resolved signals, raw ${rawPerDay.toFixed(2)}/day`);
  console.log('');
  console.log('  CONFIGURATION                                       survives   sig/day');
  console.log('  ' + '-'.repeat(72));
  for (const c of cfgs) {
    const surv = simulateDedup(c.win, c.guard);
    console.log(`  ${c.label.padEnd(50)} ${String(surv).padStart(6)}   ${(surv / Math.max(spanDays, 1)).toFixed(2)}`);
  }

  console.log(`\n${line}`);
  console.log('DONE');
  console.log(line);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
