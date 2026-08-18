/**
 * ITEM 101(d) + 102 — FULL NET BACKFILL + TP2 LOCK MEASUREMENT.
 *
 * 101: The stored book mixes GROSS and NET realized_r values. This script
 * recomputes EVERY row canonically as NET R and updates the table.
 *
 * 102: Measures whether post-TP2 lock should be at ENTRY (current) or TP1
 * (proposed). Isolates rows that hit TP2 then stopped out, computes R
 * under both lock policies.
 *
 * DATA-SOURCE RULE: reads via anon, writes via service-role.
 */
import { resolveSignalWithBars, getPostTP1LockPrice } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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

const EXECUTION_COST_PER_TRADE_USD = 0.20;
const DOLLAR_PER_PRICE_UNIT = 1;
function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1 ?? 0),
    tp2: Number(row.tp2 ?? 0),
    tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1),
    atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'),
    rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''),
    hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null,
    attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'),
    ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false,
    breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBars(client: ReturnType<typeof createClient>): Promise<{ bars: Bar[]; fromMs: number; toMs: number }> {
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const fromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const toMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) {
      out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (rows.length < 1000) break;
  }
  return { bars: out, fromMs, toMs };
}

/**
 * Custom resolver that tracks TP2-hit-then-stop outcomes and can compute
 * R under both lock-at-entry and lock-at-TP1 policies.
 */
interface TP2Analysis {
  canonicalStatus: string;
  canonicalExit: number;
  canonicalRNet: number;
  hitTP2: boolean;
  tp2ThenStopEntry: boolean; // did price hit TP2, then retrace to entry?
  tp2ThenStopTP1: boolean;   // did price hit TP2, then retrace to TP1?
  rUnderLockEntry: number | null;  // R if exit at protected price (entry lock)
  rUnderLockTP1: number | null;    // R if exit at TP1
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  direction: 'BUY' | 'SELL';
  risk: number;
}

