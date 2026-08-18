/**
 * ITEM 131 + 133 MEASUREMENT.
 *
 * 131(a): How often does atrFloorSlPips exceed maxSLPips at the user's live cap
 *         of 90? This is an emission suppressor at signalEngine.ts:8248 that has
 *         never been counted. Measured on the LIVE ATR DISTRIBUTION over
 *         gold_m1_bars, using the ENGINE'S OWN ATR construct (14-period true
 *         range over aligned high/low/prevClose bar arrays, calculateRealATR).
 *
 * 131(c): The tight-stop cohort — signals where the ceiling BINDS, so the
 *         realised stop is tighter than the 1.2 x ATR noise floor. Reports the
 *         fraction affected and their canonical WR versus the rest.
 *
 * 133(a): Canonical book at minConfidence 0.68 / 0.72 / 0.80 / 0.85 / 0.90.
 *         POWER STATED FIRST for every arm.
 * 133(b): Emission rate implied by each threshold, combined with the 225-min
 *         dedup window and the cluster guard.
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 + trade_outcomes_v1 read
 * DIRECT from Supabase via anon key. READ-ONLY — nothing is written.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeRNet } from '../lib/evCompute';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

const PIP_VALUE = 0.1;

/** Live constants under test — mirrored from signalEngine.ts. */
const MIN_SL_ATR_MULTIPLE = 1.2;
const USER_MAX_SL_PIPS = 90;
const CONFIGURED_SL_PIPS = 70;
const ATR_PERIOD = 14;
const DEDUP_CLUSTER_BAND_ATR = 1.5;
const DEDUP_TIME_WINDOW_MIN = 225;

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

async function fetchAllBars(client: ReturnType<typeof createClient>): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * VERBATIM port of signalEngine.calculateRealATR(14): average of `period` true
 * ranges over a period+1 window, each true range using the GENUINE previous
 * bar's close from the same aligned series.
 */
function atrAt(bars: Bar[], endIdx: number, period: number = ATR_PERIOD): number | null {
  if (endIdx < period) return null;
  const trs: number[] = [];
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    if (!b || !prev) return null;
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? 0;
  return a + (b - a) * (idx - lo);
}

interface Row {
  id: string;
  dir: 'BUY' | 'SELL';
  entry: number;
  risk: number;
  rNet: number;
  /** EV computed with risk in PIPS — the prior round's construct, kept for comparison. */
  rNetPips: number;
  isWin: boolean;
  sigTs: number;
  atr: number;
  conf: number;
  /** pips of the realised stop as the engine would compute it today */
  realisedSlPips: number;
  /** the 1.2 x ATR noise floor in pips */
  atrFloorPips: number;
  /** true when maxSLPips truncated the stop below the noise floor */
  ceilingBinds: boolean;
}

function book(rows: Row[]): { n: number; wr: number; ev: number; pf: number } {
  const n = rows.length;
  if (n === 0) return { n: 0, wr: 0, ev: 0, pf: 0 };
  const wins = rows.filter((r) => r.isWin).length;
  const ev = rows.reduce((a, r) => a + r.rNet, 0) / n;
  const gp = rows.filter((r) => r.rNet > 0).reduce((a, r) => a + r.rNet, 0);
  const gl = Math.abs(rows.filter((r) => r.rNet < 0).reduce((a, r) => a + r.rNet, 0));
  return { n, wr: (wins / n) * 100, ev, pf: gl > 0 ? gp / gl : 0 };
}

/**
 * ACTIVE-ONLY cluster guard (Item 132d correction). A candidate is blocked only
 * while a same-cluster, same-direction signal is STILL ACTIVE — which is what
 * the live guard does — rather than by any previously emitted signal ever, which
 * is what the prior round simulated and which produced a pessimistic LOWER BOUND.
 */
