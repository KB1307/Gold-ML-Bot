/**
 * GATE 1 VERIFICATION (Design B) — proves a shadow row lands via the path the
 * LIVE ENGINE actually uses: pushShadowSellRecord → anon Supabase client →
 * direct INSERT to shadow_signals_v1 (RLS INSERT policy).
 *
 * This exercises the REAL pushShadowSellRecord function (imported from
 * shadowSignalService.ts), not a hand-written service-role insert or an
 * in-process handler stub. It fires the function, waits for the
 * fire-and-forget insert to complete, then queries shadow_signals_v1 via
 * the service-role client (read-back only) to confirm the row landed.
 *
 * The service key (SUPABASE_SERVICE_ROLE_KEY) is used ONLY in this Node
 * script for read-back — it is NEVER used by the live engine path. The live
 * engine writes via the anon key, which is public by design.
 *
 * Usage: bunx tsx expo/scripts/verifyGate1ShadowLivePath.ts
 */
import { pushShadowSellRecord, type ShadowSellRecord } from '../services/shadowSignalService';
import { createClient } from '@supabase/supabase-js';

async function main(): Promise<void> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

  if (!url || !anonKey || !svc) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 1 — SHADOW LOGGING VIA LIVE ENGINE PATH (Design B)');
  console.log('  pushShadowSellRecord → anon Supabase client → direct INSERT');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log(`  Supabase URL:  ${url}`);
  console.log(`  Anon key:      ${anonKey.slice(0, 12)}...${anonKey.slice(-4)} (public, in client bundle)`);
  console.log(`  Service key:   ${svc.slice(0, 12)}...${svc.slice(-4)} (read-back ONLY, never in client)\n`);

  // Service-role client for read-back ONLY (not the live write path)
  const supabase = createClient(url, svc, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const testSignalId = `gate1-designB-${Date.now()}`;
  const record: ShadowSellRecord = {
    signalId: testSignalId,
    createdAt: Date.now(),
    direction: 'SELL',
    entry: 4050.0, sl: 3980.0, tp1: 4020.0, tp2: 3990.0, tp3: 3960.0,
    confidence: 0.75,
    entryShifted: 4090.0, slShifted: 4020.0, tp1Shifted: 4060.0, tp2Shifted: 4030.0, tp3Shifted: 4000.0,
    slMultiplier: 1.4, atr: 1.2, regime: 'TRENDING', sessionName: 'LONDON',
    hourUtc: new Date().getUTCHours(),
    srZonesSnapshot: { gate1: true, path: 'pushShadowSellRecord-designB' },
    attentionScores: { score: 0.5 },
    htfTrend: 'BEARISH', ltfTrend: 'BEARISH', rsi: 42.5,
  };

  console.log('  Step 1: Fire pushShadowSellRecord (the LIVE engine write path)...');
  console.log(`  → signal_id: ${testSignalId}`);
  pushShadowSellRecord(record);
  console.log('  → fire-and-forget call dispatched\n');

  // Wait for the fire-and-forget insert to complete
  console.log('  Step 2: Wait 5s for fire-and-forget insert to land...');
  await new Promise((r) => setTimeout(r, 5000));

  // Read back via service-role client
  console.log(`  Step 3: Query shadow_signals_v1 for signal_id="${testSignalId}"...`);
  const { data, error } = await supabase
    .from('shadow_signals_v1')
    .select('*')
    .eq('signal_id', testSignalId)
    .single();

  if (error) {
    console.error(`\n  ❌ GATE 1 FAILED: row not found or query error: ${error.message}`);
    console.error('     The live engine write path did NOT land a row.');
    process.exit(1);
  }

  if (!data) {
    console.error('\n  ❌ GATE 1 FAILED: no row returned.');
    process.exit(1);
  }

  console.log('\n  ✅ ROW LANDED VIA LIVE ENGINE PATH (pushShadowSellRecord → anon Supabase INSERT):');
  console.log(JSON.stringify(data, null, 2));

  // Verify the row matches what we sent
  const matches =
    data.signal_id === testSignalId &&
    Number(data.entry) === 4050.0 &&
    Number(data.sl) === 3980.0 &&
    Number(data.confidence) === 0.75 &&
    data.direction === 'SELL';

  if (!matches) {
    console.error('\n  ❌ GATE 1 FAILED: row landed but values don\'t match the record sent.');
    process.exit(1);
  }

  console.log('\n  ✅ Row values match the record sent via pushShadowSellRecord.');
  console.log('  ✅ The live engine path uses the ANON key (public, RLS-permitted INSERT).');
  console.log('  ✅ The service key was used ONLY for read-back in this script — never');
  console.log('     in the live engine path, never shipped to the browser.');

  // Cleanup
  await supabase.from('shadow_signals_v1').delete().eq('signal_id', testSignalId);
  console.log('\n  🧹 test row cleaned up.');
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 1: CLOSED — shadow row proven to land via live engine path');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
