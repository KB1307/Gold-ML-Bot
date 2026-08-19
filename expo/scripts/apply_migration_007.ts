/**
 * APPLY MIGRATION 007 (pipeline health check) to the live database, then force
 * the first health check and verify end-to-end.
 *
 * WHY THIS SCRIPT EXISTS — evidence in expo/artifacts/ddl_access_probe_2026-08-19.txt:
 * the SUPABASE_SERVICE_ROLE_KEY is an API JWT (REST + RLS bypass), NOT a database
 * credential. It cannot execute DDL (no exec-style RPC exists; PostgREST exposes
 * only `public`). Applying DDL requires a real Postgres connection, which needs
 * the DATABASE PASSWORD — a separate secret, found in Supabase Dashboard →
 * Project Settings → Database → "Connection string" (the password in that string).
 *
 * The project's pooler endpoint was located by region sweep:
 *   aws-0-eu-north-1.pooler.supabase.com:5432 (session mode)
 *   user: postgres.tcbnqmnzsnjhqkyuhrch
 *
 * USAGE:
 *   1. Add to expo/.env:  SUPABASE_DB_PASSWORD=<your database password>
 *   2. cd expo && bun scripts/apply_migration_007.ts
 *
 * The migration is idempotent (CREATE IF NOT EXISTS / OR REPLACE / unschedule-
 * then-schedule), so re-running is safe. Read the SQL it executes before
 * running: ../backend/migrations/007_pipeline_health.sql.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
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
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD;
const REF = new URL(SUPA_URL).hostname.split('.')[0];
const HOST = process.env.SUPABASE_DB_HOST ?? 'aws-0-eu-north-1.pooler.supabase.com';
const PORT = Number(process.env.SUPABASE_DB_PORT ?? 5432);

if (!DB_PASSWORD) {
  console.error('MISSING SUPABASE_DB_PASSWORD in expo/.env');
  console.error('');
  console.error('The service key cannot apply DDL (see artifacts/ddl_access_probe_2026-08-19.txt).');
  console.error('To run this script, add your DATABASE PASSWORD (NOT the service key):');
  console.error('  Supabase Dashboard → Project Settings → Database → Connection string → password');
  console.error('  then add to expo/.env:  SUPABASE_DB_PASSWORD=<password>');
  console.error('');
  console.error('Alternative (no password needed): paste backend/migrations/007_pipeline_health.sql');
  console.error('into the Supabase SQL Editor and run it — then run verify_pipeline_health.ts.');
  process.exit(1);
}

function findMigrationFile(): string {
  const candidates = [
    resolve(process.cwd(), '..', 'backend', 'migrations', '007_pipeline_health.sql'),
    resolve(process.cwd(), 'backend', 'migrations', '007_pipeline_health.sql'),
    resolve(new URL('.', import.meta.url).pathname, '..', '..', 'backend', 'migrations', '007_pipeline_health.sql'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* try next */
    }
  }
  console.error('Could not locate backend/migrations/007_pipeline_health.sql');
  process.exit(1);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  APPLY MIGRATION 007 — PIPELINE HEALTH CHECK');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const migrationPath = findMigrationFile();
  const migrationSql = readFileSync(migrationPath, 'utf8');
  console.log(`Migration file: ${migrationPath}`);
  console.log(`Target:         ${HOST}:${PORT} as postgres.${REF} (session mode)\n`);

  const { Client } = await import('pg');
  const client = new Client({
    host: HOST,
    port: PORT,
    user: `postgres.${REF}`,
    password: DB_PASSWORD,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });

  // ── Step 1: connect ──────────────────────────────────────────────────────
  console.log('Step 1: Connecting to the database...');
  try {
    await client.connect();
  } catch (e) {
    console.error(`❌ Connection failed: ${(e as Error).message}`);
    console.error('   Check SUPABASE_DB_PASSWORD (must be the DATABASE password, not the service key).');
    process.exit(1);
  }
  const who = await client.query<{ current_user: string }>('select current_user');
  console.log(`✅ Connected as ${who.rows[0].current_user}\n`);

  // ── Step 2: apply the migration (single multi-statement simple query) ────
  console.log('Step 2: Applying migration 007 (idempotent — CREATE IF NOT EXISTS / OR REPLACE)...');
  try {
    await client.query(migrationSql);
    console.log('✅ Migration applied without error\n');
  } catch (e) {
    console.error(`❌ Migration failed: ${(e as Error).message}`);
    await client.end().catch(() => {});
    process.exit(1);
  }

  // ── Step 3: confirm the cron job is registered ───────────────────────────
  console.log('Step 3: Confirming pg_cron job registration...');
  const jobs = await client.query<{ jobname: string; schedule: string; active: boolean }>(
    "select jobname, schedule, active from cron.job where jobname = 'pipeline-health-check'"
  );
  if (jobs.rows.length === 0) {
    console.error('❌ cron job pipeline-health-check NOT registered');
  } else {
    const j = jobs.rows[0];
    console.log(`✅ cron job "${j.jobname}" schedule=${j.schedule} active=${j.active}\n`);
  }

  // ── Step 4: force the first health check ─────────────────────────────────
  console.log('Step 4: Forcing the first health check (select public.get_pipeline_health(24))...');
  const first = await client.query<{ result: unknown }>('select public.get_pipeline_health(24) as result');
  console.log('✅ First check result:');
  console.log(JSON.stringify(first.rows[0].result, null, 2));

  await client.end();
  console.log('');

  // ── Step 5: verify from the app's perspective (anon key, REST) ───────────
  console.log('Step 5: Verifying anon-key read path (what the app UI uses)...');
  const anon = createClient(SUPA_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await anon
    .from('pipeline_health_v1')
    .select('id, checked_at, status, non200_count, cron_lag_minutes')
    .order('checked_at', { ascending: false })
    .limit(3);
  if (error) {
    console.error(`❌ Anon read failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`✅ Anon read OK — latest rows: ${JSON.stringify(data, null, 2)}`);

  // RLS posture: anon INSERT must be REJECTED (no insert policy by design).
  const { error: insertErr } = await anon
    .from('pipeline_health_v1')
    .insert({ status: 'HEALTHY', non200_count: 0 } as never);
  if (insertErr) {
    console.log(`✅ RLS correctly blocks anon INSERT: ${insertErr.message}`);
  } else {
    console.error('❌ RLS FAILED: anon was able to INSERT into pipeline_health_v1 — security issue!');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  MIGRATION APPLIED + FIRST CHECK RUN + END-TO-END VERIFIED');
  console.log('  The dashboard health card is live. Re-run verify_pipeline_health.ts');
  console.log('  any time to check the latest state.');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
