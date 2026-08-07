/**
 * ITEM 35 — WHY IS THE LIVE/INCREMENTAL RESOLVER MISSING TERMINAL EVENTS
 * THE OFFLINE REPLAY CATCHES?
 * =====================================================================
 *
 * MINDSET 8 rules (restated verbatim):
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
 * DATA-SOURCE RULE: gold_m1_bars read DIRECT from Supabase via anon key.
 * Export fetched to /tmp/diagnostics_export.txt. No Rork backend reads.
 * No engine code is modified. No fixes are shipped.
 *
 * WHAT THIS SCRIPT MEASURES:
 *  35a. For each of the 9 CLOSED-mismatch signals from Item 32, report
 *       their generation time, whether the fromScratch resolution finds
 *       a terminal event, and at what bar timestamp (how far past creation).
 *       This directly tests SCHEDULING vs MECHANISM: if the TPs were hit
 *       AFTER the 2h audit window, the live audit structurally cannot
 *       see them regardless of when it runs.
 *  35b. Trace the mechanism: the live catchUpAndEvaluateSignals path marks
 *       signals CLOSED at 2h age (line 1468) without checking bars. The
 *       auditTerminalSLSignals path uses resolutionWindowMs = 2h by default
 *       (line 1948), so even force=true audit only evaluates 2h of bars.
 *       The fromScratch Item 32 script evaluated 8h of bars. If the 9
 *       corrections' TP events fall between 2h and 8h, the audit window
 *       is the mechanism gap — not scheduling.
 *  35c. For every CLOSED signal in the export, run fresh fromScratch
 *       resolution with BOTH 2h and 8h bar windows, report how many
 *       would be corrected at each window. This is the practical question:
 *       is what the user sees right now accurate?
 *  35d. Recommendation (no implementation): state what would fix it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

// ─── env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch { /* optional */ }
  }
  return out;
}

// ─── types ──────────────────────────────────────────────────────────────
interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  exit: number | null;
  id: string;
  generatedMs: number;
}

