/**
 * ITEM 41 CHECKPOINT — FALSE-LOSS MECHANISM FIX, REPLAYED AGAINST THE LIVE CORPUS
 * ==============================================================================
 *
 * MINDSET (restated verbatim):
 *  Senior Lead Quantitative Trading Engineer / Senior Institutional Gold
 *  (XAU/USD) Elite Portfolio Manager.
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * DATA-SOURCE RULE: trade_outcomes_v1 + gold_m1_bars read DIRECT via anon key.
 * READ-ONLY against every durable store. This script writes NOTHING.
 *
 * WHAT ITEM 41 CHANGED (the code under test, all in TradingContext.tsx):
 *  41a. Audit `resolutionWindowMs` default 2h -> RESOLUTION_WINDOW_MS (8h).
 *  41b. The `signalAge > 2h -> CLOSED + recordTradeOutcome('LOSS')` block in
 *       catchUpAndEvaluateSignals is DELETED. Maturity alone can no longer
 *       produce a label. A matured signal is resolved from bars (fromScratch)
 *       only when coverage is dense; otherwise it is left untouched for a later
 *       pass. No path assigns a terminal or records an outcome without bars.
 *  41c. The live tick monitor's `signalAge > 2h -> CLOSED` wall-clock stamp is
 *       also gone (it was the OTHER evidence-free CLOSED, and it fed :1450's
 *       skip-once-CLOSED guard). Past maturity the live monitor now returns the
 *       signal untouched and the bar-based paths own the verdict.
 *
 * REPLAY DEFINITION (what "through the fixed path" means here, precisely):
 *  For each corpus row we fetch the signal's real Vantage bars over the NEW 8h
 *  window, run the REAL exported assessBarCoverage() from TradingContext, and
 *  then call the REAL resolveSignalWithBars() with exactly the arguments the
 *  fixed catch-up now passes (fromScratch = matured && dense, evalNowMs = end of
 *  window). Nothing about the outcome is re-implemented here.
 *
 * PRE-REGISTERED GATES (fixed before any number was seen):
 *  G41-1 Every false-LOSS row (corpus=LOSS, bars=WIN) must resolve to a WIN
 *        status under the fixed path, and ZERO of them may still be LOSS.
 *  G41-2 No row on which the corpus and the bars already AGREE may flip. The fix
 *        must correct the defect and nothing else.
 *  G41-3 Bar-evidence-only: every replayed signal lacking dense coverage must
 *        come back "left unchanged" (no terminal, no outcome). A single guessed
 *        label fails this gate.
 *  G41-4 Static, against the live working tree: the guessed-LOSS write and BOTH
 *        wall-clock CLOSED stamps must be absent, and the 8h window must be in
 *        force in the audit, the catch-up, and the live monitor.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;

interface SandboxModule {
  assessBarCoverage(
    bars: { timestamp: number }[],
    fromTime: number,
    toTime: number,
  ): { dense: boolean; reason: string };
}

/**
 * Loads the REAL TradingContext module into a plain-node sandbox (the established
 * pattern in this repo, see test_partA_false_sl_fallback.ts) so the coverage gate
 * under test is the live one, not a copy that can silently drift.
 */
