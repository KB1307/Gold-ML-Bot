/**
 * ITEM 229 / CHECKPOINT F — NINE WINS, ONE LOSS, AND THE BOOK STILL LOSES.
 *
 * Today's screen showed 9 wins / 1 loss / 90% day win rate, yet profit factor
 * 0.91 in dollars — because nine of the ten exits were SL_AFTER_BE: TP1 banked,
 * then stopped at the profit lock. Nine capped wins barely cover one full-R loss.
 *
 *   F1 - TODAY's local-day signals placed INDIVIDUALLY by signal_id with
 *        max_favourable_target_reached_before_exit (and its R value).
 *   F2 - The FULL canonical SL_AFTER_BE population: BEFORE-exit distribution
 *        (CAPTURABLE) vs AFTER-exit distribution (COUNTERFACTUAL, standing rule).
 *   F3 - THE DECISION-RELEVANT SPLIT: of all SL_AFTER_BE exits, what fraction
 *        touched TP2 BEFORE the exit vs only after? Produces a VERDICT ONLY on
 *        whether Items 202-204's lock-question closure should be reopened —
 *        no exit constant is touched this round.
 *   F5 - Average win vs average loss in R (not dollars) across the resolved
 *        book, the breakeven win rate they imply, compared with actual. The
 *        dollar figures in export SECTION 4 (3.85 vs 5.87) are NOT R and are
 *        kept strictly separate.
 *
 * IDENTIFICATION DISCIPLINE: trade_outcomes_v1 stores result = WIN|LOSS only;
 * there is no exit-structure column on the outcome row. So the SL_AFTER_BE
 * population is identified by the SAME canonical fromScratch replay as Item 224
 * (pinned: 8h window, safeBarStart=emitted+60s, resolveSignalWithBars,
 * gold_m1_bars via anon key). Stored MFE columns are CROSS-CHECKED against the
 * replay values, never trusted blindly — provenance is not appearance.
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 + trade_outcomes_v1 read
 * DIRECT via anon key. READ-ONLY: no terminal status, realized_r or label field
 * is written by this script.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

interface SignalRow {
  signal_id: string; emitted_at: string; direction: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
  confidence: number; source: string;
}

interface OutcomeRow {
  signal_id: string; ts: string; result: string | null; realized_r: number | null;
  is_scratch: boolean | null;
  max_favourable_target_reached_before_exit: number | null;
  max_favourable_excursion_before_exit_r: number | null;
  max_favourable_target_after_exit: number | null;
  max_favourable_excursion_after_exit_r: number | null;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const LOCAL_DAY_START_ISO = '2026-08-25T22:00:00Z'; // device UTC+2 "today" boundary

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
function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}
function fmtR(v: number | null): string {
  return v === null || v === undefined ? 'null' : `${v.toFixed(4)}R`;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`${line}`);
  console.log('ITEM 229 / CHECKPOINT F — NINE WINS, ONE LOSS, AND THE BOOK STILL LOSES');
  console.log(line);
  console.log(`  run at      : ${new Date().toISOString()}`);
  console.log(`  pinned      : same canonical instrument as Item 224/canonicalBook.ts`);
  console.log(`                (8h window Item 41a, safeBarStart=emitted+60s, fromScratch, anon key)`);

  // ── Load corpus ─────────────────────────────────────────────────────────────
  const allSignalRows: SignalRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source')
      .order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`emitted_signals_v1 fetch failed: ${error.message}`);
    const batch = (data ?? []) as SignalRow[];
    allSignalRows.push(...batch);
    if (batch.length < 1000) break;
  }

  const allOutcomeRows: OutcomeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('trade_outcomes_v1')
      .select(`signal_id, ts, result, realized_r, is_scratch,
        max_favourable_target_reached_before_exit, max_favourable_excursion_before_exit_r,
        max_favourable_target_after_exit, max_favourable_excursion_after_exit_r`)
      .order('ts', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`trade_outcomes_v1 fetch failed: ${error.message}`);
    const batch = (data ?? []) as OutcomeRow[];
    allOutcomeRows.push(...batch);
    if (batch.length < 1000) break;
  }

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
  console.log(`  corpus     : ${allSignalRows.length} emitted signals, ${allOutcomeRows.length} outcome rows, ${allBars.length} bars (through ${new Date(barsEndMs).toISOString()})`);

  // ── Canonical fromScratch replay (identical machinery to Item 224) ──────────
  interface Replay {
    row: SignalRow; emittedMs: number; status: string; terminalTs: number; bars: Bar[];
    beforeTarget: number | null; beforeR: number | null; afterTarget: number | null; afterR: number | null;
  }
  const replays: Replay[] = [];
  const origLog = console.log;
  console.log = () => {};
  try {
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
      const mfe = res.maxFavourable;
      replays.push({
        row, emittedMs, status: String(res.newStatus),
        terminalTs: res.resolvedAtBarTs ?? (evalBars.length > 0 ? evalBars[evalBars.length - 1].timestamp : emittedMs),
        bars: evalBars,
        beforeTarget: mfe ? mfe.targetReachedBeforeExit : null,
        beforeR: mfe ? mfe.excursionBeforeExitR : null,
        afterTarget: mfe ? mfe.targetAfterExit : null,
        afterR: mfe ? mfe.excursionAfterExitR : null,
      });
    }
  } finally {
    console.log = origLog;
  }
  console.log(`  canonical fromScratch replay: ${replays.length} signals resolved`);

  // Cross-check replay MFE against STORED MFE for every row carrying one — labels first.
  let checkedStored = 0, mismatches = 0;
  for (const rp of replays) {
    const o = allOutcomeRows.find(x => x.signal_id === rp.row.signal_id);
    if (!o || o.max_favourable_target_reached_before_exit === null || rp.beforeTarget === null) continue;
    checkedStored += 1;
    if (o.max_favourable_target_reached_before_exit !== rp.beforeTarget
      || o.max_favourable_target_after_exit !== rp.afterTarget
      || Math.abs((o.max_favourable_excursion_before_exit_r ?? -999) - (rp.beforeR ?? -999)) > 1e-9) {
      mismatches += 1;
      if (mismatches <= 8) {
        console.log(`    MFE MISMATCH ${rp.row.signal_id}: stored[before=${o.max_favourable_target_reached_before_exit} r=${o.max_favourable_excursion_before_exit_r} after=${o.max_favourable_target_after_exit}]`
          + ` replay[before=${rp.beforeTarget} r=${rp.beforeR} after=${rp.afterTarget}]`);
      }
    }
  }

  const dirOf = new Map(allSignalRows.map(r => [r.signal_id, r.direction]));
  const confOf = new Map(allSignalRows.map(r => [r.signal_id, r.confidence]));

  // ── F1: today's signals individually ────────────────────────────────────────
  const localStartMs = Date.parse(LOCAL_DAY_START_ISO);
  const todayReplays = replays.filter(r => r.emittedMs >= localStartMs).sort((a, b) => a.emittedMs - b.emittedMs);
  console.log(`\n${line}`);
  console.log(`F1 — TODAY'S LOCAL-DAY SIGNALS INDIVIDUALLY (since ${LOCAL_DAY_START_ISO}, n=${todayReplays.length})`);
  console.log(line);
  for (const rp of todayReplays) {
    const stored = allOutcomeRows.find(x => x.signal_id === rp.row.signal_id);
    console.log(
      `    ${new Date(rp.emittedMs).toISOString()}  ${rp.row.signal_id}\n` +
      `      dir=${dirOf.get(rp.row.signal_id)} conf=${confOf.get(rp.row.signal_id)} replayStatus=${rp.status}` +
      ` storedResult=${stored?.result ?? '-'} storedR=${fmtR(stored?.realized_r ?? null)}\n` +
      `      BEFORE-exit target=${rp.beforeTarget} (${fmtR(rp.beforeR)})   AFTER-exit target=${rp.afterTarget} (${fmtR(rp.afterR)})` +
      `   [stored MFE check: ${stored && stored.max_favourable_target_reached_before_exit !== null ? (stored.max_favourable_target_reached_before_exit === rp.beforeTarget ? 'AGREE' : 'DISAGREE') : 'no stored value'}]`,
    );
  }
  const todaySlaBe = todayReplays.filter(r => r.status === 'SL_AFTER_BE');
  const todayResolvedR = todayReplays
    .map(r => ({ rp: r, o: allOutcomeRows.find(x => x.signal_id === r.row.signal_id) }))
    .filter(x => x.o?.realized_r != null);
  const sumWinR = todayResolvedR.filter(x => (x.o!.realized_r ?? 0) > 0).reduce((s, x) => s + (x.o!.realized_r ?? 0), 0);
  const sumLossR = Math.abs(todayResolvedR.filter(x => (x.o!.realized_r ?? 0) < 0).reduce((s, x) => s + (x.o!.realized_r ?? 0), 0));
  console.log(`\n  summary: ${todayReplays.length} signals, SL_AFTER_BE=${todaySlaBe.length}/${todayReplays.length}`);
  console.log(`  today in R: total win ${sumWinR.toFixed(4)}R across ${todayResolvedR.filter(x => (x.o!.realized_r ?? 0) > 0).length} wins, loss ${sumLossR.toFixed(4)}R -> net ${(sumWinR - sumLossR).toFixed(4)}R, PF_R=${sumLossR > 0 ? (sumWinR / sumLossR).toFixed(3) : 'inf'}`);
  console.log(`  NOTE: the export's PF 0.91 is DOLLAR-based (position-size differences); in R this day is net positive.`);
  console.log(`  today's SL_AFTER_BE exits that reached TP2+ BEFORE exit: ${todaySlaBe.filter(r => (r.beforeTarget ?? 0) >= 2).length}/${todaySlaBe.length}`);

  // ── F2/F3: full canonical SL_AFTER_BE population ────────────────────────────
  const slaBeAll = replays.filter(r => r.status === 'SL_AFTER_BE');
  console.log(`\n${line}`);
  console.log(`F2 — FULL CANONICAL SL_AFTER_BE POPULATION (n=${slaBeAll.length})`);
  console.log(line);

  const distOf = (get: (r: Replay) => number | null): Map<number, number> => {
    const m = new Map<number, number>();
    for (const r of slaBeAll) { const k = get(r) ?? -1; m.set(k, (m.get(k) ?? 0) + 1); }
    return new Map([...m.entries()].sort((a, b) => a[0] - b[0]));
  };
  const printD = (label: string, get: (r: Replay) => number | null): void => {
    const counts = distOf(get);
    console.log(`\n  ${label}`);
    const names: Record<number, string> = { [-1]: '-1 (NULL)', 0: '0 (exit level)', 1: '1 (TP1)', 2: '2 (TP2)', 3: '3 (TP3)' };
    for (const [k, c] of counts) console.log(`    ${(names[k] ?? String(k)).padEnd(16)} : ${String(c).padStart(4)}  (${pct(c, slaBeAll.length)})`);
  };
  printD('BEFORE EXIT  = CAPTURABLE information (the trade was still open)', r => r.beforeTarget);
  printD('AFTER EXIT   = COUNTERFACTUAL (standing rule — the market moved after close)', r => r.afterTarget);

  console.log(`\n  MFE stored-vs-replay cross-check: ${checkedStored} rows compared, ${mismatches} mismatches`);

  const tp2Before = slaBeAll.filter(r => (r.beforeTarget ?? 0) >= 2).length;
  const tp2AfterOnly = slaBeAll.filter(r => (r.beforeTarget ?? 0) < 2 && (r.afterTarget ?? 0) >= 2).length;
  const neitherTp2 = slaBeAll.length - tp2Before - tp2AfterOnly;

  console.log(`\n${line}`);
  console.log('F3 — THE DECISION-RELEVANT TP2 SPLIT ACROSS ALL SL_AFTER_BE EXITS');
  console.log(line);
  console.log(`  n (SL_AFTER_BE)                     : ${slaBeAll.length}`);
  console.log(`  touched TP2 BEFORE the exit         : ${tp2Before}  (${pct(tp2Before, slaBeAll.length)})  <- CAPTURABLE but not taken`);
  console.log(`  touched TP2 only AFTER the exit     : ${tp2AfterOnly}  (${pct(tp2AfterOnly, slaBeAll.length)})  <- COUNTERFACTUAL`);
  console.log(`  never reached TP2 either side       : ${neitherTp2}  (${pct(neitherTp2, slaBeAll.length)})`);

  // ── F5: R-basis avg win / avg loss ───────────────────────────────────────────
  const rBook = allOutcomeRows.filter(r => r.realized_r !== null && r.is_scratch !== true);
  const wins = rBook.filter(r => (r.realized_r ?? 0) > 0);
  const losses = rBook.filter(r => (r.realized_r ?? 0) < 0);
  const zeroRows = rBook.length - wins.length - losses.length;
  const avgWin = wins.reduce((s, r) => s + (r.realized_r ?? 0), 0) / Math.max(wins.length, 1);
  const avgLossAbs = Math.abs(losses.reduce((s, r) => s + (r.realized_r ?? 0), 0) / Math.max(losses.length, 1));
  const actualWr = (wins.length / Math.max(wins.length + losses.length, 1)) * 100;
  const breakevenWr = (avgLossAbs / (avgWin + avgLossAbs)) * 100;
  const edge = actualWr - breakevenWr;

  console.log(`\n${line}`);
  console.log('F5 — WIN/LOSS SIZE IN R ON THE RESOLVED BOOK (stored realized_r)');
  console.log(line);
  console.log(`  non-scratch rows with realized_r : ${rBook.length} (zero-R rows excluded from sides: ${zeroRows})`);
  console.log(`  average WIN                      : ${avgWin.toFixed(4)}R  (n=${wins.length})`);
  console.log(`  average LOSS                     : ${avgLossAbs.toFixed(4)}R  (n=${losses.length})`);
  console.log(`  win size / loss size             : ${(avgWin / avgLossAbs).toFixed(3)}x  <- R basis; the dollar 3.85/5.87 ratio is a SEPARATE claim and is not conflated here`);
  console.log(`  implied breakeven win rate       : ${breakevenWr.toFixed(2)}%  = loss/(win+loss)`);
  console.log(`  actual win rate (same rows)      : ${actualWr.toFixed(2)}%  (n=${wins.length + losses.length})`);
  console.log(`  edge                             : ${edge >= 0 ? '+' : ''}${edge.toFixed(2)} percentage points above breakeven`);

  // Per-exit-structure economics so the SL_AFTER_BE shape is visible in R too.
  const groups = ['TP3_HIT', 'ALL_TARGETS_HIT', 'PARTIAL_WIN_SL_HIT', 'SL_AFTER_BE', 'SL_HIT'] as const;
  console.log('\n  realised-R economics BY REPLAY EXIT STRUCTURE (stored realized_r paired to replay status):');
  for (const g of groups) {
    const vals = replays
      .filter(r => r.status === g)
      .map(r => allOutcomeRows.find(x => x.signal_id === r.row.signal_id))
      .filter((o): o is OutcomeRow => !!o && o.realized_r != null && o.is_scratch !== true)
      .map(o => o.realized_r as number);
    if (vals.length === 0) continue;
    const w = vals.filter(v => v > 0), l = vals.filter(v => v < 0);
    console.log(`    ${g.padEnd(20)}: n=${vals.length}  meanR=${(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4)}  meanWin=${w.length ? (w.reduce((s, v) => s + v, 0) / w.length).toFixed(4) : '-'}  meanLossAbs=${l.length ? Math.abs(l.reduce((s, v) => s + v, 0) / l.length).toFixed(4) : '-'}`);
  }
  console.log('\n  CAVEAT (Item 219 quoting rule): stored realized_r mixes writer eras (app GROSS vs cron/backfill NET);');
  console.log('  means above quote each row\'s own stored value under that same convention.');
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
