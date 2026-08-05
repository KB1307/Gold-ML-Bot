/**
 * ITEMS 17d / 17e / 18b / 19a / 19e — READ-ONLY MEASUREMENT.
 *
 * Measures, against the LIVE diagnostics export artifact plus the LIVE
 * gold_m1_bars (Vantage MT5) table read DIRECT via the anon key:
 *
 *   17d — how many emitted signals would be rejected by the proposed
 *         entry-anchor freshness guard (17b) and the geometry sanity gate
 *         (17c), and what their stored outcomes were.
 *   17e — the anchor-divergence profile around the 02:48Z staleness event.
 *   18b — how many signals were entry-confirmed ONLY via the resolver's
 *         `crossedTp1` branch and never touched their entry zone, and what
 *         those signals contribute to the canonical EV.
 *   19a — why the ATR multiplier resolves to 1.00x on every signal.
 *   19e — what an ATR+structure-derived ("ON" mode) SL would have been for
 *         every signal versus the pinned 80 pips, and the R-multiples that
 *         geometry would have produced when re-resolved against real bars.
 *
 * NO engine changes. Report only. Reads gold_m1_bars via Supabase DIRECT
 * (anon key) per the data-source rule; the Rork backend is never a read path.
 *
 * Usage: bun expo/scripts/investigateItems17to19.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ─── Engine constants mirrored EXACTLY from services/signalEngine.ts ─────────
const PIP = 0.1;
const MIN_SL_ATR_MULTIPLE = 1.2; // signalEngine.ts:429
const TP_R = { tp1: 0.7, tp2: 1.05, tp3: 1.4 } as const; // signalEngine.ts:425
const DEFAULT_MAX_SL_PIPS = 90; // signalEngine.ts:7367
const ENTRY_TOL = 1.0; // signalResolver.ts:167
const EXTENDED_ENTRY_TOL = 3.0; // signalResolver.ts:168
const POST_TP1_LOCK_R = 0.35; // signalResolver.ts post-TP1 profit lock

interface OhlcBar { timestamp: number; open: number; high: number; low: number; close: number }

interface Zone { kind: 'SUPPORT' | 'RESISTANCE'; price: number; touches: number; reaction: number }

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  confidence: number;
  tp: number[];
  sl: number;
  targetsHit: number;
  exitPrice: number | null;
  atr: number | null;
  /** ATR as printed in the CURRENT rationale format. Trustworthy unit (price $). */
  atrRationale: number | null;
  slPipsPrinted: number | null;
  multiplierPrinted: number | null;
  zones: Zone[];
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
    const atrTel = num(block.match(/atr=([\d.]+)/)?.[1]);
    const atrLoose = num(block.match(/ATR: ([\d.]+)\)/)?.[1]);
    // STRICT current-geometry marker: only the post-B2 1.4R scalper code prints
    // the "SL <p>p (<m>x ATR) | Multiplier: <x>x" triple. Older engine
    // generations in the same export print a different rationale, so a
    // fleet-wide ATR/multiplier claim would mix incompatible code states.
    const cur = block.match(/rationale: SL ([\d.]+)p \(([\d.]+)x ATR\) \| Multiplier: ([\d.]+)x \((?:High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);
    const zones: Zone[] = [];
    const zoneRe = /(SUPPORT|RESISTANCE) @ ([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%/g;
    let zm: RegExpExecArray | null;
    while ((zm = zoneRe.exec(block)) !== null) {
      zones.push({ kind: zm[1] as Zone['kind'], price: parseFloat(zm[2]), touches: parseInt(zm[3], 10), reaction: parseInt(zm[4], 10) });
    }
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      confidence: num(block.match(/confidence: ([\d.]+)%/)?.[1]) ?? 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      targetsHit: num(block.match(/targets hit: (\d+)/)?.[1]) ?? 0,
      exitPrice: num(block.match(/exit price: ([\d.]+)/)?.[1]),
      atr: atrTel ?? atrLoose,
      atrRationale: cur ? num(cur[4]) : null,
      slPipsPrinted: cur ? num(cur[1]) : null,
      multiplierPrinted: cur ? num(cur[3]) : null,
      zones,
    });
  }
  return out;
}

