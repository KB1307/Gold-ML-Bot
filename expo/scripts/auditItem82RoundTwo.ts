/**
 * ITEM 82 ROUND TWO — LIVE EVIDENCE FOR A3 / B4 / B5 / B8 / C5.
 *
 * READ-ONLY against Supabase. Anon key, DIRECT (DATA-SOURCE RULE): the Rork
 * backend is never a read path.
 *
 * Every number this script prints is derived from rows it fetched in this run.
 * Nothing is quoted from a prior report.
 *
 * SECTIONS
 *   A3/B6  execution-cost impact: the book at $0.00, $0.05 and $0.20 round trip.
 *   B4     NaN drift root cause: which feature keys actually exist on corpus rows.
 *   B5     resolver-window divergence: 8h vs 24h over the existing corpus.
 *   B8     the label layer: F-8 label-vs-R disagreement, F-9 null direction,
 *          F-18 the two-book gap.
 *   C5     emission vs persistence: source split and the unresolvable rows.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  } catch {
    // fall through — reported as NOT_CONFIGURED below
  }
  return env;
};

const RULE = '='.repeat(84);
const sub = (s: string): void => {
  console.log(`\n${'-'.repeat(84)}`);
  console.log(s);
  console.log('-'.repeat(84));
};

interface OutcomeRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  realized_r: number | string | null;
  is_scratch: boolean | null;
  features: unknown;
}

interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: string | null;
  entry: number | string | null;
  sl: number | string | null;
  tp1: number | string | null;
  tp2: number | string | null;
  tp3: number | string | null;
  source: string | null;
}

interface Bar {
  timestamp: number;
  high: number;
  low: number;
  close: number;
}

/** Page a table exhaustively. The 300-row F-12 defect was a caller limit, not a cap. */
async function pageAll<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  orderCol: string,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const num = (v: unknown): number => Number(v);
const fmt = (n: number, d = 4): string => (Number.isFinite(n) ? n.toFixed(d) : 'NaN');

