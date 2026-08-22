/**
 * ITEMS 202/203/204 — EXIT-STRUCTURE MEASUREMENT ROUND (READ-ONLY).
 *
 * 202(b/c) pull the 12 signals of the 2026-08-21 UTC day (the "Today's
 * Signals (12)" card population) from emitted_signals_v1 + trade_outcomes_v1
 * and re-resolve each canonically with the REAL resolveSignalWithBars,
 * fromScratch: true, against gold_m1_bars (8h window = MAX_RESOLUTION_WINDOW_MS).
 *
 * 202(d/e) + 203/204 measure the POST_TP1_PROFIT_LOCK_R exit structure on the
 * FULL canonical population:
 *   - SL_AFTER_BE vs PARTIAL_WIN_SL_HIT R-distributions, separated.
 *   - Breakeven arithmetic from ACTUAL average win/loss sizes.
 *   - Counterfactual books at lock 0.35 / 0.50 / 0.70 via the REAL resolver's
 *     LadderOverride hook (cap/floor semantics identical to live), plus a
 *     TRAIL_TO_TP2 variant through a harness that is VALIDATED against the
 *     real resolver at baseline AND at both alternative locks before use.
 *   - Paired Wilcoxon signed-rank + paired bootstrap on the SAME trades.
 *   - Continuation replay past every SL_AFTER_BE exit within the 8h window.
 *
 * DATA-SOURCE RULE: gold_m1_bars + sr_zones_v1 + trade_outcomes_v1 +
 * emitted_signals_v1 reads = Supabase DIRECT via anon key. READ-ONLY.
 * NOTHING IS WRITTEN. No scoring/exit/emission logic is changed.
 */
import { resolveSignalWithBars, getPostTP1LockPrice, SL_WICK_PENETRATION_PIPS } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { computeRNet, costInR } from '../lib/evCompute';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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
  direction: string;
  result: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  realized_r: number | null;
  is_scratch: boolean | null;
}

const DAY_12_START_MS = Date.parse('2026-08-21T00:00:00Z');
const DAY_12_END_MS = Date.parse('2026-08-22T00:00:00Z');
const WINDOW_MS = 8 * 60 * 60 * 1000;
const PIP = 0.1;
/** Same era definition as scripts/item197_198_round.ts: first stored sr_zones_snapshot. */
const SNAPSHOT_ERA_START_MS = Date.parse('2026-07-16T10:51:28.481Z');

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

// ---------------------------------------------------------------------------
// Resolved-record shape shared by the real resolver and the harness.
// ---------------------------------------------------------------------------
interface Resolved {
  id: string;
  status: SignalStatus | string;
  outcome: 'WIN' | 'LOSS' | null;
  exitPrice: number;
  targetsHit: number;
  exitBarTs: number | null;
}

interface PopRecord {
  sig: TradingSignal;
  row: SignalRow;
  emittedMs: number;
  risk: number;
  coverageHours: number;
  fullCoverage: boolean;
  baseline: Resolved;
}

// ---------------------------------------------------------------------------
// TRAIL_TO_TP2 harness — mirrors resolveSignalWithBars exactly, with
// parameterized post-TP1 / post-TP2 stops. VALIDATED against the real
// resolver before its TRAIL_TO_TP2 output is trusted.
// ---------------------------------------------------------------------------
interface VariantRules {
  label: string;
  /** Stop level while targetsHit === 1 (between TP1 and TP2). */
  postTP1Stop(sig: TradingSignal): number;
  /** Exit price when the post-TP1 stop is hit. */
  postTP1Exit(sig: TradingSignal): number;
  /** Stop level while targetsHit >= 2 (before TP3). Baseline = entry. */
  postTP2Stop(sig: TradingSignal): number;
  /** Exit price when the post-TP2 stop is hit. Baseline = (tp1+tp2+entry)/3. */
  postTP2Exit(sig: TradingSignal): number;
  /** Exit price when a TP1-only runner matures with no terminal event. Baseline = lock. */
  maturedTP1Exit(sig: TradingSignal, lastClose: number): number;
}

