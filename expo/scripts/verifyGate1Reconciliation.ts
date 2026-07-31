/**
 * Gate 1 Reconciliation — empirically proves which RLS design is LIVE on
 * shadow_signals_v1 by testing actual anon-key INSERT/SELECT/UPDATE/DELETE
 * behavior against the real database. PostgREST doesn't expose pg_policies,
 * so we rely on empirical permission tests + the information_schema views
 * that ARE exposed.
 *
 * Usage: bunx tsx scripts/verifyGate1Reconciliation.ts
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

if (!URL || !ANON || !SVC) {
  console.error('Missing env vars: EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const svcClient = createClient(URL, SVC, { auth: { autoRefreshToken: false, persistSession: false } });
const anonClient = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const ts = () => Date.now();
const baseRow = {
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
  sr_zones_snapshot: { recon: true } as Record<string, unknown>,
  attention_scores: { score: 0.5 } as Record<string, unknown>,
  htf_trend: 'BEARISH' as const,
  ltf_trend: 'BEARISH' as const,
  rsi: 42.5,
};

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 1 RECONCILIATION — LIVE RLS + WRITE-PATH EMPIRICAL PROOF');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── 0. Table exists? ──
  console.log('── 0. Table exists (service-role SELECT)? ──');
  const { data: existCheck, error: existErr } = await svcClient
    .from('shadow_signals_v1')
    .select('id')
    .limit(1);
  if (existErr) {
    console.error(`❌ Table missing or inaccessible: ${existErr.message}`);
    process.exit(1);
  }
  console.log(`✅ Table exists. Rows visible to service role: ${existCheck?.length ?? 0}\n`);

  // ── 1. Table columns (via information_schema) ──
  console.log('── 1. Table columns (information_schema.columns) ──');
  const { data: cols, error: colsErr } = await svcClient
    .from('information_schema_columns')
    .select('column_name, data_type, is_nullable, column_default')
    .eq('table_name', 'shadow_signals_v1')
    .eq('table_schema', 'public')
    .order('ordinal_position');
  if (colsErr) {
    console.log(`  (information_schema.columns not exposed: ${colsErr.message})`);
  } else {
    console.log(`  Columns (${cols?.length ?? 0}):`);
    for (const c of cols ?? []) {
      console.log(`    ${c.column_name} | ${c.data_type} | nullable=${c.is_nullable} | default=${c.column_default ?? 'none'}`);
    }
  }
  console.log('');

  // ── 2. Table-level info (information_schema.tables) ──
  console.log('── 2. Table info (information_schema.tables) ──');
  const { data: tblInfo, error: tblErr } = await svcClient
    .from('information_schema_tables')
    .select('table_name, table_schema, is_insertable_into, is_updatable, is_typed')
    .eq('table_name', 'shadow_signals_v1')
    .eq('table_schema', 'public');
  if (tblErr) {
    console.log(`  (information_schema.tables not exposed: ${tblErr.message})`);
  } else {
    console.log(`  ${JSON.stringify(tblInfo, null, 2)}`);
  }
  console.log('');

  // ── 3. EMPIRICAL ANON INSERT TEST — the key test ──
  console.log('── 3. EMPIRICAL: can ANON key INSERT into shadow_signals_v1? ──');
  const anonRow = { ...baseRow, signal_id: `recon-anon-${ts()}` };
  const { data: anonInsert, error: anonInsErr } = await anonClient
    .from('shadow_signals_v1')
    .insert(anonRow)
    .select('id, signal_id, created_at, direction, entry, session_name');

  if (anonInsErr) {
    console.log(`  ❌ ANON INSERT BLOCKED by RLS: ${anonInsErr.message}`);
    console.log('  → Design A is live (anon CANNOT write; writes must go server-side).');
  } else {
    console.log('  ✅ ANON INSERT SUCCEEDED — row landed:');
    console.log(`  ${JSON.stringify(anonInsert)}`);
    console.log('  → Design B is live (anon CAN write directly, no backend needed).');
  }
  console.log('');

  // ── 4. Read back the anon-inserted row via service role ──
  if (!anonInsErr && anonInsert) {
    console.log('── 4. Read-back of anon-inserted row via service-role ──');
    const { data: rb, error: rbErr } = await svcClient
      .from('shadow_signals_v1')
      .select('*')
      .eq('signal_id', anonRow.signal_id)
      .single();
    if (rbErr) {
      console.log(`  ❌ Read-back failed: ${rbErr.message}`);
    } else {
      console.log(`  ✅ Row confirmed in DB:`);
      console.log(`    id=${rb?.id}`);
      console.log(`    signal_id=${rb?.signal_id}`);
      console.log(`    created_at=${rb?.created_at}`);
      console.log(`    direction=${rb?.direction}`);
      console.log(`    entry=${rb?.entry}`);
      console.log(`    session_name=${rb?.session_name}`);
      console.log(`    confidence=${rb?.confidence}`);
      console.log(`    atr=${rb?.atr}`);
    }
    console.log('');
  }

  // ── 5. EMPIRICAL ANON SELECT TEST ──
  console.log('── 5. EMPIRICAL: can ANON key SELECT from shadow_signals_v1? ──');
  const { data: anonSel, error: anonSelErr } = await anonClient
    .from('shadow_signals_v1')
    .select('id, signal_id')
    .limit(3);
  if (anonSelErr) {
    console.log(`  ❌ ANON SELECT BLOCKED: ${anonSelErr.message}`);
  } else {
    console.log(`  ✅ ANON SELECT works (returned ${anonSel?.length ?? 0} rows)`);
  }
  console.log('');

  // ── 6. EMPIRICAL ANON UPDATE TEST ──
  console.log('── 6. EMPIRICAL: can ANON key UPDATE shadow_signals_v1? ──');
  const { error: anonUpdErr } = await anonClient
    .from('shadow_signals_v1')
    .update({ entry: 9999.0 })
    .eq('signal_id', `recon-anon-${ts()}`); // non-existent id, just testing permission
  if (anonUpdErr) {
    console.log(`  ✅ ANON UPDATE blocked: ${anonUpdErr.message}`);
  } else {
    console.log(`  ⚠️ ANON UPDATE not blocked (may be no-op on zero rows)`);
  }
  console.log('');

  // ── 7. EMPIRICAL ANON DELETE TEST ──
  console.log('── 7. EMPIRICAL: can ANON key DELETE from shadow_signals_v1? ──');
  const { error: anonDelErr } = await anonClient
    .from('shadow_signals_v1')
    .delete()
    .eq('signal_id', `recon-anon-nonexistent-${ts()}`);
  if (anonDelErr) {
    console.log(`  ✅ ANON DELETE blocked: ${anonDelErr.message}`);
  } else {
    console.log(`  ⚠️ ANON DELETE not blocked (may be no-op on zero rows)`);
  }
  console.log('');

  // ── 8. EMPIRICAL SERVICE-ROLE INSERT (control — should always work) ──
  console.log('── 8. CONTROL: service-role INSERT (should always work) ──');
  const svcRow = { ...baseRow, signal_id: `recon-svc-${ts()}` };
  const { data: svcInsert, error: svcInsErr } = await svcClient
    .from('shadow_signals_v1')
    .insert(svcRow)
    .select('id, signal_id, direction');
  if (svcInsErr) {
    console.log(`  ❌ SERVICE INSERT FAILED: ${svcInsErr.message}`);
  } else {
    console.log(`  ✅ Service insert succeeded: ${JSON.stringify(svcInsert)}`);
  }
  console.log('');

  // ── 9. Cleanup recon rows ──
  console.log('── 9. Cleanup recon test rows ──');
  const { error: delErr } = await svcClient
    .from('shadow_signals_v1')
    .delete()
    .like('signal_id', 'recon-%');
  if (delErr) {
    console.log(`  ⚠️ Cleanup failed: ${delErr.message}`);
  } else {
    console.log('  ✅ Recon rows cleaned up.');
  }
  console.log('');

  // ── 10. Existing real rows in the table ──
  console.log('── 10. Existing real rows in shadow_signals_v1 (most recent 10) ──');
  const { data: recent, error: recentErr } = await svcClient
    .from('shadow_signals_v1')
    .select('signal_id, created_at, direction, session_name, entry, confidence')
    .order('created_at', { ascending: false })
    .limit(10);
  if (recentErr) {
    console.log(`  ⚠️ Query failed: ${recentErr.message}`);
  } else {
    console.log(`  Total recent rows: ${recent?.length ?? 0}`);
    for (const r of recent ?? []) {
      console.log(`    ${r.signal_id} | ${r.created_at} | ${r.direction} | ${r.session_name} | entry=${r.entry} | conf=${r.confidence}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  RECONCILIATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