/** Book statistics over a set of R values. */
function book(rs: number[]): { n: number; wr: number; ev: number; pf: number } {
  const n = rs.length;
  if (n === 0) return { n: 0, wr: NaN, ev: NaN, pf: NaN };
  const wins = rs.filter((r) => r > 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const loss = rs.filter((r) => r <= 0).reduce((a, b) => a + Math.abs(b), 0);
  return {
    n,
    wr: (wins.length / n) * 100,
    ev: rs.reduce((a, b) => a + b, 0) / n,
    pf: loss === 0 ? Infinity : gross / loss,
  };
}

async function main(): Promise<void> {
  console.log(`\n${RULE}`);
  console.log('ITEM 82 ROUND TWO — LIVE EVIDENCE (read-only, anon key, DIRECT)');
  console.log(RULE);
  console.log(`  run at: ${new Date().toISOString()}`);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error('BLOCKER: Supabase anon credentials not found in expo/.env — reporting nothing as done.');
    process.exit(1);
  }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(`  supabase: ${url} (anon)`);

  const outcomes = await pageAll<OutcomeRow>(
    client,
    'trade_outcomes_v1',
    'signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch, features',
    'ts',
  );
  const emitted = await pageAll<EmittedRow>(
    client,
    'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, source',
    'emitted_at',
  );
  console.log(`  trade_outcomes_v1 rows fetched : ${outcomes.length}`);
  console.log(`  emitted_signals_v1 rows fetched: ${emitted.length}`);

  // ───────────────────────────────────────────────────────────────────────────
  // A3 / B6 — EXECUTION-COST IMPACT
  // ───────────────────────────────────────────────────────────────────────────
  sub('A3 / B6 — EXECUTION-COST IMPACT ON THE BOOK');
  const emittedById = new Map(emitted.map((e) => [e.signal_id, e]));
  const withR = outcomes.filter((o) => o.realized_r !== null);
  console.log(`  rows with realized_r    : ${withR.length} of ${outcomes.length}`);

  // Risk in price terms per signal = |entry - sl| from emitted_signals_v1. Only
  // rows where BOTH sides exist can carry a per-signal cost, because cost in R
  // depends on that signal's own stop distance.
  let matchedRisk = 0;
  const costRows: { r: number; riskUsd: number }[] = [];
  for (const o of withR) {
    const e = emittedById.get(o.signal_id);
    if (!e || e.entry === null || e.sl === null) continue;
    const riskPrice = Math.abs(num(e.entry) - num(e.sl));
    if (!Number.isFinite(riskPrice) || riskPrice <= 0) continue;
    matchedRisk += 1;
    costRows.push({ r: num(o.realized_r), riskUsd: riskPrice });
  }
  console.log(`  rows with a real |entry-sl| risk distance: ${matchedRisk}`);
  if (costRows.length > 0) {
    const risks = costRows.map((c) => c.riskUsd).sort((a, b) => a - b);
    console.log(`  risk distance $ : min ${fmt(risks[0], 2)} median ${fmt(risks[Math.floor(risks.length / 2)], 2)} max ${fmt(risks[risks.length - 1], 2)}`);
    console.log('');
    console.log('  cost$    n      WR%      EV(R)      PF       mean cost(R)   EV delta vs $0');
    const base = book(costRows.map((c) => c.r));
    for (const cost of [0, 0.05, 0.2]) {
      const netRs = costRows.map((c) => c.r - cost / c.riskUsd);
      const b = book(netRs);
      const meanCostR = costRows.reduce((a, c) => a + cost / c.riskUsd, 0) / costRows.length;
      console.log(
        `  $${cost.toFixed(2)}   ${String(b.n).padStart(4)}  ${fmt(b.wr, 2).padStart(7)}  ${fmt(b.ev).padStart(9)}  ${fmt(b.pf, 3).padStart(7)}  ${fmt(meanCostR).padStart(12)}   ${fmt(b.ev - base.ev).padStart(9)}`,
      );
    }
    // Breakeven cost: the dollar cost at which book EV reaches zero.
    let lo = 0;
    let hi = 50;
    for (let i = 0; i < 60; i += 1) {
      const mid = (lo + hi) / 2;
      const ev = book(costRows.map((c) => c.r - mid / c.riskUsd)).ev;
      if (ev > 0) lo = mid;
      else hi = mid;
    }
    console.log(`  breakeven round-trip cost (EV -> 0): $${fmt(lo, 3)}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B4 — NaN DRIFT ROOT CAUSE
  // ───────────────────────────────────────────────────────────────────────────
  sub('B4 — NaN FEATURE DRIFT: ROOT CAUSE');
  const featureKeys = ['rsi', 'atr', 'volumeRatio', 'dxyChange', 'sentiment'];
  const presence = new Map<string, { present: number; numeric: number; missing: number }>();
  for (const k of featureKeys) presence.set(k, { present: 0, numeric: 0, missing: 0 });
  let emptyFeatureObjects = 0;
  const sampleKeys = new Map<string, number>();
  for (const o of outcomes) {
    const f = (o.features ?? {}) as Record<string, unknown>;
    const keys = Object.keys(f);
    if (keys.length === 0) emptyFeatureObjects += 1;
    for (const k of keys) sampleKeys.set(k, (sampleKeys.get(k) ?? 0) + 1);
    for (const k of featureKeys) {
      const rec = presence.get(k)!;
      if (k in f && f[k] !== null && f[k] !== undefined) {
        rec.present += 1;
        if (typeof f[k] === 'number' && Number.isFinite(f[k] as number)) rec.numeric += 1;
      } else {
        rec.missing += 1;
      }
    }
  }
  console.log(`  rows with a COMPLETELY EMPTY features object: ${emptyFeatureObjects} of ${outcomes.length}`);
  console.log('');
  console.log('  the 5 features analyzeFeatureValueDrift() reads (signalEngine.ts:5037):');
  for (const k of featureKeys) {
    const r = presence.get(k)!;
    console.log(`    ${k.padEnd(12)} present ${String(r.present).padStart(4)}  finite-number ${String(r.numeric).padStart(4)}  MISSING ${String(r.missing).padStart(4)}`);
  }
  console.log('');
  console.log('  every key actually observed on corpus rows (count):');
  for (const [k, n] of [...sampleKeys.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
  console.log('');
  console.log('  DIVISION-BY-ZERO CHECK: drift denominator is (historicalImportance + 0.01)');
  console.log('  at signalEngine.ts:5067, so it is >= 0.01 and can never be zero.');
  console.log('  A NaN therefore cannot come from the arithmetic; it can only come from');
  console.log('  a NaN input. sum + undefined === NaN.');

  // ───────────────────────────────────────────────────────────────────────────
  // B5 — RESOLVER WINDOW DIVERGENCE (8h vs 24h)
  // ───────────────────────────────────────────────────────────────────────────
  sub('B5 — RESOLVER WINDOW DIVERGENCE: 8h vs 24h OVER THE EXISTING CORPUS');
  console.log('  Method: for each resolved outcome that has emitted geometry, read the real');
  console.log('  gold_m1_bars in [emitted+60s, emitted+W] for W in {8h, 24h} and ask whether a');
  console.log('  terminal event (SL or TP3 touch) first occurs INSIDE 8h or only between 8h');
  console.log('  and 24h. A signal whose first terminal event lands in the 8h..24h band is');
  console.log('  labelled differently by the two windows. Read-only: nothing is re-resolved.');

  const barsCache = new Map<string, Bar[]>();
  const fetchBars = async (fromMs: number, toMs: number): Promise<Bar[]> => {
    const key = `${fromMs}:${toMs}`;
    const hit = barsCache.get(key);
    if (hit) return hit;
    const out: Bar[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('gold_m1_bars')
        .select('timestamp, high, low, close')
        .gte('timestamp', new Date(fromMs).toISOString())
        .lte('timestamp', new Date(toMs).toISOString())
        .order('timestamp', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
      const rows = (data ?? []) as { timestamp: string; high: number; low: number; close: number }[];
      out.push(...rows.map((r) => ({ timestamp: new Date(r.timestamp).getTime(), high: Number(r.high), low: Number(r.low), close: Number(r.close) })));
      if (rows.length < PAGE) break;
    }
    barsCache.set(key, out);
    return out;
  };

  const H8 = 8 * 60 * 60 * 1000;
  const H24 = 24 * 60 * 60 * 1000;
  const candidates = outcomes.filter((o) => {
    const e = emittedById.get(o.signal_id);
    return e && e.entry !== null && e.sl !== null && e.tp3 !== null && (e.direction === 'BUY' || e.direction === 'SELL');
  });
  console.log(`  candidates (outcome + full emitted geometry + a direction): ${candidates.length}`);

  // Cap the probe so the script stays inside a sane runtime; report the cap.
  const PROBE_CAP = 120;
  const probe = candidates.slice(-PROBE_CAP);
  console.log(`  probing the ${probe.length} most recent (cap ${PROBE_CAP}) — POWER: this is a`);
  console.log('  SUBSAMPLE, so the divergence count below is a rate applied to the candidate');
  console.log('  set, not an exhaustive census. Stated before the result per MINDSET rule 7.');

  let terminalIn8h = 0;
  let terminalIn8to24 = 0;
  let terminalNeither = 0;
  let noBars = 0;
  for (const o of probe) {
    const e = emittedById.get(o.signal_id)!;
    const emittedMs = new Date(e.emitted_at).getTime();
    const bars = await fetchBars(emittedMs + 60_000, emittedMs + H24);
    if (bars.length === 0) {
      noBars += 1;
      continue;
    }
    const isBuy = e.direction === 'BUY';
    const sl = num(e.sl);
    const tp3 = num(e.tp3);
    let firstTerminalAt: number | null = null;
    for (const b of bars) {
      const slHit = isBuy ? b.low <= sl : b.high >= sl;
      const tpHit = isBuy ? b.high >= tp3 : b.low <= tp3;
      if (slHit || tpHit) {
        firstTerminalAt = b.timestamp;
        break;
      }
    }
    if (firstTerminalAt === null) terminalNeither += 1;
    else if (firstTerminalAt - emittedMs <= H8) terminalIn8h += 1;
    else terminalIn8to24 += 1;
  }
  console.log('');
  console.log(`  first terminal event INSIDE 8h            : ${terminalIn8h}`);
  console.log(`  first terminal event in the 8h..24h band  : ${terminalIn8to24}  <-- LABELLED DIFFERENTLY by the two windows`);
  console.log(`  no terminal event within 24h              : ${terminalNeither}`);
  console.log(`  no bars available in the window           : ${noBars}`);
  const probed = terminalIn8h + terminalIn8to24 + terminalNeither;
  if (probed > 0) {
    const rate = (terminalIn8to24 / probed) * 100;
    console.log(`  divergence rate: ${terminalIn8to24}/${probed} = ${fmt(rate, 2)}%`);
    console.log(`  extrapolated to all ${candidates.length} candidates: ~${Math.round((rate / 100) * candidates.length)} row(s) (PROVISIONAL — extrapolation, not a census)`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // B8 — THE LABEL LAYER
  // ───────────────────────────────────────────────────────────────────────────
  sub('B8 — THE LABEL LAYER: F-8, F-9, F-18');

  const rPositive = outcomes.filter((o) => o.realized_r !== null && num(o.realized_r) > 0);
  const storedWin = outcomes.filter((o) => o.result === 'WIN');
  console.log(`  total rows                     : ${outcomes.length}`);
  console.log(`  stored result = WIN            : ${storedWin.length}`);
  console.log(`  realized_r > 0                 : ${rPositive.length}`);
  console.log(`  realized_r IS NULL             : ${outcomes.filter((o) => o.realized_r === null).length}`);

  // F-8: enumerate the disagreement and classify it.
  const winButNotPositive = outcomes.filter((o) => o.result === 'WIN' && (o.realized_r === null || num(o.realized_r) <= 0));
  const positiveButNotWin = outcomes.filter((o) => o.result !== 'WIN' && o.realized_r !== null && num(o.realized_r) > 0);
  console.log('');
  console.log(`  F-8 DISAGREEMENT`);
  console.log(`    stored WIN but realized_r <= 0 or null : ${winButNotPositive.length}`);
  console.log(`    stored LOSS but realized_r > 0         : ${positiveButNotWin.length}`);
  console.log(`    net label-vs-R gap                     : ${storedWin.length - rPositive.length}`);
  console.log('');
  console.log('    stored WIN with non-positive R (up to 30 shown) — R, scratch, direction:');
  for (const o of winButNotPositive.slice(0, 30)) {
    console.log(`      ${o.signal_id.slice(-8)}  R=${o.realized_r === null ? 'NULL' : fmt(num(o.realized_r))}  scratch=${o.is_scratch}  dir=${o.direction ?? 'NULL'}  entry=${fmt(num(o.entry_price), 2)} exit=${fmt(num(o.exit_price), 2)}`);
  }
  console.log('');
  console.log('    stored LOSS with positive R (up to 30 shown):');
  for (const o of positiveButNotWin.slice(0, 30)) {
    console.log(`      ${o.signal_id.slice(-8)}  R=${fmt(num(o.realized_r))}  scratch=${o.is_scratch}  dir=${o.direction ?? 'NULL'}  entry=${fmt(num(o.entry_price), 2)} exit=${fmt(num(o.exit_price), 2)}`);
  }

  // F-9: the null-direction rows.
  const nullDir = outcomes.filter((o) => o.direction === null);
  console.log('');
  console.log(`  F-9 NULL DIRECTION`);
  console.log(`    rows with direction IS NULL : ${nullDir.length}`);
  const nullDirR = nullDir.filter((o) => o.realized_r !== null).map((o) => num(o.realized_r));
  console.log(`    of those, realized_r NULL   : ${nullDir.filter((o) => o.realized_r === null).length}`);
  console.log(`    of those, realized_r = 0    : ${nullDirR.filter((r) => r === 0).length}`);
  console.log(`    of those, realized_r != 0   : ${nullDirR.filter((r) => r !== 0).length}`);
  console.log(`    stored result WIN / LOSS    : ${nullDir.filter((o) => o.result === 'WIN').length} / ${nullDir.filter((o) => o.result !== 'WIN').length}`);
  console.log(`    present in emitted_signals_v1: ${nullDir.filter((o) => emittedById.has(o.signal_id)).length} of ${nullDir.length}`);
  const nullDirTs = nullDir.map((o) => o.ts).sort();
  if (nullDirTs.length > 0) console.log(`    ts range                    : ${nullDirTs[0]} .. ${nullDirTs[nullDirTs.length - 1]}`);
  console.log(`    pnl exactly 0               : ${nullDir.filter((o) => num(o.pnl) === 0).length}`);
  console.log(`    entry_price == exit_price   : ${nullDir.filter((o) => num(o.entry_price) === num(o.exit_price)).length}`);

  // F-18: the two books, and what closes the gap.
  console.log('');
  console.log('  F-18 THE TWO BOOKS');
  const allR = outcomes.filter((o) => o.realized_r !== null).map((o) => num(o.realized_r));
  const bAll = book(allR);
  console.log('    BOOK 1 — server query, realized_r sign, ALL rows with an R:');
  console.log(`      n=${bAll.n}  WR=${fmt(bAll.wr, 2)}%  EV=${fmt(bAll.ev)}R  PF=${fmt(bAll.pf, 3)}`);
  const storedLabelWr = (storedWin.length / outcomes.length) * 100;
  console.log(`    BOOK 2 — stored result label over ALL ${outcomes.length} rows:`);
  console.log(`      WR=${fmt(storedLabelWr, 2)}%  (this is the definition the app's own summary uses)`);
  console.log('');
  console.log('    candidate explanations, each tested:');
  const exNullDir = outcomes.filter((o) => o.direction !== null && o.realized_r !== null).map((o) => num(o.realized_r));
  const bExNull = book(exNullDir);
  console.log(`      (a) exclude the ${nullDir.length} null-direction rows:`);
  console.log(`          n=${bExNull.n}  WR=${fmt(bExNull.wr, 2)}%  EV=${fmt(bExNull.ev)}R  PF=${fmt(bExNull.pf, 3)}`);
  const exScratch = outcomes.filter((o) => o.realized_r !== null && o.is_scratch !== true).map((o) => num(o.realized_r));
  const bExScratch = book(exScratch);
  console.log(`      (b) exclude is_scratch rows (${outcomes.filter((o) => o.is_scratch === true).length}):`);
  console.log(`          n=${bExScratch.n}  WR=${fmt(bExScratch.wr, 2)}%  EV=${fmt(bExScratch.ev)}R  PF=${fmt(bExScratch.pf, 3)}`);
  const exBoth = outcomes.filter((o) => o.direction !== null && o.realized_r !== null && o.is_scratch !== true).map((o) => num(o.realized_r));
  const bExBoth = book(exBoth);
  console.log(`      (c) exclude BOTH null-direction and scratch:`);
  console.log(`          n=${bExBoth.n}  WR=${fmt(bExBoth.wr, 2)}%  EV=${fmt(bExBoth.ev)}R  PF=${fmt(bExBoth.pf, 3)}`);
  const labelWrExNull = (() => {
    const rows = outcomes.filter((o) => o.direction !== null);
    return { n: rows.length, wr: (rows.filter((o) => o.result === 'WIN').length / rows.length) * 100 };
  })();
  console.log(`      (d) stored LABEL WR excluding null-direction rows:`);
  console.log(`          n=${labelWrExNull.n}  WR=${fmt(labelWrExNull.wr, 2)}%   <-- compare to the app's reported figure`);

  // Direction split, both definitions.
  console.log('');
  console.log('    per-direction, both definitions:');
  for (const dir of ['BUY', 'SELL', null]) {
    const rows = outcomes.filter((o) => o.direction === dir);
    if (rows.length === 0) continue;
    const rs = rows.filter((o) => o.realized_r !== null).map((o) => num(o.realized_r));
    const b = book(rs);
    const labelWr = (rows.filter((o) => o.result === 'WIN').length / rows.length) * 100;
    console.log(`      ${String(dir ?? '(null)').padEnd(7)} n=${String(rows.length).padStart(4)}  R-sign WR=${fmt(b.wr, 2).padStart(6)}%  label WR=${fmt(labelWr, 2).padStart(6)}%  EV=${fmt(b.ev)}R  PF=${fmt(b.pf, 3)}`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // C5 — EMISSION vs PERSISTENCE
  // ───────────────────────────────────────────────────────────────────────────
  sub('C5 — EMISSION vs PERSISTENCE');
  const bySource = new Map<string, number>();
  for (const e of emitted) bySource.set(e.source ?? '(null)', (bySource.get(e.source ?? '(null)') ?? 0) + 1);
  console.log('  emitted_signals_v1 by source:');
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${s}`);

  const emittedTs = emitted.map((e) => e.emitted_at).sort();
  console.log(`  emitted_at range: ${emittedTs[0]} .. ${emittedTs[emittedTs.length - 1]}`);
  console.log('');
  console.log('  per-source emitted_at range (does the LIVE source have a recent stamp?):');
  for (const s of bySource.keys()) {
    const ts = emitted.filter((e) => (e.source ?? '(null)') === s).map((e) => e.emitted_at).sort();
    console.log(`    ${s.padEnd(24)} ${ts[0]} .. ${ts[ts.length - 1]}  (n=${ts.length})`);
  }

  // Emitted rows with NO outcome — the unresolvable set.
  const outcomeIds = new Set(outcomes.map((o) => o.signal_id));
  const noOutcome = emitted.filter((e) => !outcomeIds.has(e.signal_id));
  console.log('');
  console.log(`  emitted rows with NO trade_outcomes_v1 row: ${noOutcome.length}`);
  console.log('  characterising them (this is the "unresolvable 16" the Edge Function reports):');
  let missingGeometry = 0;
  let missingDirection = 0;
  let tooRecent = 0;
  let barsAbsent = 0;
  const nowMs = Date.now();
  for (const e of noOutcome) {
    const ageMs = nowMs - new Date(e.emitted_at).getTime();
    const geomMissing = e.entry === null || e.sl === null || e.tp3 === null;
    if (geomMissing) missingGeometry += 1;
    if (e.direction !== 'BUY' && e.direction !== 'SELL') missingDirection += 1;
    if (ageMs < H8) tooRecent += 1;
    const emittedMs = new Date(e.emitted_at).getTime();
    const bars = await fetchBars(emittedMs + 60_000, emittedMs + H8);
    if (bars.length === 0) barsAbsent += 1;
    console.log(
      `    ${e.signal_id.slice(-8)}  emitted=${e.emitted_at}  age=${(ageMs / 3600000).toFixed(1)}h  dir=${e.direction ?? 'NULL'}  entry=${e.entry ?? 'NULL'} sl=${e.sl ?? 'NULL'} tp3=${e.tp3 ?? 'NULL'}  bars_in_8h=${bars.length}  src=${e.source ?? 'NULL'}`,
    );
  }
  console.log('');
  console.log(`    missing geometry (entry/sl/tp3 null): ${missingGeometry}`);
  console.log(`    missing/invalid direction           : ${missingDirection}`);
  console.log(`    younger than the 8h window          : ${tooRecent}`);
  console.log(`    ZERO bars available in their window  : ${barsAbsent}   <-- permanent if the bar gap is permanent`);

  console.log(`\n${RULE}`);
  console.log('END — every number above was derived from rows fetched in this run.');
  console.log(RULE);
}

main().catch((err: unknown) => {
  console.error('\nBLOCKER — audit did not complete. Reporting nothing as done.');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  process.exit(1);
});