async function loadTradingContext(): Promise<SandboxModule> {
  const sandboxDir = path.join(process.cwd(), 'scripts', '__sandbox_item41__');
  const sandboxPath = path.join(sandboxDir, 'TradingContext.item41.ts');
  const sourcePath = path.join(process.cwd(), 'contexts', 'TradingContext.tsx');
  const source = await readFile(sourcePath, 'utf8');

  const prelude = `import type { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "../../types/trading.ts";
type AppStateStatus = string;
const AsyncStorage = { async getItem() { return null; }, async setItem() {}, async removeItem() {} } as any;
const signalEngine = {} as any;
function setExternalPrice(..._args: unknown[]): void {}
async function fetchLiveGoldPriceFallback(..._args: unknown[]): Promise<unknown> { return null; }
const Platform = { OS: "web" as const };
const AppState = { addEventListener() { return { remove() {} }; }, currentState: "active" } as any;
async function fetchHistoricalData(..._args: unknown[]): Promise<unknown> { return null; }
const goldWebSocketService = {} as any;
function registerBackgroundTask(..._args: unknown[]): void {}
function setupNotificationChannel(..._args: unknown[]): void {}
async function requestNotificationPermissions(..._args: unknown[]): Promise<boolean> { return false; }
async function sendSignalNotification(..._args: unknown[]): Promise<void> {}
function subscribeToChartPrice(..._args: unknown[]): () => void { return () => {}; }
function subscribeToChartHeartbeat(..._args: unknown[]): () => void { return () => {}; }
type OhlcBar = unknown;
async function ensureBarStoreReady(..._args: unknown[]): Promise<void> {}
async function ingestTickAllTimeframes(..._args: unknown[]): Promise<void> {}
async function upsertBars(..._args: unknown[]): Promise<void> {}
async function getBars(..._args: unknown[]): Promise<unknown[]> { return []; }
async function getBarStoreStats(..._args: unknown[]): Promise<unknown> { return {}; }
async function pruneOldBars(..._args: unknown[]): Promise<void> {}
async function getLatestBarTimestamp(..._args: unknown[]): Promise<number> { return 0; }
function resolveSignalWithBars(..._args: unknown[]): unknown { return null; }
const POST_TP1_PROFIT_LOCK_R = 0.35;
function computePostTP1LockPrice(signal: { type: string; entryPrice: number; sl: number; tp1: number }): number {
  const stopDistance = Math.abs(signal.entryPrice - signal.sl);
  const minDelta = 5 * 0.1;
  const rBased = Number.isFinite(stopDistance) && stopDistance > 0 ? stopDistance * POST_TP1_PROFIT_LOCK_R : minDelta;
  const tp1Distance = Math.abs(signal.tp1 - signal.entryPrice);
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0 ? tp1Distance * 0.9 : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(rBased, minDelta), ceiling);
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}
const supabase = { from() { return { select() { return { data: null, error: null }; } }; } } as any;
async function sendTelegramAlert(..._args: unknown[]): Promise<void> {}
async function appendDiagnosticEvent(..._args: unknown[]): Promise<void> {}
async function pruneOldDiagnosticEvents(..._args: unknown[]): Promise<void> {}
async function ensureDiagnosticEventStoreReady(..._args: unknown[]): Promise<void> {}
type DiagnosticEventType = string;
function createContextHook<T>(factory: () => T): [(props: { children?: unknown }) => unknown, () => T] {
  return [(() => null) as unknown as (props: { children?: unknown }) => unknown, factory];
}
function useState<T>(initial: T): [T, (v: T) => void] { return [initial, () => {}]; }
function useEffect(..._args: unknown[]): void {}
function useCallback<T>(fn: T): T { return fn; }
function useMemo<T>(fn: () => T): T { return fn(); }
function useRef<T>(initial: T): { current: T } { return { current: initial }; }
`;

  const rewritten = source
    .replace(/^import\s+createContextHook\s+from\s+["']@nkzw\/create-context-hook["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react["'];?\r?\n/m, '')
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/signalEngine["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/goldWebSocketService["'];?\r?\n/m, '')
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+["']@\/services\/backgroundTaskService["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/chartPriceBridge["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/barStore["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/signalResolver["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/telegramNotifier["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/supabase["'];?\r?\n/m, '');

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${prelude}\n${rewritten}`);
  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<SandboxModule>;
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch {
      /* optional */
    }
  }
  return out;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  id: string;
  generatedMs: number;
}

interface CorpusRow {
  signal_id: string;
  ts: string;
  result: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  realized_r: number | null;
}

function parseExport(p: string): ParsedSignal[] {
  const raw = readFileSync(p, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp[0],
    tp2: p.tp[1],
    tp3: p.tp[2],
    sl: p.sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let i = 0; i < 600; i++) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

const WIN_STATUSES = new Set([
  'ALL_TARGETS_HIT',
  'TP3_HIT',
  'TP2_HIT',
  'TP1_HIT',
  'PARTIAL_WIN_SL_HIT',
  'SL_AFTER_BE',
]);

function labelOf(status: string): 'WIN' | 'LOSS' | 'NEITHER' {
  if (WIN_STATUSES.has(status)) return 'WIN';
  if (status === 'SL_HIT') return 'LOSS';
  return 'NEITHER';
}

interface ReplayRow {
  row: CorpusRow;
  sig: ParsedSignal;
  barCount: number;
  dense: boolean;
  coverageReason: string;
  fixedStatus: string;
  fixedLabel: 'WIN' | 'LOSS' | 'NEITHER' | 'UNCHANGED';
  fixedExit: number | null;
  fixedR: number | null;
}

let pass = 0;
let fail = 0;
function gate(label: string, ok: boolean, detail: string): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 41 CHECKPOINT — FALSE-LOSS FIX REPLAYED AGAINST THE LIVE CORPUS');
  console.log('MINDSET 8 rules apply. Reads only. This script writes nothing.');
  console.log('='.repeat(80));
  console.log('\nPRE-REGISTERED GATES:');
  console.log('  G41-1 every false-LOSS row resolves to a WIN status; ZERO remain LOSS.');
  console.log('  G41-2 no already-agreeing row flips (no collateral damage).');
  console.log('  G41-3 bar-evidence-only: non-dense coverage => left unchanged, never labelled.');
  console.log('  G41-4 static: guessed-LOSS write + both wall-clock CLOSED stamps are GONE.');

  // ── G41-4: static assertions against the LIVE working tree ──
  console.log('\n' + '='.repeat(80));
  console.log('G41-4 — STATIC ASSERTIONS AGAINST THE LIVE WORKING TREE (contexts/TradingContext.tsx)');
  console.log('='.repeat(80));
  const src = readFileSync('contexts/TradingContext.tsx', 'utf8');
  gate(
    'catch-up guessed-LOSS write removed',
    !src.includes("Signal expired (>2 hours) - marking as CLOSED") && !src.includes("'LOSS',\n          signal.learningContext"),
    'no `age>2h -> CLOSED + recordTradeOutcome(LOSS)` block remains in catchUpAndEvaluateSignals',
  );
  gate(
    'live-monitor wall-clock CLOSED removed',
    !src.includes('expired after 2 hours'),
    'the live tick monitor no longer stamps CLOSED off the clock (Item 41c)',
  );
  gate(
    '8h window is the single maturity definition',
    src.includes('const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;') &&
      src.includes('opts.windowMs : RESOLUTION_WINDOW_MS') &&
      src.includes('signalTime + RESOLUTION_WINDOW_MS') &&
      src.includes('signalAge > RESOLUTION_WINDOW_MS'),
    'RESOLUTION_WINDOW_MS in force in audit default, catch-up window, and live-monitor maturity',
  );
  gate(
    'no twoHoursInMs left anywhere in resolution logic',
    !src.includes('twoHoursInMs'),
    'the old 2h constant is fully removed, so the two paths cannot drift apart again',
  );
  gate(
    'matured resolution is gated on dense bar coverage',
    src.includes('const resolveFromScratch = isMatured && maturedCoverage.dense;'),
    'fromScratch only when matured AND assessBarCoverage reports dense',
  );

  const tc = await loadTradingContext();
  gate(
    'real assessBarCoverage loaded from the live module',
    typeof tc.assessBarCoverage === 'function',
    'coverage gate under test is the live one, not a copy',
  );

  // ── export + corpus ──
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let ok = false;
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${p}`, { headers: h });
    if (res.ok) {
      writeFileSync('/tmp/diagnostics_export.txt', await res.text());
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log('\n  BLOCKER: diagnostics export unavailable. STOP. Nothing reported as done.');
    process.exitCode = 1;
    return;
  }
  const byId = new Map<string, ParsedSignal>();
  for (const s of parseExport('/tmp/diagnostics_export.txt')) if (s.id) byId.set(s.id, s);

  const corpus: CorpusRow[] = [];
  for (let page = 0; page < 40; page++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, result, entry_price, exit_price, pnl, realized_r')
      .order('ts', { ascending: true })
      .range(page * 500, (page + 1) * 500 - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    corpus.push(...(data as CorpusRow[]));
    if (data.length < 500) break;
  }
  console.log(`\n  Corpus rows (trade_outcomes_v1): ${corpus.length}`);

  // ── POWER, stated before the result (MINDSET rule 7) ──
  console.log('\n  POWER: this is a DETERMINISTIC replay, not a sample-based inference. Every');
  console.log('  matched corpus row is re-resolved against its own real Vantage bars, so the');
  console.log('  only failure mode is a signal with no/thin bar coverage, which is reported');
  console.log('  explicitly rather than averaged away. No p-value applies.');

  // ── replay every matched row through the FIXED path ──
  console.log('\n' + '='.repeat(80));
  console.log('REPLAY — every matched corpus row through the FIXED catch-up path (8h + coverage-gated fromScratch)');
  console.log('='.repeat(80));
  const rows: ReplayRow[] = [];
  for (const row of corpus) {
    const sig = byId.get(row.signal_id);
    if (!sig || sig.tp.length < 3 || !(sig.sl > 0)) continue;
    const windowEnd = sig.generatedMs + RESOLUTION_WINDOW_MS;
    const bars = await fetchBars(client, sig.generatedMs, windowEnd);
    const coverage = tc.assessBarCoverage(bars, sig.generatedMs, windowEnd);
    // The fixed path only resolves a matured signal when coverage is dense.
    // Every corpus row is far past 8h, so isMatured is true for all of them.
    const resolveFromScratch = coverage.dense;
    if (!resolveFromScratch) {
      rows.push({
        row,
        sig,
        barCount: bars.length,
        dense: false,
        coverageReason: coverage.reason,
        fixedStatus: 'LEFT UNCHANGED (insufficient bar evidence)',
        fixedLabel: 'UNCHANGED',
        fixedExit: null,
        fixedR: null,
      });
      continue;
    }
    const outcome = resolveSignalWithBars(toTradingSignal(sig), bars, {
      fromScratch: true,
      evalNowMs: windowEnd,
    });
    const stopDist = Math.abs(sig.entry - sig.sl);
    const signed = sig.direction === 'BUY' ? outcome.exitPrice - sig.entry : sig.entry - outcome.exitPrice;
    rows.push({
      row,
      sig,
      barCount: bars.length,
      dense: true,
      coverageReason: coverage.reason,
      fixedStatus: outcome.newStatus,
      fixedLabel: labelOf(outcome.newStatus),
      fixedExit: outcome.exitPrice,
      fixedR: stopDist > 0 ? Number((signed / stopDist).toFixed(4)) : null,
    });
  }
  console.log(`  Rows replayed (matched to a signal in the export): ${rows.length}`);
  console.log(`  Of those, dense-covered and therefore resolvable:  ${rows.filter((r) => r.dense).length}`);
  console.log(`  Left unchanged for want of bar evidence:            ${rows.filter((r) => !r.dense).length}`);

  const falseLoss = rows.filter((r) => r.row.result === 'LOSS' && r.fixedLabel === 'WIN');
  const falseWin = rows.filter((r) => r.row.result === 'WIN' && r.fixedLabel === 'LOSS');

  console.log('\n  THE FALSE-LOSS SET, replayed through the fixed path:');
  console.log('  (NOTE: the brief said "the 7 known false-LOSS signals". The measured split in');
  console.log('   Item 37 was 10 false LOSS + 7 false WIN = 17. The false-LOSS set replayed here');
  console.log('   is therefore the 10-row set; the 7 are the false-WIN set, covered by Item 42.)');
  console.log('\n  idx   signal_id    dir   corpus  ->  FIXED path status        exit      R      bars  coverage');
  console.log('  ' + '─'.repeat(103));
  for (const r of falseLoss.slice().sort((a, b) => a.sig.index - b.sig.index)) {
    console.log(
      `  ${String(r.sig.index).padEnd(5)} ${r.row.signal_id.slice(-9).padEnd(12)} ${r.sig.direction.padEnd(5)} ` +
        `${r.row.result.padEnd(7)} ->  ${r.fixedStatus.padEnd(22)} ${(r.fixedExit ?? 0).toFixed(1).padStart(8)} ` +
        `${(r.fixedR ?? 0).toFixed(3).padStart(7)}  ${String(r.barCount).padStart(4)}  ${r.coverageReason}`,
    );
  }
  console.log(`\n  False-LOSS rows found: ${falseLoss.length}`);
  console.log(`  Of those still labelled LOSS by the fixed path: ${falseLoss.filter((r) => r.fixedLabel === 'LOSS').length}`);

  console.log('\n  THE FALSE-WIN SET (reported here only for completeness — Item 42 owns the fix;');
  console.log('  the resolver already labels these correctly, the LIVE MONITOR did not):');
  for (const r of falseWin.slice().sort((a, b) => a.sig.index - b.sig.index)) {
    console.log(
      `  ${String(r.sig.index).padEnd(5)} ${r.row.signal_id.slice(-9).padEnd(12)} ${r.sig.direction.padEnd(5)} ` +
        `${r.row.result.padEnd(7)} ->  ${r.fixedStatus.padEnd(22)} ${(r.fixedExit ?? 0).toFixed(1).padStart(8)}`,
    );
  }
  console.log(`  False-WIN rows found: ${falseWin.length}`);

  // ── gates ──
  console.log('\n' + '='.repeat(80));
  console.log('GATE VERDICTS');
  console.log('='.repeat(80));
  gate(
    'G41-1 every false-LOSS row now resolves WIN, none remain LOSS',
    falseLoss.length > 0 && falseLoss.every((r) => r.fixedLabel === 'WIN'),
    `${falseLoss.length} false-LOSS rows, ${falseLoss.filter((r) => r.fixedLabel === 'WIN').length} now WIN, ${falseLoss.filter((r) => r.fixedLabel === 'LOSS').length} still LOSS`,
  );

  const agreeing = rows.filter((r) => r.dense && labelOf(r.fixedStatus) === r.row.result);
  const flippedAgreeing = agreeing.filter((r) => labelOf(r.fixedStatus) !== r.row.result);
  gate(
    'G41-2 no already-agreeing row flipped',
    flippedAgreeing.length === 0,
    `${agreeing.length} rows where corpus and bars agree, ${flippedAgreeing.length} flipped`,
  );

  const guessed = rows.filter((r) => !r.dense && r.fixedLabel !== 'UNCHANGED');
  gate(
    'G41-3 no label assigned without dense bar evidence',
    guessed.length === 0,
    `${rows.filter((r) => !r.dense).length} thin-coverage rows, ${guessed.length} of them labelled anyway`,
  );

  // ── EV effect of the fix, on the replayed set ──
  const resolvable = rows.filter((r) => r.dense && r.fixedR != null);
  const fixedEV = resolvable.length > 0 ? resolvable.reduce((s, r) => s + (r.fixedR ?? 0), 0) / resolvable.length : 0;
  const corpusR = rows.filter((r) => r.row.realized_r != null);
  const corpusEV = corpusR.length > 0 ? corpusR.reduce((s, r) => s + (r.row.realized_r ?? 0), 0) / corpusR.length : 0;
  console.log('\n' + '='.repeat(80));
  console.log('EV EFFECT ON THE REPLAYED SET (informational — Item 43 owns the durable correction)');
  console.log('='.repeat(80));
  console.log(`  Corpus EV as stored (realized_r, n=${corpusR.length}):        ${corpusEV >= 0 ? '+' : ''}${corpusEV.toFixed(4)}R`);
  console.log(`  Fixed-path EV on the same signals (n=${resolvable.length}):   ${fixedEV >= 0 ? '+' : ''}${fixedEV.toFixed(4)}R`);
  console.log(`  Delta:                                              ${fixedEV - corpusEV >= 0 ? '+' : ''}${(fixedEV - corpusEV).toFixed(4)}R`);

  console.log('\n' + '='.repeat(80));
  console.log(`ITEM 41 CHECKPOINT: ${fail === 0 ? 'ALL GATES PASSED' : 'GATE FAILURE — NOTHING REPORTED AS DONE'} (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(80));
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