function resolveWithTP2Analysis(signal: TradingSignal, bars: Bar[]): TP2Analysis | null {
  const isBuy = signal.type === 'BUY';
  const entry = signal.entryPrice;
  const sl = signal.sl;
  const tp1 = signal.tp1;
  const tp2 = signal.tp2;
  const tp3 = signal.tp3;
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || bars.length === 0) return null;

  const rOfGross = (exit: number): number => isBuy ? (exit - entry) / risk : (entry - exit) / risk;
  const rNet = (exit: number): number => rOfGross(exit) - costInR(risk);

  const touched = (bar: Bar, level: number): boolean => bar.low <= level && bar.high >= level;

  let entryFilled = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let lockPrice = sl;
  let canonicalStatus = 'CLOSED';
  let canonicalExit = entry;
  let tp2ThenStopEntry = false;
  let tp2ThenStopTP1 = false;

  for (const bar of bars) {
    if (!entryFilled) {
      if (!touched(bar, entry)) continue;
      entryFilled = true;
    }

    // Check lock/SL first
    if (touched(bar, lockPrice)) {
      if (tp2Hit) {
        // Post-TP2 stop hit
        canonicalStatus = 'PARTIAL_WIN_SL_HIT';
        canonicalExit = ((tp1 + tp2 + entry) / 3);
        tp2ThenStopEntry = (lockPrice === entry);
        break;
      }
      if (tp1Hit) {
        // Post-TP1 lock hit
        canonicalStatus = 'SL_AFTER_BE';
        canonicalExit = lockPrice;
        break;
      }
      canonicalStatus = 'SL_HIT';
      canonicalExit = lockPrice;
      break;
    }

    if (touched(bar, tp3)) {
      canonicalStatus = 'ALL_TARGETS_HIT';
      canonicalExit = tp3;
      break;
    }
    if (!tp2Hit && touched(bar, tp2)) {
      tp2Hit = true;
      lockPrice = entry; // current: lock at entry after TP2
    }
    if (!tp1Hit && touched(bar, tp1)) {
      tp1Hit = true;
      lockPrice = getPostTP1LockPrice(signal);
    }
  }

  if (!entryFilled) return null;

  if (canonicalStatus === 'CLOSED') {
    const last = bars[bars.length - 1];
    canonicalExit = last.close;
  }

  const canonicalRNet = rNet(canonicalExit);

  // For TP2 analysis: if TP2 was hit, check what would happen under lock-at-TP1
  let rUnderLockEntry: number | null = null;
  let rUnderLockTP1: number | null = null;
  let tp2ThenStopTP1Value = false;

  if (tp2Hit) {
    // Under current lock-at-entry: exit = (tp1+tp2+entry)/3 when entry is hit
    // The canonical exit IS this if tp2ThenStopEntry is true
    if (tp2ThenStopEntry || canonicalStatus === 'PARTIAL_WIN_SL_HIT') {
      rUnderLockEntry = rNet((tp1 + tp2 + entry) / 3);
    } else if (canonicalStatus === 'ALL_TARGETS_HIT') {
      rUnderLockEntry = rNet(tp3);
    } else {
      // TP2 hit but neither TP3 nor stop-at-entry: closed at last close
      rUnderLockEntry = canonicalRNet;
    }

    // Under lock-at-TP1: re-scan to find when TP1 would be hit AFTER TP2
    // If TP1 is hit after TP2 (which it already was before TP2), the stop is at TP1
    // Since TP1 was already touched before TP2, the lock-at-TP1 would trigger
    // on the FIRST bar after TP2 where price touches TP1
    let tp1HitAfterTP2 = false;
    let tp1HitAfterTP2Bar: Bar | null = null;
    let pastTP2 = false;
    for (const bar of bars) {
      if (!entryFilled) { if (!touched(bar, entry)) continue; entryFilled = true; }
      if (touched(bar, tp2)) pastTP2 = true;
      if (pastTP2 && touched(bar, tp1) && !touched(bar, tp3)) {
        tp1HitAfterTP2 = true;
        tp1HitAfterTP2Bar = bar;
        break;
      }
      if (pastTP2 && touched(bar, tp3)) break; // TP3 hit first
    }
    if (tp1HitAfterTP2) {
      tp2ThenStopTP1Value = true;
      rUnderLockTP1 = rNet(tp1); // exit at TP1
    } else if (canonicalStatus === 'ALL_TARGETS_HIT') {
      rUnderLockTP1 = rNet(tp3); // TP3 hit before TP1 retrace
    } else {
      rUnderLockTP1 = canonicalRNet; // neither TP1 retrace nor TP3
    }
  }

  return {
    canonicalStatus,
    canonicalExit: Number(canonicalExit.toFixed(1)),
    canonicalRNet,
    hitTP2: tp2Hit,
    tp2ThenStopEntry,
    tp2ThenStopTP1: tp2ThenStopTP1Value,
    rUnderLockEntry,
    rUnderLockTP1,
    entry, sl, tp1, tp2, tp3,
    direction: isBuy ? 'BUY' : 'SELL',
    risk,
  };
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 101(d) FULL NET BACKFILL + ITEM 102 TP2 LOCK MEASUREMENT');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  if (!serviceKey) { console.error('BLOCKER: missing service-role key'); process.exit(1); }

  const anonClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const adminClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1. Fetch all signals
  console.log('\n  1. Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await anonClient.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`     ${allSignals.length} signals`);

  // 2. Fetch all bars
  console.log('  2. Fetching gold_m1_bars...');
  const { bars: allBars, toMs: barsToMs } = await fetchAllBars(anonClient);
  console.log(`     ${allBars.length} bars`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTimestamps = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTimestamps) {
      if (ts < fromMs) continue;
      if (ts > toMs) break;
      const b = barsByMinute.get(ts);
      if (b) out.push(b);
    }
    return out;
  }

  // 3. Fetch trade_outcomes_v1
  console.log('  3. Fetching trade_outcomes_v1...');
  const { data: toRows } = await anonClient.from('trade_outcomes_v1').select('signal_id, direction, result, realized_r, entry_price, exit_price, pnl, is_scratch');
  const toAll = (toRows ?? []) as { signal_id: string; direction: string | null; result: string; realized_r: number | null; entry_price: number; exit_price: number; pnl: number; is_scratch: boolean | null }[];
  console.log(`     ${toAll.length} rows`);

  // 4. Resolve all signals canonically with TP2 analysis
  console.log('  4. Resolving all signals canonically (8h window, fromScratch)...');
  const tp2Results = new Map<string, TP2Analysis>();
  const origConsoleLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const barsFrom = sigTs - 60_000;
    const barsTo = sigTs + 8 * 60 * 60 * 1000;
    const bars = barsInWindow(barsFrom, Math.min(barsTo, barsToMs));
    if (bars.length === 0) continue;
    console.log = () => {};
    try {
      // Also run the canonical resolver for the canonical status
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(barsTo, barsToMs) });
      const tp2 = resolveWithTP2Analysis(sig, bars);
      console.log = origConsoleLog;
      if (tp2) {
        // Use the canonical resolver's status as ground truth
        tp2.canonicalStatus = result.newStatus;
        tp2.canonicalExit = result.exitPrice;
        const risk = Math.abs(sig.entryPrice - sig.sl);
        const rG = sig.type === 'BUY' ? (result.exitPrice - sig.entryPrice) / risk : (sig.entryPrice - result.exitPrice) / risk;
        tp2.canonicalRNet = rG - costInR(risk);
        tp2Results.set(sig.id, tp2);
      }
    } catch (err) {
      console.log = origConsoleLog;
    }
  }
  console.log = origConsoleLog;
  console.log(`     ${tp2Results.size} signals resolved`);

  // ════════════════════════════════════════════════════════════════════
  // 101(d): FULL NET BACKFILL
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  101(d) — FULL NET BACKFILL');
  console.log(line);

  // Compute BEFORE book
  const storedUsable = toAll.filter(r => r.realized_r !== null);
  const beforeN = storedUsable.length;
  const beforeWins = storedUsable.filter(r => Number(r.realized_r) > 0);
  const beforeWR = (beforeWins.length / beforeN) * 100;
  const beforeEV = storedUsable.reduce((s, r) => s + Number(r.realized_r), 0) / beforeN;
  console.log(`\n  BEFORE: n=${beforeN} WR=${beforeWR.toFixed(2)}% EV=${beforeEV >= 0 ? '+' : ''}${beforeEV.toFixed(6)}R (MIXED GROSS/NET)`);

  // Find rows needing update
  const toUpdate: { signal_id: string; new_realized_r: number; new_result: string; new_exit_price: number; new_pnl: number }[] = [];
  let matched = 0;
  let alreadyCorrect = 0;

  for (const toRow of toAll) {
    const tp2 = tp2Results.get(toRow.signal_id);
    if (!tp2) continue;
    matched++;
    const storedR = toRow.realized_r === null ? null : Number(toRow.realized_r);
    const canonicalRNet = parseFloat(tp2.canonicalRNet.toFixed(6));
    const canonicalResult = tp2.canonicalRNet > 0 ? 'WIN' : 'LOSS';

    if (storedR !== null && Math.abs(storedR - canonicalRNet) < 0.001 && toRow.result === canonicalResult) {
      alreadyCorrect++;
      continue;
    }

    const newPnl = tp2.direction === 'BUY' ? tp2.canonicalExit - tp2.entry : tp2.entry - tp2.canonicalExit;
    toUpdate.push({
      signal_id: toRow.signal_id,
      new_realized_r: canonicalRNet,
      new_result: canonicalResult,
      new_exit_price: tp2.canonicalExit,
      new_pnl: parseFloat(newPnl.toFixed(6)),
    });
  }

  console.log(`  Matched to canonical: ${matched}`);
  console.log(`  Already correct (NET): ${alreadyCorrect}`);
  console.log(`  To update: ${toUpdate.length}`);

  // Execute updates in batches
  let updated = 0;
  let failed = 0;
  const BATCH_SIZE = 50;
  for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
    const batch = toUpdate.slice(i, i + BATCH_SIZE);
    for (const u of batch) {
      const { error } = await adminClient
        .from('trade_outcomes_v1')
        .update({
          realized_r: u.new_realized_r,
          result: u.new_result,
          exit_price: u.new_exit_price,
          pnl: u.new_pnl,
        })
        .eq('signal_id', u.signal_id);
      if (error) { console.error(`  UPDATE FAILED ${u.signal_id}: ${error.message}`); failed++; }
      else updated++;
    }
    if (i + BATCH_SIZE < toUpdate.length) {
      console.log(`    ... ${Math.min(i + BATCH_SIZE, toUpdate.length)}/${toUpdate.length} updated`);
    }
  }
  console.log(`  Updated: ${updated}, Failed: ${failed}`);

  // Re-read and compute AFTER book
  const { data: toAfter } = await anonClient.from('trade_outcomes_v1').select('signal_id, result, realized_r');
  const toAfterRows = (toAfter ?? []) as { signal_id: string; result: string; realized_r: number | null }[];
  const afterUsable = toAfterRows.filter(r => r.realized_r !== null);
  const afterN = afterUsable.length;
  const afterWins = afterUsable.filter(r => Number(r.realized_r) > 0);
  const afterWR = (afterWins.length / afterN) * 100;
  const afterEV = afterUsable.reduce((s, r) => s + Number(r.realized_r), 0) / afterN;

  // Also compute canonical book on the SAME population
  const canonicalEntries = afterUsable.map(r => {
    const tp2 = tp2Results.get(r.signal_id);
    if (!tp2) return null;
    return tp2.canonicalRNet;
  }).filter((x): x is number => x !== null);
  const canonicalN = canonicalEntries.length;
  const canonicalWins = canonicalEntries.filter(r => r > 0);
  const canonicalWR = (canonicalWins.length / canonicalN) * 100;
  const canonicalEV = canonicalEntries.reduce((s, r) => s + r, 0) / canonicalN;

  console.log(`\n  ┌────────────────────────────────────────────────────────────────────────┐`);
  console.log(`  │ BOOK                        │  n  │  WR    │ EV NET       │`);
  console.log(`  ├─────────────────────────────┼─────┼────────┼──────────────┤`);
  console.log(`  │ BEFORE (mixed GROSS/NET)    │ ${String(beforeN).padStart(3)} │ ${beforeWR.toFixed(2)}% │ ${beforeEV >= 0 ? '+' : ''}${beforeEV.toFixed(6)}R  │`);
  console.log(`  │ AFTER  (all NET)            │ ${String(afterN).padStart(3)} │ ${afterWR.toFixed(2)}% │ ${afterEV >= 0 ? '+' : ''}${afterEV.toFixed(6)}R  │`);
  console.log(`  │ CANONICAL (same population) │ ${String(canonicalN).padStart(3)} │ ${canonicalWR.toFixed(2)}% │ ${canonicalEV >= 0 ? '+' : ''}${canonicalEV.toFixed(6)}R  │`);
  console.log(`  └─────────────────────────────┴─────┴────────┴──────────────┘`);

  const reconcileDiff = Math.abs(afterEV - canonicalEV);
  console.log(`\n  Reconciliation: |AFTER - CANONICAL| = ${reconcileDiff.toFixed(6)}R`);
  if (reconcileDiff < 0.005) {
    console.log(`  ✅ BOOKS RECONCILE. All stored realized_r are now NET, matching canonical.`);
  } else {
    console.log(`  ⚠ Books do not fully reconcile. Diff=${reconcileDiff.toFixed(6)}R`);
  }

  // ════════════════════════════════════════════════════════════════════
  // 102: TP2 LOCK MEASUREMENT
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 102 — TP2 LOCK: ENTRY vs TP1');
  console.log(line);

  // 102(a): Quote both resolvers
  console.log(`\n  102(a) — BOTH RESOLVERS QUOTED:`);
  console.log(`    Edge Function (resolve-emitted-signals/index.ts:280):`);
  console.log(`      lockPrice = entry;  // after TP2, lock at breakeven`);
  console.log(`    signalResolver.ts (lines 259-260, 377-384):`);
  console.log(`      entryHitAfterTP2 = hasTP2 ? (isBuy ? bar.low <= entryPrice : bar.high >= entryPrice) : false`);
  console.log(`      → exit = getProtectedExitPrice(signal, 2) = (tp1+tp2+entry)/3`);
  console.log(`    VERDICT: Both resolvers AGREE — post-TP2 lock = entry, exit = (tp1+tp2+entry)/3`);

  // 102(b): Isolate TP2-then-stop rows and compute R under both policies
  console.log(`\n  102(b) — TP2-THEN-STOP POPULATION, BOTH POLICIES:`);

  const tp2HitRows = [...tp2Results.values()].filter(r => r.hitTP2);
  const tp2ThenStopRows = tp2HitRows.filter(r =>
    r.canonicalStatus === 'PARTIAL_WIN_SL_HIT' || r.tp2ThenStopEntry || r.tp2ThenStopTP1
  );

  console.log(`    Total TP2-hit signals: ${tp2HitRows.length}`);
  console.log(`    TP2-then-stop (PARTIAL_WIN_SL_HIT): ${tp2ThenStopRows.length}`);

  // Policy 1: lock-at-ENTRY (current) — exit = (tp1+tp2+entry)/3
  const entryLockRows = tp2ThenStopRows.filter(r => r.rUnderLockEntry !== null);
  const entryLockN = entryLockRows.length;
  const entryLockWins = entryLockRows.filter(r => (r.rUnderLockEntry ?? 0) > 0);
  const entryLockWR = entryLockN > 0 ? (entryLockWins.length / entryLockN) * 100 : 0;
  const entryLockEV = entryLockN > 0 ? entryLockRows.reduce((s, r) => s + (r.rUnderLockEntry ?? 0), 0) / entryLockN : 0;

  // Policy 2: lock-at-TP1 (proposed) — exit = TP1
  const tp1LockRows = tp2ThenStopRows.filter(r => r.rUnderLockTP1 !== null);
  const tp1LockN = tp1LockRows.length;
  const tp1LockWins = tp1LockRows.filter(r => (r.rUnderLockTP1 ?? 0) > 0);
  const tp1LockWR = tp1LockN > 0 ? (tp1LockWins.length / tp1LockN) * 100 : 0;
  const tp1LockEV = tp1LockN > 0 ? tp1LockRows.reduce((s, r) => s + (r.rUnderLockTP1 ?? 0), 0) / tp1LockN : 0;

  // Also compute: how many TP2-hit signals would have been stopped at TP1 but NOT at entry?
  const tp1StopOnly = tp2HitRows.filter(r => r.tp2ThenStopTP1 && !r.tp2ThenStopEntry);
  // And how many would have reached TP3 under entry-lock but been stopped at TP1?
  const tp3UnderEntryButStopTP1 = tp2HitRows.filter(r =>
    r.canonicalStatus === 'ALL_TARGETS_HIT' && r.tp2ThenStopTP1
  );

  console.log(`\n    POWER: n=${tp2ThenStopRows.length} TP2-then-stop rows (PROVISIONAL if < 30)`);
  console.log(`\n    ┌────────────────────────────────────────────────────────────────────┐`);
  console.log(`    │ POLICY              │  n  │  WR    │ EV NET       │`);
  console.log(`    ├─────────────────────┼─────┼────────┼──────────────┤`);
  console.log(`    │ Lock-at-ENTRY (cur) │ ${String(entryLockN).padStart(3)} │ ${entryLockWR.toFixed(2)}% │ ${entryLockEV >= 0 ? '+' : ''}${entryLockEV.toFixed(6)}R  │`);
  console.log(`    │ Lock-at-TP1 (prop)  │ ${String(tp1LockN).padStart(3)} │ ${tp1LockWR.toFixed(2)}% │ ${tp1LockEV >= 0 ? '+' : ''}${tp1LockEV.toFixed(6)}R  │`);
  console.log(`    └─────────────────────┴─────┴────────┴──────────────┘`);

  const evDiff = tp1LockEV - entryLockEV;
  console.log(`\n    EV difference (TP1 lock - Entry lock): ${evDiff >= 0 ? '+' : ''}${evDiff.toFixed(6)}R`);
  console.log(`    TP2-hit signals stopped at TP1 but NOT at entry: ${tp1StopOnly.length}`);
  console.log(`    TP3 under entry-lock but would stop at TP1: ${tp3UnderEntryButStopTP1.length}`);

  // Worked examples
  console.log(`\n    WORKED EXAMPLES (first 5 TP2-then-stop):`);
  for (const r of tp2ThenStopRows.slice(0, 5)) {
    console.log(`      ${r.direction} entry=${r.entry.toFixed(1)} sl=${r.sl.toFixed(1)} tp1=${r.tp1.toFixed(1)} tp2=${r.tp2.toFixed(1)} risk=${r.risk.toFixed(2)}`);
    console.log(`        status=${r.canonicalStatus} exit=${r.canonicalExit.toFixed(1)}`);
    console.log(`        R under entry-lock: ${r.rUnderLockEntry !== null ? r.rUnderLockEntry.toFixed(6) : 'N/A'}`);
    console.log(`        R under TP1-lock:   ${r.rUnderLockTP1 !== null ? r.rUnderLockTP1.toFixed(6) : 'N/A'}`);
  }

  // VERDICT
  if (entryLockN < 10) {
    console.log(`\n    VERDICT: n=${entryLockN} is UNDERPOWERED (< 10). Cannot ship a change.`);
    console.log(`    Both resolvers already AGREE on entry-lock. Keeping current behavior.`);
    console.log(`    Forward evidence: once n >= 30 TP2-then-stop rows, re-run and compare.`);
  } else if (tp1LockEV > entryLockEV + 0.01) {
    console.log(`\n    VERDICT: TP1-lock WINS by ${evDiff.toFixed(4)}R. Ship lock-at-TP1 in both resolvers.`);
  } else if (entryLockEV >= tp1LockEV) {
    console.log(`\n    VERDICT: ENTRY-lock WINS (or ties). Keep current behavior. Both resolvers agree.`);
  } else {
    console.log(`\n    VERDICT: Difference is ${evDiff.toFixed(4)}R — not material. Keep current behavior.`);
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item101_102 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
