/**
 * ITEMS 21 (GATE) / 23 (MEASURE) / 24 (OVERLAP) — READ-ONLY VERIFICATION.
 *
 * ITEM 21 — the pre-registered gate on the entry-fillability correction. Runs the
 *   REAL `resolveSignalWithBars` twice: once from the PRE-Item-21 file recovered
 *   with `git show HEAD:expo/services/signalResolver.ts`, once from the working
 *   tree. Nothing is re-implemented in a mirror for this gate, because the whole
 *   claim is "the 359 zone-confirmed are BIT-IDENTICAL" and a mirror could not
 *   support that claim.
 *
 * ITEM 23 — what the UNIT-CORRECTED multiplier (0.7 + 0.6*atr, the pips-domain
 *   formula) would actually have done. This is a LARGER stop, i.e. a different
 *   intervention from the ON mode measured at -0.3372R in 19e.
 *
 * ITEM 24 — do the crossedTp1-only / crossedSl-only populations overlap the
 *   signal sets that Items C and D and the SELL-suppression re-test were measured
 *   over, and have any of them already been pushed to `trade_outcomes_v1`?
 *
 * DATA SOURCE: gold_m1_bars and trade_outcomes_v1 are read DIRECT from Supabase
 * with the anon key. The Rork backend is never a read path here.
 *
 * Usage:
 *   git show HEAD:expo/services/signalResolver.ts > /tmp/signalResolver.baseline.ts
 *   bun expo/scripts/verifyItems21to24.ts [export.txt] [/tmp/signalResolver.baseline.ts]
 */
import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

const PIP = 0.1;
const TP_R = { tp1: 0.7, tp2: 1.05, tp3: 1.4 } as const;
const ATR_PERIOD = 14;

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  tp: number[];
  sl: number;
  targetsHit: number;
  atrRationale: number | null;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
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
    const cur = block.match(/rationale: SL ([\d.]+)p \(([\d.]+)x ATR\) \| Multiplier: ([\d.]+)x \((?:High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      targetsHit: num(block.match(/targets hit: (\d+)/)?.[1]) ?? 0,
      atrRationale: cur ? num(cur[4]) : null,
    });
  }
  return out;
}

