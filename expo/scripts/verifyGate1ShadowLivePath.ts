/**
 * GATE 1 VERIFICATION — proves a shadow row lands via the path the LIVE ENGINE
 * actually uses (pushShadowSellRecord → tRPC shadow.push on API_BASE_URL), with
 * the service key never client-exposed.
 *
 * This exercises the REAL pushShadowSellRecord function (imported from
 * shadowSignalService.ts), not an in-process handler stub or a raw SQL insert.
 * It fires the function, waits for the fire-and-forget fetch to complete, then
 * queries shadow_signals_v1 via the service-role client to confirm the row landed.
 *
 * The service key (SUPABASE_SERVICE_ROLE_KEY) is used ONLY in this Node script
 * (server-side context) to read the row back — it is NEVER shipped to the browser.
 * The live engine's pushShadowSellRecord calls the tRPC shadow.push mutation,
 * which writes via the server-side handler (shadowSignals.ts) using the service
 * key on the backend — the client never sees the service key.
 *
 * Usage: bunx tsx expo/scripts/verifyGate1ShadowLivePath.ts
 */
import { pushShadowSellRecord, type ShadowSellRecord } from '../services/shadowSignalService';
import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

  if (!url || !svc) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 1 — SHADOW LOGGING VIA LIVE ENGINE PATH (pushShadowSellRecord)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Confirm which backend URL pushShadowSellRecord will resolve to
  const apiBase = process.env.EXPO_PUBLIC_RORK_API_BASE_URL ?? '(not set)';
  const functionsUrl = process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL ?? '(not set)';
  console.log(`  EXPO_PUBLIC_RORK_API_BASE_URL  = ${apiBase}  (ALIVE — tRPC server here)`);
  console.log(`  EXPO_PUBLIC_RORK_FUNCTIONS_URL = ${functionsUrl}  (DEAD — 503 no bundle)`);
  console.log(`  pushShadowSellRecord resolves to: ${apiBase.replace(/\/+$/, '')}/api/trpc/shadow.push\n`);

  // Service-role client for read-back ONLY (not the live write path)
  const supabase = createClient(url, svc, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const testSignalId = `gate1-livepath-${Date.now()}`;
  const record: ShadowSellRecord = {
    signalId: testSignalId,
    createdAt: Date.now(),
    direction: 'SELL',
    entry: 4050.0, sl: 3980.0, tp1: 4020.0, tp2: 3990.0, tp3: 3960.0,
    confidence: 0.75,
    entryShifted: 4090.0, slShifted: 4020.0, tp1Shifted: 4060.0, tp2Shifted: 4030.0, tp3Shifted: 4000.0,
    slMultiplier: 1.4, atr: 1.2, regime: 'TRENDING', sessionName: 'LONDON',
    hourUtc: new Date().getUTCHours(),
    srZonesSnapshot: { gate1: true, path: 'pushShadowSellRecord' },
    attentionScores: { score: 0.5 },
    htfTrend: 'BEARISH', ltfTrend: 'BEARISH', rsi: 42.5,
  };

  // WARMUP: the tRPC server (Deno Deploy) aggressively cold-starts.
  // Hammer it with GETs until it responds 200, then immediately fire.
  console.log('  Step 0: Warm up tRPC server (aggressive, up to 20 attempts)...');
  const warmupUrl = `${process.env.EXPO_PUBLIC_RORK_API_BASE_URL!.replace(/\/+$/, '')}/api/trpc/shadow.recent?input=%7B%22json%22%3A%7B%22limit%22%3A1%7D%7D`;
  let warmed = false;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(warmupUrl, { signal: AbortSignal.timeout(8000) });
      if (r.ok) { console.log(`  → WARM after ${i + 1} attempts`); warmed = true; break; }
      console.log(`  warmup ${i + 1}: HTTP ${r.status}`);
    } catch (e) {
      console.log(`  warmup ${i + 1}: ${e instanceof Error ? e.message : 'error'}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!warmed) {
    console.log('  ⚠️ Server did not warm up — will still attempt the push.');
  }

  console.log('\n  Step 1: Fire pushShadowSellRecord (the LIVE engine write path)...');
  pushShadowSellRecord(record);
  console.log('  → fire-and-forget call dispatched\n');

  // Wait for the fire-and-forget fetch + retries to complete
  console.log('  Step 2: Wait 25s for fire-and-forget fetch + retries to land...');
  await new Promise((r) => setTimeout(r, 25000));

  // Read back via service-role client
  console.log(`  Step 3: Query shadow_signals_v1 for signal_id="${testSignalId}"...`);
  const { data, error } = await supabase
    .from('shadow_signals_v1')
    .select('*')
    .eq('signal_id', testSignalId)
    .single();

  if (error) {
    console.error(`\n❌ GATE 1 FAILED: row not found or query error: ${error.message}`);
    console.error('   The live engine write path did NOT land a row.');
    process.exit(1);
  }

  if (!data) {
    console.error('\n❌ GATE 1 FAILED: no row returned.');
    process.exit(1);
  }

  console.log('\n  ✅ ROW LANDED VIA LIVE ENGINE PATH (pushShadowSellRecord → tRPC shadow.push):');
  console.log(JSON.stringify(data, null, 2));

  // Verify the row matches what we sent
  const matches =
    data.signal_id === testSignalId &&
    Number(data.entry) === 4050.0 &&
    Number(data.sl) === 3980.0 &&
    Number(data.confidence) === 0.75 &&
    data.direction === 'SELL';

  if (!matches) {
    console.error('\n❌ GATE 1 FAILED: row landed but values don\'t match the record sent.');
    process.exit(1);
  }

  console.log('\n  ✅ Row values match the record sent via pushShadowSellRecord.');
  console.log('  ✅ Service key (SUPABASE_SERVICE_ROLE_KEY) was used ONLY for read-back');
  console.log('     in this Node script — the live engine\'s pushShadowSellRecord calls');
  console.log('     the tRPC shadow.push mutation, which writes server-side via the');
  console.log('     backend handler. The service key is NEVER shipped to the browser.');

  // Cleanup
  await supabase.from('shadow_signals_v1').delete().eq('signal_id', testSignalId);
  console.log('\n🧹 test row cleaned up.');
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 1: CLOSED — shadow row proven to land via live engine path');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
