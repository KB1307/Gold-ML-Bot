/**
 * Generates a REAL diagnostics export SECTION 6 — exactly as the app renders it.
 * Fetches the shadow summary via the SAME path the app uses (backend tRPC
 * shadow.summary route), and calls the REAL buildDiagnosticsExportText with
 * the REAL in-memory counter values. Also fetches the summary directly from
 * Supabase to show what data exists (supplementary, clearly labeled).
 *
 * Usage: bunx tsx scripts/verifyRealExport.ts
 */
import { createClient } from '@supabase/supabase-js';
import { buildDiagnosticsExportText } from '../services/diagnosticsExport';
import { getShadowWriteFailures, getShadowWriteSuccesses, pushShadowSellRecord } from '../services/shadowSignalService';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

const anonClient = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
const svcClient = createClient(URL, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

// Determine the API origin the same way the app does
function getApiOrigin(): string {
  const base = process.env.EXPO_PUBLIC_RORK_API_BASE_URL;
  const funcs = process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  const origin = base || funcs || '';
  return origin.replace(/\/$/, '');
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  REAL DIAGNOSTICS EXPORT — SECTION 6 AS IT ACTUALLY RENDERS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: Trigger a real successful shadow write (to populate counters) ──
  console.log('── Step 1: Trigger a real successful shadow write via pushShadowSellRecord ──');
  const testRecord = {
    signalId: `export-test-${Date.now()}`,
    createdAt: Date.now(),
    direction: 'SELL' as const,
    entry: 4050.0, sl: 3980.0, tp1: 4020.0, tp2: 3990.0, tp3: 3960.0,
    confidence: 0.75,
    entryShifted: 4090.0, slShifted: 4020.0, tp1Shifted: 4060.0, tp2Shifted: 4030.0, tp3Shifted: 4000.0,
    slMultiplier: 1.4, atr: 1.2, regime: 'TRENDING', sessionName: 'LONDON', hourUtc: new Date().getUTCHours(),
    srZonesSnapshot: { test: true }, attentionScores: { score: 0.5 },
    htfTrend: 'BEARISH', ltfTrend: 'BEARISH', rsi: 42.5,
  };
  pushShadowSellRecord(testRecord);
  // Wait for the fire-and-forget insert to complete
  await new Promise(r => setTimeout(r, 3000));
  console.log(`  Counters after successful write: successes=${getShadowWriteSuccesses()}, failures=${getShadowWriteFailures()}`);

  // Verify the row landed
  const { data: landed } = await svcClient.from('shadow_signals_v1').select('id, signal_id').eq('signal_id', testRecord.signalId).single();
  console.log(`  Row landed in DB: ${landed ? `YES (id=${landed.id})` : 'NO'}`);
  console.log('');

  // ── Step 2: Fetch shadow summary via the SAME path the app uses (backend tRPC) ──
  console.log('── Step 2: Fetch shadow summary via backend tRPC shadow.summary (app path) ──');
  const apiOrigin = getApiOrigin();
  console.log(`  API origin: ${apiOrigin}`);
  const summaryUrl = `${apiOrigin}/api/trpc/shadow.summary?input=${encodeURIComponent(JSON.stringify({ json: { days: 30 } }))}`;
  console.log(`  Fetching: ${summaryUrl}`);
  let shadowSellSummary: unknown = null;
  try {
    const resp = await fetch(summaryUrl);
    console.log(`  Response status: ${resp.status} ${resp.statusText}`);
    if (resp.ok) {
      const d = await resp.json();
      shadowSellSummary = d?.result?.data?.json ?? null;
    } else {
      const text = await resp.text().catch(() => '');
      console.log(`  Response body: ${text.slice(0, 300)}`);
    }
  } catch (e) {
    console.log(`  Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log(`  → shadowSellSummary = ${JSON.stringify(shadowSellSummary)}`);
  console.log('');

  // ── Step 3: ALSO fetch summary directly from Supabase (supplementary) ──
  console.log('── Step 3: Fetch shadow summary DIRECTLY from Supabase (supplementary) ──');
  const { data: recentRows, error: recentErr } = await anonClient
    .from('shadow_signals_v1')
    .select('signal_id, created_at, direction, session_name, entry, sl, tp1, confidence, atr, htf_trend')
    .order('created_at', { ascending: false })
    .limit(10);
  if (recentErr) {
    console.log(`  Direct query failed: ${recentErr.message}`);
  } else {
    console.log(`  Direct query returned ${recentRows?.length ?? 0} rows:`);
    for (const r of recentRows ?? []) {
      console.log(`    ${r.signal_id} | ${r.created_at} | ${r.direction} | ${r.session_name} | entry=${r.entry} | conf=${r.confidence}`);
    }
  }
  console.log('');

  // ── Step 4: Build the REAL export and extract SECTION 6 ──
  console.log('── Step 4: Build REAL diagnostics export via buildDiagnosticsExportText ──');
  const counters = {
    shadowWriteFailures: getShadowWriteFailures(),
    shadowWriteSuccesses: getShadowWriteSuccesses(),
  };
  console.log(`  Counters passed to export: failures=${counters.shadowWriteFailures}, successes=${counters.shadowWriteSuccesses}`);
  console.log(`  shadowSellSummary passed: ${shadowSellSummary ? 'non-null' : 'null'}`);

  // Build with minimal stub inputs for the other sections (we only care about SECTION 6)
  const fullExport = buildDiagnosticsExportText({
    signalHistory: [],
    modelWeights: null,
    modelHealth: {
      modelHealthScore: 0, featureCorrelationStatus: 'N/A', confidenceDegradation: 0,
      conceptDriftScore: 0, driftAlertLevel: 'none', daysSinceRetrain: 0,
      retrainingRecommended: false, retrainScheduled: false, featureImportanceDrift: [],
    },
    performanceMetrics: {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
      sharpeRatio: 0, expectancy: 0, averageWin: 0, averageLoss: 0, totalProfit: 0,
      totalLoss: 0, maxDrawdown: 0, currentDrawdown: 0,
    },
    diagnosticEvents: [],
    shadowSellSummary: shadowSellSummary as never,
    shadowWriteFailures: counters.shadowWriteFailures,
    shadowWriteSuccesses: counters.shadowWriteSuccesses,
  });

  // Extract SECTION 6 from the full export
  const section6Start = fullExport.indexOf('SECTION 6');
  const section6End = fullExport.indexOf('======', section6Start + 10);
  const section6Text = fullExport.substring(
    fullExport.lastIndexOf('------', section6Start),
    section6End > 0 ? section6End : fullExport.length,
  ).trim();

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  REAL SECTION 6 OUTPUT (as it actually renders):');
  console.log('═══════════════════════════════════════════════════════════════════\n');
  console.log(section6Text);
  console.log('\n═══════════════════════════════════════════════════════════════════');

  // Cleanup the test row
  await svcClient.from('shadow_signals_v1').delete().eq('signal_id', testRecord.signalId);
  console.log('\n(Cleanup: test row deleted.)');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
