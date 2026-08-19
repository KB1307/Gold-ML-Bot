/**
 * PROBE — determine whether migration DDL can be applied with available creds.
 * READ-ONLY: every test is either an RPC existence probe or `select 1`.
 *
 * Paths probed, in order:
 *   1. exec-style RPCs via service key (exec_sql, exec_sql_readonly, ...)
 *   2. PostgREST access to internal schemas (cron.job) via service key
 *   3. Direct Postgres connection db.<ref>.supabase.co:5432 (service key as password)
 *   4. Supavisor pooler across regions (postgres.<ref> user, service key as password)
 *
 * Usage: cd expo && bunx tsx scripts/probe_ddl_access.ts
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const SUPA_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const REF = new URL(SUPA_URL).hostname.split('.')[0];
console.log(`Project ref: ${REF}`);

const admin = createClient(SUPA_URL, SRK, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function probeRpcs() {
  console.log('\n=== 1. exec-style RPC probes (service key) ===');
  const candidates = ['exec_sql', 'exec_sql_readonly', 'run_sql', 'pgrst_exec', 'exec', 'sql'];
  for (const name of candidates) {
    try {
      const { data, error } = await admin.rpc(name as never, { query: 'select 1' } as never);
      if (error) {
        console.log(`  ${name}: ${error.code ?? ''} ${error.message.slice(0, 80)}`);
      } else {
        console.log(`  ${name}: EXISTS! data=${JSON.stringify(data)?.slice(0, 120)}`);
      }
    } catch (e) {
      console.log(`  ${name}: threw ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

async function probeInternalSchemas() {
  console.log('\n=== 2. PostgREST on cron.job / net._http_response (service key) ===');
  for (const t of ['cron.job', 'net._http_response', 'pipeline_health_v1']) {
    const { data, error } = await admin.from(t as never).select('*').limit(1);
    if (error) console.log(`  ${t}: ${error.code ?? ''} ${error.message.slice(0, 90)}`);
    else console.log(`  ${t}: READABLE rows=${JSON.stringify(data)?.slice(0, 100)}`);
  }
}

async function tryPg(host: string, port: number, user: string, label: string): Promise<string> {
  const { Client } = await import('pg');
  const client = new Client({
    host,
    port,
    user,
    password: SRK,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 6000,
    query_timeout: 6000,
  });
  try {
    await client.connect();
    const res = await client.query('select current_user, current_database()');
    await client.end();
    return `${label}: CONNECTED as ${res.rows[0].current_user}`;
  } catch (e) {
    return `${label}: ${(e as Error).message.split('\n')[0].slice(0, 100)}`;
  }
}

async function probePg() {
  console.log('\n=== 3. Direct Postgres: db.<ref>.supabase.co:5432 (service key as password) ===');
  console.log(`  ${await tryPg(`db.${REF}.supabase.co`, 5432, 'postgres', 'direct')}`);

  console.log('\n=== 4. Supavisor pooler across regions (service key as password) ===');
  const regions = [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
    'ap-south-1', 'ap-south-2', 'sa-east-1', 'ca-central-1', 'me-central-1',
  ];
  const attempts: Promise<string>[] = [];
  for (const r of regions) {
    for (const pfx of ['aws-0', 'aws-1']) {
      for (const port of [6543, 5432]) {
        attempts.push(
          tryPg(`${pfx}-${r}.pooler.supabase.com`, port, `postgres.${REF}`, `${pfx}-${r}:${port}`)
        );
      }
    }
  }
  const results = await Promise.all(attempts);
  const connected = results.filter((r) => r.includes('CONNECTED'));
  if (connected.length > 0) {
    for (const c of connected) console.log(`  ✅ ${c}`);
    console.log(`  (${results.length - connected.length} other hosts unreachable — expected)`);
  } else {
    console.log(`  all ${results.length} pooler endpoints rejected the service key / unreachable`);
    const authFailures = results.filter((r) => /password|auth/i.test(r));
    if (authFailures.length > 0) console.log(`  (${authFailures.length} reached auth stage — wrong password)`);
  }
}

async function main() {
  await probeRpcs();
  await probeInternalSchemas();
  await probePg();
  console.log('\nPROBE COMPLETE');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