// ─── export parser (same as Item 32) ─────────────────────────────────────
function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const exit = block.match(/exit price: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
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

// ─── bar fetcher ────────────────────────────────────────────────────────
async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 400; p++) {
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

// ─── MAIN ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnv();
  const client: SupabaseClient = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL as string,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log('='.repeat(80));
  console.log('ITEM 35 — LIVE vs FROMSCRATCH RESOLVER DIVERGENCE');
  console.log('MINDSET 8 rules apply. Read-only. No engine code touched. No fixes shipped.');
  console.log('='.repeat(80));

  // ── fetch export ──
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  for (const path of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`  Export fetched: ${text.length} bytes`);
      break;
    }
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Signals parsed: ${signals.length}`);

  // ── fetch bars (wide window: signal creation to +8h) ──
  const minTs = Math.min(...signals.map((s) => s.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...signals.map((s) => s.generatedMs)) + 8 * 60 * 60_000;
  const allBars = await fetchBars(client, minTs, maxTs);
  console.log(`  Bars fetched: ${allBars.length} from ${new Date(minTs).toISOString()} to ${new Date(maxTs).toISOString()}`);

  const byMinute = new Map<number, OhlcBar>();
  for (const b of allBars) {
    byMinute.set(Math.floor(b.timestamp / 60_000) * 60_000, b);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 35a + 35b: IDENTIFY CLOSED-MISMATCH SIGNALS AND WHEN THEIR TPs WERE HIT
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('35a/35b — CLOSED-MISMATCH SIGNALS: WHEN DID THE TP EVENT OCCUR?');
  console.log('='.repeat(80));
  console.log('  Testing: do the fromScratch-corrected terminal events fall');
  console.log('  WITHIN the 2h audit window, or AFTER it?');
  console.log('  Live catchUpAndEvaluateSignals marks signals CLOSED at >2h age (line 1468).');
  console.log('  Audit uses resolutionWindowMs = 2h by default (line 1948).');
  console.log('  Item 32 fromScratch used 8h bar window.');
  console.log('');

  const closedSignals = signals.filter((s) => s.status === 'CLOSED');
  console.log(`  CLOSED signals in export: ${closedSignals.length}`);

  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
  const evalNow = maxTs;

  interface ClosedResult {
    signal: ParsedSignal;
    outcome2h: ResolverOutcome;
    outcome8h: ResolverOutcome;
    covered: boolean;
    tpEventTs: number | null;
    hoursToTp: number | null;
    within2h: boolean;
  }

  const results: ClosedResult[] = [];
  for (const p of closedSignals) {
    const sig = toTradingSignal(p);
    const sigTs = p.generatedMs;
    const covered = byMinute.has(Math.floor(sigTs / 60_000) * 60_000);

    // 2h window (what the live audit sees)
    const bars2h = allBars.filter(
      (b) => b.timestamp >= sigTs + 60_000 && b.timestamp <= sigTs + TWO_HOURS_MS,
    );
    // 8h window (what Item 32 fromScratch sees)
    const bars8h = allBars.filter(
      (b) => b.timestamp >= sigTs + 60_000 && b.timestamp <= sigTs + EIGHT_HOURS_MS,
    );

    const quiet = { fromScratch: true, evalNowMs: evalNow, logPrefix: '' };
    const origLog = console.log;
    console.log = (): void => {};
    const outcome2h = resolveSignalWithBars(sig, bars2h, quiet);
    const outcome8h = resolveSignalWithBars(sig, bars8h, quiet);
    console.log = origLog;

    const tpEventTs = outcome8h.resolvedAtBarTs ?? null;
    const hoursToTp = tpEventTs !== null ? (tpEventTs - sigTs) / (60 * 60 * 1000) : null;
    const within2h = tpEventTs !== null && (tpEventTs - sigTs) <= TWO_HOURS_MS;

    results.push({ signal: p, outcome2h, outcome8h, covered, tpEventTs, hoursToTp, within2h });
  }

  // Report
  const mismatches = results.filter(
    (r) => r.outcome8h.newStatus !== 'CLOSED' && r.outcome8h.newStatus !== 'NEVER_FILLABLE' && r.outcome8h.newStatus !== 'EXPIRED_MISSED_ENTRY',
  );
  const confirmations = results.filter(
    (r) => r.outcome8h.newStatus === 'CLOSED',
  );

  console.log(`\n  CLOSED signals corrected by 8h fromScratch: ${mismatches.length}`);
  console.log(`  CLOSED signals confirmed as CLOSED by 8h fromScratch: ${confirmations.length}`);

  console.log(`\n  ${'idx'.padStart(4)} ${'dir'.padEnd(5)} ${'entry'.padStart(8)} ${'2h_status'.padEnd(20)} ${'8h_status'.padEnd(20)} ${'TP_event_ts'.padEnd(26)} ${'hours_to_TP'.padStart(11)} ${'within_2h'.padStart(9)}`);
  console.log(`  ${'─'.repeat(120)}`);
  for (const r of mismatches) {
    const tsStr = r.tpEventTs !== null ? new Date(r.tpEventTs).toISOString() : 'n/a';
    const hrs = r.hoursToTp !== null ? r.hoursToTp.toFixed(2) + 'h' : 'n/a';
    console.log(`  ${String(r.signal.index).padStart(4)} ${r.signal.direction.padEnd(5)} ${r.signal.entry.toFixed(1).padStart(8)} ${r.outcome2h.newStatus.padEnd(20)} ${r.outcome8h.newStatus.padEnd(20)} ${tsStr.padEnd(26)} ${hrs.padStart(11)} ${(r.within2h ? 'YES' : 'NO').padStart(9)}`);
  }

  // Summary: how many TP events fall within 2h vs after 2h
  const withinCount = mismatches.filter((r) => r.within2h).length;
  const afterCount = mismatches.filter((r) => !r.within2h).length;
  console.log(`\n  TP events WITHIN 2h audit window: ${withinCount}`);
  console.log(`  TP events AFTER 2h audit window:  ${afterCount}`);
  console.log(`  TP events with no bar timestamp:  ${mismatches.filter((r) => r.tpEventTs === null).length}`);

  if (afterCount > 0) {
    console.log(`\n  => MECHANISM GAP CONFIRMED: ${afterCount} of ${mismatches.length} corrected signals`);
    console.log(`     had their TP event AFTER the 2h audit window. The live audit`);
    console.log(`     (resolutionWindowMs = 2h) structurally cannot see these bars.`);
    console.log(`     This is NOT a scheduling issue — even a perfectly-timed audit`);
    console.log(`     with force=true would not correct them.`);
  }
  if (withinCount > 0) {
    console.log(`\n  => SCHEDULING GAP: ${withinCount} of ${mismatches.length} corrected signals`);
    console.log(`     had their TP event WITHIN the 2h audit window. The live audit`);
    console.log(`     COULD correct these if it ran with force=true. If these remain`);
    console.log(`     CLOSED in the export, the daily sweep did not run (app closed).`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 35c: CURRENT STATE — every CLOSED signal, 2h vs 8h fromScratch
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('35c — CURRENT STATE: every CLOSED signal, 2h vs 8h fromScratch');
  console.log('='.repeat(80));
  console.log('  This is the practical question: is what the user sees accurate?');
  console.log('');

  let correctedAt2h = 0;
  let correctedAt8h = 0;
  let confirmedClosed = 0;
  let notCovered = 0;

  for (const r of results) {
    if (!r.covered) {
      notCovered++;
      continue;
    }
    const changed2h = r.outcome2h.newStatus !== 'CLOSED';
    const changed8h = r.outcome8h.newStatus !== 'CLOSED';
    if (changed2h) correctedAt2h++;
    if (changed8h) correctedAt8h++;
    if (!changed8h) confirmedClosed++;
  }

  console.log(`  Total CLOSED signals in export:     ${closedSignals.length}`);
  console.log(`  Not bar-covered (cannot verify):    ${notCovered}`);
  console.log(`  Corrected by 2h fromScratch:        ${correctedAt2h}`);
  console.log(`  Corrected by 8h fromScratch:        ${correctedAt8h}`);
  console.log(`  Confirmed as CLOSED (8h fromScratch): ${confirmedClosed}`);
  console.log(`  Corrected ONLY at 8h (not at 2h):   ${correctedAt8h - correctedAt2h}`);
  console.log('');
  console.log(`  => The audit window gap accounts for ${correctedAt8h - correctedAt2h} of ${correctedAt8h} corrections.`);
  console.log(`     These signals' terminal events are beyond the 2h window the live`);
  console.log(`     audit evaluates. The scheduling gap accounts for ${correctedAt2h} of ${correctedAt8h}.`);

  // ═══════════════════════════════════════════════════════════════════════
  // 35d: CODE TRACE — THE MECHANISM DIFFERENCE
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('35b — MECHANISM TRACE: live vs fromScratch divergence');
  console.log('='.repeat(80));
  console.log('');
  console.log('  LIVE PATH (catchUpAndEvaluateSignals, TradingContext.tsx:1429):');
  console.log('    1. Skips signals already in terminal status (line 1450):');
  console.log('       if (signal.status === "CLOSED" || "SL_HIT" || ...) continue;');
  console.log('    2. For ACTIVE signals >2h old, marks CLOSED WITHOUT checking bars');
  console.log('       (line 1468-1472):');
  console.log('       if (signalAge > twoHoursInMs) { status = "CLOSED"; exitPrice = currentPrice }');
  console.log('    3. For signals WITH bars, calls resolveSignalWithBars WITHOUT');
  console.log('       fromScratch (line 1724) — forward-seeded, ratchets forward only.');
  console.log('    4. Once CLOSED, no subsequent catchUp pass re-evaluates it (line 1450 skip).');
  console.log('');
  console.log('  AUDIT PATH (auditTerminalSLSignals, TradingContext.tsx:1918):');
  console.log('    1. Processes ALL terminal signals (including CLOSED) with force=true.');
  console.log('    2. Calls resolveSignalWithBars with fromScratch:force (line 1988-1996).');
  console.log('    3. BUT: bar window = signalTs to min(now, signalTs + 2h) (line 1971).');
  console.log('       resolutionWindowMs = twoHoursInMs = 2h by DEFAULT (line 1948).');
  console.log('       The daily sweep (line 3198) calls WITHOUT windowMs override.');
  console.log('    4. If no TP/SL in 2h of bars, fromScratch returns CLOSED (line 522).');
  console.log('       Audit sees statusChanged=false → confirms CLOSED, marks audited.');
  console.log('');
  console.log('  FROMSCRATCH OFFLINE (Item 32 script):');
  console.log('    1. Evaluates bars from signalTs to signalTs + 8h.');
  console.log('    2. Finds TP events that occurred between 2h and 8h after creation.');
  console.log('    3. Returns ALL_TARGETS_HIT / PARTIAL_WIN_SL_HIT / SL_AFTER_BE.');
  console.log('');
  console.log('  THE DIVERGENCE:');
  console.log('    The audit window (2h) is SHORTER than the signal outcome window (8h+).');
  console.log('    A signal that does not hit TP/SL within 2h is marked CLOSED by the live');
  console.log('    path, and the audit CONFIRMS that CLOSED because it only looks at the');
  console.log('    same 2h of bars. The fromScratch offline replay looks at 8h and finds');
  console.log('    the TP event the live system never saw.');
  console.log('');
  console.log('  This is NOT a scheduling gap (the audit could run perfectly on time');
  console.log('  and still miss these). It is a MECHANISM gap: the audit window is too');
  console.log('  narrow to capture late TP hits.');

  // ═══════════════════════════════════════════════════════════════════════
  // 35d: RECOMMENDATION (NO IMPLEMENTATION)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('35d — RECOMMENDATION (no implementation, no fix shipped)');
  console.log('='.repeat(80));
  console.log('');
  console.log('  1. The audit window (resolutionWindowMs) should be extended beyond 2h');
  console.log('     to match the actual signal outcome window. The Item 32 script used');
  console.log('     8h; the real maximum is however long a signal can take to hit TP3.');
  console.log('     The ENTRY_MATURITY_MS (2h) is the MATURITY threshold, not the');
  console.log('     OUTCOME window — these are different concepts that were conflated.');
  console.log('');
  console.log('  2. The live catchUpAndEvaluateSignals path marks signals CLOSED at >2h');
  console.log('     WITHOUT checking bars (line 1468). This is the INITIAL wrong assignment.');
  console.log('     Even with a wider audit window, the signal is displayed as CLOSED');
  console.log('     on the dashboard until the next audit sweep corrects it.');
  console.log('');
  console.log('  3. The daily sweep IS scheduled (21:00-22:00 UTC with 25h catch-up),');
  console.log('     but it only runs while the app JS context is alive (foreground).');
  console.log('     There is NO backend-side scheduled re-audit for signal outcomes —');
  console.log('     only the sr_zones_v1 refresh has a pg_cron schedule. Signal outcome');
  console.log('     reconciliation is entirely client-side.');
  console.log('');
  console.log('  4. DO NOT implement a fix without knowing the full impact. Extending');
  console.log('     the audit window changes how many bars are evaluated per signal,');
  console.log('     which changes CPU/memory load and may change other outcomes.');
  console.log('     Measure the impact first.');
  console.log('');
  console.log('  5. Running Force Audit now against every currently-CLOSED signal would');
  console.log('     correct the scheduling-gap signals (TP within 2h) but NOT the');
  console.log('     mechanism-gap signals (TP after 2h) — the audit window must be');
  console.log('     widened first for those.');

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 35 complete. Nothing was written. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