async function fetchBars(fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 200; p++) {
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
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close });
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

/** Faithful re-resolution mirroring signalResolver.ts semantics. */
function resolve(
  s: { direction: 'BUY' | 'SELL'; entry: number; tp: number[]; sl: number; generatedMs: number },
  bars: OhlcBar[],
  requireZoneTouch: boolean,
): { confirmed: boolean; confirmedVia: 'zone' | 'tp1' | 'sl' | null; targetsHit: number; r: number | null; status: string } {
  const isBuy = s.direction === 'BUY';
  const dir = isBuy ? 1 : -1;
  const risk = Math.abs(s.entry - s.sl);
  if (risk <= 0) return { confirmed: false, confirmedVia: null, targetsHit: 0, r: null, status: 'INVALID' };
  const evalBars = bars.filter(b => b.timestamp >= s.generatedMs + 60_000);
  let confirmed = false;
  let via: 'zone' | 'tp1' | 'sl' | null = null;
  let targets = 0;
  const lock = s.entry + dir * risk * POST_TP1_LOCK_R;
  for (const bar of evalBars) {
    if (!confirmed) {
      const touchedZone = isBuy
        ? bar.low <= s.entry + EXTENDED_ENTRY_TOL && bar.high >= s.entry - EXTENDED_ENTRY_TOL
        : bar.high >= s.entry - EXTENDED_ENTRY_TOL && bar.low <= s.entry + EXTENDED_ENTRY_TOL;
      const crossedTp1 = isBuy ? bar.high >= s.tp[0] : bar.low <= s.tp[0];
      const crossedSl = isBuy ? bar.low <= s.sl : bar.high >= s.sl;
      if (touchedZone) { confirmed = true; via = 'zone'; }
      else if (!requireZoneTouch && crossedTp1) { confirmed = true; via = 'tp1'; }
      else if (!requireZoneTouch && crossedSl) { confirmed = true; via = 'sl'; }
      else continue;
    }
    const slHit = isBuy ? bar.low <= s.sl : bar.high >= s.sl;
    const lockHit = targets === 1 ? (isBuy ? bar.low <= lock : bar.high >= lock) : false;
    const entryStop = targets >= 2 ? (isBuy ? bar.low <= s.entry : bar.high >= s.entry) : false;
    const t1 = isBuy ? bar.high >= s.tp[0] : bar.low <= s.tp[0];
    const t2 = isBuy ? bar.high >= s.tp[1] : bar.low <= s.tp[1];
    const t3 = isBuy ? bar.high >= s.tp[2] : bar.low <= s.tp[2];
    // Same-bar ambiguity: adverse side resolves first (conservative).
    if (targets === 0 && slHit) return { confirmed, confirmedVia: via, targetsHit: 0, r: -1, status: 'SL_HIT' };
    if (lockHit) return { confirmed, confirmedVia: via, targetsHit: 1, r: POST_TP1_LOCK_R, status: 'SL_AFTER_BE' };
    if (entryStop && !t3) return { confirmed, confirmedVia: via, targetsHit: targets, r: 0, status: 'PARTIAL_WIN_SL_HIT' };
    if (t3) return { confirmed, confirmedVia: via, targetsHit: 3, r: TP_R.tp3, status: 'ALL_TARGETS_HIT' };
    if (t2) targets = Math.max(targets, 2);
    else if (t1) targets = Math.max(targets, 1);
  }
  if (!confirmed) return { confirmed: false, confirmedVia: null, targetsHit: 0, r: null, status: 'NEVER_ENTERED' };
  const openR = targets === 2 ? TP_R.tp2 : targets === 1 ? TP_R.tp1 : 0;
  return { confirmed, confirmedVia: via, targetsHit: targets, r: openR, status: 'OPEN' };
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) { console.error('Usage: bun expo/scripts/investigateItems17to19.ts <export.txt>'); process.exit(1); }
  const signals = parseExport(path);
  const withGeom = signals.filter(s => s.tp.length === 3 && s.sl > 0 && Number.isFinite(s.generatedMs));

  console.log('='.repeat(78));
  console.log('ITEMS 17d / 17e / 18b / 19a / 19e — READ-ONLY MEASUREMENT');
  console.log('='.repeat(78));
  console.log(`\nPOWER (stated before any result):`);
  console.log(`  signals parsed from export        : ${signals.length}`);
  console.log(`  with full geometry + timestamp    : ${withGeom.length}`);

  const minTs = Math.min(...withGeom.map(s => s.generatedMs)) - 10 * 60_000;
  const maxTs = Math.max(...withGeom.map(s => s.generatedMs)) + 6 * 60 * 60_000;
  const bars = await fetchBars(minTs, maxTs);
  const byMinute = new Map<number, OhlcBar>();
  for (const b of bars) byMinute.set(Math.floor(b.timestamp / 60_000) * 60_000, b);
  console.log(`  gold_m1_bars rows (anon DIRECT)   : ${bars.length}`);
  console.log(`  bar window                        : ${new Date(minTs).toISOString()} .. ${new Date(maxTs).toISOString()}`);

  const covered = withGeom.filter(s => byMinute.has(Math.floor(s.generatedMs / 60_000) * 60_000));
  console.log(`  signals with a bar AT generation   : ${covered.length}  <-- denominator for 17c/17d`);
  console.log(`  signals NOT covered (no bar)       : ${withGeom.length - covered.length}  (reported, never counted as pass)`);

  // ── 17d/17e: anchor divergence vs the Vantage bar at the generation minute ──
  console.log(`\n${'='.repeat(78)}\n17d — ANCHOR DIVERGENCE AND THE TWO PROPOSED GATES\n${'='.repeat(78)}`);
  console.log('LABEL: divergence = |signal.entryPrice - Vantage close at the generation minute|.');
  console.log('  This is NOT anchor AGE. Anchor age is NOT INSTRUMENTED anywhere in the');
  console.log('  emitted record, so it cannot be measured retrospectively (rule 8).');
  console.log('  Divergence is a DIFFERENT quantity that contains both real venue basis');
  console.log('  and staleness; it is reported as itself, not as a proxy for age.\n');

  const divs: { s: ParsedSignal; div: number; close: number; broken: boolean }[] = [];
  for (const s of covered) {
    const bar = byMinute.get(Math.floor(s.generatedMs / 60_000) * 60_000);
    if (!bar) continue;
    const broken = s.direction === 'BUY' ? bar.close >= s.tp[0] : bar.close <= s.tp[0];
    divs.push({ s, div: Math.abs(s.entry - bar.close), close: bar.close, broken });
  }
  const sortedDiv = divs.map(d => d.div).sort((a, b) => a - b);
  console.log(`  divergence distribution over ${divs.length} signals ($):`);
  for (const q of [0.5, 0.75, 0.9, 0.95, 0.99]) console.log(`    p${(q * 100).toFixed(0).padStart(2)}  ${pct(sortedDiv, q).toFixed(2)}`);
  console.log(`    max  ${sortedDiv[sortedDiv.length - 1].toFixed(2)}`);
  console.log(`    mean ${(sortedDiv.reduce((a, b) => a + b, 0) / sortedDiv.length).toFixed(2)}`);

  for (const thr of [1.5, 2.0, 2.5, 3.0, 4.0, 5.0]) {
    const hit = divs.filter(d => d.div > thr);
    console.log(`  divergence > $${thr.toFixed(1)}: ${hit.length} signals (${(100 * hit.length / divs.length).toFixed(2)}%)`);
  }

  const brokenGeom = divs.filter(d => d.broken);
  console.log(`\n  17c GEOMETRY-UNWINNABLE AT GENERATION (Vantage close already at/past TP1):`);
  console.log(`    ${brokenGeom.length} of ${divs.length} (${(100 * brokenGeom.length / divs.length).toFixed(2)}%)`);
  const brokenByStatus = new Map<string, number>();
  for (const d of brokenGeom) brokenByStatus.set(d.s.status, (brokenByStatus.get(d.s.status) ?? 0) + 1);
  for (const [st, n] of [...brokenByStatus.entries()].sort((a, b) => b[1] - a[1])) console.log(`      stored outcome ${st.padEnd(20)} ${n}`);
  for (const d of brokenGeom.slice(0, 12)) {
    console.log(`      [${d.s.index}] ${d.s.direction} entry ${d.s.entry} TP1 ${d.s.tp[0]} | Vantage close ${d.close.toFixed(2)} (+$${(d.close - d.s.entry).toFixed(2)}) | stored ${d.s.status} targets ${d.s.targetsHit}`);
  }

  console.log(`\n17e — THE 02:48Z EVENT IN CONTEXT (divergence around that minute)`);
  const ev = divs.filter(d => Math.abs(d.s.generatedMs - new Date('2026-08-05T02:48:03Z').getTime()) < 6 * 60 * 60_000)
    .sort((a, b) => a.s.generatedMs - b.s.generatedMs);
  for (const d of ev) {
    console.log(`    ${new Date(d.s.generatedMs).toISOString()} [${d.s.index}] ${d.s.direction} entry ${d.s.entry} close ${d.close.toFixed(2)} div $${d.div.toFixed(2)}${d.broken ? '  <== GEOMETRY UNWINNABLE' : ''}`);
  }

  // ── 18b: crossedTp1-only confirmations ──
  console.log(`\n${'='.repeat(78)}\n18b — SIGNALS CONFIRMED ONLY VIA crossedTp1, NEVER TOUCHING THE ENTRY ZONE\n${'='.repeat(78)}`);
  console.log('METHOD: re-walk real bars per signal with the resolver\'s own tolerances');
  console.log(`  (ENTRY_TOL ${ENTRY_TOL}, EXTENDED_ENTRY_TOL ${EXTENDED_ENTRY_TOL}) and record WHICH branch confirmed entry.\n`);

  let tp1Only = 0, zoneOk = 0, slOnly = 0, never = 0;
  const tp1OnlyRows: { s: ParsedSignal; r: number | null }[] = [];
  const allR: number[] = [];
  for (const s of covered) {
    const res = resolve(s, bars, false);
    if (res.confirmedVia === 'tp1') { tp1Only++; tp1OnlyRows.push({ s, r: res.r }); }
    else if (res.confirmedVia === 'zone') zoneOk++;
    else if (res.confirmedVia === 'sl') slOnly++;
    else never++;
    if (res.r !== null) allR.push(res.r);
  }
  console.log(`  confirmed via entry-zone touch     : ${zoneOk}`);
  console.log(`  confirmed ONLY via crossedTp1      : ${tp1Only}   <-- MATERIALITY NUMBER`);
  console.log(`  confirmed ONLY via crossedSl       : ${slOnly}`);
  console.log(`  never confirmed                    : ${never}`);
  const tp1Statuses = new Map<string, number>();
  for (const t of tp1OnlyRows) tp1Statuses.set(t.s.status, (tp1Statuses.get(t.s.status) ?? 0) + 1);
  console.log(`  stored outcomes of the crossedTp1-only set:`);
  for (const [st, n] of [...tp1Statuses.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${st.padEnd(22)} ${n}`);

  const evAll = allR.length > 0 ? allR.reduce((a, b) => a + b, 0) / allR.length : NaN;
  const tp1R = tp1OnlyRows.map(t => t.r).filter((r): r is number => r !== null);
  const keptR = allR.length - tp1R.length > 0 ? (allR.reduce((a, b) => a + b, 0) - tp1R.reduce((a, b) => a + b, 0)) / (allR.length - tp1R.length) : NaN;
  console.log(`\n  EV including crossedTp1-only : ${evAll.toFixed(4)}R over n=${allR.length}`);
  console.log(`  EV excluding crossedTp1-only : ${keptR.toFixed(4)}R over n=${allR.length - tp1R.length}`);
  console.log(`  crossedTp1-only mean R       : ${tp1R.length > 0 ? (tp1R.reduce((a, b) => a + b, 0) / tp1R.length).toFixed(4) : 'n/a'}R over n=${tp1R.length}`);
  console.log(`  DELTA to EV from removing them: ${(keptR - evAll).toFixed(4)}R`);

  // ── 19a / 19e ──
  console.log(`\n${'='.repeat(78)}\n19a — WHY THE ATR MULTIPLIER IS 1.00x EVERY TIME\n${'='.repeat(78)}`);
  // LABEL RECONCILIATION (rule 5). The `atr=` forward-telemetry field spans
  // 0.40..124.20 across the 392 rows — two incompatible unit conventions in one
  // column (price-$ for recent live rows, something else for older/simulated
  // rows). It is therefore NOT usable for any ATR-denominated claim. Only the
  // rows carrying the CURRENT rationale format print an ATR on the same scale
  // the engine actually used, so 19a/19e are computed on THAT subset only and
  // the reduced n is stated rather than hidden.
  const ratOnly = withGeom.filter(s => s.atrRationale !== null);
  const telAtrs = withGeom.map(s => s.atr).filter((a): a is number => a !== null).sort((a, b) => a - b);
  console.log(`  LABEL WARNING: atr over ALL ${telAtrs.length} rows spans ${telAtrs[0].toFixed(2)}..${telAtrs[telAtrs.length - 1].toFixed(2)}.`);
  console.log(`    The export mixes SEVERAL ENGINE GENERATIONS. Only rows printing the`);
  console.log(`    current "SL <p>p (<m>x ATR) | Multiplier" triple were produced by today's`);
  console.log(`    geometry code, so ONLY those can speak to today's multiplier behaviour.`);
  const atrs = ratOnly.map(s => s.atrRationale as number).sort((a, b) => a - b);
  console.log(`  TRUSTWORTHY ATR (rationale-printed, price $) n=${atrs.length}: min ${atrs[0].toFixed(2)} p50 ${pct(atrs, 0.5).toFixed(2)} max ${atrs[atrs.length - 1].toFixed(2)}`);
  console.log(`  formula: max(1.0, min(1.6, 0.7 + atr * 0.06))`);
  console.log(`  0.7 + 0.06*atr exceeds 1.0 only when atr > 5.00 ($ = 50 pips).`);
  const above = atrs.filter(a => a > 5.0).length;
  console.log(`  rationale-bearing signals with ATR > 5.00: ${above} of ${atrs.length} -> multiplier sits on the 1.0 FLOOR otherwise.`);
  const printedMult = new Map<number, number>();
  for (const s of ratOnly) if (s.multiplierPrinted !== null) printedMult.set(s.multiplierPrinted, (printedMult.get(s.multiplierPrinted) ?? 0) + 1);
  console.log(`  printed multiplier histogram (rationale subset): ${[...printedMult.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m.toFixed(2)}x x${n}`).join(', ')}`);
  const slPrinted = new Map<number, number>();
  for (const s of ratOnly) if (s.slPipsPrinted !== null) slPrinted.set(s.slPipsPrinted, (slPrinted.get(s.slPipsPrinted) ?? 0) + 1);
  console.log(`  printed SL pips histogram: ${[...slPrinted.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}p x${n}`).join(', ')}`);
  const floors = atrs.map(a => a * MIN_SL_ATR_MULTIPLE / PIP).sort((a, b) => a - b);
  console.log(`  ATR noise floor in pips (1.2xATR/pip): p50 ${pct(floors, 0.5).toFixed(1)}p max ${floors[floors.length - 1].toFixed(1)}p`);
  console.log(`  -> floor exceeds the 80p manual SL in ${floors.filter(f => f > 80).length} of ${floors.length} cases, so max(configured, floor) = the manual SL essentially always.`);

  console.log(`\n${'='.repeat(78)}\n19e — ON-MODE SL vs THE 80p ACTUALLY USED, AND RESULTING R\n${'='.repeat(78)}`);
  console.log('ON-mode definition measured here: slPips = clamp(max(1.2xATR, distance to the');
  console.log('  nearest opposing zone beyond entry + 0.3xATR buffer), 12p, 90p); TP ladder');
  console.log('  stays 0.70/1.05/1.40 R of that SL.\n');

  const onRows: { s: ParsedSignal; onSl: number; offSl: number; onR: number | null; offR: number | null }[] = [];
  const onCovered = covered.filter(s => s.atrRationale !== null);
  console.log(`  POWER: restricted to the ${onCovered.length} covered signals with a TRUSTWORTHY printed ATR`);
  console.log(`  (of ${covered.length} covered). This is UNDERPOWERED for an EV claim and is reported as such.\n`);
  for (const s of onCovered) {
    const atr = s.atrRationale as number;
    const isBuy = s.direction === 'BUY';
    const opposing = s.zones.filter(z => (isBuy ? z.kind === 'SUPPORT' && z.price < s.entry : z.kind === 'RESISTANCE' && z.price > s.entry));
    let structPips = 0;
    if (opposing.length > 0) {
      const nearest = opposing.reduce((best, z) => (Math.abs(z.price - s.entry) < Math.abs(best.price - s.entry) ? z : best));
      structPips = (Math.abs(s.entry - nearest.price) + 0.3 * atr) / PIP;
    }
    const atrPips = (atr * MIN_SL_ATR_MULTIPLE) / PIP;
    const onSl = Math.min(Math.max(Math.max(atrPips, structPips), 12), DEFAULT_MAX_SL_PIPS);
    const offSl = Math.abs(s.entry - s.sl) / PIP;
    const dir = isBuy ? 1 : -1;
    const onGeom = {
      direction: s.direction, entry: s.entry, generatedMs: s.generatedMs,
      sl: s.entry - dir * onSl * PIP,
      tp: [s.entry + dir * onSl * TP_R.tp1 * PIP, s.entry + dir * onSl * TP_R.tp2 * PIP, s.entry + dir * onSl * TP_R.tp3 * PIP],
    };
    onRows.push({ s, onSl, offSl, onR: resolve(onGeom, bars, false).r, offR: resolve(s, bars, false).r });
  }
  const onSls = onRows.map(r => r.onSl).sort((a, b) => a - b);
  console.log(`  n=${onRows.length}`);
  console.log(`  ON-mode SL pips: min ${onSls[0].toFixed(1)} p25 ${pct(onSls, 0.25).toFixed(1)} p50 ${pct(onSls, 0.5).toFixed(1)} p75 ${pct(onSls, 0.75).toFixed(1)} max ${onSls[onSls.length - 1].toFixed(1)}`);
  console.log(`  OFF-mode SL pips (actual): ${[...new Set(onRows.map(r => Math.round(r.offSl)))].sort((a, b) => a - b).join(', ')}`);
  const onR = onRows.map(r => r.onR).filter((r): r is number => r !== null);
  const offR = onRows.map(r => r.offR).filter((r): r is number => r !== null);
  const mean = (a: number[]): number => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log(`\n  OFF-mode re-resolved EV: ${mean(offR).toFixed(4)}R  (n=${offR.length})`);
  console.log(`  ON-mode  re-resolved EV: ${mean(onR).toFixed(4)}R  (n=${onR.length})`);
  const onWins = onR.filter(r => r > 0).length, offWins = offR.filter(r => r > 0).length;
  console.log(`  OFF win rate: ${(100 * offWins / Math.max(offR.length, 1)).toFixed(1)}%   ON win rate: ${(100 * onWins / Math.max(onR.length, 1)).toFixed(1)}%`);
  console.log(`\n  NOTE: R is unit-normalised, so a tighter ON stop earning the same R earns FEWER`);
  console.log(`  DOLLARS at fixed lot size. R comparison alone does not settle adoption.`);
  const onDollars = onRows.filter(r => r.onR !== null).reduce((sum, r) => sum + (r.onR as number) * r.onSl * PIP, 0);
  const offDollars = onRows.filter(r => r.offR !== null).reduce((sum, r) => sum + (r.offR as number) * r.offSl * PIP, 0);
  console.log(`  per-signal $ move at 1 unit: OFF ${(offDollars / Math.max(offR.length, 1)).toFixed(3)}  ON ${(onDollars / Math.max(onR.length, 1)).toFixed(3)}`);

  console.log(`\n${'='.repeat(78)}\nEND. No engine file was modified by this script.\n${'='.repeat(78)}`);
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : err); process.exit(1); });
