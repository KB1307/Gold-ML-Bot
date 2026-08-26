/**
 * ITEM 224 / CHECKPOINT A — THE TP-AFTER-BE GAP.
 *
 * A2b  live PostgREST column probe of trade_outcomes_v1 AFTER migration 014.
 * A3   parity of the two MFE implementations on SYNTHETIC bars (exact equality).
 * A3b  parity of the same two implementations on >=30 REAL resolved signals.
 * A4   guarded backfill of the four columns over the canonical population.
 * A4b  BEFORE-EXIT distribution (capturable) and AFTER-EXIT distribution
 *      (counterfactual) across every SL_AFTER_BE exit, reported separately.
 *
 * PINNED PARAMETERS — IDENTICAL to canonicalBook.ts. This is the SAME instrument
 * with new fields, not a new instrument:
 *   window 8h (Item 41a) | safeBarStart = emitted_at + 60s | fromScratch replay
 *   via the REAL resolveSignalWithBars | bars from gold_m1_bars (Supabase anon,
 *   direct) | population = every emitted signal the replay can decide.
 * Nothing about the replay changed. Only four additive columns are written.
 *
 * WRITE DISCIPLINE (F-29). The UPDATE carries
 * `.is('max_favourable_target_reached_before_exit', null)` so POSTGRES decides
 * idempotency atomically, exactly as the Item 179(d) features backfill used
 * `.eq('features','{}')`. A row already carrying a value can never be rewritten
 * by this script even if it gained one between the read and the write. Only the
 * four new columns appear in the payload: result, realized_r, exit_price, pnl,
 * ts and direction are unreachable from here.
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 + trade_outcomes_v1 via
 * Supabase DIRECT with the anon key (migration 005 grants the outcome upsert).
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeMaxFavourableExcursion, type MfeBar, type MfeResult } from '../services/maxFavourableExcursion';
import { computeEdgeMaxFavourableExcursion } from '../../backend/functions/resolve-emitted-signals/maxFavourableExcursion';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

interface SignalRow {
  signal_id: string; emitted_at: string; direction: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
  confidence: number; source: string;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
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
    tp1: Number(row.tp1), tp2: Number(row.tp2), tp3: Number(row.tp3),
    sl: Number(row.sl), confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    breakevenReached: false, breakevenTime: undefined,
  } as unknown as TradingSignal;
}

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp <= t) lo = m + 1; else hi = m; }
  return lo;
}

async function fetchAll<T>(
  client: ReturnType<typeof createClient>, table: string, select: string, orderCol: string,
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

const MFE_COLUMNS = [
  'max_favourable_target_reached_before_exit',
  'max_favourable_excursion_before_exit_r',
  'max_favourable_target_after_exit',
  'max_favourable_excursion_after_exit_r',
] as const;

/** Exact-equality comparison of the two implementations. No tolerance. */
function mfeEqual(a: MfeResult, b: MfeResult): boolean {
  return a.targetReachedBeforeExit === b.targetReachedBeforeExit
    && a.excursionBeforeExitR === b.excursionBeforeExitR
    && a.targetAfterExit === b.targetAfterExit
    && a.excursionAfterExitR === b.excursionAfterExitR;
}
const fmtMfe = (m: MfeResult): string =>
  `before[t=${m.targetReachedBeforeExit} r=${m.excursionBeforeExitR}] after[t=${m.targetAfterExit} r=${m.excursionAfterExitR}]`;

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const doWrite = process.argv.includes('--write');

  console.log(`\n${line}`);
  console.log('ITEM 224 / CHECKPOINT A — TP-AFTER-BE GAP: MFE FIELDS, PARITY, BACKFILL');
  console.log(line);
  console.log(`  run at            : ${new Date().toISOString()}`);
  console.log(`  mode              : ${doWrite ? 'WRITE (guarded UPDATE)' : 'DRY RUN (no writes)'}`);
  console.log(`  pinned            : 8h window (Item 41a), safeBarStart=emitted+60s, fromScratch, gold_m1_bars via anon key`);

  // ═════════════════════════════════════════════════════════════════════════
  // A2b — POST-MIGRATION LIVE COLUMN PROBE
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A2b — LIVE POSTGREST COLUMN PROBE OF trade_outcomes_v1 (AFTER migration 014 ran)');
  console.log(line);
  console.log('  WHY: migrations 010/011/012 sat unapplied for days while the code already wrote their');
  console.log('  columns, and the Item 149 guard printed PASS against its own stale inventory. A migration');
  console.log('  file in the repo is NOT a migration in the database. This asks the live schema directly.');
  const probe = await client.from('trade_outcomes_v1').select('*').limit(1);
  if (probe.error) { console.error(`  BLOCKER: probe failed: ${probe.error.message}`); process.exit(1); }
  const liveColumns = probe.data && probe.data.length > 0 ? Object.keys(probe.data[0]) : [];
  console.log(`  live column count : ${liveColumns.length}`);
  let allPresent = true;
  for (const col of MFE_COLUMNS) {
    const present = liveColumns.includes(col);
    if (!present) allPresent = false;
    console.log(`    ${present ? 'PRESENT' : 'ABSENT '}  ${col}`);
  }
  // Second, independent probe: select the four columns BY NAME. A typo'd or
  // absent column makes PostgREST fail loudly instead of silently returning rows.
  const named = await client.from('trade_outcomes_v1').select(MFE_COLUMNS.join(', ')).limit(1);
  console.log(`  named-column select: ${named.error ? `FAILED — ${named.error.message}` : 'OK (PostgREST accepted all four names)'}`);
  console.log(`  A2b VERDICT       : ${allPresent && !named.error ? 'PASS — all four columns exist in the LIVE schema' : 'FAIL — migration 014 is not live'}`);
  if (!allPresent || named.error) { console.error('  STOPPING: no field-writing code may be trusted until the columns are live.'); process.exit(1); }

  // ═════════════════════════════════════════════════════════════════════════
  // A3 — SYNTHETIC PARITY FIXTURE
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A3 — PARITY FIXTURE ON SYNTHETIC BARS (client impl vs edge impl, EXACT equality)');
  console.log(line);
  console.log('  HONEST SCOPE: the two resolvers\' TERMINAL LABELS legitimately differ on same-bar');
  console.log('  ambiguity (client uses an open-distance heuristic at signalResolver.ts:293-318; the edge');
  console.log('  resolver checks the lock BEFORE the targets at index.ts:410-470). That divergence class is');
  console.log('  documented and is NOT fixed here. These four FIELDS are ordering-independent max/touched');
  console.log('  scans, which is exactly why they CAN be made identical when the labels cannot.');

  interface Fixture { name: string; dir: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number; tp3: number; terminalTs: number; bars: MfeBar[] }
  const fx: Fixture[] = [
    {
      name: 'BUY: TP2 touched in the TERMINAL bar (the discarded same-bar case)',
      dir: 'BUY', entry: 4000, sl: 3980, tp1: 4014, tp2: 4021, tp3: 4028, terminalTs: 3,
      bars: [
        { timestamp: 1, high: 4005, low: 3999 },
        { timestamp: 2, high: 4015, low: 4008 },
        { timestamp: 3, high: 4022, low: 3990 },
        { timestamp: 4, high: 4030, low: 4020 },
      ],
    },
    {
      name: 'SELL: TP3 only AFTER the exit (the Item 204 counterfactual case)',
      dir: 'SELL', entry: 4000, sl: 4020, tp1: 3986, tp2: 3979, tp3: 3972, terminalTs: 2,
      bars: [
        { timestamp: 1, high: 4002, low: 3985 },
        { timestamp: 2, high: 4010, low: 3996 },
        { timestamp: 3, high: 3998, low: 3971 },
      ],
    },
    {
      name: 'BUY: never moved favourably at all (0/0 must stay 0/0, no floor)',
      dir: 'BUY', entry: 4000, sl: 3980, tp1: 4014, tp2: 4021, tp3: 4028, terminalTs: 2,
      bars: [
        { timestamp: 1, high: 3999, low: 3990 },
        { timestamp: 2, high: 3995, low: 3979 },
      ],
    },
    {
      name: 'SELL: terminal bar is the LAST bar (after-exit side legitimately empty)',
      dir: 'SELL', entry: 4000, sl: 4020, tp1: 3986, tp2: 3979, tp3: 3972, terminalTs: 3,
      bars: [
        { timestamp: 1, high: 4004, low: 3990 },
        { timestamp: 2, high: 3998, low: 3980 },
        { timestamp: 3, high: 3990, low: 3984 },
      ],
    },
    {
      name: 'BUY: degenerate zero risk (entry == sl) must yield all zeros, not NaN/Infinity',
      dir: 'BUY', entry: 4000, sl: 4000, tp1: 4014, tp2: 4021, tp3: 4028, terminalTs: 1,
      bars: [{ timestamp: 1, high: 4030, low: 3990 }],
    },
  ];

  let fxPass = 0;
  for (const f of fx) {
    const input = { direction: f.dir, entry: f.entry, sl: f.sl, tp1: f.tp1, tp2: f.tp2, tp3: f.tp3, terminalBarTs: f.terminalTs };
    const a = computeMaxFavourableExcursion(input, f.bars);
    const b = computeEdgeMaxFavourableExcursion(input, f.bars);
    const ok = mfeEqual(a, b);
    if (ok) fxPass += 1;
    console.log(`\n  ${ok ? 'PASS' : 'FAIL'}  ${f.name}`);
    console.log(`        client: ${fmtMfe(a)}`);
    console.log(`        edge  : ${fmtMfe(b)}`);
  }
  console.log(`\n  A3 VERDICT: ${fxPass}/${fx.length} fixtures agree EXACTLY  → ${fxPass === fx.length ? 'PASS' : 'FAIL'}`);

  // ═════════════════════════════════════════════════════════════════════════
  // Load the live corpus for A3b / A4 / A4b
  // ═════════════════════════════════════════════════════════════════════════
  const allSignalRows = await fetchAll<SignalRow>(client, 'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source', 'emitted_at');
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
  console.log(`\n  corpus loaded: ${allSignalRows.length} emitted signals, ${allBars.length} bars (through ${new Date(barsEndMs).toISOString()})`);

  // Canonical replay (pinned, unchanged) + MFE per signal.
  interface Replay {
    row: SignalRow; emittedMs: number; status: string; outcome: 'WIN' | 'LOSS' | null;
    terminalTs: number; bars: Bar[]; mfe: MfeResult | undefined;
  }
  const replays: Replay[] = [];
  const origLog = console.log;
  console.log = () => {};
  for (const row of allSignalRows) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const windowEnd = Math.min(emittedMs + WINDOW_MS, barsEndMs);
    const lo = lowerBound(allBars, emittedMs - SAFE_BAR_OFFSET_MS);
    const hi = upperBound(allBars, windowEnd);
    const bars = allBars.slice(lo, hi);
    if (bars.length === 0) continue;
    const res = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd });
    const evalBars = bars.filter(b => b.timestamp >= emittedMs + SAFE_BAR_OFFSET_MS);
    replays.push({
      row, emittedMs, status: String(res.newStatus), outcome: res.outcomeResult,
      terminalTs: res.resolvedAtBarTs ?? (evalBars.length > 0 ? evalBars[evalBars.length - 1].timestamp : emittedMs),
      bars: evalBars, mfe: res.maxFavourable,
    });
  }
  console.log = origLog;
  console.log(`  canonical fromScratch replay: ${replays.length} signals resolved`);

  // ═════════════════════════════════════════════════════════════════════════
  // A3b — PARITY ON REAL SIGNALS
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A3b — PARITY ON >=30 REAL RESOLVED SIGNALS (exact equality, disagreements by signal_id)');
  console.log(line);
  console.log('  WHY THIS AND NOT JUST THE FIXTURE: these two resolvers have diverged on REAL data before —');
  console.log('  that is the entire reason a parity question exists. A synthetic pass alone would be the');
  console.log('  weaker claim, so the same two implementations are run over real bars below.');
  const realParityPool = replays.filter(r => r.outcome !== null && r.mfe !== undefined);
  const disagreements: string[] = [];
  let realChecked = 0;
  for (const r of realParityPool) {
    const input = {
      direction: (r.row.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
      entry: Number(r.row.entry), sl: Number(r.row.sl),
      tp1: Number(r.row.tp1), tp2: Number(r.row.tp2), tp3: Number(r.row.tp3),
      terminalBarTs: r.terminalTs,
    };
    const a = computeMaxFavourableExcursion(input, r.bars);
    const b = computeEdgeMaxFavourableExcursion(input, r.bars);
    realChecked += 1;
    if (!mfeEqual(a, b)) {
      disagreements.push(`    ${r.row.signal_id}  client=${fmtMfe(a)}  edge=${fmtMfe(b)}`);
    }
    // Also assert the value the RESOLVER attached matches a fresh client compute,
    // i.e. the field actually shipped in ResolverOutcome is the field measured here.
    if (r.mfe && !mfeEqual(r.mfe, a)) {
      disagreements.push(`    ${r.row.signal_id}  RESOLVER-ATTACHED=${fmtMfe(r.mfe)}  fresh-client=${fmtMfe(a)}`);
    }
  }
  console.log(`  real signals compared        : ${realChecked} (requirement: >=30)`);
  console.log(`  exact-equality disagreements : ${disagreements.length}`);
  for (const d of disagreements.slice(0, 20)) console.log(d);
  const a3bPass = realChecked >= 30 && disagreements.length === 0;
  console.log(`  A3b VERDICT: ${a3bPass ? 'PASS' : 'FAIL'}${realChecked < 30 ? ' — FEWER THAN 30 REAL SIGNALS AVAILABLE (underpowered, not a pass)' : ''}`);
  if (disagreements.length > 0 && fxPass === fx.length) {
    console.log('  NOTE: synthetic fixtures passed while REAL data disagrees — the fixture is not modelling');
    console.log('  whatever differs. The synthetic pass is therefore NOT sufficient evidence.');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // A4 — GUARDED BACKFILL
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A4 — BACKFILL OF THE FOUR COLUMNS (server-side atomic guard, four columns only)');
  console.log(line);
  console.log('  GATE: the UPDATE carries .is(\'max_favourable_target_reached_before_exit\', null), so');
  console.log('  POSTGRES enforces write-once atomically — the F-29-safe form of the Item 179(d)');
  console.log('  .eq(\'features\',\'{}\') guard. Only the four new columns are in the payload; result,');
  console.log('  realized_r, exit_price, pnl, ts and direction are unreachable from this script.');

  const { data: outcomeIdRows, error: outcomeIdErr } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, max_favourable_target_reached_before_exit')
    .limit(10000);
  if (outcomeIdErr) throw new Error(`trade_outcomes_v1 read failed: ${outcomeIdErr.message}`);
  const outcomeState = new Map<string, unknown>();
  for (const o of (outcomeIdRows ?? []) as { signal_id: string; max_favourable_target_reached_before_exit: unknown }[]) {
    outcomeState.set(o.signal_id, o.max_favourable_target_reached_before_exit);
  }

  let scanned = 0, updated = 0, skippedAlreadySet = 0, skippedNoOutcomeRow = 0, skippedNoMfe = 0, failed = 0;
  for (const r of replays) {
    scanned += 1;
    if (!outcomeState.has(r.row.signal_id)) { skippedNoOutcomeRow += 1; continue; }
    if (outcomeState.get(r.row.signal_id) !== null && outcomeState.get(r.row.signal_id) !== undefined) { skippedAlreadySet += 1; continue; }
    if (!r.mfe) { skippedNoMfe += 1; continue; }
    if (!doWrite) { updated += 1; continue; }
    const { error } = await client
      .from('trade_outcomes_v1')
      .update({
        max_favourable_target_reached_before_exit: r.mfe.targetReachedBeforeExit,
        max_favourable_excursion_before_exit_r: r.mfe.excursionBeforeExitR,
        max_favourable_target_after_exit: r.mfe.targetAfterExit,
        max_favourable_excursion_after_exit_r: r.mfe.excursionAfterExitR,
      })
      .eq('signal_id', r.row.signal_id)
      .is('max_favourable_target_reached_before_exit', null);
    if (error) { failed += 1; if (failed <= 5) console.log(`    UPDATE failed ${r.row.signal_id.slice(-8)}: ${error.message}`); continue; }
    updated += 1;
  }
  console.log(`\n  rows scanned (replay-decided)         : ${scanned}`);
  console.log(`  rows ${doWrite ? 'UPDATED' : 'that WOULD be updated'}                : ${updated}`);
  console.log(`  skipped — column already non-null     : ${skippedAlreadySet}`);
  console.log(`  skipped — no trade_outcomes_v1 row    : ${skippedNoOutcomeRow}`);
  console.log(`  skipped — no MFE (entry never filled) : ${skippedNoMfe}`);
  console.log(`  UPDATE failures                       : ${failed}`);

  if (doWrite) {
    const { count: filledCount, error: verifyErr } = await client
      .from('trade_outcomes_v1')
      .select('signal_id', { count: 'exact', head: true })
      .not('max_favourable_target_reached_before_exit', 'is', null);
    console.log(`  POST-WRITE live verification: rows with a non-null before-exit target = ${verifyErr ? `ERROR ${verifyErr.message}` : filledCount}`);
    // Re-run the same guarded UPDATE once more: a correct guard must update ZERO rows.
    let secondPass = 0;
    for (const r of replays.slice(0, 25)) {
      if (!r.mfe || !outcomeState.has(r.row.signal_id)) continue;
      const { error, count } = await client
        .from('trade_outcomes_v1')
        .update({ max_favourable_target_reached_before_exit: r.mfe.targetReachedBeforeExit }, { count: 'exact' })
        .eq('signal_id', r.row.signal_id)
        .is('max_favourable_target_reached_before_exit', null);
      if (!error && typeof count === 'number') secondPass += count;
    }
    console.log(`  IDEMPOTENCY PROOF: re-running the guarded UPDATE over the first 25 rows touched ${secondPass} rows (must be 0)`);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // A4b — THE TWO DISTRIBUTIONS, SEPARATED
  // ═════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('A4b — SL_AFTER_BE EXITS: BEFORE-EXIT (CAPTURABLE) vs AFTER-EXIT (COUNTERFACTUAL)');
  console.log(line);
  const slAfterBe = replays.filter(r => r.status === 'SL_AFTER_BE' && r.mfe !== undefined);
  const before: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  const after: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let bestBeforeR = -Infinity, bestAfterR = -Infinity, sumBeforeR = 0, sumAfterR = 0;
  for (const r of slAfterBe) {
    const m = r.mfe as MfeResult;
    before[m.targetReachedBeforeExit] = (before[m.targetReachedBeforeExit] ?? 0) + 1;
    after[m.targetAfterExit] = (after[m.targetAfterExit] ?? 0) + 1;
    sumBeforeR += m.excursionBeforeExitR; sumAfterR += m.excursionAfterExitR;
    if (m.excursionBeforeExitR > bestBeforeR) bestBeforeR = m.excursionBeforeExitR;
    if (m.excursionAfterExitR > bestAfterR) bestAfterR = m.excursionAfterExitR;
  }
  const n = slAfterBe.length;
  console.log(`  SL_AFTER_BE exits in the canonical replay: n=${n}`);
  console.log(`\n  ── BEFORE EXIT — CAPTURABLE (what a different exit rule could actually have banked) ──`);
  console.log(`     highest target touched at or before the terminal bar:`);
  for (const k of [0, 1, 2, 3]) {
    const pct = n > 0 ? ((before[k] / n) * 100).toFixed(1) : '0.0';
    console.log(`       TP${k === 0 ? '0 (none)' : k}: ${String(before[k]).padStart(3)}  (${pct}%)`);
  }
  const tp2PlusBefore = (before[2] ?? 0) + (before[3] ?? 0);
  console.log(`     reached TP2 or better BEFORE the exit: ${tp2PlusBefore}/${n} (${n > 0 ? ((tp2PlusBefore / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`     mean before-exit excursion: ${n > 0 ? (sumBeforeR / n).toFixed(4) : 'n/a'}R   max: ${Number.isFinite(bestBeforeR) ? bestBeforeR.toFixed(4) : 'n/a'}R`);
  console.log(`\n  ── AFTER EXIT — COUNTERFACTUAL (position ALREADY CLOSED; Item 204 continuation only) ──`);
  console.log(`     THIS IS NOT CAPTURABLE. It cannot be banked by any exit rule, because the trade was`);
  console.log(`     already terminal when these levels printed. Never quote it as realisable P&L.`);
  for (const k of [0, 1, 2, 3]) {
    const pct = n > 0 ? ((after[k] / n) * 100).toFixed(1) : '0.0';
    console.log(`       TP${k === 0 ? '0 (none)' : k}: ${String(after[k]).padStart(3)}  (${pct}%)`);
  }
  const tp2PlusAfter = (after[2] ?? 0) + (after[3] ?? 0);
  console.log(`     reached TP2 or better AFTER the exit: ${tp2PlusAfter}/${n} (${n > 0 ? ((tp2PlusAfter / n) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`     mean after-exit excursion: ${n > 0 ? (sumAfterR / n).toFixed(4) : 'n/a'}R   max: ${Number.isFinite(bestAfterR) ? bestAfterR.toFixed(4) : 'n/a'}R`);

  // Whole-book context so the SL_AFTER_BE numbers are not read in isolation.
  const decided = replays.filter(r => r.outcome !== null && r.mfe !== undefined);
  const bookBefore: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const r of decided) bookBefore[(r.mfe as MfeResult).targetReachedBeforeExit] += 1;
  console.log(`\n  whole-book before-exit target mix (n=${decided.length}, all terminal types): ${JSON.stringify(bookBefore)}`);

  console.log(`\n${line}`);
  console.log('A5 — WHAT THIS UNLOCKS (statement only; the lock question is NOT reopened on this data)');
  console.log(line);
  console.log('  The lock question (Items 202-204) closed EV-NEUTRAL on a properly paired replay, and this');
  console.log('  round does not revisit that verdict. What changes is the INSTRUMENT: a per-signal MFE');
  console.log('  column means any future exit-rule question can be asked with a SQL query over durable');
  console.log('  per-signal facts instead of standing up an aggregate replay harness whose parameters have');
  console.log('  to be re-pinned and re-argued each time. The before/after split is what makes that safe:');
  console.log('  the capturable column can inform an exit rule; the counterfactual column can only ever');
  console.log('  describe continuation.');
  console.log(`\nDONE — additive fields only. No terminal status, result or realized_r was read or written.\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