function simulateEmission(rows: Row[], holdMs: number[], useTimeWindow: boolean): number {
  const emitted: { ts: number; entry: number; dir: string; until: number }[] = [];
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const band = Math.max(r.atr, 0.01) * DEDUP_CLUSTER_BAND_ATR;
    const blocked = emitted.some((e) => {
      if (e.dir !== r.dir) return false;
      const stillActive = e.until > r.sigTs;
      const sameCluster = Math.abs(e.entry - r.entry) <= band;
      if (sameCluster && stillActive) return true;
      if (useTimeWindow && r.sigTs - e.ts < DEDUP_TIME_WINDOW_MIN * 60_000) return true;
      return false;
    });
    if (blocked) continue;
    count++;
    emitted.push({ ts: r.sigTs, entry: r.entry, dir: r.dir, until: r.sigTs + (holdMs[i] ?? 0) });
  }
  return count;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !key) throw new Error('missing Supabase env');
  const client = createClient(url, key);

  console.log('='.repeat(74));
  console.log('ITEM 131 + 133 MEASUREMENT (READ-ONLY)');
  console.log('='.repeat(74));

  const bars = await fetchAllBars(client);
  console.log(`bars loaded          : ${bars.length}`);
  console.log(`tape span            : ${new Date(bars[0]?.timestamp ?? 0).toISOString()} -> ${new Date(bars[bars.length - 1]?.timestamp ?? 0).toISOString()}`);

  // ---------------- 131(a): live ATR distribution ----------------
  console.log('');
  console.log('--- 131(a) LIVE ATR DISTRIBUTION + SL-CEILING REJECTION FREQUENCY ---');
  const atrs: number[] = [];
  for (let i = ATR_PERIOD; i < bars.length; i++) {
    const a = atrAt(bars, i);
    if (a !== null && Number.isFinite(a)) atrs.push(a);
  }
  const sortedAtr = [...atrs].sort((a, b) => a - b);
  console.log(`ATR samples (1 per completed bar): ${atrs.length}`);
  console.log(`  p05=${quantile(sortedAtr, 0.05).toFixed(3)}  p25=${quantile(sortedAtr, 0.25).toFixed(3)}  p50=${quantile(sortedAtr, 0.5).toFixed(3)}  p75=${quantile(sortedAtr, 0.75).toFixed(3)}  p90=${quantile(sortedAtr, 0.9).toFixed(3)}  p95=${quantile(sortedAtr, 0.95).toFixed(3)}  p99=${quantile(sortedAtr, 0.99).toFixed(3)}  max=${(sortedAtr[sortedAtr.length - 1] ?? 0).toFixed(3)}`);

  // atrFloorSlPips = atr * 1.2 / 0.1 = atr * 12. Rejects when > maxSLPips.
  const atrThresholdForReject = (USER_MAX_SL_PIPS * PIP_VALUE) / MIN_SL_ATR_MULTIPLE;
  console.log('');
  console.log(`atrFloorSlPips = atr * ${MIN_SL_ATR_MULTIPLE} / ${PIP_VALUE} = atr * ${(MIN_SL_ATR_MULTIPLE / PIP_VALUE).toFixed(0)}`);
  console.log(`REJECT when atrFloorSlPips > ${USER_MAX_SL_PIPS}  <=>  ATR > ${atrThresholdForReject.toFixed(3)}`);
  for (const cap of [70, 90, 110, 130]) {
    const thr = (cap * PIP_VALUE) / MIN_SL_ATR_MULTIPLE;
    const nOver = atrs.filter((a) => a > thr).length;
    console.log(`  cap ${String(cap).padStart(3)} pips -> ATR > ${thr.toFixed(2)} -> ${nOver}/${atrs.length} bars = ${((nOver / atrs.length) * 100).toFixed(2)}% of tape MINUTES rejected`);
  }

  // ---------------- canonical population ----------------
  const { data: sigRows, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, atr, sl_multiplier, regime, rsi, session_name, hour_utc, htf_trend, ltf_trend')
    .order('emitted_at', { ascending: true });
  if (sigErr) throw new Error(`signal fetch: ${sigErr.message}`);
  const allSigs = (sigRows ?? []) as Record<string, unknown>[];
  console.log('');
  console.log(`emitted_signals_v1 rows: ${allSigs.length}`);

  const barsToMs = bars[bars.length - 1]?.timestamp ?? Date.now();
  const rows: Row[] = [];
  const holdMs: number[] = [];
  let skippedUnresolved = 0;
  let skippedNoAtr = 0;
  for (const raw of allSigs) {
    const sig = toTradingSignal(raw);
    const sigTs = sig.createdAt as number;
    let res: ReturnType<typeof resolveSignalWithBars> | null = null;
    try { res = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: barsToMs }); } catch { res = null; }
    if (!res || !res.newStatus || res.newStatus === 'ACTIVE') { skippedUnresolved += 1; continue; }
    const entry = Number(raw.entry);
    const sl = Number(raw.sl);
    // RISK IN PRICE UNITS. costInR() multiplies by DOLLAR_PER_PRICE_UNIT=1, so
    // $0.20 / |entry-sl| is only the documented ~0.03R burden when risk is in
    // DOLLARS. Passing pips (risk/0.1) deflates both gross R and the cost by 10x.
    const risk = Math.abs(entry - sl);
    if (!Number.isFinite(risk) || risk <= 0) { skippedNoAtr += 1; continue; }
    const exit = Number(res.exitPrice ?? entry);
    const dir = String(raw.direction) === 'SELL' ? 'SELL' : 'BUY';
    const rNet = computeRNet(dir, entry, exit, risk);
    const rNetPips = computeRNet(dir, entry, exit, risk / PIP_VALUE);
    const atr = Number(raw.atr ?? 0);
    if (!Number.isFinite(atr) || atr <= 0) { skippedNoAtr += 1; continue; }

    // Recompute the stop the engine would place TODAY for this ATR.
    const atrMultiplier = parseFloat(Math.max(1.0, Math.min(1.6, 0.7 + atr * 0.06)).toFixed(2));
    const atrFloorPips = (atr * MIN_SL_ATR_MULTIPLE) / PIP_VALUE;
    const rawSlPips = Math.max(CONFIGURED_SL_PIPS * atrMultiplier, atrFloorPips);
    const realisedSlPips = Math.min(rawSlPips, USER_MAX_SL_PIPS);
    const ceilingBinds = atrFloorPips > USER_MAX_SL_PIPS;

    const resolvedTs = Number(res.resolvedAtBarTs ?? sigTs);
    rows.push({
      id: String(raw.signal_id ?? ''), dir, entry, risk, rNet, rNetPips,
      isWin: rNet > 0, sigTs, atr, conf: Number(raw.confidence ?? 0),
      realisedSlPips, atrFloorPips, ceilingBinds,
    });
    holdMs.push(Math.max(0, resolvedTs - sigTs));
  }
  console.log(`canonically resolved   : ${rows.length}  (skipped unresolved ${skippedUnresolved}, skipped no-atr/risk ${skippedNoAtr})`);
  const spanDays = rows.length > 1 ? ((rows[rows.length - 1]?.sigTs ?? 0) - (rows[0]?.sigTs ?? 0)) / 86_400_000 : 0;
  console.log(`book span (days)       : ${spanDays.toFixed(1)}`);

  const full = book(rows);
  console.log(`FULL BOOK (risk in PRICE units, CORRECT): n=${full.n} WR=${full.wr.toFixed(2)}% EV=${full.ev >= 0 ? '+' : ''}${full.ev.toFixed(4)}R PF=${full.pf.toFixed(3)}`);
  const pipsWins = rows.filter((r) => r.rNetPips > 0).length;
  const pipsEv = rows.length > 0 ? rows.reduce((a, r) => a + r.rNetPips, 0) / rows.length : 0;
  console.log(`FULL BOOK (risk in PIPS, prior round's bug): n=${rows.length} WR=${((pipsWins / Math.max(rows.length, 1)) * 100).toFixed(2)}% EV=${pipsEv >= 0 ? '+' : ''}${pipsEv.toFixed(4)}R`);
  console.log('The PRICE-units line is the one to trust: costInR() is documented as');
  console.log('$0.20 / risk-in-dollars, which is the ~0.03R burden the project cites.');

  // ---------------- 131(a) on the canonical population ----------------
  console.log('');
  console.log('--- 131(a) ON THE CANONICAL POPULATION (SELECTION-BIASED, STATED) ---');
  const wouldReject = rows.filter((r) => r.ceilingBinds).length;
  console.log(`signals in the book whose atrFloorPips > ${USER_MAX_SL_PIPS}: ${wouldReject}/${rows.length}`);
  console.log('NOTE: the book contains only signals that WERE emitted, i.e. that already');
  console.log('passed this gate. This count is therefore a SELECTION-BIASED floor, not the');
  console.log('rejection rate. The tape-minute figure above is the unbiased estimate.');
  const sortedSigAtr = [...rows.map((r) => r.atr)].sort((a, b) => a - b);
  console.log(`signal-time ATR: p50=${quantile(sortedSigAtr, 0.5).toFixed(3)} p90=${quantile(sortedSigAtr, 0.9).toFixed(3)} p99=${quantile(sortedSigAtr, 0.99).toFixed(3)} max=${(sortedSigAtr[sortedSigAtr.length - 1] ?? 0).toFixed(3)}`);

  // ---------------- 131(c) tight-stop cohort ----------------
  console.log('');
  console.log('--- 131(c) TIGHT-STOP COHORT (realised stop < 1.2 x ATR) ---');
  const tight = rows.filter((r) => r.realisedSlPips < r.atrFloorPips - 1e-9);
  const rest = rows.filter((r) => !(r.realisedSlPips < r.atrFloorPips - 1e-9));
  const bt = book(tight);
  const br = book(rest);
  console.log(`TIGHT (ceiling truncated below noise floor): n=${bt.n} (${((bt.n / rows.length) * 100).toFixed(1)}%) WR=${bt.wr.toFixed(2)}% EV=${bt.ev >= 0 ? '+' : ''}${bt.ev.toFixed(4)}R PF=${bt.pf.toFixed(3)}`);
  console.log(`REST  (stop clears the noise floor)       : n=${br.n} (${((br.n / rows.length) * 100).toFixed(1)}%) WR=${br.wr.toFixed(2)}% EV=${br.ev >= 0 ? '+' : ''}${br.ev.toFixed(4)}R PF=${br.pf.toFixed(3)}`);
  if (bt.n > 0 && br.n > 0) {
    console.log(`delta WR = ${(bt.wr - br.wr).toFixed(2)}pp   delta EV = ${(bt.ev - br.ev >= 0 ? '+' : '')}${(bt.ev - br.ev).toFixed(4)}R`);
    console.log(`POWER: tight arm n=${bt.n} — ${bt.n >= 30 ? 'ADEQUATE' : 'UNDERPOWERED (n<30), treat as indicative only'}`);
  } else {
    console.log('POWER: one arm is EMPTY at the current cap — the cohort cannot be measured on this book.');
  }

  // ---------------- 133 confidence thresholds ----------------
  console.log('');
  console.log('--- 133(a) CANONICAL BOOK BY minConfidence (POWER FIRST) ---');
  const sortedConf = [...rows.map((r) => r.conf)].sort((a, b) => a - b);
  console.log(`confidence distribution: p05=${quantile(sortedConf, 0.05).toFixed(3)} p25=${quantile(sortedConf, 0.25).toFixed(3)} p50=${quantile(sortedConf, 0.5).toFixed(3)} p75=${quantile(sortedConf, 0.75).toFixed(3)} p90=${quantile(sortedConf, 0.9).toFixed(3)} max=${(sortedConf[sortedConf.length - 1] ?? 0).toFixed(3)}`);
  console.log('');
  console.log('thr    | POWER              | n    | WR      | EV_net    | PF');
  console.log('-------+--------------------+------+---------+-----------+------');
  const thresholds = [0.68, 0.72, 0.8, 0.85, 0.9];
  const perThr: { thr: number; n: number; emitted: number }[] = [];
  for (const thr of thresholds) {
    const idx: number[] = [];
    rows.forEach((r, i) => { if (r.conf >= thr) idx.push(i); });
    const arm = idx.map((i) => rows[i]).filter((r): r is Row => r !== undefined);
    const b = book(arm);
    const power = b.n === 0 ? 'EMPTY' : b.n < 30 ? `UNDERPOWERED n=${b.n}` : 'ADEQUATE';
    console.log(`${thr.toFixed(2)}   | ${power.padEnd(18)} | ${String(b.n).padStart(4)} | ${b.wr.toFixed(2).padStart(6)}% | ${(b.ev >= 0 ? '+' : '') + b.ev.toFixed(4)}R | ${b.pf.toFixed(3)}`);
    const armHold = idx.map((i) => holdMs[i] ?? 0);
    perThr.push({ thr, n: b.n, emitted: simulateEmission(arm, armHold, true) });
  }

  console.log('');
  console.log('--- 133(b) IMPLIED EMISSION RATE PER THRESHOLD (225-min dedup + ACTIVE-only cluster guard) ---');
  console.log('thr    | survives book | after dedup | signals/day');
  console.log('-------+---------------+-------------+------------');
  for (const p of perThr) {
    console.log(`${p.thr.toFixed(2)}   | ${String(p.n).padStart(13)} | ${String(p.emitted).padStart(11)} | ${(p.emitted / Math.max(spanDays, 0.01)).toFixed(2)}`);
  }

  console.log('');
  console.log('--- 132(d) ACTIVE-ONLY vs ANY-PRIOR CLUSTER GUARD (full book, thr=0) ---');
  const activeOnly = simulateEmission(rows, holdMs, true);
  const activeOnlyNoWindow = simulateEmission(rows, holdMs, false);
  console.log(`raw book                                   : ${rows.length} = ${(rows.length / Math.max(spanDays, 0.01)).toFixed(2)}/day`);
  console.log(`ACTIVE-only cluster guard + 225min window   : ${activeOnly} = ${(activeOnly / Math.max(spanDays, 0.01)).toFixed(2)}/day`);
  console.log(`ACTIVE-only cluster guard, NO time window   : ${activeOnlyNoWindow} = ${(activeOnlyNoWindow / Math.max(spanDays, 0.01)).toFixed(2)}/day`);

  console.log('');
  console.log('DONE.');
}

main().catch((e: unknown) => {
  console.error('FAILED:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