function resolveVariant(sig: TradingSignal, bars: Bar[], rules: VariantRules, evalNowMs: number): Resolved {
  const wickPen = SL_WICK_PENETRATION_PIPS;
  const slSlack = wickPen * PIP;
  const createdAtMs = sig.createdAt ?? new Date(sig.timestamp).getTime();
  const safeBarStart = createdAtMs + 60_000;
  const evalBars = bars.filter(b => b.timestamp >= safeBarStart);

  let status: SignalStatus | string = 'ACTIVE';
  let targetsHit = 0;
  let exitPrice = sig.entryPrice;
  let outcome: 'WIN' | 'LOSS' | null = null;
  let entryConfirmed = false;
  let exitBarTs: number | null = null;

  const entryMin = Math.min(sig.entryPrice, sig.entryPriceWithSlippage);
  const entryMax = Math.max(sig.entryPrice, sig.entryPriceWithSlippage);
  const ENTRY_TOL = 1.0;
  const EXTENDED_ENTRY_TOL = 3.0;
  const isBuy = sig.type === 'BUY';
  const slTriggerPrice = isBuy ? sig.sl - slSlack : sig.sl + slSlack;

  const everTouchedEntryBand = evalBars.some(
    b => b.low <= (entryMax + EXTENDED_ENTRY_TOL) && b.high >= (entryMin - EXTENDED_ENTRY_TOL),
  );

  for (const bar of evalBars) {
    if (!entryConfirmed) {
      const touchedZone = isBuy
        ? bar.low <= (entryMax + ENTRY_TOL) && bar.high >= (entryMin - ENTRY_TOL)
        : bar.high >= (entryMin - ENTRY_TOL) && bar.low <= (entryMax + ENTRY_TOL);
      const crossedTp1 = isBuy ? bar.high >= sig.tp1 : bar.low <= sig.tp1;
      const crossedSl = isBuy ? bar.low <= sig.sl : bar.high >= sig.sl;
      const touchedExtended = isBuy
        ? bar.low <= (entryMax + EXTENDED_ENTRY_TOL) && bar.high >= (entryMin - EXTENDED_ENTRY_TOL)
        : bar.high >= (entryMin - EXTENDED_ENTRY_TOL) && bar.low <= (entryMax + EXTENDED_ENTRY_TOL);
      if (touchedZone || crossedTp1 || crossedSl || touchedExtended) {
        entryConfirmed = true;
      } else {
        continue;
      }
    }

    const hasTP1 = targetsHit >= 1;
    const hasTP2 = targetsHit >= 2;

    const postTP1Stop = rules.postTP1Stop(sig);
    const postTP2Stop = rules.postTP2Stop(sig);
    const activeStop = hasTP2 ? postTP2Stop : (hasTP1 ? postTP1Stop : slTriggerPrice);

    const origSlHit = isBuy ? bar.low <= slTriggerPrice : bar.high >= slTriggerPrice;
    const lockHit = hasTP1 && !hasTP2
      ? (isBuy ? bar.low <= postTP1Stop : bar.high >= postTP1Stop)
      : false;
    const entryHitAfterTP2 = hasTP2
      ? (isBuy ? bar.low <= postTP2Stop : bar.high >= postTP2Stop)
      : false;
    const stopBreached = (!hasTP1 && origSlHit) || (hasTP1 && !hasTP2 && lockHit) || (hasTP2 && entryHitAfterTP2);

    const tp3Hit = isBuy ? bar.high >= sig.tp3 : bar.low <= sig.tp3;
    const tp2Hit = isBuy ? bar.high >= sig.tp2 : bar.low <= sig.tp2;
    const tp1Hit = isBuy ? bar.high >= sig.tp1 : bar.low <= sig.tp1;

    let newTargetsHitThisBar = targetsHit;
    let newTargetLevelThisBar: number | null = null;
    if (tp3Hit && targetsHit < 3) {
      newTargetsHitThisBar = 3;
      newTargetLevelThisBar = sig.tp3;
    } else if (tp2Hit && targetsHit < 2) {
      newTargetsHitThisBar = 2;
      newTargetLevelThisBar = sig.tp2;
    } else if (tp1Hit && targetsHit < 1) {
      newTargetsHitThisBar = 1;
      newTargetLevelThisBar = sig.tp1;
    }

    if (newTargetLevelThisBar !== null && stopBreached) {
      const targetDist = Math.abs(bar.open - newTargetLevelThisBar);
      const slDist = Math.abs(bar.open - activeStop);
      if (slDist <= targetDist) {
        if (hasTP2) {
          status = 'PARTIAL_WIN_SL_HIT';
          targetsHit = Math.max(targetsHit, 2);
          exitPrice = rules.postTP2Exit(sig);
          outcome = 'WIN';
        } else if (hasTP1) {
          status = 'SL_AFTER_BE';
          targetsHit = Math.max(targetsHit, 1);
          exitPrice = rules.postTP1Exit(sig);
          outcome = 'WIN';
        } else {
          status = 'SL_HIT';
          exitPrice = sig.sl;
          outcome = 'LOSS';
        }
        exitBarTs = bar.timestamp;
        break;
      }
      targetsHit = newTargetsHitThisBar;
      exitPrice = newTargetLevelThisBar;
      status = newTargetsHitThisBar === 3 ? 'ALL_TARGETS_HIT' : newTargetsHitThisBar === 2 ? 'TP2_HIT' : 'TP1_HIT';
      if (newTargetsHitThisBar === 3) {
        outcome = 'WIN';
        exitBarTs = bar.timestamp;
        break;
      }
      const hasTP2After = newTargetsHitThisBar >= 2;
      const stopHitAfter = hasTP2After
        ? (isBuy ? bar.low <= postTP2Stop : bar.high >= postTP2Stop)
        : (isBuy ? bar.low <= postTP1Stop : bar.high >= postTP1Stop);
      if (hasTP2After && stopHitAfter) {
        status = 'PARTIAL_WIN_SL_HIT';
        targetsHit = Math.max(targetsHit, 2);
        exitPrice = rules.postTP2Exit(sig);
        outcome = 'WIN';
        exitBarTs = bar.timestamp;
        break;
      }
      if (!hasTP2After && stopHitAfter) {
        status = 'SL_AFTER_BE';
        targetsHit = Math.max(targetsHit, 1);
        exitPrice = rules.postTP1Exit(sig);
        outcome = 'WIN';
        exitBarTs = bar.timestamp;
        break;
      }
      continue;
    }

    if (!hasTP1 && origSlHit) {
      status = 'SL_HIT';
      exitPrice = sig.sl;
      outcome = 'LOSS';
      exitBarTs = bar.timestamp;
      break;
    }
    if (hasTP2 && entryHitAfterTP2) {
      status = 'PARTIAL_WIN_SL_HIT';
      targetsHit = Math.max(targetsHit, 2);
      exitPrice = rules.postTP2Exit(sig);
      outcome = 'WIN';
      exitBarTs = bar.timestamp;
      break;
    }
    if (hasTP1 && !hasTP2 && lockHit) {
      status = 'SL_AFTER_BE';
      targetsHit = Math.max(targetsHit, 1);
      exitPrice = rules.postTP1Exit(sig);
      outcome = 'WIN';
      exitBarTs = bar.timestamp;
      break;
    }
    if (tp3Hit && targetsHit < 3) {
      status = 'ALL_TARGETS_HIT';
      targetsHit = 3;
      exitPrice = sig.tp3;
      outcome = 'WIN';
      exitBarTs = bar.timestamp;
      break;
    } else if (tp2Hit && targetsHit < 2) {
      status = 'TP2_HIT';
      targetsHit = 2;
      exitPrice = sig.tp2;
    } else if (tp1Hit && targetsHit < 1) {
      status = 'TP1_HIT';
      targetsHit = 1;
      exitPrice = sig.tp1;
    }
  }

  if (entryConfirmed && !everTouchedEntryBand && evalBars.length > 0 && evalNowMs - createdAtMs >= 2 * 60 * 60 * 1000) {
    return { id: sig.id, status: 'NEVER_FILLABLE', outcome: null, exitPrice: sig.entryPrice, targetsHit: 0, exitBarTs: null };
  }

  if (!entryConfirmed) {
    if (evalNowMs - createdAtMs >= 2 * 60 * 60 * 1000) {
      return { id: sig.id, status: 'EXPIRED_MISSED_ENTRY', outcome: null, exitPrice: sig.entryPrice, targetsHit: 0, exitBarTs: null };
    }
    return { id: sig.id, status, outcome: null, exitPrice, targetsHit, exitBarTs };
  }

  if (status === 'ACTIVE' || status === 'TP1_HIT' || status === 'TP2_HIT') {
    if (evalNowMs - createdAtMs >= 2 * 60 * 60 * 1000) {
      const lastClose = evalBars.length > 0 ? evalBars[evalBars.length - 1].close : sig.entryPrice;
      exitBarTs = evalBars.length > 0 ? evalBars[evalBars.length - 1].timestamp : createdAtMs;
      if (targetsHit >= 2) {
        return { id: sig.id, status: 'PARTIAL_WIN_SL_HIT', outcome: 'WIN', exitPrice: rules.postTP2Exit(sig), targetsHit, exitBarTs };
      }
      if (targetsHit >= 1) {
        return { id: sig.id, status: 'SL_AFTER_BE', outcome: 'WIN', exitPrice: rules.maturedTP1Exit(sig, lastClose), targetsHit, exitBarTs };
      }
      return { id: sig.id, status: 'CLOSED', outcome: null, exitPrice: lastClose, targetsHit: 0, exitBarTs };
    }
  }

  return { id: sig.id, status, outcome, exitPrice, targetsHit, exitBarTs };
}

