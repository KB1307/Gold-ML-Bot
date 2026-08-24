/**
 * CHECKPOINT A / A1 — THE CANONICAL BOOK. ONE INSTRUMENT.
 *
 * A PINNED fromScratch replay. Every parameter is fixed here, in this header;
 * changing any of them changes the instrument and requires a new name.
 *
 * PINNED PARAMETERS
 * ─────────────────
 *   Resolution window : 8h (MAX_RESOLUTION_WINDOW_MS, TradingContext.tsx:291;
 *                       authority: Item 41a's 2h -> 8h sweep).
 *   safeBarStart      : emitted_at + 60s (no bar that overlaps emission).
 *   Population        : emitted_signals_v1 joined to trade_outcomes_v1 on
 *                       signal_id, stored realized_r non-null, is_scratch not
 *                       true, all sources — PLUS (reported separately) every
 *                       emitted signal the replay itself decides.
 *   Replay            : the REAL resolveSignalWithBars (services/signalResolver)
 *                       with fromScratch: true — no stored status, target, or
 *                       breakeven flag is consulted. Labels come from bars only.
 *   Scratch rule      : rows with is_scratch = true are excluded from every
 *                       book. Rows the replay cannot decide (outcome === null:
 *                       EXPIRED_MISSED_ENTRY / NEVER_FILLABLE / still ACTIVE)
 *                       are excluded from the canonical book and counted.
 *   Win predicate     : canonical = resolver outcome === 'WIN' (equivalently
 *                       rNet > 0); stored = realized_r > 0.
 *   Cost model        : shared evCompute module — $0.20/trade, $1/price-unit;
 *                       NET = GROSS − costInR(|entry − sl|).
 *   Bars              : gold_m1_bars (Vantage feed) via Supabase anon key,
 *                       direct read. Nothing is written anywhere.
 *   CI                : 95% bootstrap over signal resampling, mulberry32 seed
 *                       20260824, 10,000 iterations — deterministic.
 *   Era boundary      : 2026-07-16T10:51:28.481Z (first stored sr_zones_snapshot,
 *                       same as item197_198_round.ts / item202_exit_structure.ts).
 *
 * A0 settles the gross/net question on STORED FIELDS ALONE (stored exit_price,
 * emitted entry/sl, stored realized_r) before any book is computed.
 *
 * DATA-SOURCE RULE: gold_m1_bars + trade_outcomes_v1 + emitted_signals_v1 reads
 * = Supabase DIRECT via anon key. READ-ONLY.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { computeRGross, computeRNet, costInR } from '../lib/evCompute';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  source: string;
}

interface OutcomeRow {
  signal_id: string;
  ts: string;
  result: string;
  entry_price: number;
  exit_price: number | null;
  pnl: number;
  realized_r: number | null;
  is_scratch: boolean | null;
}

// ── PINNED CONSTANTS (see header) ────────────────────────────────────────────
const WINDOW_MS = 8 * 60 * 60 * 1000;               // Item 41a authority
const SAFE_BAR_OFFSET_MS = 60_000;
const SNAPSHOT_ERA_START_MS = Date.parse('2026-07-16T10:51:28.481Z');
const BOOTSTRAP_SEED = 20260824;
const BOOTSTRAP_ITERS = 10_000;
const GROSS_NET_TOL_R = 0.01;                        // row-level classification tolerance

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

function toTradingSignal(row: SignalRow): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    createdAt: new Date(row.emitted_at).getTime(),
    type: row.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    sl: Number(row.sl),
    confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    breakevenReached: false,
    breakevenTime: undefined,
  } as unknown as TradingSignal;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: NaN, hi: NaN };
  const rnd = mulberry32(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let it = 0; it < BOOTSTRAP_ITERS; it++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(rnd() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(BOOTSTRAP_ITERS * 0.025)], hi: means[Math.floor(BOOTSTRAP_ITERS * 0.975)] };
}

interface BookStats {
  n: number; wr: number; evGross: number; evNet: number; pfNet: number; maxDDNet: number;
  ciNet: { lo: number; hi: number };
}

interface Entry { rNet: number; rGross: number; emittedMs: number }

function bookStats(entries: Entry[]): BookStats {
  const n = entries.length;
  if (n === 0) {
    return { n: 0, wr: 0, evGross: 0, evNet: 0, pfNet: 0, maxDDNet: 0, ciNet: { lo: NaN, hi: NaN } };
  }
  const wins = entries.filter(e => e.rNet > 0);
  const wr = (wins.length / n) * 100;
  const evGross = entries.reduce((s, e) => s + e.rGross, 0) / n;
  const evNet = entries.reduce((s, e) => s + e.rNet, 0) / n;
  const sumWin = wins.reduce((s, e) => s + e.rNet, 0);
  const sumLoss = entries.filter(e => e.rNet <= 0).reduce((s, e) => s + Math.abs(e.rNet), 0);
  const pfNet = sumLoss > 0 ? sumWin / sumLoss : Infinity;
  const chrono = [...entries].sort((a, b) => a.emittedMs - b.emittedMs);
  let cum = 0, peak = 0, maxDD = 0;
  for (const e of chrono) {
    cum += e.rNet;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return { n, wr, evGross, evNet, pfNet, maxDDNet: maxDD, ciNet: bootstrapCI(entries.map(e => e.rNet)) };
}

function fmtBook(label: string, b: BookStats): string {
  const sgn = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(4);
  const ci = Number.isFinite(b.ciNet.lo)
    ? `  95%CI_net=[${sgn(b.ciNet.lo)}, ${sgn(b.ciNet.hi)}]`
    : '';
  return `  ${label.padEnd(30)} n=${String(b.n).padStart(3)}  WR=${b.wr.toFixed(1)}%  EV_gross=${sgn(b.evGross)}R  EV_net=${sgn(b.evNet)}R  PF_net=${b.pfNet.toFixed(2)}  MaxDD_net=${b.maxDDNet.toFixed(2)}R${ci}`;
}

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function upperBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

async function fetchAll<T>(
  client: ReturnType<typeof createClient>,
  table: string,
  select: string,
  orderCol: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from(table).select(select).order(orderCol, { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const allSignalRows = await fetchAll<SignalRow>(client, 'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source', 'emitted_at');
  const outcomeRows = await fetchAll<OutcomeRow>(client, 'trade_outcomes_v1',
    'signal_id, ts, result, entry_price, exit_price, pnl, realized_r, is_scratch', 'ts');
  const outcomesBySignal = new Map<string, OutcomeRow>();
  for (const o of outcomeRows) outcomesBySignal.set(o.signal_id, o);

  const { data: barsEndRow } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(barsEndRow?.[0]?.timestamp)).getTime();
  const minSignalMs = Math.min(...allSignalRows.map(r => new Date(r.emitted_at).getTime()));

  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(minSignalMs - 60_000).toISOString())
      .lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars fetch failed: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }

  const runStartIso = new Date().toISOString();
  console.log(`\n${line}`);
  console.log('CHECKPOINT A — THE CANONICAL BOOK (pinned fromScratch replay) + GROSS/NET PROBE + STORED COMPARISON');
  console.log(line);
  console.log(`  run at                          : ${runStartIso}`);
  console.log(`  emitted_signals_v1 rows         : ${allSignalRows.length}`);
  const bySource: Record<string, number> = {};
  for (const r of allSignalRows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  console.log(`  by source                       : ${JSON.stringify(bySource)}`);
  console.log(`  trade_outcomes_v1 rows          : ${outcomeRows.length}`);
  console.log(`  gold_m1_bars window             : ${new Date(minSignalMs - 60_000).toISOString()} -> ${new Date(barsEndMs).toISOString()} (${allBars.length} bars)`);
  console.log(`  PINNED                          : 8h window (Item 41a), safeBarStart=emitted+60s, fromScratch, evCompute $0.20 cost, bootstrap seed ${BOOTSTRAP_SEED}`);
  console.log(`  era boundary                    : ${new Date(SNAPSHOT_ERA_START_MS).toISOString()}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // A0 — GROSS vs NET: stored realized_r vs arithmetic on STORED FIELDS ALONE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A0 — IS STORED realized_r GROSS OR NET? (row-level arithmetic on stored fields: emitted entry/sl + stored exit_price)');
  console.log(line);
  console.log(`  evCompute.ts:41 documents realized_r as NET; Item 202(c) measured GROSS on the 12 signals of 2026-08-21.`);
  console.log(`  The resolver Edge Function computes NET since commit 912242c (2026-08-17 21:30Z, "BLOCK A / E-1");`);
  console.log(`  before that commit both resolvers wrote GROSS (the D6 finding). Both eras therefore exist in the table.`);
  console.log(`  Test per row: g = R_gross(stored exit_price); n = g - costInR(risk); stored matches whichever |stored - x| <= ${GROSS_NET_TOL_R}R.`);

  const joinPopulation: { row: SignalRow; out: OutcomeRow }[] = [];
  for (const row of allSignalRows) {
    const o = outcomesBySignal.get(row.signal_id);
    if (!o) continue;
    if (o.realized_r === null || o.realized_r === undefined) continue;
    if (o.is_scratch === true) continue;
    joinPopulation.push({ row, out: o });
  }
  const joinRows = joinPopulation.length;
  const excludedNullR = outcomeRows.filter(o => o.realized_r === null || o.realized_r === undefined).length;
  const excludedScratch = outcomeRows.filter(o => o.realized_r !== null && o.realized_r !== undefined && o.is_scratch === true).length;
  const emittedIdSet = new Set(allSignalRows.map(r => r.signal_id));
  const excludedNoEmission = outcomeRows.filter(o => !emittedIdSet.has(o.signal_id)).length;
  const excludedNoOutcome = allSignalRows.length - outcomeRows.filter(o => emittedIdSet.has(o.signal_id)).length;
  console.log(`\n  join population (realized_r non-null, is_scratch not true): n=${joinRows}`);
  console.log(`  outcome-row disposition: total=${outcomeRows.length}  join=${joinRows}  realized_r=null excluded=${excludedNullR}  scratch excluded=${excludedScratch}  no-emission-row=${excludedNoEmission}`);
  console.log(`  emitted signals with NO outcome row at all: ${excludedNoOutcome}`);

  let grossMatches = 0, netMatches = 0, neither = 0, noExitPrice = 0;
  const grossExamples: string[] = [];
  const netExamples: string[] = [];
  const neitherExamples: string[] = [];
  const byWeekGross: Record<string, { gross: number; net: number; neither: number }> = {};
  const bySourceVerdict: Record<string, { gross: number; net: number; neither: number }> = {};
  const byTsFormat: Record<string, { gross: number; net: number; neither: number }> = {};
  for (const { row, out } of joinPopulation) {
    const storedR = Number(out.realized_r);
    const entry = Number(row.entry);
    const sl = Number(row.sl);
    const risk = Math.abs(entry - sl);
    const weekKey = out.ts.slice(0, 10);
    byWeekGross[weekKey] ??= { gross: 0, net: 0, neither: 0 };
    if (out.exit_price === null || out.exit_price === undefined || !Number.isFinite(Number(out.exit_price)) || risk <= 0) {
      noExitPrice += 1;
      continue;
    }
    // Writer attribution proxies:
    //   source      — LIVE rows are written by the app path (learningStore direct
    //                 upsert) racing the cron Edge Function; BACKFILL rows by scripts.
    //   ts format   — ms-precision ISO = wall-clock WRITE time (app path,
    //                 learningStore toRemoteRow uses outcome.timestamp); no-ms =
    //                 bar timestamp (Edge Function writes resolvedAtBarTs).
    const srcKey = row.source;
    bySourceVerdict[srcKey] ??= { gross: 0, net: 0, neither: 0 };
    const tsKey = /\.\d{3}/.test(out.ts) ? 'ms wall-clock (app-path write)' : 'bar-time (cron/backfill write)';
    byTsFormat[tsKey] ??= { gross: 0, net: 0, neither: 0 };

    const exit = Number(out.exit_price);
    const dir = row.direction === 'BUY' ? 'BUY' : 'SELL';
    const g = computeRGross(dir, entry, exit, risk);
    const n = g - costInR(risk);
    const dGross = Math.abs(storedR - g);
    const dNet = Math.abs(storedR - n);
    const ex = `  ${row.signal_id.slice(-12)}  ${dir}  entry=${entry} sl=${sl} risk=${risk.toFixed(1)} exit=${exit}  storedR=${storedR.toFixed(4)}  g=${g.toFixed(4)} (Δ${dGross.toFixed(4)})  n=${n.toFixed(4)} (Δ${dNet.toFixed(4)})  ts=${out.ts}`;
    if (dGross <= GROSS_NET_TOL_R && dGross <= dNet) {
      grossMatches += 1; byWeekGross[weekKey].gross += 1;
      bySourceVerdict[srcKey].gross += 1; byTsFormat[tsKey].gross += 1;
      if (grossExamples.length < 4) grossExamples.push(ex);
    } else if (dNet <= GROSS_NET_TOL_R) {
      netMatches += 1; byWeekGross[weekKey].net += 1;
      bySourceVerdict[srcKey].net += 1; byTsFormat[tsKey].net += 1;
      if (netExamples.length < 4) netExamples.push(ex);
    } else {
      neither += 1; byWeekGross[weekKey].neither += 1;
      bySourceVerdict[srcKey].neither += 1; byTsFormat[tsKey].neither += 1;
      if (neitherExamples.length < 4) neitherExamples.push(ex);
    }
  }
  console.log(`\n  VERDICT COUNTS over n=${joinPopulation.length} (tolerance ±${GROSS_NET_TOL_R}R):`);
  console.log(`    stored realized_r == GROSS arithmetic : ${grossMatches}`);
  console.log(`    stored realized_r == NET arithmetic   : ${netMatches}`);
  console.log(`    neither (|Δ| > tol on both)           : ${neither}`);
  console.log(`    skipped (null exit_price / zero risk) : ${noExitPrice}`);
  console.log(`\n  row-level examples — GROSS-matching rows:`);
  for (const e of grossExamples) console.log(e);
  console.log(`  row-level examples — NET-matching rows:`);
  for (const e of netExamples) console.log(e);
  if (neitherExamples.length > 0) {
    console.log(`  row-level examples — NEITHER (possible label defects, see A2 disagreement analysis):`);
    for (const e of neitherExamples) console.log(e);
  }
  console.log(`\n  transition by ts day (ts = exit-bar time for bar-writer rows; wall-clock WRITE time for app-path rows): gross / net / neither`);
  for (const day of Object.keys(byWeekGross).sort()) {
    const b = byWeekGross[day];
    console.log(`    ${day}: ${b.gross} / ${b.net} / ${b.neither}`);
  }
  console.log(`\n  verdict by SOURCE (writer attribution): gross / net / neither`);
  for (const src of Object.keys(bySourceVerdict).sort()) {
    const b = bySourceVerdict[src];
    console.log(`    ${src}: ${b.gross} / ${b.net} / ${b.neither}`);
  }
  console.log(`\n  verdict by ts FORMAT (ms-precision = app-path wall-clock write; no-ms = bar-time cron/backfill write): gross / net / neither`);
  for (const k of Object.keys(byTsFormat).sort()) {
    const b = byTsFormat[k];
    console.log(`    ${k}: ${b.gross} / ${b.net} / ${b.neither}`);
  }
  console.log(`\n  A0 VERDICT (row-level, pasted arithmetic above): stored realized_r is NOT one convention —`);
  console.log(`  it is WRITER-DEPENDENT. The counts, source split, and ts-format split above identify the`);
  console.log(`  writers. Code corroboration: the app path realizes GROSS by construction —`);
  console.log(`  services/signalEngine.ts:7755 computes realizedR = pnl / stopDistance (no cost), and`);
  console.log(`  services/learningStore.ts upserts it directly into trade_outcomes_v1 (anon key,`);
  console.log(`  onConflict=signal_id, first writer wins the race with the cron resolver). The net-fixed`);
  console.log(`  writers are the resolve-emitted-signals Edge Function (NET since 912242c, 2026-08-17)`);
  console.log(`  and the repair/backfill scripts built on the shared evCompute module.`);
  console.log(`  Any instrument that reads stored realized_r as a single convention inherits a`);
  console.log(`  one-cost-unit error on the gross-writer rows. The canonical book below does not read`);
  console.log(`  stored realized_r at all — it replays bars.`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Canonical replay of every emitted signal (fromScratch, pinned window)
  // ═══════════════════════════════════════════════════════════════════════════
  interface Replay { row: SignalRow; emittedMs: number; risk: number; status: string; outcome: 'WIN' | 'LOSS' | null; exitPrice: number; fullCoverage: boolean }
  const replays: Replay[] = [];
  const noBars: string[] = [];
  const origLog = console.log;
  console.log = () => {};
  for (const row of allSignalRows) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const windowEnd = Math.min(emittedMs + WINDOW_MS, barsEndMs);
    const lo = lowerBound(allBars, emittedMs - SAFE_BAR_OFFSET_MS);
    const hi = upperBound(allBars, windowEnd);
    const bars = allBars.slice(lo, hi);
    if (bars.length === 0) { noBars.push(sig.id); continue; }
    const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd });
    replays.push({
      row,
      emittedMs,
      risk: Math.abs(sig.entryPrice - sig.sl),
      status: String(result.newStatus),
      outcome: result.outcomeResult,
      exitPrice: result.exitPrice,
      fullCoverage: barsEndMs >= emittedMs + WINDOW_MS,
    });
  }
  console.log = origLog;
  const replayById = new Map(replays.map(r => [r.row.signal_id, r]));
  console.log(`\n  canonical fromScratch replay: ${replays.length} signals resolved (${noBars.length} with zero bars, excluded)`);

  const canonEntry = (r: Replay): Entry => {
    const dir = r.row.direction === 'BUY' ? 'BUY' : 'SELL';
    return {
      rGross: computeRGross(dir, Number(r.row.entry), r.exitPrice, r.risk),
      rNet: computeRNet(dir, Number(r.row.entry), r.exitPrice, r.risk),
      emittedMs: r.emittedMs,
    };
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // THE CANONICAL BOOK (quotable) — replay-decided, FULL 8h coverage, all sources
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A1/A2 — THE CANONICAL BOOK (fromScratch replay labels; quotable)');
  console.log(line);
  const decidedFull = replays.filter(r => r.outcome !== null && r.fullCoverage);
  const decidedAny = replays.filter(r => r.outcome !== null);
  console.log(`  decided (any coverage): ${decidedAny.length}   decided with FULL 8h coverage: ${decidedFull.length}`);
  console.log(`  excluded by canonical rule (outcome === null: EXPIRED_MISSED_ENTRY / NEVER_FILLABLE / ACTIVE): ${replays.length - decidedAny.length}`);
  const nullStatusCounts: Record<string, number> = {};
  for (const r of replays.filter(r => r.outcome === null)) nullStatusCounts[r.status] = (nullStatusCounts[r.status] ?? 0) + 1;
  console.log(`  canonical-null status mix: ${JSON.stringify(nullStatusCounts)}`);
  console.log(fmtBook('FULL (all sources)', bookStats(decidedFull.map(canonEntry))));
  const eraFull = decidedFull.filter(r => r.emittedMs >= SNAPSHOT_ERA_START_MS);
  const eraPre = decidedFull.filter(r => r.emittedMs < SNAPSHOT_ERA_START_MS);
  console.log(fmtBook('  snapshot-era (>= boundary)', bookStats(eraFull.map(canonEntry))));
  console.log(fmtBook('  pre-snapshot (< boundary)', bookStats(eraPre.map(canonEntry))));
  const postBoundaryLive = decidedFull.filter(r => r.emittedMs >= SNAPSHOT_ERA_START_MS && r.row.source === 'LIVE');
  console.log(fmtBook('  post-boundary LIVE only', bookStats(postBoundaryLive.map(canonEntry))));
  const srcCounts: Record<string, number> = {};
  for (const r of decidedFull) srcCounts[r.row.source] = (srcCounts[r.row.source] ?? 0) + 1;
  console.log(`  FULL book per-source counts: ${JSON.stringify(srcCounts)}`);
  const statusMix: Record<string, number> = {};
  for (const r of decidedFull) statusMix[r.status] = (statusMix[r.status] ?? 0) + 1;
  console.log(`  FULL book canonical status mix: ${JSON.stringify(statusMix)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // A2 — STORED BOOK ON THE IDENTICAL POPULATION + disagreement characterisation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A2 — STORED-LABEL BOOK ON THE IDENTICAL POPULATION (join: realized_r non-null, is_scratch not true)');
  console.log(line);
  const joinWithReplay = joinPopulation
    .map(({ row, out }) => ({ row, out, rep: replayById.get(row.signal_id) }))
    .filter((x): x is { row: SignalRow; out: OutcomeRow; rep: Replay } => x.rep !== undefined && x.rep.outcome !== null);
  console.log(`  join rows with a canonical verdict: ${joinWithReplay.length} (join population n=${joinPopulation.length}; ${joinPopulation.length - joinWithReplay.length} have canonical outcome=null and are excluded from BOTH books)`);

  // stored book, as-stored
  const storedAsIs: Entry[] = joinWithReplay.map(({ row, out, rep }) => ({
    rGross: Number(out.realized_r),   // as-stored (mixed convention — see A0)
    rNet: Number(out.realized_r),
    emittedMs: rep.emittedMs,
  }));
  // stored book, corrected to net per A0 (subtract cost when the row is from the gross era)
  const storedNetCorrected: Entry[] = joinWithReplay.map(({ row, out, rep }) => {
    const storedR = Number(out.realized_r);
    const exit = out.exit_price === null ? null : Number(out.exit_price);
    const g = computeRGross(row.direction === 'BUY' ? 'BUY' : 'SELL', Number(row.entry), exit ?? Number(row.entry), rep.risk);
    const isGrossRow = exit !== null && Math.abs(storedR - g) <= GROSS_NET_TOL_R;
    return { rGross: isGrossRow ? storedR : storedR + costInR(rep.risk), rNet: isGrossRow ? storedR - costInR(rep.risk) : storedR, emittedMs: rep.emittedMs };
  });
  const canonicalOnJoin: Entry[] = joinWithReplay.map(({ rep }) => canonEntry(rep));

  console.log(fmtBook('CANONICAL (join population)', bookStats(canonicalOnJoin)));
  const joinEraCanon = joinWithReplay.filter(x => x.rep.emittedMs >= SNAPSHOT_ERA_START_MS);
  const joinStoredEraEntries: Entry[] = joinEraCanon.map(({ row, out, rep }) => ({ rGross: Number(out.realized_r), rNet: Number(out.realized_r), emittedMs: rep.emittedMs }));
  console.log(fmtBook('  join snapshot-era CANONICAL', bookStats(joinEraCanon.map(({ rep }) => canonEntry(rep)))));
  console.log(fmtBook('  join snapshot-era STORED as-is', bookStats(joinStoredEraEntries)));
  console.log(fmtBook('STORED as-stored (mixed conv.)', bookStats(storedAsIs)));
  console.log(fmtBook('STORED net-corrected (per A0)', bookStats(storedNetCorrected)));
  const evCanon = bookStats(canonicalOnJoin).evNet;
  const evStoredAsIs = bookStats(storedAsIs).evNet;
  const evStoredNet = bookStats(storedNetCorrected).evNet;
  console.log(`  EV delta (stored as-is − canonical)      : ${(evStoredAsIs - evCanon).toFixed(4)}R`);
  console.log(`  EV delta (stored net-corrected − canon.) : ${(evStoredNet - evCanon).toFixed(4)}R`);

  // Row-level disagreement
  let winLossDisagree = 0, bigRDisagree = 0, exitPriceAgree = 0;
  const disagreeByEra = { preBoundary: 0, postBoundary: 0 };
  const disagreeBySource: Record<string, number> = {};
  const disagreeByDirection = { BUY: 0, SELL: 0 };
  const disagreeByPair: Record<string, number> = {};
  for (const { row, out, rep } of joinWithReplay) {
    const canonWin = rep.outcome === 'WIN';
    const storedWin = Number(out.realized_r) > 0;
    const canonNet = computeRNet(row.direction === 'BUY' ? 'BUY' : 'SELL', Number(row.entry), rep.exitPrice, rep.risk);
    const rDisagree = Math.abs(Number(out.realized_r) - canonNet) > 0.25;
    if (out.exit_price !== null && Math.abs(Number(out.exit_price) - rep.exitPrice) <= 0.05) exitPriceAgree += 1;
    const disagrees = canonWin !== storedWin || rDisagree;
    if (canonWin !== storedWin) winLossDisagree += 1;
    if (rDisagree) bigRDisagree += 1;
    if (disagrees) {
      if (rep.emittedMs < SNAPSHOT_ERA_START_MS) disagreeByEra.preBoundary += 1; else disagreeByEra.postBoundary += 1;
      disagreeBySource[row.source] = (disagreeBySource[row.source] ?? 0) + 1;
      disagreeByDirection[row.direction === 'BUY' ? 'BUY' : 'SELL'] += 1;
      const pair = `${rep.status}->${out.result}`;
      disagreeByPair[pair] = (disagreeByPair[pair] ?? 0) + 1;
    }
  }
  console.log(`\n  row-level disagreement (canonical vs stored, join population n=${joinWithReplay.length}):`);
  console.log(`    win/loss sign disagreements        : ${winLossDisagree}`);
  console.log(`    |ΔR| > 0.25R disagreements        : ${bigRDisagree}`);
  console.log(`    stored exit_price == replay exit   : ${exitPriceAgree} (exit price agreement rate)`);
  console.log(`    disagreement concentration — era     : pre-boundary=${disagreeByEra.preBoundary}  post-boundary=${disagreeByEra.postBoundary}`);
  console.log(`    disagreement concentration — source  : ${JSON.stringify(disagreeBySource)}`);
  console.log(`    disagreement concentration — direction: ${JSON.stringify(disagreeByDirection)}`);
  const pairsSorted = Object.entries(disagreeByPair).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`    disagreement concentration — status pair (canonical->stored):`);
  for (const [pair, count] of pairsSorted) console.log(`      ${pair}: ${count}`);
  console.log(`\n  A2 READ: if sign disagreements are few and the net-corrected stored book is close to`);
  console.log(`  canonical, the F-29-era repairs held; the as-stored book remains unquotable while`);
  console.log(`  the gross-writer rows persist in it. Canonical wins where they diverge.`);

  // ── A2b: the missing rows — why the quotable book and the stored book differ ──
  console.log(`\n  A2b — THE MISSING ROWS: replay-decided signals ABSENT from the stored join`);
  console.log(`  (the quotable FULL book is n=${decidedFull.length}; the join book is n=${joinWithReplay.length};`);
  console.log(`   the difference is a POPULATION difference, not a label difference — measure it:)`);
  const missing = decidedFull.filter(r => {
    const o = outcomesBySignal.get(r.row.signal_id);
    return !o || o.realized_r === null || o.realized_r === undefined || o.is_scratch === true;
  });
  const missingBySource: Record<string, number> = {};
  const missingByEra = { preBoundary: 0, postBoundary: 0 };
  const missingByStatus: Record<string, number> = {};
  for (const r of missing) {
    missingBySource[r.row.source] = (missingBySource[r.row.source] ?? 0) + 1;
    if (r.emittedMs < SNAPSHOT_ERA_START_MS) missingByEra.preBoundary += 1; else missingByEra.postBoundary += 1;
    missingByStatus[r.status] = (missingByStatus[r.status] ?? 0) + 1;
  }
  console.log(fmtBook('  MISSING-from-join (canonical)', bookStats(missing.map(canonEntry))));
  console.log(`    by source     : ${JSON.stringify(missingBySource)}`);
  console.log(`    by era        : pre-boundary=${missingByEra.preBoundary}  post-boundary=${missingByEra.postBoundary}`);
  console.log(`    by status     : ${JSON.stringify(missingByStatus)}`);
  console.log(`    arithmetic    : FULL book = join part + missing part (n ${decidedFull.length} = ${joinWithReplay.filter(x => x.rep.fullCoverage).length} + ${missing.length})`);

  console.log(`\n${line}`);
  console.log('A4 — QUOTING RULE');
  console.log(line);
  console.log(`  Only this script's output is quotable. Every future EV claim must re-run canonicalBook.ts.`);
  console.log(`  Era claims must name the boundary (${new Date(SNAPSHOT_ERA_START_MS).toISOString()}) and the cohort`);
  console.log(`  (all sources vs post-boundary LIVE). Stored realized_r is NEVER quotable without stating`);
  console.log(`  its era convention (gross before the 2026-08-17 net fix, net after — per A0 counts above).`);
  console.log(`\nDONE (measurement only — nothing written, nothing shipped)\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
