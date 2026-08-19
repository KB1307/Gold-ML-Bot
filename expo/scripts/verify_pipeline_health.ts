/**
 * VERIFY the pipeline health check end-to-end from the app's perspective
 * (anon key over REST — exactly what the dashboard card reads).
 *
 * Run AFTER migration 007 is applied (SQL Editor paste, or
 * apply_migration_007.ts with SUPABASE_DB_PASSWORD set).
 *
 * Checks, in order:
 *   1. pipeline_health_v1 is readable via the ANON key (RLS SELECT policy works,
 *      table exposed) — this is the exact path the app UI uses.
 *   2. Rows exist (cron job is writing). Reports latest status, freshness,
 *      and cron lag.
 *   3. Staleness guard: if the newest row is older than 20 minutes, the checker
 *      itself has stopped — surfaced explicitly.
 *   4. RLS posture: anon INSERT must be REJECTED (no write path by design).
 *
 * Exit codes: 0 = verified healthy infrastructure; 1 = migration not applied;
 * 2 = table exists but no rows (force first run); 3 = checker stale;
 * 4 = RLS posture failure.
 *
 * Usage: cd expo && bun scripts/verify_pipeline_health.ts
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)$/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch {
    console.error('Could not read expo/.env — run from the expo/ directory.');
    process.exit(1);
  }
}
loadEnv();

const SUPA_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const STALE_MINUTES = 20;

interface HealthRow {
  id: number;
  checked_at: string;
  status: string;
  non200_count: number;
  last_cron_success_at: string | null;
  cron_lag_minutes: number | null;
  window_hours: number;
}

function ageMinutes(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60_000;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PIPELINE HEALTH — END-TO-END VERIFICATION (anon key)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const anon = createClient(SUPA_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 1. Table readable via anon ────────────────────────────────────────────
  console.log('Check 1: pipeline_health_v1 readable via anon key...');
  const { data, error } = await anon
    .from('pipeline_health_v1')
    .select(
      'id, checked_at, status, non200_count, last_cron_success_at, cron_lag_minutes, window_hours'
    )
    .order('checked_at', { ascending: false })
    .limit(5);

  if (error) {
    if (error.code === 'PGRST205' || error.message.includes('Could not find')) {
      console.error('❌ Table does not exist — migration 007 NOT applied.');
      console.error('   Apply it: paste backend/migrations/007_pipeline_health.sql into the Supabase');
      console.error('   SQL Editor and run; or add SUPABASE_DB_PASSWORD to expo/.env and run');
      console.error('   scripts/apply_migration_007.ts.');
      process.exit(1);
    }
    console.error(`❌ Read failed: ${error.message}`);
    process.exit(1);
  }
  console.log('✅ Table exists and anon SELECT works (RLS policy live)\n');

  // ── 2. Rows exist ────────────────────────────────────────────────────────
  if (!data || data.length === 0) {
    console.error('❌ Table exists but has NO rows — the cron job has not run yet.');
    console.error('   Force the first check now (SQL Editor or apply script):');
    console.error('   select public.get_pipeline_health(24);');
    process.exit(2);
  }
  console.log('Check 2: cron job is writing. Latest rows (newest first):');
  for (const row of data as HealthRow[]) {
    const lag = row.cron_lag_minutes !== null ? `${Math.round(row.cron_lag_minutes)}m` : 'null';
    console.log(
      `  [${row.status}] checked ${row.checked_at} · non200=${row.non200_count} · zone-refresh lag=${lag}`
    );
  }
  console.log('');

  const latest = data[0] as HealthRow;
  const age = ageMinutes(latest.checked_at);

  // ── 3. Staleness guard ───────────────────────────────────────────────────
  console.log(`Check 3: freshness — newest check was ${age.toFixed(1)} minutes ago...`);
  if (age > STALE_MINUTES) {
    console.error(`❌ STALE: expected a check every 15 min, newest is ${Math.round(age)} min old.`);
    console.error('   The pipeline-health-check cron job may not be registered or has died.');
    console.error('   Inspect: select jobname, schedule, active from cron.job where jobname = \'pipeline-health-check\';');
    process.exit(3);
  }
  console.log(`✅ Fresh (< ${STALE_MINUTES} min)\n`);

  // ── 4. RLS posture ───────────────────────────────────────────────────────
  console.log('Check 4: RLS posture — anon INSERT must be rejected...');
  const { error: insertErr } = await anon
    .from('pipeline_health_v1')
    .insert({ status: 'HEALTHY', non200_count: 0 } as never);
  if (insertErr) {
    console.log(`✅ Anon INSERT correctly blocked: ${insertErr.message}`);
  } else {
    console.error('❌ RLS FAILED: anon was able to INSERT — security issue!');
    process.exit(4);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  VERIFIED — infrastructure live, latest status: ${latest.status}`);
  console.log(`  The dashboard card is reading this table right now.`);
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