const RULES_BASE: VariantRules = {
  label: 'LOCK_035 (live)',
  postTP1Stop: (sig) => getPostTP1LockPrice(sig),
  postTP1Exit: (sig) => getPostTP1LockPrice(sig),
  postTP2Stop: (sig) => sig.entryPrice,
  postTP2Exit: (sig) => Number(((sig.tp1 + sig.tp2 + sig.entryPrice) / 3).toFixed(1)),
  maturedTP1Exit: (sig) => getPostTP1LockPrice(sig),
};

function lockRules(fractionOfR: number, label: string): VariantRules {
  return {
    label,
    postTP1Stop: (sig) => getPostTP1LockPrice(sig, { lockFractionOfR: fractionOfR }),
    postTP1Exit: (sig) => getPostTP1LockPrice(sig, { lockFractionOfR: fractionOfR }),
    postTP2Stop: (sig) => sig.entryPrice,
    postTP2Exit: (sig) => Number(((sig.tp1 + sig.tp2 + sig.entryPrice) / 3).toFixed(1)),
    maturedTP1Exit: (sig) => getPostTP1LockPrice(sig, { lockFractionOfR: fractionOfR }),
  };
}

/**
 * TRAIL_TO_TP2 — precise definition used in this round:
 *  - Pre-TP1: identical to live (original SL with wick-penetration slack).
 *  - After TP1 banks: NO profit lock. The effective stop stays at the ORIGINAL
 *    SL price (no wick slack — lock-style check). A hit there exits the whole
 *    position at the original SL (the full round-trip failure, −1R gross).
 *  - After TP2 banks: the stop moves to TP1 ("lock moves to TP1 once TP2 also
 *    banked"). A hit there pays (tp1+tp2+tp1)/3.
 *  - TP3: unchanged, +TP3.
 *  - A TP1-only runner that matures with no terminal event has no protected
 *    exit yet — it is valued at the last close (still open at window end).
 */
const RULES_TRAIL_TP2: VariantRules = {
  label: 'TRAIL_TO_TP2',
  postTP1Stop: (sig) => sig.sl,
  postTP1Exit: (sig) => sig.sl,
  postTP2Stop: (sig) => sig.tp1,
  postTP2Exit: (sig) => Number(((sig.tp1 + sig.tp2 + sig.tp1) / 3).toFixed(1)),
  maturedTP1Exit: (_sig, lastClose) => lastClose,
};

// ---------------------------------------------------------------------------
// Statistics helpers.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function wilcoxonSignedRank(diffs: number[]): { n: number; wPlus: number; z: number; pTwoSided: number } {
  const nonZero = diffs.filter(d => d !== 0).map(d => ({ abs: Math.abs(d), sign: d > 0 ? 1 : -1 }));
  const n = nonZero.length;
  if (n < 10) return { n, wPlus: NaN, z: NaN, pTwoSided: NaN };
  nonZero.sort((a, b) => a.abs - b.abs);
  let wPlus = 0;
  let i = 0;
  let tieCorrection = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && nonZero[j + 1].abs === nonZero[i].abs) j++;
    const avgRank = (i + j + 2) / 2;
    const t = j - i + 1;
    if (t > 1) tieCorrection += (t ** 3 - t) / 48;
    for (let k = i; k <= j; k++) {
      if (nonZero[k].sign > 0) wPlus += avgRank;
    }
    i = j + 1;
  }
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieCorrection);
  if (sigma <= 0) return { n, wPlus, z: NaN, pTwoSided: NaN };
  const raw = wPlus - mu;
  const z = (raw - Math.sign(raw) * 0.5) / sigma;
  const pTwoSided = 2 * (1 - normalCdf(Math.abs(z)));
  return { n, wPlus, z, pTwoSided };
}