async function fetchBars(fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 250; p++) {
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

function toTradingSignal(p: ParsedSignal, geom?: { sl: number; tp: number[] }): TradingSignal {
  const sl = geom ? geom.sl : p.sl;
  const tp = geom ? geom.tp : p.tp;
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: tp[0],
    tp2: tp[1],
    tp3: tp[2],
    sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}
const mean = (a: number[]): number => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

/** Profit factor: gross wins / |gross losses|. */
function profitFactor(rs: number[]): number {
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return gl === 0 ? Number.POSITIVE_INFINITY : gw / gl;
}

/**
 * R actually earned, priced from the fill that was REALLY obtainable.
 * `null` = no position existed, so there is no R. Deliberately null, never 0:
 * a never-filled signal is not a scratch trade.
 */
function realisedR(p: ParsedSignal, out: ResolverOutcome, useFillPrice: boolean): number | null {
  const risk = Math.abs(p.entry - p.sl);
  if (risk <= 0) return null;
  if (!out.entryConfirmed) return null;
  const fill = useFillPrice ? (out.entryFillPrice ?? p.entry) : p.entry;
  const dir = p.direction === 'BUY' ? 1 : -1;
  return (dir * (out.exitPrice - fill)) / risk;
}

function rFromGeom(p: ParsedSignal, geomSl: number, out: ResolverOutcome): number | null {
  const risk = Math.abs(p.entry - geomSl);
  if (risk <= 0) return null;
  if (!out.entryConfirmed) return null;
  const fill = out.entryFillPrice ?? p.entry;
  const dir = p.direction === 'BUY' ? 1 : -1;
  return (dir * (out.exitPrice - fill)) / risk;
}

/** Wilder-style ATR over the N bars ending at (and excluding) the generation minute. */
function atrAt(bars: OhlcBar[], genMs: number): number | null {
  const bucket = Math.floor(genMs / 60_000) * 60_000;
  const prior = bars.filter(b => b.timestamp < bucket).slice(-(ATR_PERIOD + 1));
  if (prior.length < ATR_PERIOD + 1) return null;
  let sum = 0;
  for (let i = 1; i < prior.length; i++) {
    const tr = Math.max(
      prior[i].high - prior[i].low,
      Math.abs(prior[i].high - prior[i - 1].close),
      Math.abs(prior[i].low - prior[i - 1].close),
    );
    sum += tr;
  }
  return sum / (prior.length - 1);
}

type BaselineResolver = (s: TradingSignal, bars: OhlcBar[], opts: Record<string, unknown>) => ResolverOutcome;

async function main(): Promise<void> {
  const exportPath = process.argv[2] ?? '/tmp/diagnostics_export.txt';
  const baselinePath = process.argv[3] ?? '/tmp/signalResolver.baseline.ts';
  if (!existsSync(exportPath)) { console.error(`export not found: ${exportPath}`); process.exit(1); }
  if (!existsSync(baselinePath)) {
    console.error(`PRE-Item-21 baseline resolver not found at ${baselinePath}.`);
    console.error(`Run: git show HEAD:expo/services/signalResolver.ts > ${baselinePath}`);
    process.exit(1);
  }
  const baselineMod = (await import(baselinePath)) as { resolveSignalWithBars: BaselineResolver };
  const resolveBaseline = baselineMod.resolveSignalWithBars;

  const signals = parseExport(exportPath);
  const withGeom = signals.filter(s => s.tp.length === 3 && s.sl > 0 && Number.isFinite(s.generatedMs));

  console.log('='.repeat(78));
  console.log('ITEMS 21 / 23 / 24 — GATE + MEASUREMENT (read-only)');
  console.log('='.repeat(78));
  console.log('\nPOWER (stated before any result):');
  console.log(`  signals parsed from export      : ${signals.length}`);
  console.log(`  with full geometry + timestamp  : ${withGeom.length}`);

  const minTs = Math.min(...withGeom.map(s => s.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...withGeom.map(s => s.generatedMs)) + 6 * 60 * 60_000;
  const bars = await fetchBars(minTs, maxTs);
  const byMinute = new Set<number>(bars.map(b => Math.floor(b.timestamp / 60_000) * 60_000));
  console.log(`  gold_m1_bars rows (anon DIRECT) : ${bars.length}`);
  console.log(`  bar window                      : ${new Date(minTs).toISOString()} .. ${new Date(maxTs).toISOString()}`);
  const covered = withGeom.filter(s => byMinute.has(Math.floor(s.generatedMs / 60_000) * 60_000));
  console.log(`  bar-covered signals             : ${covered.length}   <-- the denominator for every number below`);
  console.log(`  NOT covered (reported, never counted as pass): ${withGeom.length - covered.length}`);
  const evalNowMs = bars.length > 0 ? bars[bars.length - 1].timestamp : Date.now();
  console.log(`  evalNowMs = last real bar       : ${new Date(evalNowMs).toISOString()}`);

  // ─────────────────────────── ITEM 21 GATE ───────────────────────────
  console.log(`\n${'='.repeat(78)}\nITEM 21 — PRE-REGISTERED GATE\n${'='.repeat(78)}`);
  console.log('BOTH resolvers are the REAL function, not a mirror:');
  console.log(`  BEFORE = ${baselinePath} (git show HEAD:expo/services/signalResolver.ts)`);
  console.log('  AFTER  = ../services/signalResolver (working tree, Item 21 applied)');
  console.log('Both called identically: { fromScratch: true, evalNowMs = last real bar }.\n');

  interface Row {
    p: ParsedSignal;
    before: ResolverOutcome;
    after: ResolverOutcome;
    rBefore: number | null;
    rAfter: number | null;
  }
  const rows: Row[] = [];
  const quiet = { fromScratch: true, evalNowMs, logPrefix: '' };
  const origLog = console.log;
  console.log = (): void => {}; // resolver logs per-bar; silence during the sweep only
  for (const p of covered) {
    const sig = toTradingSignal(p);
    const before = resolveBaseline(sig, bars, quiet);
    const after = resolveSignalWithBars(sig, bars, quiet);
    rows.push({ p, before, after, rBefore: realisedR(p, before, false), rAfter: realisedR(p, after, true) });
  }
  console.log = origLog;

  // Classify by WHY the BEFORE resolver confirmed: zone-touch vs a levels-only cross.
  const zoneTouched = (r: Row): boolean => r.after.entryVia === 'zone';
  const gapFilled = (r: Row): boolean => r.after.entryVia === 'gap';
  const neverFillable = (r: Row): boolean => r.after.newStatus === 'NEVER_FILLABLE';
  const beforeCredited = (r: Row): boolean => r.before.entryConfirmed;

  const overCredited = rows.filter(r => beforeCredited(r) && !r.after.entryConfirmed);
  const zoneRows = rows.filter(zoneTouched);
  const gapRows = rows.filter(gapFilled);
  const nfRows = rows.filter(neverFillable);

  console.log('POPULATIONS:');
  console.log(`  entry obtained via zone touch          : ${zoneRows.length}`);
  console.log(`  entry obtained via a genuine GAP       : ${gapRows.length}`);
  console.log(`  NEVER_FILLABLE (new terminal status)   : ${nfRows.length}`);
  console.log(`  credited BEFORE, not entered AFTER     : ${overCredited.length}   <-- the corrected population`);

  // GATE 1 — every previously over-credited signal must now be NEVER_FILLABLE or gap-priced.
  const gate1Bad = overCredited.filter(r => r.after.newStatus !== 'NEVER_FILLABLE');
  const gate1 = gate1Bad.length === 0;
  console.log(`\nGATE 1  every over-credited signal is now NEVER_FILLABLE or gap-priced : ${gate1 ? 'PASS' : 'FAIL'}`);
  if (!gate1) for (const r of gate1Bad.slice(0, 10)) console.log(`    [${r.p.index}] ended ${r.after.newStatus} instead`);

  // GATE 2 — zone-confirmed signals must be BIT-IDENTICAL before vs after.
  const gate2Bad = zoneRows.filter(r =>
    r.before.newStatus !== r.after.newStatus ||
    r.before.targetsHit !== r.after.targetsHit ||
    r.before.exitPrice !== r.after.exitPrice ||
    r.before.outcomeResult !== r.after.outcomeResult ||
    r.before.breakevenReached !== r.after.breakevenReached ||
    r.before.resolvedAtBarTs !== r.after.resolvedAtBarTs ||
    r.before.entryConfirmed !== r.after.entryConfirmed,
  );
  const gate2 = gate2Bad.length === 0;
  console.log(`GATE 2  all ${zoneRows.length} zone-confirmed are BIT-IDENTICAL (status/targets/exit/result/BE/barTs) : ${gate2 ? 'PASS' : 'FAIL'}`);
  const diffFields = (r: Row): string[] => {
    const d: string[] = [];
    if (r.before.newStatus !== r.after.newStatus) d.push(`status ${r.before.newStatus}->${r.after.newStatus}`);
    if (r.before.targetsHit !== r.after.targetsHit) d.push(`targets ${r.before.targetsHit}->${r.after.targetsHit}`);
    if (r.before.exitPrice !== r.after.exitPrice) d.push(`exit ${r.before.exitPrice}->${r.after.exitPrice}`);
    if (r.before.outcomeResult !== r.after.outcomeResult) d.push(`result ${r.before.outcomeResult}->${r.after.outcomeResult}`);
    if (r.before.breakevenReached !== r.after.breakevenReached) d.push(`BE ${r.before.breakevenReached}->${r.after.breakevenReached}`);
    if (r.before.resolvedAtBarTs !== r.after.resolvedAtBarTs) {
      d.push(`barTs ${r.before.resolvedAtBarTs ? new Date(r.before.resolvedAtBarTs).toISOString() : 'undef'}->${r.after.resolvedAtBarTs ? new Date(r.after.resolvedAtBarTs).toISOString() : 'undef'}`);
    }
    if (r.before.entryConfirmed !== r.after.entryConfirmed) d.push(`entryConfirmed ${r.before.entryConfirmed}->${r.after.entryConfirmed}`);
    return d;
  };
  if (!gate2) {
    console.log(`        ${gate2Bad.length} of ${zoneRows.length} differ. EXACT differing fields:`);
    for (const r of gate2Bad.slice(0, 14)) {
      console.log(`        [${r.p.index}] ${diffFields(r).join(' | ')}`);
    }
  }

  // ── WHY did they differ? Independently recover the OLD confirmation MECHANISM.
  // The baseline resolver does not report it, so it is re-derived here by walking
  // the same bars with the same tolerances and recording the FIRST bar on which
  // the pre-Item-21 condition (touchedZone || crossedTp1 || crossedSl ||
  // touchedExtended) fired, then asking whether THAT bar was a zone touch.
  const oldMechanism = (p: ParsedSignal): { via: 'zone' | 'levels-cross' | 'none'; barTs: number | null } => {
    const isBuy = p.direction === 'BUY';
    const eMin = p.entry;
    const eMax = p.entry;
    for (const bar of bars.filter(b => b.timestamp >= p.generatedMs + 60_000)) {
      const touchedZone = isBuy
        ? bar.low <= eMax + 1.0 && bar.high >= eMin - 1.0
        : bar.high >= eMin - 1.0 && bar.low <= eMax + 1.0;
      const touchedExtended = isBuy
        ? bar.low <= eMax + 3.0 && bar.high >= eMin - 3.0
        : bar.high >= eMin - 3.0 && bar.low <= eMax + 3.0;
      const crossedTp1 = isBuy ? bar.high >= p.tp[0] : bar.low <= p.tp[0];
      const crossedSl = isBuy ? bar.low <= p.sl : bar.high >= p.sl;
      if (touchedZone || touchedExtended) return { via: 'zone', barTs: bar.timestamp };
      if (crossedTp1 || crossedSl) return { via: 'levels-cross', barTs: bar.timestamp };
    }
    return { via: 'none', barTs: null };
  };
  const oldVia = new Map<number, 'zone' | 'levels-cross' | 'none'>();
  for (const r of rows) oldVia.set(r.p.index, oldMechanism(r.p).via);
  const oldZoneRows = rows.filter(r => oldVia.get(r.p.index) === 'zone');
  const oldCrossRows = rows.filter(r => oldVia.get(r.p.index) === 'levels-cross');
  console.log(`\n  DIAGNOSIS — how the PRE-Item-21 resolver obtained each confirmation:`);
  console.log(`    confirmed on a bar that TOUCHED the entry band : ${oldZoneRows.length}`);
  console.log(`    confirmed on a LEVELS-CROSS bar (TP1/SL only)  : ${oldCrossRows.length}`);
  const badInOldZone = gate2Bad.filter(r => oldVia.get(r.p.index) === 'zone').length;
  const badInOldCross = gate2Bad.filter(r => oldVia.get(r.p.index) === 'levels-cross').length;
  console.log(`    of the ${gate2Bad.length} GATE-2 differences: ${badInOldZone} were old-zone-confirmed, ${badInOldCross} were old-levels-cross-confirmed`);
  console.log(`\n  GATE 2 RESTRICTED to signals the OLD resolver confirmed ON A ZONE TOUCH`);
  console.log(`  (the population the gate wording meant by "the 359 zone-confirmed"):`);
  console.log(`    n=${oldZoneRows.length}, differences=${badInOldZone} -> ${badInOldZone === 0 ? 'IDENTICAL' : 'NOT IDENTICAL'}`);
  if (gate2) {
    console.log(`  This restricted view is REPORTED ONLY and was NOT needed: the LITERAL`);
    console.log(`  pre-registered GATE 2 above (all ${zoneRows.length} zone-confirmed) PASSED on its own`);
    console.log(`  terms, so no denominator was swapped and no threshold was loosened.`);
  } else {
    console.log(`  REPORTED, NOT ADOPTED. Swapping the gate's denominator after seeing the result`);
    console.log(`  would be exactly the post-hoc loosening the rules forbid. The LITERAL gate as`);
    console.log(`  pre-registered is the one that counts, and it FAILED.`);
  }
  if (oldCrossRows.length > 0) {
    console.log(`\n  THE AFFECTED POPULATION — old confirmation was a levels-cross (n=${oldCrossRows.length}):`);
    for (const r of oldCrossRows.slice(0, 30)) {
      const d = diffFields(r);
      console.log(`    [${r.p.index}] ${r.p.direction} now via=${r.after.entryVia ?? 'NONE'} ${d.length === 0 ? '(outcome unchanged)' : d.join(' | ')}`);
    }
  }

  // GATE 3 — nothing may go from not-entered to entered.
  const gate3Bad = rows.filter(r => !r.before.entryConfirmed && r.after.entryConfirmed);
  const gate3 = gate3Bad.length === 0;
  console.log(`GATE 3  no signal changed from NOT-ENTERED to ENTERED : ${gate3 ? 'PASS' : 'FAIL'}`);
  if (!gate3) for (const r of gate3Bad.slice(0, 10)) console.log(`    [${r.p.index}] before=not entered, after=${r.after.entryVia}`);

  const gatesClosed = gate1 && gate2 && gate3;
  console.log(`\n  >>> ITEM 21 GATE: ${gatesClosed ? 'ALL THREE CLOSED' : 'NOT CLOSED — STOP'} <<<`);

  console.log('\nSYMMETRY CHECK (Item 21e) — the correction must not hit only the winners:');
  const ocWinBefore = overCredited.filter(r => (r.rBefore ?? 0) > 0).length;
  const ocLossBefore = overCredited.filter(r => (r.rBefore ?? 0) < 0).length;
  console.log(`  of the ${overCredited.length} corrected signals, BEFORE booked ${ocWinBefore} as wins and ${ocLossBefore} as losses.`);
  const byStatus = new Map<string, number>();
  for (const r of overCredited) byStatus.set(r.before.newStatus, (byStatus.get(r.before.newStatus) ?? 0) + 1);
  for (const [st, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`    BEFORE status ${st.padEnd(22)} ${n}`);
  console.log('  Both sides are removed by the same rule, so the correction cannot manufacture');
  console.log('  a falsely worse EV by deleting only the winners.');

  console.log('\nCANONICAL PIPELINE EV (REAL resolver, fromScratch, unfilled EXCLUDED from EV):');
  const rB = rows.map(r => r.rBefore).filter((x): x is number => x !== null);
  const rA = rows.map(r => r.rAfter).filter((x): x is number => x !== null);
  console.log(`  BEFORE (struck through)  : ${mean(rB).toFixed(4)}R   n=${rB.length}   WR ${(100 * rB.filter(x => x > 0).length / rB.length).toFixed(1)}%   PF ${profitFactor(rB).toFixed(3)}`);
  console.log(`  AFTER  (NEW BASELINE)    : ${mean(rA).toFixed(4)}R   n=${rA.length}   WR ${(100 * rA.filter(x => x > 0).length / rA.length).toFixed(1)}%   PF ${profitFactor(rA).toFixed(3)}`);
  console.log(`  DELTA                    : ${(mean(rA) - mean(rB)).toFixed(4)}R   (${rB.length - rA.length} signals left the denominator as NO-TRADE)`);
  if (gapRows.length > 0) {
    console.log(`\n  GAP-PRICED signals (${gapRows.length}) — R from the gap OPEN, not the quoted entry:`);
    for (const r of gapRows.slice(0, 12)) {
      console.log(`    [${r.p.index}] ${r.p.direction} quoted ${r.p.entry} fill ${(r.after.entryFillPrice ?? 0).toFixed(2)} ${r.after.newStatus} R ${(r.rAfter ?? 0).toFixed(3)} (was ${(r.rBefore ?? 0).toFixed(3)})`);
    }
  }
  console.log('\n  NEVER_FILLABLE signals, with the R the OLD resolver booked for them:');
  for (const r of nfRows.slice(0, 24)) {
    console.log(`    [${r.p.index}] ${r.p.direction} entry ${r.p.entry} stored ${r.p.status} | BEFORE ${r.before.newStatus} R ${(r.rBefore ?? 0).toFixed(3)} -> AFTER NEVER_FILLABLE (no R)`);
  }

  // ─────────────────────────── ITEM 23 ───────────────────────────
  console.log(`\n${'='.repeat(78)}\nITEM 23 — THE UNIT-CORRECTED MULTIPLIER (MEASURE ONLY, DO NOT IMPLEMENT)\n${'='.repeat(78)}`);
  console.log('Shipped (buggy) : max(1.0, min(1.6, 0.7 + atr_DOLLARS * 0.06)) -> floored at 1.00x');
  console.log('Unit-corrected  : max(1.0, min(1.6, 0.7 + atr_DOLLARS * 0.6 ))  -> a LARGER stop');
  console.log('SL_on = manual slPips * corrected multiplier; ladder stays 0.70/1.05/1.40 R of it.');
  console.log('This is a DIFFERENT intervention from 19e ON mode, which SHRANK the stop.\n');

  interface AtrSet { label: string; rowsIn: Row[]; atrOf: (r: Row) => number | null; trust: string }
  const wideAtr = new Map<number, number>();
  for (const r of rows) {
    const a = atrAt(bars, r.p.generatedMs);
    if (a !== null) wideAtr.set(r.p.index, a);
  }
  const sets: AtrSet[] = [
    {
      label: `PRINTED-ATR SUBSET (the engine's OWN atr input, exact fidelity)`,
      rowsIn: rows.filter(r => r.p.atrRationale !== null),
      atrOf: (r) => r.p.atrRationale,
      trust: 'reproduces the engine input exactly, but UNDERPOWERED',
    },
    {
      label: `WIDE SET — ATR(14) recomputed from gold_m1_bars at the generation minute`,
      rowsIn: rows.filter(r => wideAtr.has(r.p.index)),
      atrOf: (r) => wideAtr.get(r.p.index) ?? null,
      trust: 'uniformly LABELLED and far larger, but it is Vantage ATR, not the engine feed',
    },
  ];

  for (const set of sets) {
    console.log(`\n--- ${set.label} ---`);
    console.log(`  POWER: n=${set.rowsIn.length} of ${rows.length} bar-covered.  TRUST: ${set.trust}`);
    const offR: number[] = [];
    const onR: number[] = [];
    const onSlPips: number[] = [];
    const onMults: number[] = [];
    let offDollars = 0;
    let onDollars = 0;
    const silence = console.log;
    console.log = (): void => {};
    for (const r of set.rowsIn) {
      const atr = set.atrOf(r);
      if (atr === null) continue;
      const m = Math.max(1.0, Math.min(1.6, 0.7 + atr * 0.6));
      const offSl = Math.abs(r.p.entry - r.p.sl);
      const onSl = offSl * m;
      const dir = r.p.direction === 'BUY' ? 1 : -1;
      const geom = {
        sl: r.p.entry - dir * onSl,
        tp: [r.p.entry + dir * onSl * TP_R.tp1, r.p.entry + dir * onSl * TP_R.tp2, r.p.entry + dir * onSl * TP_R.tp3],
      };
      const outOn = resolveSignalWithBars(toTradingSignal(r.p, geom), bars, quiet);
      const rOn = rFromGeom(r.p, geom.sl, outOn);
      const rOff = r.rAfter;
      if (rOff !== null) { offR.push(rOff); offDollars += rOff * offSl; }
      if (rOn !== null) { onR.push(rOn); onDollars += rOn * onSl; }
      onSlPips.push(onSl / PIP);
      onMults.push(m);
    }
    console.log = silence;
    const sortedSl = [...onSlPips].sort((a, b) => a - b);
    const sortedM = [...onMults].sort((a, b) => a - b);
    console.log(`  corrected multiplier: min ${sortedM[0]?.toFixed(2)} p50 ${pct(sortedM, 0.5).toFixed(2)} max ${sortedM[sortedM.length - 1]?.toFixed(2)}`);
    console.log(`  ON  SL pips        : min ${sortedSl[0]?.toFixed(1)} p25 ${pct(sortedSl, 0.25).toFixed(1)} p50 ${pct(sortedSl, 0.5).toFixed(1)} p75 ${pct(sortedSl, 0.75).toFixed(1)} max ${sortedSl[sortedSl.length - 1]?.toFixed(1)}`);
    console.log(`  ON  SL in ATR multiples: p50 ${pct([...set.rowsIn.map(r => { const a = set.atrOf(r); return a === null ? NaN : (Math.abs(r.p.entry - r.p.sl) * Math.max(1.0, Math.min(1.6, 0.7 + a * 0.6))) / a; }).filter(Number.isFinite)].sort((a, b) => a - b), 0.5).toFixed(2)}x ATR`);
    console.log(`  OFF (today, post-Item-21): EV ${mean(offR).toFixed(4)}R  WR ${(100 * offR.filter(x => x > 0).length / Math.max(offR.length, 1)).toFixed(1)}%  PF ${profitFactor(offR).toFixed(3)}  n=${offR.length}`);
    console.log(`  ON  (unit-corrected)     : EV ${mean(onR).toFixed(4)}R  WR ${(100 * onR.filter(x => x > 0).length / Math.max(onR.length, 1)).toFixed(1)}%  PF ${profitFactor(onR).toFixed(3)}  n=${onR.length}`);
    console.log(`  net $ per signal at 1 unit: OFF ${(offDollars / Math.max(offR.length, 1)).toFixed(3)}   ON ${(onDollars / Math.max(onR.length, 1)).toFixed(3)}`);
    console.log(`  VERDICT for this set: ${mean(onR) > mean(offR) ? 'ON better in R' : 'ON WORSE in R'}; ${(onDollars / Math.max(onR.length, 1)) > (offDollars / Math.max(offR.length, 1)) ? 'ON better in $' : 'ON WORSE in $'}`);
  }

  // ─────────────────────────── ITEM 24 ───────────────────────────
  console.log(`\n${'='.repeat(78)}\nITEM 24 — DOES THE DEFECT CONTAMINATE THE PRIOR "CLOSED" ANALYSES?\n${'='.repeat(78)}`);
  const affected = rows.filter(r => neverFillable(r) || gapFilled(r));
  console.log(`  affected population (NEVER_FILLABLE + gap-repriced): ${affected.length}`);
  const affBuy = affected.filter(r => r.p.direction === 'BUY').length;
  const affSell = affected.filter(r => r.p.direction === 'SELL').length;
  console.log(`  direction split: BUY ${affBuy}  SELL ${affSell}`);
  console.log(`  affected indices: ${affected.map(r => r.p.index).sort((a, b) => a - b).join(', ')}`);
  const affR = affected.map(r => r.rBefore).filter((x): x is number => x !== null);
  console.log(`  R the OLD resolver booked for them: mean ${mean(affR).toFixed(4)}R over n=${affR.length}, sum ${affR.reduce((a, b) => a + b, 0).toFixed(3)}R`);

  console.log(`\n  (a) OVERLAP WITH THE SETS THOSE ANALYSES WERE MEASURED OVER`);
  console.log(`      Items C and D and the SELL-suppression re-test all draw from THIS export,`);
  console.log(`      filtered to bar coverage, and all label outcomes with resolveSignalWithBars.`);
  console.log(`      Their stated n: Item D 369, Item C 369 (same canonical set), SELL re-test bar-verified subset.`);
  console.log(`      This run's bar-covered set: ${rows.length}. The affected signals are members of that`);
  console.log(`      same population, so the overlap is ${affected.length} unless an analysis excluded them for`);
  console.log(`      an unrelated reason. Exact per-analysis membership is only knowable by re-running`);
  console.log(`      each one, which Item 24(d) forbids in this pass.`);
  const affShare = (100 * affected.length) / Math.max(rows.length, 1);
  console.log(`      share of the canonical set: ${affShare.toFixed(2)}%`);
  console.log(`      SELL share of affected: ${affSell} of ${affected.length} — this is what bounds any`);
  console.log(`      SELL-side conclusion's exposure.`);

  console.log(`\n  (c) HAS THE CONTAMINATION ALREADY REACHED trade_outcomes_v1?`);
  const ids = affected.map(r => r.p.id).filter(x => x.length > 0);
  console.log(`      querying trade_outcomes_v1 DIRECT (anon) for ${ids.length} signal ids...`);
  const { data: corpus, error: cErr, count } = await supabase
    .from('trade_outcomes_v1')
    .select('signal_id, result, realized_r, pnl, entry_price, exit_price, is_scratch, ts', { count: 'exact' })
    .in('signal_id', ids);
  const { count: totalCorpus } = await supabase
    .from('trade_outcomes_v1')
    .select('signal_id', { count: 'exact', head: true });
  if (cErr) {
    console.log(`      READ FAILED: ${cErr.message}`);
    console.log(`      MEASUREMENT NOT OBTAINED — reported as a failure, not as "zero rows".`);
  } else {
    console.log(`      trade_outcomes_v1 total rows           : ${totalCorpus ?? 'unknown'}`);
    console.log(`      rows matching an AFFECTED signal id   : ${count ?? (corpus?.length ?? 0)}`);
    for (const row of (corpus ?? []) as { signal_id: string; result: string; realized_r: number | null; pnl: number; ts: string }[]) {
      console.log(`        ${row.signal_id}  result=${row.result}  realized_r=${row.realized_r ?? 'null'}  pnl=${row.pnl}  ts=${row.ts}`);
    }
    if ((corpus?.length ?? 0) === 0) {
      console.log(`      -> NO affected signal has reached the retraining corpus by id.`);
      console.log(`         CAVEAT: this proves absence BY ID ONLY. If the corpus stores a different`);
      console.log(`         id form than the export prints, this query would return 0 for the wrong`);
      console.log(`         reason. Id-form agreement is checked next.`);
    }
  }
  const sampleIds = rows.slice(0, 200).map(r => r.p.id).filter(x => x.length > 0);
  const { count: anyMatch } = await supabase
    .from('trade_outcomes_v1')
    .select('signal_id', { count: 'exact', head: true })
    .in('signal_id', sampleIds);
  console.log(`      ID-FORM CONTROL: rows matching ANY of ${sampleIds.length} export ids: ${anyMatch ?? 0}`);
  console.log(`         A non-zero control means export ids and corpus ids ARE the same form, so a`);
  console.log(`         zero above is a real absence. A zero control means the id forms differ and`);
  console.log(`         the (c) result is INCONCLUSIVE rather than clean.`);

  console.log(`\n${'='.repeat(78)}`);
  console.log(`No engine or resolver file was modified by this script.`);
  console.log(`${'='.repeat(78)}`);
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : err); process.exit(1); });
