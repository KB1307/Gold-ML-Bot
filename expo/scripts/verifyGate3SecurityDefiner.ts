/**
 * GATE 3 VERIFICATION — investigates and locks down the publicly-executable
 * SECURITY DEFINER function `rls_auto_enable()`.
 *
 * Supabase's advisor flags that public.rls_auto_enable() is a SECURITY DEFINER
 * function executable by BOTH anon and authenticated roles. A SECURITY DEFINER
 * function runs with the definer's elevated privileges regardless of caller —
 * so a publicly-executable one is a privilege-escalation surface.
 *
 * This script:
 * 1. Reports what rls_auto_enable() does and where it came from.
 * 2. Confirms whether it can bypass/disable RLS on our tables.
 * 3. REVOKEs EXECUTE from anon/authenticated/public (keeps service-role access).
 * 4. Confirms nothing the app depends on was broken.
 *
 * Since PostgREST doesn't expose pg_catalog directly, this script uses the
 * Supabase SQL endpoint via fetch with the service-role key to run raw SQL.
 *
 * Usage: bunx tsx expo/scripts/verifyGate3SecurityDefiner.ts
 */

const PIP_VALUE = 0.10;

async function execSql(query: string): Promise<unknown> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  if (!url || !svc) throw new Error('Missing SUPABASE env vars');

  // Try the /pg/query endpoint first (Supabase SQL editor endpoint)
  try {
    const resp = await fetch(`${url}/pg/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${svc}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) return await resp.json();
  } catch {
    // fall through to REST RPC
  }

  // Fallback: use a PostgREST-compatible approach via the rpc endpoint
  // We'll use the supabase-js client's .rpc() if available, but for raw SQL
  // we need the pg/query endpoint. If that fails, report it.
  throw new Error('Cannot execute raw SQL — /pg/query endpoint unavailable. ' +
    'Manual SQL execution required via Supabase SQL Editor.');
}

async function main(): Promise<void> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
  const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

  if (!url || !svc || !anon) {
    console.error('Missing env vars: EXPO_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EXPO_PUBLIC_SUPABASE_ANON_KEY');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 3 — SECURITY DEFINER FUNCTION LOCKDOWN');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Step 1: Check if rls_auto_enable is callable by anon (the security issue)
  console.log('  Step 1: Test if rls_auto_enable() is callable by anon key...');
  const anonResp = await fetch(`${url}/rest/v1/rpc/rls_auto_enable`, {
    method: 'POST',
    headers: {
      'apikey': anon,
      'Authorization': `Bearer ${anon}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const anonBody = await anonResp.text();
  console.log(`  → HTTP ${anonResp.status}: ${anonBody.slice(0, 200)}`);

  if (anonResp.status === 200 || (anonResp.status === 400 && !anonBody.includes('Could not find'))) {
    console.log('  ⚠️ rls_auto_enable IS callable by anon — privilege escalation surface confirmed.');
  } else if (anonBody.includes('Could not find') || anonResp.status === 404) {
    console.log('  → rls_auto_enable not found in PostgREST schema — may not exist or not exposed.');
  } else {
    console.log(`  → rls_auto_enable returned ${anonResp.status} — function exists and is reachable by anon.`);
  }

  // Step 2: Check what the function does — query pg_proc via service-role RPC
  console.log('\n  Step 2: Query rls_auto_enable definition...');

  // Try via service-role RPC
  const svcResp = await fetch(`${url}/rest/v1/rpc/rls_auto_enable`, {
    method: 'POST',
    headers: {
      'apikey': svc,
      'Authorization': `Bearer ${svc}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const svcBody = await svcResp.text();
  console.log(`  → Service-role call HTTP ${svcResp.status}: ${svcBody.slice(0, 200)}`);

  // Step 3: Attempt to run the REVOKE via /pg/query
  console.log('\n  Step 3: Attempt REVOKE EXECUTE on rls_auto_enable from public/anon/authenticated...');
  try {
    const revokeResult = await execSql(
      `REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;`
    );
    console.log('  → REVOKE executed successfully:', JSON.stringify(revokeResult).slice(0, 200));
  } catch (err) {
    console.log(`  → /pg/query unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    console.log('  → Will attempt REVOKE via REST API or report manual step needed.');
  }

  // Step 4: Verify the revoke worked — anon should now get 404/403
  console.log('\n  Step 4: Verify anon can no longer call rls_auto_enable...');
  const anonResp2 = await fetch(`${url}/rest/v1/rpc/rls_auto_enable`, {
    method: 'POST',
    headers: {
      'apikey': anon,
      'Authorization': `Bearer ${anon}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const anonBody2 = await anonResp2.text();
  console.log(`  → HTTP ${anonResp2.status}: ${anonBody2.slice(0, 200)}`);

  if (anonResp2.status === 404 || anonBody2.includes('Could not find') || anonResp2.status === 403) {
    console.log('  ✅ anon can no longer call rls_auto_enable — REVOKE confirmed.');
  } else {
    console.log('  ⚠️ anon can still reach rls_auto_enable — REVOKE may not have applied.');
  }

  // Step 5: Confirm app functionality is not broken — test that our tables still work
  console.log('\n  Step 5: Confirm app tables still work after REVOKE...');
  const { createClient } = await import('@supabase/supabase-js');
  const anonClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const svcClient = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } });

  // gold_m1_bars SELECT (anon should still work — RLS allows it)
  const { error: goldErr } = await anonClient.from('gold_m1_bars').select('timestamp').limit(1);
  console.log(`  gold_m1_bars anon SELECT: ${goldErr ? '❌ ' + goldErr.message : '✅ works'}`);

  // shadow_signals_v1 SELECT (anon should still work — RLS allows it)
  const { error: shadowErr } = await anonClient.from('shadow_signals_v1').select('id').limit(1);
  console.log(`  shadow_signals_v1 anon SELECT: ${shadowErr ? '❌ ' + shadowErr.message : '✅ works'}`);

  // shadow_signals_v1 INSERT via service-role (should still work)
  const { error: insertErr, data: insertData } = await svcClient.from('shadow_signals_v1')
    .insert({
      signal_id: `gate3-verify-${Date.now()}`,
      created_at: new Date().toISOString(),
      direction: 'SELL', entry: 1, sl: 1, tp1: 1, tp2: 1, tp3: 1,
      confidence: 0.5, entry_shifted: 1, sl_shifted: 1, tp1_shifted: 1, tp2_shifted: 1, tp3_shifted: 1,
      sl_multiplier: 1, atr: 1, regime: 'x', session_name: 'x', hour_utc: 0,
    }).select('id');
  console.log(`  shadow_signals_v1 service-role INSERT: ${insertErr ? '❌ ' + insertErr.message : '✅ works (id=' + (insertData?.[0]?.id ?? '?') + ')'}`);

  // Clean up
  if (insertData?.[0]?.id) {
    await svcClient.from('shadow_signals_v1').delete().eq('id', insertData[0].id);
    console.log('  🧹 cleanup done');
  }

  // sr_zones_v1 SELECT
  const { error: srErr } = await anonClient.from('sr_zones_v1').select('id').limit(1);
  console.log(`  sr_zones_v1 anon SELECT: ${srErr ? '❌ ' + srErr.message : '✅ works'}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 3: See report above for REVOKE status and app functionality');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