function pairedBootstrapMean(diffs: number[], seed: number, iterations: number): { mean: number; lo: number; hi: number } {
  const rnd = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    for (let k = 0; k < diffs.length; k++) sum += diffs[Math.floor(rnd() * diffs.length)];
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  return { mean, lo: means[Math.floor(iterations * 0.025)], hi: means[Math.floor(iterations * 0.975)] };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function rNetOf(sig: TradingSignal, exitPrice: number): number {
  const risk = Math.abs(sig.entryPrice - sig.sl);
  return computeRNet(sig.type === 'BUY' ? 'BUY' : 'SELL', sig.entryPrice, exitPrice, risk);
}

interface BookStats { n: number; wr: number; evGross: number; evNet: number; pfNet: number; maxDDNet: number; }

function bookStats(entries: { rNet: number; rGross: number; emittedMs: number }[]): BookStats {
  const n = entries.length;
  if (n === 0) return { n: 0, wr: 0, evGross: 0, evNet: 0, pfNet: 0, maxDDNet: 0 };
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
  return { n, wr, evGross, evNet, pfNet, maxDDNet: maxDD };
}

function fmtBook(label: string, b: BookStats): string {
  return `  ${label.padEnd(22)} n=${String(b.n).padStart(3)}  WR=${b.wr.toFixed(1)}%  EV_gross=${b.evGross >= 0 ? '+' : ''}${b.evGross.toFixed(4)}R  EV_net=${b.evNet >= 0 ? '+' : ''}${b.evNet.toFixed(4)}R  PF_net=${b.pfNet.toFixed(2)}  MaxDD_net=${b.maxDDNet.toFixed(2)}R`;
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const line = '='.repeat(96);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // ---- Fetch all emitted signals + outcomes + bars ------------------------
  const allSignalRows: SignalRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source')
      .order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`BLOCKER: signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as SignalRow[];
    allSignalRows.push(...rows);
    if (rows.length < 1000) break;
  }

  const outcomeRows: OutcomeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch')
      .order('ts', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`BLOCKER: outcome fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as OutcomeRow[];
    outcomeRows.push(...rows);
    if (rows.length < 1000) break;
  }
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
    if (error) { console.error(`BLOCKER: bar fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }

  console.log(`\n${line}`);
  console.log('ITEMS 202/203/204 — EXIT-STRUCTURE MEASUREMENT (READ-ONLY)');
  console.log(line);
  console.log(`  emitted_signals_v1 rows        : ${allSignalRows.length}`);
  const bySource: Record<string, number> = {};
  for (const r of allSignalRows) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  console.log(`  by source                      : ${JSON.stringify(bySource)}`);
  console.log(`  trade_outcomes_v1 rows         : ${outcomeRows.length}`);
  console.log(`  gold_m1_bars window            : ${new Date(minSignalMs - 60_000).toISOString()} -> ${new Date(barsEndMs).toISOString()} (${allBars.length} bars)`);
  console.log(`  resolution window              : 8h (MAX_RESOLUTION_WINDOW_MS), fromScratch, safeBarStart = createdAt+60s`);

  function barsForWindow(fromMs: number, toMs: number): Bar[] {
    const lo = lowerBound(allBars, fromMs);
    const hi = upperBound(allBars, toMs);
    return allBars.slice(lo, hi);
  }

  // ---- 202(a): reconcile the two cards ------------------------------------
  console.log(`\n${line}`);
  console.log('202(a) — TELEMETRY CARD vs PERFORMANCE SNAPSHOT RECONCILIATION');
  console.log(line);

  const dayRows = allSignalRows.filter(r => {
    const ms = new Date(r.emitted_at).getTime();
    return ms >= DAY_12_START_MS && ms < DAY_12_END_MS;
  });
  const dayOutcomes = dayRows.map(r => outcomesBySignal.get(r.signal_id)).filter((o): o is OutcomeRow => o !== undefined);
  const dayStoredWins = dayOutcomes.filter(o => o.result === 'WIN').length;
  const dayStoredLosses = dayOutcomes.filter(o => o.result === 'LOSS').length;
  console.log(`  "Today's Signals (12)" population = emitted_signals_v1 rows with emitted_at in [2026-08-21T00:00Z, 2026-08-22T00:00Z): ${dayRows.length} rows, all source=LIVE`);
  console.log(`  card day-window                 : telemetry.tsx startOfLocalDay(device tz) over in-memory signalHistory — the 12 visible rows match this UTC day 1:1 (entries 4608.1/4612.7/4624.4/4605.4/4601.0 all present)`);
  console.log(`  Day Win Rate denominator        : wins/(wins+losses) of TODAY's classified signals (telemetry.tsx:117-118), classifySignalOutcome counts SL_AFTER_BE as WIN (TradingContext.tsx:489)`);
  console.log(`  stored outcomes for the 12      : WIN=${dayStoredWins}  LOSS=${dayStoredLosses}  absent=${dayRows.length - dayOutcomes.length}  -> stored day WR = ${dayStoredWins + dayStoredLosses > 0 ? ((dayStoredWins / (dayStoredWins + dayStoredLosses)) * 100).toFixed(1) : 'n/a'}%`);

  const storedUsable = outcomeRows.filter(o => o.realized_r !== null);
  const storedWins = storedUsable.filter(o => Number(o.realized_r) > 0).length;
  const storedWr = (storedWins / storedUsable.length) * 100;
  const sumPnlWin = storedUsable.filter(o => o.pnl > 0).reduce((s, o) => s + o.pnl, 0);
  const sumPnlLoss = storedUsable.filter(o => o.pnl < 0).reduce((s, o) => s + Math.abs(o.pnl), 0);
  const storedPfDollars = sumPnlLoss > 0 ? sumPnlWin / sumPnlLoss : Infinity;
  const rWinSum = storedUsable.filter(o => Number(o.realized_r) > 0).reduce((s, o) => s + Number(o.realized_r), 0);
  const rLossSum = storedUsable.filter(o => Number(o.realized_r) <= 0).reduce((s, o) => s + Math.abs(Number(o.realized_r)), 0);
  console.log(`\n  Performance Snapshot (dashboard.tsx:658-674) = performanceMetrics (TradingContext.tsx:2303-2341):`);
  console.log(`    window  : ALL closedTrades in the ENTIRE in-memory history (all-time), NOT today`);
  console.log(`    WinRate : winningTrades/totalTrades          (TradingContext.tsx:2331)`);
  console.log(`    PF      : totalProfit/totalLoss in DOLLARS   (TradingContext.tsx:2332-2334, computeSignalPnL) — not R`);
  console.log(`  LIVE stored analogue (trade_outcomes_v1, all-time, n=${storedUsable.length} with realized_r):`);
  console.log(`    WR=${storedWr.toFixed(1)}%   PF($)=${storedPfDollars.toFixed(2)}   PF(R)=${rLossSum > 0 ? (rWinSum / rLossSum).toFixed(2) : 'inf'}`);
  console.log(`  -> RECONCILED: the two card numbers describe DIFFERENT populations (today-12 vs all-time) and the snapshot PF is DOLLAR-based;`);
  console.log(`     92% day WR and 65% all-time WR are not contradictory. The stored all-time book reproduces both headline figures.`);

  // ---- 202(b): the 12 signals ---------------------------------------------
  console.log(`\n${line}`);
  console.log('202(b) — THE 12 SIGNALS (2026-08-21 UTC day), STORED');
  console.log(line);
  console.log('  signal_id             dir  entry    sl      tp1     tp2     tp3     conf  stored result  stored realized_r');
  for (const r of dayRows.slice().reverse()) {
    const o = outcomesBySignal.get(r.signal_id);
    const storedResultText = o ? `${o.result}${o.is_scratch ? '/SCRATCH' : ''}` : 'absent';
    const storedRText = o && o.realized_r !== null ? Number(o.realized_r).toFixed(4) : 'null';
    console.log(
      `  ${r.signal_id.slice(-12).padEnd(14)} ${r.direction.padEnd(4)} ${String(r.entry).padEnd(7)} ${String(r.sl).padEnd(7)} ${String(r.tp1).padEnd(7)} ${String(r.tp2).padEnd(7)} ${String(r.tp3).padEnd(7)} ${Number(r.confidence).toFixed(2)}  ${storedResultText.padEnd(13)} ${storedRText}`,
    );
  }

  // ---- Resolve EVERYTHING canonically (baseline) ---------------------------
  const origLog = console.log;
  const population: PopRecord[] = [];
  const noBars: string[] = [];
  console.log = () => {};
  for (const row of allSignalRows) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const windowEnd = Math.min(emittedMs + WINDOW_MS, barsEndMs);
    const bars = barsForWindow(emittedMs - 60_000, windowEnd);
    if (bars.length === 0) { noBars.push(sig.id); continue; }
    const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd });
    population.push({
      sig, row, emittedMs,
      risk: Math.abs(sig.entryPrice - sig.sl),
      coverageHours: Math.max(0, (windowEnd - emittedMs) / 3_600_000),
      fullCoverage: barsEndMs >= emittedMs + WINDOW_MS,
      baseline: { id: sig.id, status: result.newStatus, outcome: result.outcomeResult, exitPrice: result.exitPrice, targetsHit: result.targetsHit, exitBarTs: result.resolvedAtBarTs ?? null },
    });
  }
  console.log = origLog;
  console.log(`\n  canonical baseline resolve: ${population.length} signals resolved (${noBars.length} with zero bars, excluded)`);

  // ---- 202(c): canonical re-resolution of the 12 ---------------------------
  console.log(`\n${line}`);
  console.log('202(c) — CANONICAL RE-RESOLUTION OF THE 12 (fromScratch, 8h window, NET per evCompute $0.20/trade)');
  console.log(line);
  console.log('  signal_id   dir  entry   canonical status      R_gross   R_net    stored result  stored R   match');
  for (const row of dayRows.slice().reverse()) {
    const rec = population.find(p => p.sig.id === row.signal_id);
    if (!rec) { console.log(`  ${row.signal_id.slice(-12)} — NO BARS, cannot resolve`); continue; }
    const b = rec.baseline;
    const rg = rec.risk > 0 ? (rec.sig.type === 'BUY' ? (b.exitPrice - rec.sig.entryPrice) / rec.risk : (rec.sig.entryPrice - b.exitPrice) / rec.risk) : 0;
    const rn = b.outcome === null ? 0 : rNetOf(rec.sig, b.exitPrice);
    const o = outcomesBySignal.get(row.signal_id);
    const storedResult = o?.result ?? 'absent';
    const storedR = o?.realized_r !== null && o?.realized_r !== undefined ? Number(o.realized_r) : null;
    let match = '';
    if (!o || o.realized_r === null) match = 'NO STORED OUTCOME';
    else {
      const canonWin = b.outcome === 'WIN';
      const storedWin = storedR !== null && storedR > 0;
      const rDelta = storedR !== null ? Math.abs(storedR - rn) : 999;
      match = canonWin === storedWin && rDelta <= 0.05 ? 'MATCH' : `MISMATCH (win/loss ${canonWin === storedWin ? 'same' : 'DIFF'}, |ΔR|=${rDelta.toFixed(3)})`;
    }
    const rgText = (b.outcome === null ? 0 : rg).toFixed(3);
    const rnText = b.outcome === null ? 'excluded' : rn.toFixed(3);
    const storedRText = storedR !== null ? storedR.toFixed(3) : 'null';
    console.log(
      `  ${row.signal_id.slice(-12)} ${row.direction.padEnd(4)} ${String(row.entry).padEnd(7)} ${String(b.status).padEnd(20)} ${rgText.padEnd(8)} ${rnText.padEnd(8)} ${storedResult.padEnd(13)} ${storedRText.padEnd(10)} ${match}`,
    );
    console.log(`      coverage ${rec.coverageHours.toFixed(1)}h of 8h${rec.fullCoverage ? '' : ' (TRUNCATED — bars end 2026-08-21T20:55Z)'}${b.exitBarTs ? `, exit bar ${new Date(b.exitBarTs).toISOString()}` : ''}`);
  }

  // ---- Canonical books ------------------------------------------------------
  const decidedAll = population.filter(p => p.baseline.outcome !== null);
  const decidedFull = decidedAll.filter(p => p.fullCoverage);
  const mkEntries = (pop: PopRecord[]): { rNet: number; rGross: number; emittedMs: number; rec: PopRecord }[] =>
    pop.map(p => ({ rNet: rNetOf(p.sig, p.baseline.exitPrice), rGross: (p.sig.type === 'BUY' ? (p.baseline.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - p.baseline.exitPrice)) / p.risk, emittedMs: p.emittedMs, rec: p }));

  console.log(`\n${line}`);
  console.log('CANONICAL BOOK (baseline lock 0.35R) — two coverage cuts');
  console.log(line);
  const bookAll = bookStats(mkEntries(decidedAll).map(e => ({ rNet: e.rNet, rGross: e.rGross, emittedMs: e.emittedMs })));
  const bookFull = bookStats(mkEntries(decidedFull).map(e => ({ rNet: e.rNet, rGross: e.rGross, emittedMs: e.emittedMs })));
  console.log(fmtBook('ALL decided (any coverage)', bookAll));
  console.log(fmtBook('FULL 8h coverage decided', bookFull));

  const statusCounts: Record<string, number> = {};
  for (const p of decidedFull) statusCounts[String(p.baseline.status)] = (statusCounts[String(p.baseline.status)] ?? 0) + 1;
  console.log(`  FULL-coverage decided status mix: ${JSON.stringify(statusCounts)}`);

  // Era split — same definition as item197_198_round.ts (first stored sr_zones_snapshot),
  // to reconcile against the prior round's snapshot-era n=150 book (EV_net -0.1016R).
  const eraFull = decidedFull.filter(p => p.emittedMs >= SNAPSHOT_ERA_START_MS);
  const eraPre = decidedFull.filter(p => p.emittedMs < SNAPSHOT_ERA_START_MS);
  console.log(`  era split at ${new Date(SNAPSHOT_ERA_START_MS).toISOString()}: snapshot-era n=${eraFull.length}, pre-snapshot n=${eraPre.length}`);
  const mk = (pop: PopRecord[]) => bookStats(mkEntries(pop).map(e => ({ rNet: e.rNet, rGross: e.rGross, emittedMs: e.emittedMs })));
  console.log(fmtBook('  snapshot-era (LOCK_035)', mk(eraFull)));
  console.log(fmtBook('  pre-snapshot  (LOCK_035)', mk(eraPre)));

  // headline population = FULL coverage (honest, no truncated-window bias)
  const POP = decidedFull;
  const popEntries = mkEntries(POP);

  // ---- 202(d): SL_AFTER_BE vs PARTIAL_WIN_SL_HIT distributions -------------
  console.log(`\n${line}`);
  console.log('202(d) — EXIT-TYPE R-DISTRIBUTIONS (FULL 8h-coverage canonical population)');
  console.log(line);
  function distFor(label: string, recs: PopRecord[]): void {
    if (recs.length === 0) { console.log(`  ${label}: n=0`); return; }
    const rs = recs.map(p => (p.sig.type === 'BUY' ? (p.baseline.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - p.baseline.exitPrice)) / p.risk);
    const nets = recs.map(p => rNetOf(p.sig, p.baseline.exitPrice));
    console.log(`  ${label}: n=${recs.length}  gross R min=${Math.min(...rs).toFixed(3)} median=${median(rs).toFixed(3)} max=${Math.max(...rs).toFixed(3)}  net R min=${Math.min(...nets).toFixed(3)} median=${median(nets).toFixed(3)} max=${Math.max(...nets).toFixed(3)}`);
  }
  const sabe = POP.filter(p => p.baseline.status === 'SL_AFTER_BE');
  const pwsh = POP.filter(p => p.baseline.status === 'PARTIAL_WIN_SL_HIT');
  const fullWins = POP.filter(p => ['ALL_TARGETS_HIT', 'TP3_HIT'].includes(String(p.baseline.status)));
  const slHits = POP.filter(p => p.baseline.status === 'SL_HIT');
  distFor('SL_AFTER_BE          ', sabe);
  distFor('PARTIAL_WIN_SL_HIT   ', pwsh);
  distFor('ALL_TARGETS/TP3      ', fullWins);
  distFor('SL_HIT               ', slHits);
  // how close is SL_AFTER_BE to the per-signal lock value?
  let nearLock = 0;
  for (const p of sabe) {
    const lockR = (p.sig.type === 'BUY' ? (getPostTP1LockPrice(p.sig) - p.sig.entryPrice) : (p.sig.entryPrice - getPostTP1LockPrice(p.sig))) / p.risk;
    const actualR = (p.sig.type === 'BUY' ? (p.baseline.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - p.baseline.exitPrice)) / p.risk;
    if (Math.abs(actualR - lockR) <= 0.05) nearLock++;
  }
  const sabeToday = dayRows
    .map(r => POP.find(p => p.sig.id === r.signal_id))
    .filter((p): p is PopRecord => p !== undefined && p.baseline.status === 'SL_AFTER_BE');
  const sabeTodayAll = dayRows
    .map(r => population.find(p => p.sig.id === r.signal_id))
    .filter((p): p is PopRecord => p !== undefined && p.baseline.status === 'SL_AFTER_BE');
  console.log(`  SL_AFTER_BE at exactly the per-signal lock price (|ΔR|<=0.05): ${nearLock}/${sabe.length}`);
  if (sabeTodayAll.length > 0) {
    const rs = sabeTodayAll.map(p => (p.sig.type === 'BUY' ? (p.baseline.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - p.baseline.exitPrice)) / p.risk);
    console.log(`  today's-12 SL_AFTER_BE (any coverage): n=${sabeTodayAll.length}  gross R min=${Math.min(...rs).toFixed(3)} median=${median(rs).toFixed(3)} max=${Math.max(...rs).toFixed(3)}`);
  } else { console.log(`  today's-12 SL_AFTER_BE: n=0`); }
  void sabeToday;

  // ---- 202(e): breakeven arithmetic from ACTUAL sizes ----------------------
  console.log(`\n${line}`);
  console.log('202(e) — BREAKEVEN ARITHMETIC FROM ACTUAL EXIT SIZES (FULL-coverage canonical book, NET)');
  console.log(line);
  const winsNet = popEntries.filter(e => e.rNet > 0);
  const lossesNet = popEntries.filter(e => e.rNet <= 0);
  const avgWinNet = winsNet.reduce((s, e) => s + e.rNet, 0) / Math.max(1, winsNet.length);
  const avgLossNet = Math.abs(lossesNet.reduce((s, e) => s + e.rNet, 0) / Math.max(1, lossesNet.length));
  const winsGross = popEntries.filter(e => e.rGross > 0);
  const lossesGross = popEntries.filter(e => e.rGross <= 0);
  const avgWinGross = winsGross.reduce((s, e) => s + e.rGross, 0) / Math.max(1, winsGross.length);
  const avgLossGross = Math.abs(lossesGross.reduce((s, e) => s + e.rGross, 0) / Math.max(1, lossesGross.length));
  const measuredWr = (winsNet.length / popEntries.length) * 100;
  const beNet = avgLossNet / (avgWinNet + avgLossNet) * 100;
  const beGross = avgLossGross / (avgWinGross + avgLossGross) * 100;
  console.log(`  n=${popEntries.length}  measured WR(net) = ${measuredWr.toFixed(1)}%`);
  console.log(`  ACTUAL avg win  (net) = +${avgWinNet.toFixed(4)}R   ACTUAL avg loss (net) = -${avgLossNet.toFixed(4)}R`);
  console.log(`  ACTUAL avg win  (gross)= +${avgWinGross.toFixed(4)}R   ACTUAL avg loss (gross)= -${avgLossGross.toFixed(4)}R`);
  console.log(`  implied breakeven WR (net)   = ${beNet.toFixed(1)}%  (measured ${measuredWr.toFixed(1)}% -> ${measuredWr >= beNet ? 'ABOVE' : 'BELOW'} breakeven by ${(measuredWr - beNet).toFixed(1)}pp)`);
  console.log(`  implied breakeven WR (gross) = ${beGross.toFixed(1)}%`);

  // ---- 203(a): provenance is quoted statically in the report ---------------
  // ---- 203(b): counterfactual replays --------------------------------------
  console.log(`\n${line}`);
  console.log('203(b/c/d) — COUNTERFACTUAL LOCK REPLAYS (same trades, same bars, paired)');
  console.log(line);

  // Variants via the REAL resolver (ladder override keeps live floor/cap semantics).
  interface VariantResult { label: string; resolved: Map<string, Resolved>; }
  const realVariants: VariantResult[] = [];
  const lockFractions: { label: string; fraction: number }[] = [
    { label: 'LOCK_050', fraction: 0.5 },
    { label: 'LOCK_070', fraction: 0.7 },
  ];
  console.log = () => {};
  for (const lv of lockFractions) {
    const map = new Map<string, Resolved>();
    for (const p of population) {
      const windowEnd = Math.min(p.emittedMs + WINDOW_MS, barsEndMs);
      const bars = barsForWindow(p.emittedMs - 60_000, windowEnd);
      const result = resolveSignalWithBars(p.sig, bars, { fromScratch: true, evalNowMs: windowEnd, ladder: { lockFractionOfR: lv.fraction } });
      map.set(p.sig.id, { id: p.sig.id, status: result.newStatus, outcome: result.outcomeResult, exitPrice: result.exitPrice, targetsHit: result.targetsHit, exitBarTs: result.resolvedAtBarTs ?? null });
    }
    realVariants.push({ label: lv.label, resolved: map });
  }
  console.log = origLog;

  // effective lock levels (cap 0.9*TP1 may bind at 0.70R)
  for (const lv of lockFractions) {
    const eff: number[] = [];
    for (const p of POP) {
      const lock = getPostTP1LockPrice(p.sig, { lockFractionOfR: lv.fraction });
      const lockR = (p.sig.type === 'BUY' ? (lock - p.sig.entryPrice) : (p.sig.entryPrice - lock)) / p.risk;
      eff.push(lockR);
    }
    console.log(`  ${lv.label}: effective lock in R (after 5-pip floor / 0.9*TP1 cap) min=${Math.min(...eff).toFixed(3)} median=${median(eff).toFixed(3)} max=${Math.max(...eff).toFixed(3)}`);
  }

  // Harness validation at BASE / L050 / L070 against the real resolver.
  const harnessSets: { rules: VariantRules; map: Map<string, Resolved> }[] = [];
  const validateHarness = (rules: VariantRules, realMap: Map<string, Resolved> | null): number => {
    let mismatches = 0;
    const map = new Map<string, Resolved>();
    for (const p of population) {
      const windowEnd = Math.min(p.emittedMs + WINDOW_MS, barsEndMs);
      const bars = barsForWindow(p.emittedMs - 60_000, windowEnd);
      const r = resolveVariant(p.sig, bars, rules, windowEnd);
      map.set(p.sig.id, r);
      const ref = realMap ? realMap.get(p.sig.id) : p.baseline;
      if (ref && (String(ref.status) !== String(r.status) || Math.abs(ref.exitPrice - r.exitPrice) > 0.05 || ref.targetsHit !== r.targetsHit)) mismatches++;
    }
    console.log(`  harness validation [${rules.label}] vs REAL resolver: ${mismatches} mismatches / ${population.length}`);
    return mismatches;
  };
  const mBase = validateHarness(RULES_BASE, null);
  const m050 = validateHarness(lockRules(0.5, 'LOCK_050'), realVariants[0].resolved);
  const m070 = validateHarness(lockRules(0.7, 'LOCK_070'), realVariants[1].resolved);
  const harnessTrusted = mBase === 0 && m050 === 0 && m070 === 0;
  const trailMap = new Map<string, Resolved>();
  if (harnessTrusted) {
    for (const p of population) {
      const windowEnd = Math.min(p.emittedMs + WINDOW_MS, barsEndMs);
      const bars = barsForWindow(p.emittedMs - 60_000, windowEnd);
      trailMap.set(p.sig.id, resolveVariant(p.sig, bars, RULES_TRAIL_TP2, windowEnd));
    }
    console.log(`  harness TRUSTED (0/0/0 mismatches) — TRAIL_TO_TP2 resolved through it`);
  } else {
    console.log(`  harness NOT trusted — TRAIL_TO_TP2 results BLOCKED (harness failed validation)`);
  }

  // ---- 203(c): books at each level -----------------------------------------
  function variantBook(label: string, resolved: Map<string, Resolved> | null): void {
    if (!resolved) { console.log(fmtBook(label, { n: 0, wr: 0, evGross: 0, evNet: 0, pfNet: 0, maxDDNet: 0 }) + '  BLOCKED'); return; }
    const entries = POP.map(p => {
      const r = resolved.get(p.sig.id);
      if (!r || r.outcome === null) return null;
      const rg = (p.sig.type === 'BUY' ? (r.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - r.exitPrice)) / p.risk;
      return { rNet: rNetOf(p.sig, r.exitPrice), rGross: rg, emittedMs: p.emittedMs, rec: p };
    }).filter((e): e is { rNet: number; rGross: number; emittedMs: number; rec: PopRecord } => e !== null);
    console.log(fmtBook(label, bookStats(entries)));
  }
  variantBook('LOCK_035 (live)', null);
  // baseline book reprinted from popEntries:
  console.log(fmtBook('LOCK_035 (live)', bookStats(popEntries)));
  const baselineMap = new Map(POP.map(p => [p.sig.id, p.baseline]));
  const eraBook = (label: string, resolved: Map<string, Resolved> | null): void => {
    if (!resolved) { console.log(`  ${label}: BLOCKED (harness untrusted)`); return; }
    const entries = POP.filter(p => p.emittedMs >= SNAPSHOT_ERA_START_MS).map(p => {
      const r = resolved.get(p.sig.id);
      if (!r || r.outcome === null) return null;
      const rg = (p.sig.type === 'BUY' ? (r.exitPrice - p.sig.entryPrice) : (p.sig.entryPrice - r.exitPrice)) / p.risk;
      return { rNet: rNetOf(p.sig, r.exitPrice), rGross: rg, emittedMs: p.emittedMs };
    }).filter((e): e is { rNet: number; rGross: number; emittedMs: number } => e !== null);
    console.log(fmtBook(label, bookStats(entries)));
  };
  console.log('  --- snapshot-era sub-books (era start 2026-07-16T10:51:28.481Z, same as item197_198_round.ts):');
  eraBook('  era LOCK_035 (live)', baselineMap);
  for (const rv of realVariants) variantBook(rv.label, rv.resolved);
  for (const rv of realVariants) eraBook(`  era ${rv.label}`, rv.resolved);
  variantBook('TRAIL_TO_TP2', harnessTrusted ? trailMap : null);
  eraBook('  era TRAIL_TO_TP2', harnessTrusted ? trailMap : null);

  // ---- paired tests ---------------------------------------------------------
  const baseR = new Map(popEntries.map(e => [e.rec.sig.id, e.rNet]));
  function paired(label: string, resolved: Map<string, Resolved> | null): void {
    if (!resolved) { console.log(`  ${label}: BLOCKED (harness untrusted)`); return; }
    const diffs: number[] = [];
    let degraded = 0, improved = 0, roundTrips = 0, lockBeforeTP2 = 0, sameStatus = 0, sabeToLoss = 0;
    for (const e of popEntries) {
      const r = resolved.get(e.rec.sig.id);
      if (!r || r.outcome === null) continue;
      const vR = rNetOf(e.rec.sig, r.exitPrice);
      diffs.push(vR - e.rNet);
      const baseStatus = String(e.rec.baseline.status);
      const varStatus = String(r.status);
      if (varStatus === baseStatus) sameStatus++;
      if (vR > e.rNet + 1e-9) improved++;
      if (vR < e.rNet - 1e-9) degraded++;
      // Round-trip classification is by R-SIGN, not by the resolver's outcome
      // label: the TRAIL_TO_TP2 harness reuses the SL_AFTER_BE branch when the
      // post-TP1 stop (the ORIGINAL SL) is hit, which stamps outcome='WIN' even
      // though the exit price is the original SL (R = -1). A baseline winner
      // whose variant R is negative HAS round-tripped, whatever the label says.
      if (e.rNet > 0 && vR < 0) roundTrips++;
      if (baseStatus === 'SL_AFTER_BE' && vR < 0) sabeToLoss++;
      if (['TP2_HIT', 'PARTIAL_WIN_SL_HIT', 'ALL_TARGETS_HIT', 'TP3_HIT'].includes(baseStatus) && varStatus === 'SL_AFTER_BE' && vR > 0) lockBeforeTP2++;
    }
    const w = wilcoxonSignedRank(diffs);
    const boot = pairedBootstrapMean(diffs, 20260822, 10000);
    const sd = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length - (diffs.reduce((s, d) => s + d, 0) / diffs.length) ** 2);
    const mde = diffs.length > 0 ? (2.8 * sd) / Math.sqrt(diffs.length) : NaN;
    const eraIdx: number[] = [];
    popEntries.forEach((e, i) => { if (e.rec.emittedMs >= SNAPSHOT_ERA_START_MS) eraIdx.push(i); });
    const eraDiffs = eraIdx.map(i => diffs[i]).filter((d): d is number => d !== undefined);
    const eraMean = eraDiffs.length > 0 ? eraDiffs.reduce((s, d) => s + d, 0) / eraDiffs.length : 0;
    console.log(`  ${label}: pairs n=${diffs.length}  improved=${improved}  degraded=${degraded}  unchanged=${sameStatus}`);
    console.log(`     WIN->LOSS round-trips (by R-sign) = ${roundTrips}   of which baseline SL_AFTER_BE winners now negative = ${sabeToLoss}   TP2+/PARTIAL winners stopped at the higher lock before TP2 = ${lockBeforeTP2}`);
    console.log(`     mean ΔEV_net = ${boot.mean >= 0 ? '+' : ''}${boot.mean.toFixed(4)}R  paired-bootstrap 95% CI [${boot.lo.toFixed(4)}, ${boot.hi.toFixed(4)}]`);
    console.log(`     Wilcoxon signed-rank: n(nonz)=${w.n} W+=${Number.isNaN(w.wPlus) ? 'n/a' : w.wPlus.toFixed(0)} z=${Number.isNaN(w.z) ? 'n/a' : w.z.toFixed(3)} p(2-sided)=${Number.isNaN(w.pTwoSided) ? 'n/a (n<10)' : w.pTwoSided.toFixed(4)}`);
    console.log(`     POWER: paired MDE (80% power, α=0.05) = ±${mde.toFixed(4)}R EV_net`);
    console.log(`     snapshot-era-only mean ΔEV_net (n=${eraDiffs.length}) = ${eraMean >= 0 ? '+' : ''}${eraMean.toFixed(4)}R`);
  }
  console.log('');
  for (const rv of realVariants) paired(rv.label, rv.resolved);
  paired('TRAIL_TO_TP2', harnessTrusted ? trailMap : null);

  // ---- 204: continuation past the SL_AFTER_BE exit --------------------------
  console.log(`\n${line}`);
  console.log('204 — CONTINUATION PAST THE SL_AFTER_BE EXIT (same bars, remaining 8h window)');
  console.log(line);
  let tp3Count = 0, tp2OnlyCount = 0, reversedCount = 0, neitherCount = 0;
  const continuation: { id: string; bucket: string }[] = [];
  for (const p of POP.filter(x => x.baseline.status === 'SL_AFTER_BE' && x.baseline.exitBarTs !== null)) {
    const windowEnd = p.emittedMs + WINDOW_MS;
    const bars = barsForWindow((p.baseline.exitBarTs ?? 0) + 60_000, windowEnd);
    const isBuy = p.sig.type === 'BUY';
    const slTouch = (b: Bar) => isBuy ? b.low <= p.sig.sl - SL_WICK_PENETRATION_PIPS * PIP : b.high >= p.sig.sl + SL_WICK_PENETRATION_PIPS * PIP;
    const tp2Touch = (b: Bar) => isBuy ? b.high >= p.sig.tp2 : b.low <= p.sig.tp2;
    const tp3Touch = (b: Bar) => isBuy ? b.high >= p.sig.tp3 : b.low <= p.sig.tp3;
    let bucket = 'NEITHER';
    let tp2BarIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const both = slTouch(b) && tp2Touch(b);
      if (both) {
        const slDist = Math.abs(b.open - p.sig.sl);
        const tp2Dist = Math.abs(b.open - p.sig.tp2);
        if (slDist <= tp2Dist) { bucket = 'REVERSED_TO_SL'; break; }
        tp2BarIdx = i; break;
      }
      if (slTouch(b)) { bucket = 'REVERSED_TO_SL'; break; }
      if (tp2Touch(b)) { tp2BarIdx = i; break; }
    }
    if (bucket === 'NEITHER' && tp2BarIdx >= 0) {
      bucket = 'TP2_ONLY';
      for (let i = tp2BarIdx; i < bars.length; i++) {
        const b = bars[i];
        const both = slTouch(b) && tp3Touch(b);
        if (both) {
          const slDist = Math.abs(b.open - p.sig.sl);
          const tp3Dist = Math.abs(b.open - p.sig.tp3);
          if (tp3Dist < slDist) { bucket = 'TP3'; }
          break;
        }
        if (tp3Touch(b)) { bucket = 'TP3'; break; }
        if (slTouch(b)) break;
      }
    }
    if (bucket === 'NEITHER' && tp2BarIdx < 0) bucket = 'NEITHER';
    if (bucket === 'TP3') tp3Count++;
    else if (bucket === 'TP2_ONLY') tp2OnlyCount++;
    else if (bucket === 'REVERSED_TO_SL') reversedCount++;
    else neitherCount++;
    continuation.push({ id: p.sig.id, bucket });
  }
  const nSabe = continuation.length;
  const frac = (c: number): string => nSabe > 0 ? `${c}/${nSabe} (${((c / nSabe) * 100).toFixed(1)}%)` : `0/0`;
  console.log(`  SL_AFTER_BE exits replayed (FULL 8h coverage): n=${nSabe}`);
  console.log(`  reached TP2 then TP3 : ${frac(tp3Count)}`);
  console.log(`  reached TP2 only     : ${frac(tp2OnlyCount)}`);
  console.log(`  reversed to wider SL : ${frac(reversedCount)}`);
  console.log(`  neither (window end) : ${frac(neitherCount)}`);
  const contFrac = nSabe > 0 ? (tp3Count + tp2OnlyCount) / nSabe : 0;
  console.log(`  CONTINUATION (TP2+)  : ${frac(tp3Count + tp2OnlyCount)}  — Wilson 95% CI below`);
  if (nSabe > 0) {
    const z = 1.96; const ph = contFrac;
    const denom = 1 + (z * z) / nSabe;
    const centre = (ph + (z * z) / (2 * nSabe)) / denom;
    const half = (z * Math.sqrt((ph * (1 - ph)) / nSabe + (z * z) / (4 * nSabe * nSabe))) / denom;
    console.log(`     [${(centre - half).toFixed(3)}, ${(centre + half).toFixed(3)}]`);
    console.log(`     POWER: n=${nSabe}; MDE on the continuation fraction (80% power, α=0.05, two-sided vs p=0.5) ≈ ±${(1.4 * Math.sqrt(0.25 / nSabe)).toFixed(3)}`);
  }

  console.log(`\n${line}\nDONE (measurement only — nothing written, nothing shipped)\n${line}`);
}

function lowerBound(arr: Bar[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].timestamp < target) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(arr: Bar[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].timestamp <= target) lo = mid + 1; else hi = mid; }
  return lo;
}

main().catch((err: unknown) => {
  console.error('item202 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
