/**
 * BLOCK A — RESOLVE THE FULL POPULATION CANONICALLY.
 *
 * Runs resolveSignalWithBars(fromScratch: true) against every row in
 * emitted_signals_v1 (417 rows: 413 BACKFILL + 4 LIVE), not just the 4 LIVE
 * rows Item 88 touched. Reports: rows attempted, rows resolved, rows with
 * insufficient bar coverage (with the gap's date range), rows that never
 * filled (NEVER_FILLABLE / EXPIRED_MISSED_ENTRY).
 *
 * Then computes the canonical book GROSS and NET (at the closed $0.20/trade
 * execution cost) and reconciles against:
 *   - the app's SECTION 4 (n=414, WR 61.8%, PF 1.15) — computed from
 *     signalEngine.ts's in-memory tradeOutcomes, itself derived from
 *     learningStore rows synced FROM trade_outcomes_v1.
 *   - trade_outcomes_v1.realized_r directly (n=402 rows found this round —
 *     the summary's "n=340" was a prior round's snapshot at a smaller count).
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 + trade_outcomes_v1
 * reads = Supabase DIRECT via anon key. READ-ONLY. No writes.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
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

const EXECUTION_COST_R_DOLLARS = 0.20; // closed cost per trade, dollars
const DOLLAR_PER_R_UNIT_APPROX = 10; // XAUUSD: 1 lot std sizing approx used elsewhere in prior rounds

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
    slPips: 70,
    tp1Pips: 49,
    tp2Pips: 74,
    tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBarsInRange(client: ReturnType<typeof createClient>, fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', fromIso)
      .lte('timestamp', toIso)
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('BLOCK A — FULL-POPULATION CANONICAL RESOLUTION');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // A-1: fetch ALL emitted_signals_v1 rows
  console.log('\n  A-1 — FETCHING FULL POPULATION');
  console.log(line);
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`BLOCKER: signal fetch failed: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`  emitted_signals_v1 total rows fetched: ${allSignals.length}`);
  const bySource: Record<string, number> = {};
  for (const r of allSignals) bySource[String(r.source)] = (bySource[String(r.source)] ?? 0) + 1;
  console.log(`  by source: ${JSON.stringify(bySource)}`);

  // Determine bar coverage range once
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  console.log(`  gold_m1_bars coverage: ${new Date(barsFromMs).toISOString()} -> ${new Date(barsToMs).toISOString()}`);

  // Pull ALL bars once into memory (14,000ish 1-min bars over ~2 months = ~87,000 rows worst case).
  // Fetch in chunks by month to keep query sizes sane, then index by minute.
  console.log(`\n  Fetching full gold_m1_bars corpus into memory (paginated)...`);
  const t0 = Date.now();
  const allBars = await fetchAllBarsInRange(client, barsFromMs, barsToMs);
  console.log(`  fetched ${allBars.length} bars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTimestamps = allBars.map(b => b.timestamp).sort((a, b) => a - b);

  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    // binary search would be faster; linear filter is fine for a one-shot batch script
    const out: Bar[] = [];
    for (const ts of sortedTimestamps) {
      if (ts < fromMs) continue;
      if (ts > toMs) break;
      const b = barsByMinute.get(ts);
      if (b) out.push(b);
    }
    return out;
  }

  console.log(`\n  A-1 — RESOLVING EVERY ROW (fromScratch: true, 4h evaluation window)`);
  console.log(line);

  let attempted = 0;
  let resolvedWin = 0;
  let resolvedLoss = 0;
  let neverFillable = 0;
  let expiredMissedEntry = 0;
  let closedFlat = 0;
  let insufficientBars = 0;
  let stillActive = 0;
  const insufficientGaps: { id: string; from: string; to: string }[] = [];
  const results: { id: string; direction: string; emittedAt: string; status: string; outcomeResult: 'WIN' | 'LOSS' | null; exitPrice: number; entry: number; sl: number; tp1: number; entryVia: string | null }[] = [];

  const suppressLogs = true;
  const origConsoleLog = console.log;

  for (const row of allSignals) {
    attempted++;
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const barsFrom = sigTs - 60_000;
    const barsTo = sigTs + 4 * 60 * 60 * 1000;

    if (barsTo > barsToMs + 5 * 60_000) {
      // signal's evaluation window extends beyond available bar coverage; still
      // attempt with whatever bars exist (partial), but flag if ZERO bars exist.
    }

    const bars = barsInWindow(barsFrom, Math.min(barsTo, barsToMs));

    if (bars.length === 0) {
      insufficientBars++;
      insufficientGaps.push({ id: sig.id, from: new Date(barsFrom).toISOString(), to: new Date(Math.min(barsTo, barsToMs)).toISOString() });
      continue;
    }

    const evalNowMs = Math.min(barsTo, barsToMs);
    try {
      if (suppressLogs) console.log = () => {};
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs });
      if (suppressLogs) console.log = origConsoleLog;

      results.push({
        id: sig.id, direction: sig.type, emittedAt: new Date(sigTs).toISOString(),
        status: result.newStatus, outcomeResult: result.outcomeResult, exitPrice: result.exitPrice,
        entry: sig.entryPrice, sl: sig.sl, tp1: sig.tp1, entryVia: result.entryVia ?? null,
      });

      if (result.newStatus === 'NEVER_FILLABLE') neverFillable++;
      else if (result.newStatus === 'EXPIRED_MISSED_ENTRY') expiredMissedEntry++;
      else if (result.newStatus === 'CLOSED') closedFlat++;
      else if (result.newStatus === 'ACTIVE' || result.newStatus === 'TP1_HIT' || result.newStatus === 'TP2_HIT') stillActive++;
      else if (result.outcomeResult === 'WIN') resolvedWin++;
      else if (result.outcomeResult === 'LOSS') resolvedLoss++;
    } catch (err) {
      if (suppressLogs) console.log = origConsoleLog;
      console.log(`  ${sig.id} — RESOLVER THREW: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  A-1 RESULTS:`);
  console.log(`    rows attempted             : ${attempted}`);
  console.log(`    resolved WIN               : ${resolvedWin}`);
  console.log(`    resolved LOSS              : ${resolvedLoss}`);
  console.log(`    NEVER_FILLABLE (excl. EV)  : ${neverFillable}`);
  console.log(`    EXPIRED_MISSED_ENTRY       : ${expiredMissedEntry}`);
  console.log(`    CLOSED flat (no result)    : ${closedFlat}`);
  console.log(`    still ACTIVE/TP1/TP2 (imm) : ${stillActive}`);
  console.log(`    insufficient bar coverage  : ${insufficientBars}`);
  if (insufficientGaps.length > 0) {
    console.log(`    insufficient-coverage rows (id, needed window):`);
    for (const g of insufficientGaps.slice(0, 20)) console.log(`      ${g.id.slice(-12)}  ${g.from} -> ${g.to}`);
    if (insufficientGaps.length > 20) console.log(`      ... and ${insufficientGaps.length - 20} more`);
  }
  const totalDecided = resolvedWin + resolvedLoss;
  console.log(`\n  total decided (WIN+LOSS)   : ${totalDecided}`);

  // A-2: CANONICAL BOOK GROSS + NET
  console.log(`\n  A-2 — CANONICAL BOOK`);
  console.log(line);

  function computeR(res: typeof results[number]): number | null {
    if (res.outcomeResult === null) return null;
    const risk = Math.abs(res.entry - res.sl);
    if (!Number.isFinite(risk) || risk <= 0) return null;
    const raw = res.direction === 'BUY' ? (res.exitPrice - res.entry) / risk : (res.entry - res.exitPrice) / risk;
    return raw;
  }

  const decided = results.filter(r => r.outcomeResult !== null);
  const rGross = decided.map(r => ({ ...r, r: computeR(r) })).filter(r => r.r !== null) as (typeof results[number] & { r: number })[];
  const n = rGross.length;
  const wins = rGross.filter(r => r.r > 0);
  const losses = rGross.filter(r => r.r <= 0);
  const wr = n > 0 ? (wins.length / n) * 100 : 0;
  const sumWinR = wins.reduce((s, r) => s + r.r, 0);
  const sumLossR = losses.reduce((s, r) => s + Math.abs(r.r), 0);
  const evGross = n > 0 ? rGross.reduce((s, r) => s + r.r, 0) / n : 0;
  const pfGross = sumLossR > 0 ? sumWinR / sumLossR : Infinity;

  console.log(`  GROSS (n=${n}):`);
  console.log(`    WR  : ${wr.toFixed(2)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`    EV  : ${evGross >= 0 ? '+' : ''}${evGross.toFixed(4)}R`);
  console.log(`    PF  : ${pfGross.toFixed(3)}`);

  // NET at $0.20 cost per trade. Cost expressed in R terms requires a $/R conversion.
  // Use the SAME risk-distance-to-R convention as the resolver (R = pnl/riskDistance);
  // cost in R = costDollars / (riskDistance * dollarPerPriceUnit). Since dollarPerPriceUnit
  // is a position-sizing constant not stored per-row, express cost net R using the MEDIAN
  // risk distance across the resolved population, stated explicitly as an approximation.
  const riskDistances = rGross.map(r => Math.abs(r.entry - r.sl)).sort((a, b) => a - b);
  const medianRisk = riskDistances.length > 0 ? riskDistances[Math.floor(riskDistances.length / 2)] : 0;
  // netR.ts convention check happens in netR module; here explicitly:
  const DOLLAR_PER_PRICE_UNIT = 1; // XAUUSD 0.01 lot: $1 per $1 move (documented assumption, stated below)
  const costInR = medianRisk > 0 ? EXECUTION_COST_R_DOLLARS / (medianRisk * DOLLAR_PER_PRICE_UNIT) : 0;
  const rNetVals = rGross.map(r => r.r - costInR);
  const winsNet = rNetVals.filter(r => r > 0);
  const lossesNet = rNetVals.filter(r => r <= 0);
  const wrNet = n > 0 ? (winsNet.length / n) * 100 : 0;
  const evNet = n > 0 ? rNetVals.reduce((s, r) => s + r, 0) / n : 0;
  const sumWinNet = winsNet.reduce((s, r) => s + r, 0);
  const sumLossNet = lossesNet.reduce((s, r) => s + Math.abs(r), 0);
  const pfNet = sumLossNet > 0 ? sumWinNet / sumLossNet : Infinity;

  console.log(`\n  NET (n=${n}, cost=$${EXECUTION_COST_R_DOLLARS}/trade, median risk distance=${medianRisk.toFixed(2)} price units, cost in R=${costInR.toFixed(4)}):`);
  console.log(`    ⚠ PROVISIONAL: $/R conversion assumes $${DOLLAR_PER_PRICE_UNIT}/price-unit (0.01 lot XAUUSD) — NOT verified against a stored position-size field. Flagging explicitly.`);
  console.log(`    WR  : ${wrNet.toFixed(2)}%  (${winsNet.length}W / ${lossesNet.length}L)`);
  console.log(`    EV  : ${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`);
  console.log(`    PF  : ${pfNet.toFixed(3)}`);

  // A-3: RECONCILE THE THREE BOOKS
  console.log(`\n  A-3 — THREE-BOOK RECONCILIATION`);
  console.log(line);

  const { data: toRows, count: toCount } = await client.from('trade_outcomes_v1').select('signal_id, direction, result, realized_r, is_scratch, entry_price, exit_price, pnl', { count: 'exact' });
  const toAll = (toRows ?? []) as { signal_id: string; direction: string; result: string; realized_r: number | null; is_scratch: boolean | null; entry_price: number; exit_price: number; pnl: number }[];
  console.log(`  trade_outcomes_v1 total rows (LIVE fetch): ${toCount}`);
  const toUsable = toAll.filter(r => r.realized_r !== null);
  const toWins = toUsable.filter(r => Number(r.realized_r) > 0);
  const toWR = toUsable.length > 0 ? (toWins.length / toUsable.length) * 100 : 0;
  const toEV = toUsable.length > 0 ? toUsable.reduce((s, r) => s + Number(r.realized_r), 0) / toUsable.length : 0;
  console.log(`  trade_outcomes_v1.realized_r book (n=${toUsable.length}): WR=${toWR.toFixed(2)}%  EV=${toEV >= 0 ? '+' : ''}${toEV.toFixed(4)}R`);

  console.log(`\n  BOOK COMPARISON:`);
  console.log(`    Canonical (this script, GROSS)   : n=${n}    WR=${wr.toFixed(1)}%   EV=${evGross >= 0 ? '+' : ''}${evGross.toFixed(3)}R`);
  console.log(`    App SECTION 4 (prior export)      : n=414  WR=61.8%  PF=1.15   (source: signalEngine in-memory tradeOutcomes)`);
  console.log(`    trade_outcomes_v1.realized_r (LIVE): n=${toUsable.length}   WR=${toWR.toFixed(1)}%   EV=${toEV >= 0 ? '+' : ''}${toEV.toFixed(3)}R`);

  // Cross-check: how many trade_outcomes_v1 rows match a canonical result, and where they disagree
  const canonicalById = new Map(rGross.map(r => [r.id, r]));
  let agree = 0, disagreeCount = 0;
  const disagreements: string[] = [];
  for (const toRow of toUsable) {
    const c = canonicalById.get(toRow.signal_id);
    if (!c) continue;
    const canonicalWin = c.r > 0;
    const storedWin = Number(toRow.realized_r) > 0;
    if (canonicalWin === storedWin) agree++;
    else { disagreeCount++; disagreements.push(`${toRow.signal_id.slice(-9)}: canonical R=${c.r.toFixed(3)} (${canonicalWin ? 'WIN' : 'LOSS'})  stored realized_r=${Number(toRow.realized_r).toFixed(3)} (${storedWin ? 'WIN' : 'LOSS'})`); }
  }
  console.log(`\n  Rows present in BOTH canonical + trade_outcomes_v1: ${agree + disagreeCount}`);
  console.log(`    agree (WIN/LOSS direction): ${agree}`);
  console.log(`    disagree                  : ${disagreeCount}`);
  for (const d of disagreements.slice(0, 15)) console.log(`      ${d}`);

  // A-4: check POST_TP1_PROFIT_LOCK_R (0.35) omission from realized_r
  console.log(`\n  A-4 — DOES realized_r OMIT THE 0.35R POST-TP1 LOCK?`);
  console.log(line);
  const slAfterBeCanonical = results.filter(r => r.status === 'SL_AFTER_BE');
  console.log(`  canonical SL_AFTER_BE rows (TP1 banked, then retraced to lock): ${slAfterBeCanonical.length}`);
  let matchedLockRows = 0, lockValueMatches = 0, lockRecordedAsLoss = 0;
  for (const sabe of slAfterBeCanonical) {
    const toRow = toAll.find(t => t.signal_id === sabe.id);
    if (!toRow) continue;
    matchedLockRows++;
    const storedR = toRow.realized_r === null ? null : Number(toRow.realized_r);
    const storedResult = toRow.result;
    console.log(`    ${sabe.id.slice(-9)}  canonical=SL_AFTER_BE(WIN, exit=${sabe.exitPrice.toFixed(1)})  stored: result=${storedResult} realized_r=${storedR ?? 'null'}`);
    if (storedR !== null && storedR > 0) lockValueMatches++;
    if (storedResult === 'LOSS' || (storedR !== null && storedR <= 0)) lockRecordedAsLoss++;
  }
  console.log(`  matched in trade_outcomes_v1: ${matchedLockRows}`);
  console.log(`  stored as a WIN with positive R (lock honoured): ${lockValueMatches}`);
  console.log(`  stored as LOSS / non-positive R (lock OMITTED, bare stop-out): ${lockRecordedAsLoss}`);
  if (matchedLockRows === 0) {
    console.log(`  ⚠ POWER: zero canonical SL_AFTER_BE rows matched a trade_outcomes_v1 row. Cannot settle A-4 from this population — IMPOSSIBLE, not underpowered-but-nonzero. Stating per rule 8.`);
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('itemA failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
