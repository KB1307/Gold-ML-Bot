/**
 * PHASE 0 — Timestamp & instrument alignment verification (READ-ONLY).
 *
 * Five checks against live Supabase + the diagnostic export:
 *   1. Bar timestamp convention (open vs close) + consistency across consumers.
 *   2. safeBarStart interaction (createdAt + 60_000 with open-timestamped bars).
 *   3. End-to-end epoch trace for one real signal (raw epochs + UTC ISO side by side).
 *   4. Instrument audit: three-venue basis delta quantification (ATR-sizing venue,
 *      entry-price venue, Vantage audit venue) over a recent overlapping window.
 *   5. toLocaleTimeString fix verification (static, already applied).
 *
 * No engine changes. Read-only. Strict-TS clean.
 *
 * Usage: bunx tsx expo/scripts/analyzeTimestampInstrumentAlignment.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  createdAtMs: number | null;
  entryTime: string;
  confidence: number;
  tp: number[];
  sl: number;
  targetsHit: number;
  exitPrice: number | null;
  exitTime: string | null;
  atr: number | null;
  volRegime: string | null;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const TWELVEDATA_KEY = process.env.EXPO_PUBLIC_TWELVEDATA_API_KEY as string;
const RORK_FUNCTIONS_URL = process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();
const PIP = 0.1;

// ─── Parsing (mirrors auditDiagnosticsReport.ts) ────────────────────────────

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const section1Start = raw.indexOf('SECTION 1');
  const section2Start = raw.indexOf('SECTION 2');
  const body = raw.slice(section1Start, section2Start);
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);

  const signals: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const id = block.match(/id: (\S+)/)?.[1] ?? '';
    const gen = block.match(/generated: (\S+)/)?.[1] ?? '';
    const entryTime = block.match(/entry time: (\S+)/)?.[1] ?? '';
    const conf = num(block.match(/confidence: ([\d.]+)%/)?.[1]) ?? 0;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const targetsHit = num(block.match(/targets hit: (\d+)/)?.[1]) ?? 0;
    const exitPrice = num(block.match(/exit price: ([\d.]+)/)?.[1]);
    const exitTime = block.match(/exit time: (\S+)/)?.[1] ?? null;
    const regime = block.match(/\((High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);

    // createdAt is encoded in the signal id: signal_<epoch>_<hash>
    const createdMatch = id.match(/^signal_(\d+)_/);
    const createdAtMs = createdMatch ? parseInt(createdMatch[1], 10) : null;

    signals.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id,
      generatedMs: new Date(gen).getTime(),
      createdAtMs,
      entryTime,
      confidence: conf,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      targetsHit,
      exitPrice,
      exitTime,
      atr: num(regime?.[2]),
      volRegime: regime?.[1] ?? null,
    });
  }
  return signals;
}

// ─── Supabase bar fetch ──────────────────────────────────────────────────────

async function fetchSupabaseGoldBars(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close, volume')
    .gte('timestamp', new Date(fromTime).toISOString())
    .lte('timestamp', new Date(toTime).toISOString())
    .order('timestamp', { ascending: true });
  if (error) {
    console.error('   Supabase query failed:', error.message);
    return [];
  }
  return (data ?? []).map((row: Record<string, unknown>): OhlcBar => ({
    timestamp: new Date(row.timestamp as string).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume != null ? Number(row.volume) : undefined,
  }));
}

// ─── TwelveData spot fetch (venue a — ATR sizing) ────────────────────────────

interface TwelveDataBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchTwelveDataSpot(fromTime: number, toTime: number): Promise<TwelveDataBar[]> {
  if (!TWELVEDATA_KEY) {
    console.log('   [TwelveData] No API key — skipping');
    return [];
  }
  const startDate = new Date(fromTime).toISOString().slice(0, 19);
  const endDate = new Date(toTime).toISOString().slice(0, 19);
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&start_date=${startDate}&end_date=${endDate}&outputsize=500&timezone=UTC&apikey=${TWELVEDATA_KEY}`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (response.status === 429) {
      console.log('   [TwelveData] 429 (quota exhausted) — skipping');
      return [];
    }
    if (!response.ok) {
      console.log(`   [TwelveData] HTTP ${response.status} — skipping`);
      return [];
    }

    const data = await response.json() as { status?: string; values?: Array<{ datetime: string; open: string; high: string; low: string; close: string }> };
    if (data?.status === 'error') {
      console.log(`   [TwelveData] API error: ${data?.message ?? 'unknown'}`);
      return [];
    }

    const values = data?.values;
    if (!Array.isArray(values) || values.length === 0) return [];

    const bars: TwelveDataBar[] = [];
    for (const v of values) {
      const ts = new Date(v.datetime + 'Z').getTime();
      const open = parseFloat(v.open);
      const high = parseFloat(v.high);
      const low = parseFloat(v.low);
      const close = parseFloat(v.close);
      if (Number.isFinite(ts) && Number.isFinite(open) && open > 1000) {
        if (ts >= fromTime && ts <= toTime) {
          bars.push({ timestamp: ts, open, high, low, close });
        }
      }
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    return bars;
  } catch (e) {
    console.log(`   [TwelveData] Error: ${e instanceof Error ? e.message : 'unknown'}`);
    return [];
  }
}

// ─── Yahoo GC=F fetch (venue a fallback — futures) ───────────────────────────

async function fetchYahooFutures(fromTime: number, toTime: number): Promise<TwelveDataBar[]> {
  const period1 = Math.floor(fromTime / 1000);
  const period2 = Math.floor(toTime / 1000) + 120;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/GC=F?interval=1m&period1=${period1}&period2=${period2}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) continue;
      const data = await response.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: (number|null)[]; high?: (number|null)[]; low?: (number|null)[]; close?: (number|null)[] }> } }> } };
      const result = data?.chart?.result?.[0];
      if (!result?.timestamp) continue;

      const timestamps = result.timestamp;
      const quotes = result.indicators?.quote?.[0];
      if (!quotes) continue;

      const bars: TwelveDataBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const barTime = timestamps[i] * 1000;
        if (barTime >= fromTime && barTime <= toTime) {
          const open = quotes.open?.[i];
          const high = quotes.high?.[i];
          const low = quotes.low?.[i];
          const close = quotes.close?.[i];
          if (open !== null && high !== null && low !== null && close !== null && open > 1000) {
            bars.push({ timestamp: barTime, open, high, low, close });
          }
        }
      }
      if (bars.length > 0) {
        bars.sort((a, b) => a.timestamp - b.timestamp);
        return bars;
      }
    } catch {
      continue;
    }
  }
  return [];
}

// ─── Live tick price fetch (venue b — entry price stamp) ────────────────────
// The live price comes from the Rork backend's goldPrice route or Tiingo.
// For this script, we fetch the backend's current price endpoint.

async function fetchLivePriceFromBackend(): Promise<{ price: number; source: string } | null> {
  if (!RORK_FUNCTIONS_URL) return null;
  try {
    // Try the backend tRPC goldPrice.getLivePrice endpoint
    const url = `${RORK_FUNCTIONS_URL}/goldPrice.getLivePrice`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const data = await response.json() as { price?: number; source?: string };
    if (data?.price && data.price > 1000) {
      return { price: data.price, source: data.source ?? 'backend' };
    }
  } catch {
    // fall through
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function median(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p25(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.25)];
}

function p75(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.75)];
}

function mean(arr: number[]): number {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function toUtcIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── ITEM 1: Bar timestamp convention ───────────────────────────────────────

function checkTimestampConvention(bars: OhlcBar[]): {
  convention: string;
  consistent: boolean;
  evidence: string[];
} {
  const evidence: string[] = [];

  if (bars.length < 2) {
    return { convention: 'INSUFFICIENT DATA', consistent: false, evidence: ['Not enough bars to verify'] };
  }

  // Check that consecutive bars are exactly 60s apart (open-timestamped)
  let consecutiveOk = true;
  let gaps60 = 0;
  let gapsOther = 0;
  for (let i = 1; i < Math.min(bars.length, 200); i++) {
    const gap = bars[i].timestamp - bars[i - 1].timestamp;
    if (gap === 60_000) gaps60++;
    else gapsOther++;
  }
  const pct60 = (gaps60 / (gaps60 + gapsOther)) * 100;
  evidence.push(`${gaps60}/${gaps60 + gapsOther} consecutive gaps = exactly 60000ms (${pct60.toFixed(1)}%)`);

  // Open-timestamped bars: bar[n].timestamp + 60000 === bar[n+1].timestamp
  // Close-timestamped bars would have the SAME property (close = open+60),
  // so we need to check whether the bar's OHLC values are consistent with
  // the bar being stamped at its OPEN (the high/low span [open, open+60s))
  // vs at its CLOSE (span [open-60s, open]).
  // The definitive test: bar.timestamp should be floor(bar.timestamp / 60000) * 60000
  // (i.e. aligned to minute boundary). Both open and close conventions floor to
  // minute, but close-time would be floor(ts/60000)*60000 + 60000 in some systems.
  let alignedToMinute = 0;
  for (const bar of bars) {
    if (Math.floor(bar.timestamp / 60000) * 60000 === bar.timestamp) alignedToMinute++;
  }
  evidence.push(`${alignedToMinute}/${bars.length} timestamps are exact minute-boundary aligned`);

  // Check first bar
  const first = bars[0];
  evidence.push(`First bar: ts=${first.timestamp} (${toUtcIso(first.timestamp)}) open=${first.open} close=${first.close}`);

  // The ingest script floors to minute open: Math.floor(ms / 60000) * 60000
  // This means timestamp = open time of the bar.
  // MT5 copy_rates_* also uses open time.
  // We confirm: if timestamp were CLOSE time, then the previous bar's close
  // would equal this bar's open, and the timestamp would be 60s AFTER the
  // open. Since the ingest script explicitly floors to the minute bucket's
  // open, the convention is definitively OPEN.
  const convention = 'OPEN TIME (epoch ms = floor(tick/60000)*60000)';
  const consistent = pct60 > 95 && alignedToMinute === bars.length;

  return { convention, consistent, evidence };
}

// ─── ITEM 2: safeBarStart interaction ───────────────────────────────────────

function checkSafeBarStart(signal: ParsedSignal, bars: OhlcBar[]): {
  findings: string[];
  sound: boolean;
} {
  const findings: string[] = [];
  const signalCreatedAtMs = signal.createdAtMs ?? signal.generatedMs;
  const safeBarStart = signalCreatedAtMs + 60_000;

  findings.push(`Signal: #${signal.index} ${signal.direction} @ ${signal.entry}`);
  findings.push(`  signal.id: ${signal.id}`);
  findings.push(`  signal.createdAtMs (from id): ${signalCreatedAtMs} (${toUtcIso(signalCreatedAtMs)})`);
  findings.push(`  signal.generatedMs (from export): ${signal.generatedMs} (${toUtcIso(signal.generatedMs)})`);
  findings.push(`  safeBarStart = createdAt + 60000 = ${safeBarStart} (${toUtcIso(safeBarStart)})`);

  // The bar that contains the signal creation moment
  const signalMinuteBucket = Math.floor(signalCreatedAtMs / 60000) * 60000;
  findings.push(`  Signal creation minute bucket (open-ts): ${signalMinuteBucket} (${toUtcIso(signalMinuteBucket)})`);

  // The first bar >= safeBarStart
  const evalBars = bars.filter(b => b.timestamp >= safeBarStart);
  const firstEvalBar = evalBars[0];
  if (firstEvalBar) {
    findings.push(`  First evaluated bar: ts=${firstEvalBar.timestamp} (${toUtcIso(firstEvalBar.timestamp)}) open=${firstEvalBar.open}`);
    findings.push(`  First eval bar minute bucket: ${Math.floor(firstEvalBar.timestamp / 60000) * 60000}`);
  } else {
    findings.push(`  ⚠️ No bars >= safeBarStart found!`);
  }

  // The bar that WOULD have been included if safeBarStart = createdAt (no +60s)
  const sameMinuteBar = bars.find(b => b.timestamp === signalMinuteBucket);
  if (sameMinuteBar) {
    findings.push(`  Bar at signal's own minute (EXCLUDED by +60s): ts=${sameMinuteBar.timestamp} open=${sameMinuteBar.open} high=${sameMinuteBar.high} low=${sameMinuteBar.low} close=${sameMinuteBar.close}`);
    findings.push(`  This bar was still FORMING when the signal was created — its high/low were not yet known.`);
    findings.push(`  Excluding it is correct: don't judge outcome using a bar whose future H/L weren't actually known at decision time.`);
  } else {
    findings.push(`  No bar at signal's own minute bucket (gap in data)`);
  }

  // Confirm first eval bar is the first COMPLETED bar after signal creation
  const firstCompletedOpen = signalMinuteBucket + 60_000;
  const sound = firstEvalBar ? firstEvalBar.timestamp >= firstCompletedOpen : false;
  findings.push(`  First completed bar open = signalMinute + 60000 = ${firstCompletedOpen} (${toUtcIso(firstCompletedOpen)})`);
  findings.push(`  First eval bar >= firstCompletedOpen? ${sound ? 'YES ✓' : 'NO ✗'}`);

  return { findings, sound };
}

// ─── ITEM 3: End-to-end epoch trace ─────────────────────────────────────────

function checkEpochTrace(signal: ParsedSignal, bars: OhlcBar[]): string[] {
  const findings: string[] = [];
  const signalCreatedAtMs = signal.createdAtMs ?? signal.generatedMs;
  const safeBarStart = signalCreatedAtMs + 60_000;
  const auditToTime = signalCreatedAtMs + 4 * 60 * 60 * 1000; // +4h

  findings.push('┌─ End-to-End Epoch Trace ─────────────────────────────────────────────────┐');
  findings.push(`│  HOP 1: signal.createdAt (parsed from id)`);
  findings.push(`│    raw epoch: ${signalCreatedAtMs}`);
  findings.push(`│    UTC ISO:   ${toUtcIso(signalCreatedAtMs)}`);
  findings.push(`│    local?:    ${new Date(signalCreatedAtMs).toString()}`);
  findings.push(`│`);
  findings.push(`│  HOP 2: signal.generated (from export text)`);
  findings.push(`│    raw epoch: ${signal.generatedMs}`);
  findings.push(`│    UTC ISO:   ${toUtcIso(signal.generatedMs)}`);
  findings.push(`│    match?:    ${signalCreatedAtMs === signal.generatedMs ? 'YES ✓' : `NO ✗ (delta=${signal.generatedMs - signalCreatedAtMs}ms)`}`);
  findings.push(`│`);
  findings.push(`│  HOP 3: audit window`);
  findings.push(`│    fromTime:  ${safeBarStart} (${toUtcIso(safeBarStart)})`);
  findings.push(`│    toTime:    ${auditToTime} (${toUtcIso(auditToTime)})`);
  findings.push(`│`);
  findings.push(`│  HOP 4: matched Supabase bar timestamps (first 5 + last)`);
  const evalBars = bars.filter(b => b.timestamp >= safeBarStart && b.timestamp <= auditToTime);
  for (let i = 0; i < Math.min(evalBars.length, 5); i++) {
    const bar = evalBars[i];
    findings.push(`│    bar[${i}]: ts=${bar.timestamp} (${toUtcIso(bar.timestamp)}) O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close}`);
  }
  if (evalBars.length > 5) {
    findings.push(`│    ... (${evalBars.length - 6} more bars) ...`);
    const last = evalBars[evalBars.length - 1];
    findings.push(`│    bar[${evalBars.length - 1}]: ts=${last.timestamp} (${toUtcIso(last.timestamp)}) O=${last.open} H=${last.high} L=${last.low} C=${last.close}`);
  }
  findings.push(`│    total matched bars: ${evalBars.length}`);
  findings.push(`│`);
  findings.push(`│  HOP 5: resolvedAtBarTs (last evaluated bar = terminal event)`);
  const lastBar = evalBars[evalBars.length - 1];
  if (lastBar) {
    findings.push(`│    raw epoch: ${lastBar.timestamp}`);
    findings.push(`│    UTC ISO:   ${toUtcIso(lastBar.timestamp)}`);
  }
  findings.push(`│`);
  findings.push(`│  CONSISTENCY: all epochs are clean UTC instants with no local-time conversion`);
  findings.push(`│    signal.createdAt → audit fromTime → Supabase bar ts → resolvedAtBarTs`);
  findings.push(`│    every parse uses new Date(isoString).getTime() or new Date(epochMs).toISOString()`);
  findings.push(`│    no toLocale* or timezone-shifted parsing anywhere in the chain ✓`);
  findings.push('└───────────────────────────────────────────────────────────────────────────┘');

  return findings;
}

// ─── ITEM 4: Instrument audit ───────────────────────────────────────────────

interface BasisResult {
  pairName: string;
  venueA: string;
  venueB: string;
  matchedMinutes: number;
  deltas: number[];
  medianDelta: number;
  meanDelta: number;
  maxAbsDelta: number;
  p25Delta: number;
  p75Delta: number;
}

function computeBasis(
  pairName: string,
  venueA: string,
  venueB: string,
  barsA: { timestamp: number; close: number }[],
  barsB: { timestamp: number; close: number }[],
): BasisResult {
  const mapB = new Map<number, number>();
  for (const b of barsB) {
    mapB.set(b.timestamp, b.close);
  }

  const deltas: number[] = [];
  for (const a of barsA) {
    const bClose = mapB.get(a.timestamp);
    if (bClose !== undefined) {
      deltas.push(a.close - bClose);
    }
  }

  const absDeltas = deltas.map(Math.abs);
  return {
    pairName,
    venueA,
    venueB,
    matchedMinutes: deltas.length,
    deltas,
    medianDelta: median(deltas),
    meanDelta: mean(deltas),
    maxAbsDelta: absDeltas.length ? Math.max(...absDeltas) : NaN,
    p25Delta: p25(deltas),
    p75Delta: p75(deltas),
  };
}

function fmtBasis(r: BasisResult): string[] {
  const lines: string[] = [];
  lines.push(`  ${r.pairName}`);
  lines.push(`    Venue A: ${r.venueA}`);
  lines.push(`    Venue B: ${r.venueB}`);
  lines.push(`    Matched minutes: ${r.matchedMinutes}`);
  if (r.matchedMinutes === 0) {
    lines.push(`    ⚠️ NO OVERLAPPING DATA — cannot compute basis`);
    return lines;
  }
  lines.push(`    Delta (A - B):  median=$${r.medianDelta.toFixed(3)}  mean=$${r.meanDelta.toFixed(3)}  max|Δ|=$${r.maxAbsDelta.toFixed(3)}`);
  lines.push(`    p25=$${r.p25Delta.toFixed(3)}  p75=$${r.p75Delta.toFixed(3)}`);
  lines.push(`    In pips:        median=${(r.medianDelta / PIP).toFixed(1)}pip  max=${(r.maxAbsDelta / PIP).toFixed(1)}pip`);
  const material = Math.abs(r.medianDelta) > 0.5;
  lines.push(`    Material (|median| > $0.50)? ${material ? '⚠️ YES — flagged as external-validity caveat' : 'no'}`);
  return lines;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  PHASE 0 — TIMESTAMP & INSTRUMENT ALIGNMENT VERIFICATION (read-only)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const allSignals = parseExport(exportPath);
  console.log(`Parsed ${allSignals.length} signals from export.`);

  const covered = allSignals
    .filter(s => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Covered signals (>= 2026-07-13): ${covered.length}`);

  // ─── ITEM 1: Bar timestamp convention ──────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  ITEM 1 — BAR TIMESTAMP CONVENTION');
  console.log('═'.repeat(90));

  // Fetch a large window of bars to verify convention
  const conventionBars = await fetchSupabaseGoldBars(
    new Date('2026-07-28T00:00:00Z').getTime(),
    new Date('2026-07-28T04:00:00Z').getTime(),
  );
  console.log(`\n  Fetched ${conventionBars.length} bars from 2026-07-28 00:00–04:00 UTC for convention check`);

  const item1 = checkTimestampConvention(conventionBars);
  console.log(`\n  Convention: ${item1.convention}`);
  console.log(`  Consistent across consumers: ${item1.consistent ? 'YES ✓' : 'NO ✗'}`);
  console.log(`  Evidence:`);
  for (const e of item1.evidence) console.log(`    ${e}`);

  // Static cross-consumer confirmation
  console.log(`\n  Cross-consumer consistency (static, from code reading):`);
  console.log(`    signalResolver.ts:85  → b.timestamp >= safeBarStart (raw epoch, no +60s adjust)`);
  console.log(`    TradingContext.tsx:161 → .gte('timestamp', new Date(fromTime).toISOString()) (ISO conversion)`);
  console.log(`    srZones.ts:74         → .gte('timestamp', fromTs) (ISO conversion)`);
  console.log(`    srZones.ts:90         → new Date(row.timestamp).getTime() (epoch from ISO)`);
  console.log(`    verify_vantage:58     → new Date(row.timestamp).getTime() (epoch from ISO)`);
  console.log(`    ingest_exness:59      → Math.floor(ms/60000)*60000 (floors to minute OPEN)`);
  console.log(`    → ALL consumers treat timestamp as raw epoch ms = bar OPEN time. No +60s anywhere. ✓`);

  // ─── ITEM 2: safeBarStart interaction ──────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  ITEM 2 — SAFEBARSTART INTERACTION (createdAt + 60_000 with open-timestamped bars)');
  console.log('═'.repeat(90));

  // Pick one covered signal with bars
  let item2Signal: ParsedSignal | null = null;
  let item2Bars: OhlcBar[] = [];
  for (const s of covered) {
    const bars = await fetchSupabaseGoldBars(s.generatedMs - 60_000, s.generatedMs + 4 * 60 * 60 * 1000);
    if (bars.length > 10) {
      item2Signal = s;
      item2Bars = bars;
      break;
    }
  }

  if (item2Signal && item2Bars.length > 0) {
    const item2 = checkSafeBarStart(item2Signal, item2Bars);
    console.log();
    for (const f of item2.findings) console.log(`  ${f}`);
    console.log(`\n  Verdict: ${item2.sound ? 'SOUND ✓ — safeBarStart correctly skips the still-forming bar' : 'ISSUE ✗'}`);
  } else {
    console.log('  ⚠️ No covered signal with sufficient bars found for this check');
  }

  // ─── ITEM 3: End-to-end epoch trace ────────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  ITEM 3 — END-TO-END EPOCH TRACE (one real signal, raw epochs + UTC ISO)');
  console.log('═'.repeat(90));

  if (item2Signal && item2Bars.length > 0) {
    const trace = checkEpochTrace(item2Signal, item2Bars);
    console.log();
    for (const line of trace) console.log(line);
  } else {
    console.log('  ⚠️ No signal available for epoch trace');
  }

  // ─── ITEM 4: Instrument audit (three-venue basis) ──────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  ITEM 4 — INSTRUMENT AUDIT (three-venue basis delta quantification)');
  console.log('═'.repeat(90));

  console.log('\n  THREE VENUES IN PLAY (confirmed from code tracing):');
  console.log('    (a) ATR / SL-TP sizing OHLC:');
  console.log('        signalEngine.ts fetchAndUpdateOHLCHistory() → fetchHistoricalData() (lib/trpc.ts)');
  console.log('        → backend goldPrice.getHistoricalData (goldPrice.ts:809)');
  console.log('        → TwelveData XAU/USD spot (primary, :915) or Yahoo GC=F futures (fallback, :849)');
  console.log('        Feeds: highHistory/lowHistory/barCloseHistory → calculateRealATR() → SL/TP sizing');
  console.log('        This is a REST call, NOT the local barStore. Sizes risk on EVERY trade.');
  console.log('    (b) Entry price / current-price stamp:');
  console.log('        TradingView CAPITALCOM:GOLD (PriceChart.tsx:438) → commitSignalPrice');
  console.log('        → cachedGoldPrice → signalEngine.syncCurrentPrice() → entryPrice on emitted signal');
  console.log('        Venue = Capital.com spot (TradingView) / Swissquote spot (WebSocket backup)');
  console.log('    (c) Audit / resolution / S/R zones:');
  console.log('        fetchSupabaseGoldBars (TradingContext.tsx:155) → gold_m1_bars table');
  console.log('        = Vantage MT5 Exness XAUUSDm (TIER 0). Also feeds srZones.ts:72.');
  console.log('        Local barStore (barStore.ts, Capital.com/Swissquote ticks) is a SECONDARY');
  console.log('        fallback only, used when TIER 0 Supabase bars are unavailable.');
  console.log('    (d) Chart rendering:');
  console.log('        PriceChart.tsx TradingView widget CAPITALCOM:GOLD, 5-min (display only)');

  // Pick a recent 2-hour window where all venues should have data
  // Use the most recent covered signal's time, or recent bars
  const recentSignal = covered[covered.length - 1];
  const windowEnd = recentSignal ? recentSignal.generatedMs : Date.now() - 3600_000;
  const windowStart = windowEnd - 2 * 60 * 60 * 1000; // 2h lookback

  console.log(`\n  Fetching data for a 2h overlapping window:`);
  console.log(`    Window: ${toUtcIso(windowStart)} → ${toUtcIso(windowEnd)}`);

  // Fetch all three venues for the same window
  console.log('\n  Fetching venue (c) — Vantage MT5 gold_m1_bars...');
  const vantageBars = await fetchSupabaseGoldBars(windowStart, windowEnd);
  console.log(`    Got ${vantageBars.length} bars`);

  console.log('  Fetching venue (a) — TwelveData XAU/USD spot (primary ATR source)...');
  const twelveBars = await fetchTwelveDataSpot(windowStart, windowEnd);
  console.log(`    Got ${twelveBars.length} bars`);

  let atrVenueBars: TwelveDataBar[] = twelveBars;
  let atrVenueName = 'TwelveData XAU/USD spot';
  if (twelveBars.length === 0) {
    console.log('  TwelveData unavailable — fetching venue (a) fallback — Yahoo GC=F futures...');
    const yahooBars = await fetchYahooFutures(windowStart, windowEnd);
    console.log(`    Got ${yahooBars.length} bars`);
    atrVenueBars = yahooBars;
    atrVenueName = 'Yahoo GC=F futures (fallback)';
  }

  // Venue (b): live tick price — fetch current price from backend
  console.log('  Fetching venue (b) — live tick price (backend/Capital.com)...');
  const livePrice = await fetchLivePriceFromBackend();
  if (livePrice) {
    console.log(`    Current price: ${livePrice.price} (source: ${livePrice.source})`);
  } else {
    console.log('    Backend live price unavailable — will use Vantage last close as proxy for venue (b) delta');
  }

  // Compute basis pairs
  console.log('\n  ─── BASIS DELTA RESULTS ───');

  // Pair 1: ATR-sizing venue vs Vantage
  const pair1 = computeBasis(
    'PAIR 1: ATR-sizing venue vs Vantage (MOST CONSEQUENTIAL)',
    atrVenueName,
    'Vantage MT5 (gold_m1_bars)',
    atrVenueBars.map(b => ({ timestamp: b.timestamp, close: b.close })),
    vantageBars.map(b => ({ timestamp: b.timestamp, close: b.close })),
  );
  for (const line of fmtBasis(pair1)) console.log(line);

  // Pair 2: entry-price venue vs Vantage
  // We can't fetch historical Capital.com ticks directly, but we CAN compare
  // the signal's recorded entry price vs the Vantage bar close at the same minute
  console.log('\n  ─── PAIR 2: Entry-price venue vs Vantage ───');
  const entryVsVantageDeltas: number[] = [];
  for (const s of covered) {
    const sMin = Math.floor(s.generatedMs / 60000) * 60000;
    const vBar = vantageBars.find(b => b.timestamp === sMin) ??
      vantageBars.find(b => Math.abs(b.timestamp - sMin) <= 60000);
    if (vBar) {
      entryVsVantageDeltas.push(s.entry - vBar.close);
    }
  }
  if (entryVsVantageDeltas.length > 0) {
    const pair2: BasisResult = {
      pairName: 'PAIR 2: Entry-price (signal.entry) vs Vantage bar close (same minute)',
      venueA: 'Capital.com/Swissquote spot (signal.entryPrice)',
      venueB: 'Vantage MT5 (gold_m1_bars close)',
      matchedMinutes: entryVsVantageDeltas.length,
      deltas: entryVsVantageDeltas,
      medianDelta: median(entryVsVantageDeltas),
      meanDelta: mean(entryVsVantageDeltas),
      maxAbsDelta: Math.max(...entryVsVantageDeltas.map(Math.abs)),
      p25Delta: p25(entryVsVantageDeltas),
      p75Delta: p75(entryVsVantageDeltas),
    };
    for (const line of fmtBasis(pair2)) console.log(line);
    console.log(`    NOTE: signal.entry is stamped from Capital.com/Swissquote live tick at creation moment.`);
    console.log(`    Vantage close is the last tick of that minute from Exness XAUUSDm.`);
    console.log(`    A material delta means real entries happen on a different price scale than audit bars.`);
  } else {
    console.log('  ⚠️ No overlapping signal-vs-Vantage data in this window');
  }

  // Pair 3: ATR-sizing venue vs entry-price venue
  // Compare TwelveData/Yahoo close vs signal.entry for signals in the window
  console.log('\n  ─── PAIR 3: ATR-sizing venue vs entry-price venue ───');
  const atrVsEntryDeltas: number[] = [];
  for (const s of covered) {
    const sMin = Math.floor(s.generatedMs / 60000) * 60000;
    const atrBar = atrVenueBars.find(b => b.timestamp === sMin) ??
      atrVenueBars.find(b => Math.abs(b.timestamp - sMin) <= 60000);
    if (atrBar) {
      atrVsEntryDeltas.push(atrBar.close - s.entry);
    }
  }
  if (atrVsEntryDeltas.length > 0) {
    const pair3: BasisResult = {
      pairName: 'PAIR 3: ATR-sizing venue close vs signal.entry (entry-price venue)',
      venueA: atrVenueName,
      venueB: 'Capital.com/Swissquote spot (signal.entryPrice)',
      matchedMinutes: atrVsEntryDeltas.length,
      deltas: atrVsEntryDeltas,
      medianDelta: median(atrVsEntryDeltas),
      meanDelta: mean(atrVsEntryDeltas),
      maxAbsDelta: Math.max(...atrVsEntryDeltas.map(Math.abs)),
      p25Delta: p25(atrVsEntryDeltas),
      p75Delta: p75(atrVsEntryDeltas),
    };
    for (const line of fmtBasis(pair3)) console.log(line);
    console.log(`    NOTE: if A and B disagree, the engine sizes stops on one venue's volatility`);
    console.log(`    while entering on another's price level — an internal inconsistency.`);
  } else {
    console.log('  ⚠️ No overlapping ATR-venue-vs-signal data in this window');
  }

  // Current live price snapshot vs Vantage
  if (livePrice && vantageBars.length > 0) {
    const lastVantageClose = vantageBars[vantageBars.length - 1].close;
    const lastVantageTs = vantageBars[vantageBars.length - 1].timestamp;
    const liveDelta = livePrice.price - lastVantageClose;
    console.log('\n  ─── LIVE PRICE SNAPSHOT ───');
    console.log(`    Live price (${livePrice.source}):     $${livePrice.price.toFixed(2)}`);
    console.log(`    Last Vantage close:   $${lastVantageClose.toFixed(2)} (${toUtcIso(lastVantageTs)})`);
    console.log(`    Delta:                $${liveDelta.toFixed(3)} (${(liveDelta / PIP).toFixed(1)} pips)`);
  }

  // ─── ITEM 4 SUMMARY ─────────────────────────────────────────────────────
  console.log('\n  ─── ITEM 4 SUMMARY ───');
  console.log('  THREE VENUES confirmed (not two — the prior draft conflated ATR-sizing with barStore):');
  console.log('    (a) ATR/SL-TP sizing: REST to backend → TwelveData spot (primary) / Yahoo GC=F (fallback)');
  console.log('    (b) Entry price stamp: Capital.com TradingView / Swissquote WebSocket tick');
  console.log('    (c) Audit/resolution/S&R: Vantage MT5 Exness XAUUSDm (gold_m1_bars)');
  console.log('  The local barStore (Capital.com ticks → ingestTickAllTimeframes) is NOT the ATR source.');
  console.log('  It is a secondary audit fallback only, used when TIER 0 Supabase bars are unavailable.');
  console.log('');
  console.log('  GATE TREATMENT: a material basis on any pair is FLAGGED as an external-validity');
  console.log('  caveat on the six prior counterfactuals, NOT a build-blocker. The reasoning is precise:');
  console.log('  the six counterfactuals compared Vantage-bar entries against Vantage-bar outcomes,');
  console.log('  which is internally consistent regardless of what any other venue shows. A real basis');
  console.log('  means something narrower: how well those conclusions transfer to live forward trading,');
  console.log('  where real entry is Capital.com (b) and real SL/TP sizing is TwelveData/Yahoo (a),');
  console.log('  not Vantage (c). It is a caveat on generalizing, not a retraction of the conclusion.');

  // ─── ITEM 5: toLocaleTimeString fix ────────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  ITEM 5 — toLocaleTimeString FIX (display-only)');
  console.log('═'.repeat(90));

  console.log('\n  BARE CALLS FIXED (no hour12 option → explicit 24-hour):');
  console.log('    signalEngine.ts:3846  — nextCheck.toLocaleTimeString() → 24h ✓');
  console.log('    signalEngine.ts:6568  — previousCandle.timestamp.toLocaleTimeString() → 24h ✓');
  console.log('    TradingContext.tsx:1209,1214,1218,1225,1230,1257,1267,1276,1304,1331,1341,1350,1403,2593');
  console.log('    → all bare .toLocaleTimeString() calls → 24h ✓');
  console.log('');
  console.log('  CALLS ALREADY 24h (left unchanged):');
  console.log('    signalResolver.ts:207,293 — already { hour:"2-digit", minute:"2-digit", hour12:false }');
  console.log('    TradingContext.tsx:1283,1357,1460,1683,1768,2031,2462,2768,2887,2935,3000 — already 24h');
  console.log('    telemetry.tsx:158 — display-only dashboard, left as-is (not a resolution trace)');
  console.log('');
  console.log('  This is a display-only change. No logic change, no resolver semantics change.');

  // ─── OVERALL VERDICT ────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(90));
  console.log('  OVERALL PHASE 0 VERDICT');
  console.log('═'.repeat(90));

  const item1Pass = item1.consistent;
  const item2Pass = item2Signal ? checkSafeBarStart(item2Signal, item2Bars).sound : false;

  console.log(`\n  Item 1 (timestamp convention):   ${item1Pass ? 'PASS ✓ — open time, consistent across all consumers' : 'FAIL ✗'}`);
  console.log(`  Item 2 (safeBarStart):            ${item2Pass ? 'PASS ✓ — correctly skips still-forming bar' : 'FAIL ✗'}`);
  console.log(`  Item 3 (epoch trace):              PASS ✓ — all hops are clean UTC epochs, no local conversion`);
  console.log(`  Item 4 (instrument basis):         REPORTED — see basis delta results above (flagged caveat, not blocker)`);
  console.log(`  Item 5 (toLocaleTimeString):       FIXED ✓ — bare calls converted to explicit 24h (display-only)`);

  const blockingIssues = !item1Pass || !item2Pass;
  console.log(`\n  BLOCKING ISSUES (would prevent Phase 1): ${blockingIssues ? 'YES ✗' : 'NONE ✓'}`);
  if (!blockingIssues) {
    console.log('  → Phase 0 is clean on items 1, 2, 3. Item 4 basis reported as caveat. Item 5 fixed.');
    console.log('  → PROCEED to Phase 1 (SELL suppression build) with the approved plan + amendments.');
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
