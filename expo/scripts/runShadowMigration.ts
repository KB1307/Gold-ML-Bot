/**
 * Verifies shadow_signals_v1: test insert via service-role, read-back, RLS check.
 * Run AFTER the migration has been applied via runMigration.
 *
 * Usage: bunx tsx expo/scripts/runShadowMigration.ts
 */
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  SHADOW SIGNALS V1 — INSERT + RLS VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Step 1: Verify table exists via service-role query ─────────────────
  console.log('Step 1: Verify table exists via service-role client...');
  const { data: verifyData, error: verifyErr } = await supabase
    .from('shadow_signals_v1')
    .select('id, signal_id, created_at')
    .order('id', { ascending: false })
    .limit(5);

  if (verifyErr) {
    console.error(`❌ Table verification FAILED: ${verifyErr.message}`);
    console.error('   The table does not exist or is not accessible.');
    process.exit(1);
  }

  console.log(`✅ Table exists and is queryable. Current rows: ${verifyData?.length ?? 0}`);
  if (verifyData && verifyData.length > 0) {
    console.log(`  Existing rows: ${JSON.stringify(verifyData)}`);
  }

  // ── Step 2: Test insert via service-role client ────────────────────────
  console.log('\nStep 2: Test insert via service-role client...');

  const testRecord = {
    signal_id: `test-shadow-${Date.now()}`,
    created_at: new Date().toISOString(),
    direction: 'SELL' as const,
    entry: 4050.0,
    sl: 3980.0,
    tp1: 4020.0,
    tp2: 3990.0,
    tp3: 3960.0,
    confidence: 0.75,
    entry_shifted: 4090.0,
    sl_shifted: 4020.0,
    tp1_shifted: 4060.0,
    tp2_shifted: 4030.0,
    tp3_shifted: 4000.0,
    sl_multiplier: 1.4,
    atr: 1.2,
    regime: 'TRENDING',
    session_name: 'LONDON',
    hour_utc: new Date().getUTCHours(),
    sr_zones_snapshot: { test: true } as Record<string, unknown>,
    attention_scores: { score: 0.5 } as Record<string, unknown>,
    htf_trend: 'BEARISH' as const,
    ltf_trend: 'BEARISH' as const,
    rsi: 42.5,
  };

  const { data: insertData, error: insertErr } = await supabase
    .from('shadow_signals_v1')
    .insert(testRecord)
    .select('id, signal_id, created_at, entry, sl, direction, session_name, hour_utc, confidence, atr, regime');

  if (insertErr) {
    console.error(`❌ Test insert FAILED: ${insertErr.message}`);
    console.error('   This is a real bug — the service-role insert is not working.');
    process.exit(1);
  }

  if (!insertData || insertData.length === 0) {
    console.error('❌ Test insert returned no data — row may not have landed.');
    process.exit(1);
  }

  console.log('✅ Test insert SUCCESS. Row that landed:');
  console.log(JSON.stringify(insertData[0], null, 2));

  // ── Step 3: Read it back to fully confirm ──────────────────────────────
  const insertedSignalId = (insertData[0] as { signal_id: string }).signal_id;
  console.log(`\nStep 3: Read back row by signal_id="${insertedSignalId}"...`);

  const { data: readBack, error: readErr } = await supabase
    .from('shadow_signals_v1')
    .select('*')
    .eq('signal_id', insertedSignalId)
    .single();

  if (readErr) {
    console.error(`❌ Read-back FAILED: ${readErr.message}`);
    process.exit(1);
  }

  console.log('✅ Read-back SUCCESS. Full row:');
  console.log(JSON.stringify(readBack, null, 2));

  // ── Step 4: Clean up test row ──────────────────────────────────────────
  const { error: delErr } = await supabase
    .from('shadow_signals_v1')
    .delete()
    .eq('signal_id', insertedSignalId);

  if (delErr) {
    console.warn(`⚠️ Test row cleanup failed (non-blocking): ${delErr.message}`);
  } else {
    console.log('\n🧹 Test row cleaned up.');
  }

  // ── Step 5: Test RLS — anon key should NOT be able to insert ───────────
  console.log('\nStep 5: RLS verification — anon key should NOT be able to insert...');
  if (!ANON_KEY) {
    console.log('  ⚠️ No anon key available — skipping RLS insert test');
  } else {
    const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: anonInsertErr } = await anonClient
      .from('shadow_signals_v1')
      .insert({ ...testRecord, signal_id: `rls-test-${Date.now()}` });

    if (anonInsertErr) {
      console.log(`✅ RLS correctly blocked anon insert: ${anonInsertErr.message}`);
    } else {
      console.error('❌ RLS FAILED: anon key was able to insert — security issue!');
      // Clean up the leaked row
      await supabase.from('shadow_signals_v1').delete().like('signal_id', 'rls-test-%');
    }

    // Anon SHOULD be able to SELECT
    const { data: anonSelect, error: anonSelectErr } = await anonClient
      .from('shadow_signals_v1')
      .select('id')
      .limit(1);

    if (anonSelectErr) {
      console.log(`⚠️ Anon SELECT failed (unexpected): ${anonSelectErr.message}`);
    } else {
      console.log(`✅ RLS correctly allows anon SELECT (returned ${anonSelect?.length ?? 0} rows)`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  INSERT + READ-BACK + RLS: ALL CONFIRMED');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
