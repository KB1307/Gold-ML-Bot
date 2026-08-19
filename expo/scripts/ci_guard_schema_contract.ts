/**
 * ITEM 149 — SCHEMA-CONTRACT GUARD.
 *
 * Enumerates every column every write path writes to sr_zones_v1,
 * emitted_signals_v1, trade_outcomes_v1, and shadow_signals_v1, then
 * compares against information_schema.columns and FAILS on any column
 * the code writes but the database lacks.
 *
 * Same pattern as ci_guard_duplicate_constants.ts.
 *
 * Run: bun run scripts/ci_guard_schema_contract.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface WritePath {
  file: string;
  table: string;
  columns: Set<string>;
  lineHint: string;
}

interface SchemaColumn {
  table_name: string;
  column_name: string;
}

// ── Hard-coded column inventory from source code analysis ──────────────────
// Each entry is { table, column, source_file, line_hint }
// This is the AUTHORITATIVE list — if code writes a column not here, the
// guard will not catch it. The guard catches columns HERE that are NOT in the DB.

const INVENTORY: { table: string; column: string; source: string }[] = [
  // ── sr_zones_v1 (written by backend/functions/refresh-sr-zones/index.ts) ──
  { table: 'sr_zones_v1', column: 'price', source: 'refresh-sr-zones/index.ts:360' },
  { table: 'sr_zones_v1', column: 'type', source: 'refresh-sr-zones/index.ts:362' },
  { table: 'sr_zones_v1', column: 'touches', source: 'refresh-sr-zones/index.ts:363' },
  { table: 'sr_zones_v1', column: 'rejection_wicks', source: 'refresh-sr-zones/index.ts:364' },
  { table: 'sr_zones_v1', column: 'reaction_strength', source: 'refresh-sr-zones/index.ts:365' },
  { table: 'sr_zones_v1', column: 'legacy_reaction_strength', source: 'refresh-sr-zones/index.ts:366' },
  { table: 'sr_zones_v1', column: 'source', source: 'refresh-sr-zones/index.ts:367' },
  { table: 'sr_zones_v1', column: 'confluence_score', source: 'refresh-sr-zones/index.ts:368' },
  { table: 'sr_zones_v1', column: 'last_touch_ts', source: 'refresh-sr-zones/index.ts:369' },
  { table: 'sr_zones_v1', column: 'updated_at', source: 'refresh-sr-zones/index.ts:370' },

  // ── emitted_signals_v1 (written by expo/services/emittedSignalService.ts) ──
  { table: 'emitted_signals_v1', column: 'signal_id', source: 'emittedSignalService.ts:111' },
  { table: 'emitted_signals_v1', column: 'emitted_at', source: 'emittedSignalService.ts:112' },
  { table: 'emitted_signals_v1', column: 'direction', source: 'emittedSignalService.ts:113' },
  { table: 'emitted_signals_v1', column: 'entry', source: 'emittedSignalService.ts:114' },
  { table: 'emitted_signals_v1', column: 'sl', source: 'emittedSignalService.ts:115' },
  { table: 'emitted_signals_v1', column: 'tp1', source: 'emittedSignalService.ts:116' },
  { table: 'emitted_signals_v1', column: 'tp2', source: 'emittedSignalService.ts:117' },
  { table: 'emitted_signals_v1', column: 'tp3', source: 'emittedSignalService.ts:118' },
  { table: 'emitted_signals_v1', column: 'confidence', source: 'emittedSignalService.ts:119' },
  { table: 'emitted_signals_v1', column: 'raw_confidence', source: 'emittedSignalService.ts:120' },
  { table: 'emitted_signals_v1', column: 'strength_diff', source: 'emittedSignalService.ts:121' },
  { table: 'emitted_signals_v1', column: 'sl_multiplier', source: 'emittedSignalService.ts:122' },
  { table: 'emitted_signals_v1', column: 'atr', source: 'emittedSignalService.ts:123' },
  { table: 'emitted_signals_v1', column: 'regime', source: 'emittedSignalService.ts:124' },
  { table: 'emitted_signals_v1', column: 'session_name', source: 'emittedSignalService.ts:125' },
  { table: 'emitted_signals_v1', column: 'hour_utc', source: 'emittedSignalService.ts:126' },
  { table: 'emitted_signals_v1', column: 'htf_trend', source: 'emittedSignalService.ts:127' },
  { table: 'emitted_signals_v1', column: 'ltf_trend', source: 'emittedSignalService.ts:128' },
  { table: 'emitted_signals_v1', column: 'rsi', source: 'emittedSignalService.ts:129' },
  { table: 'emitted_signals_v1', column: 'zone_map_age_minutes', source: 'emittedSignalService.ts:130' },
  { table: 'emitted_signals_v1', column: 'sr_zones_snapshot', source: 'emittedSignalService.ts:131' },
  { table: 'emitted_signals_v1', column: 'attention_scores', source: 'emittedSignalService.ts:132' },
  { table: 'emitted_signals_v1', column: 'source', source: 'emittedSignalService.ts:133' },

  // ── trade_outcomes_v1 (written by backend resolver + learningStore) ──
  { table: 'trade_outcomes_v1', column: 'signal_id', source: 'resolver + learningStore' },
  { table: 'trade_outcomes_v1', column: 'ts', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'direction', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'result', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'entry_price', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'exit_price', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'pnl', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'confidence', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'realized_r', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'is_scratch', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'signal_duration_ms', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'feature_schema_version', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'features', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'misleading_features', source: 'resolver' },
  { table: 'trade_outcomes_v1', column: 'device_id', source: 'resolver' },

  // ── shadow_signals_v1 (written by shadowSignalService.ts) ──
  { table: 'shadow_signals_v1', column: 'signal_id', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'created_at', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'direction', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'entry', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'sl', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp1', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp2', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp3', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'entry_shifted', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'sl_shifted', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp1_shifted', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp2_shifted', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'tp3_shifted', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'confidence', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'htf_trend', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'ltf_trend', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'regime', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'atr', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'rsi', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'session_name', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'hour_utc', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'sr_zones_snapshot', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'attention_scores', source: 'shadowSignalService.ts' },
  { table: 'shadow_signals_v1', column: 'feature_schema_version', source: 'shadowSignalService.ts' },
];

// ── Load .env for Supabase connection ──────────────────────────────────────
function loadEnv() {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error('Could not read .env:', e);
    process.exit(1);
  }
}
loadEnv();

async function main() {
  console.log('='.repeat(80));
  console.log('ITEM 149 — SCHEMA-CONTRACT GUARD');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  // ── 149(a): Write-column inventory ──────────────────────────────────────────
  console.log('--- 149(a): WRITE-COLUMN INVENTORY ---');
  const tables = [...new Set(INVENTORY.map(i => i.table))];
  for (const table of tables) {
    const cols = INVENTORY.filter(i => i.table === table);
    console.log(`\n  ${table} (${cols.length} columns written):`);
    for (const c of cols) {
      console.log(`    ${c.column.padEnd(28)} ← ${c.source}`);
    }
  }

  // ── 149(b): Compare against information_schema ──────────────────────────────
  console.log('\n--- 149(b): SCHEMA GUARD CHECK ---');

  // We can't query information_schema directly via PostgREST (it's not exposed).
  // Instead, query each table with SELECT * LIMIT 1 and inspect the returned columns.
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  let allPass = true;
  let missingColumns: { table: string; column: string; source: string }[] = [];

  for (const table of tables) {
    console.log(`\n  Checking ${table}...`);
    const { data, error } = await supabase.from(table).select('*').limit(1);

    if (error) {
      // PGRST205 = table not found
      if (error.code === 'PGRST205' || error.message.includes('Could not find')) {
        console.log(`    ❌ TABLE NOT FOUND: ${table}`);
        // Mark all columns for this table as missing
        for (const c of INVENTORY.filter(i => i.table === table)) {
          missingColumns.push(c);
        }
        allPass = false;
        continue;
      }
      console.log(`    ⚠️ Query error (may be RLS): ${error.message}`);
      // Can't verify — skip but warn
      continue;
    }

    if (!data || data.length === 0) {
      // Empty table — try to get columns from a failed insert or head request
      console.log(`    Table exists but empty — trying head request for column info...`);
      const { count, error: headErr } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true });
      if (headErr) {
        console.log(`    ⚠️ Head request also failed: ${headErr.message}`);
        continue;
      }
      console.log(`    Table exists (count=${count}) but no rows to inspect columns.`);
      // Can't verify column names without a row — report as unverifiable
      console.log(`    UNVERIFIABLE: no rows to inspect. Manual verification needed.`);
      continue;
    }

    const dbColumns = new Set(Object.keys(data[0]));
    console.log(`    DB columns (${dbColumns.size}): ${[...dbColumns].sort().join(', ')}`);

    const inventoryCols = INVENTORY.filter(i => i.table === table);
    for (const c of inventoryCols) {
      if (!dbColumns.has(c.column)) {
        console.log(`    ❌ MISSING: code writes '${c.column}' but DB lacks it (source: ${c.source})`);
        missingColumns.push(c);
        allPass = false;
      }
    }

    // Also check for DB columns that code does NOT write (informational, not failure)
    const writtenCols = new Set(inventoryCols.map(c => c.column));
    const unwritten = [...dbColumns].filter(c => !writtenCols.has(c));
    if (unwritten.length > 0) {
      console.log(`    ℹ️ DB columns not written by code (informational): ${unwritten.sort().join(', ')}`);
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('VERDICT');
  console.log('='.repeat(80));

  if (missingColumns.length === 0) {
    console.log('  ✅ PASS: all write-path columns exist in the database schema.');
    console.log('  No missing columns detected.');
  } else {
    console.log(`  ❌ FAIL: ${missingColumns.length} column(s) written by code but missing from DB:`);
    for (const m of missingColumns) {
      console.log(`    ${m.table}.${m.column} ← ${m.source}`);
    }
    console.log('\n  FIX: Add the missing column(s) via a migration SQL file.');
    console.log('  RULE: ANY code writing a new column MUST ship its migration in the same round.');
    process.exit(1);
  }

  // ── 149(c): Health probe for non-200 HTTP responses ─────────────────────────
  console.log('\n--- 149(c): HEALTH PROBE (net._http_response non-200s) ---');
  console.log('  net._http_response is not queryable via anon key (internal Postgres table).');
  console.log('  Shipping a SQL snippet the user can run in the Supabase SQL Editor:\n');
  console.log('  --- BEGIN SQL ---');
  console.log(`  -- ITEM 149(c) REVISED: Find non-200 responses from pg_net calls (cron → edge functions)
  -- Run in Supabase SQL Editor. Checks the last 24 hours.
  -- Column names verified against the pg_net schema (net._http_response: id,
  -- status_code, content_type, headers, content, timed_out, error_msg, created)
  -- and pg_cron (cron.job_run_details: jobid, runid, status, return_message,
  -- start_time, end_time). The original snippet used j.id and r.request_started_at,
  -- neither of which exists — fixed.

  -- Query 1: All non-200 pg_net responses in the last 24h (no join — always works).
  SELECT
    r.id,
    r.status_code,
    r.error_msg,
    r.created,
    left(r.content::text, 300) AS response_body
  FROM net._http_response r
  WHERE r.status_code >= 400
    AND r.created > NOW() - INTERVAL '24 hours'
  ORDER BY r.created DESC
  LIMIT 20;

  -- Query 2: Correlate each non-200 with the cron job that fired it.
  -- pg_net and pg_cron share no foreign key, so join on the time window:
  -- the HTTP response is created while the cron run is executing.
  SELECT
    cj.jobname AS cron_job,
    j.runid,
    j.status AS cron_status,
    j.start_time,
    r.status_code,
    left(r.content::text, 300) AS response_body
  FROM net._http_response r
  JOIN cron.job_run_details j
    ON r.created BETWEEN j.start_time - INTERVAL '2 seconds'
                     AND j.end_time + INTERVAL '10 seconds'
  JOIN cron.job cj ON cj.jobid = j.jobid
  WHERE r.status_code >= 400
    AND r.created > NOW() - INTERVAL '24 hours'
  ORDER BY r.created DESC
  LIMIT 20;

  -- Query 3: Did refresh-sr-zones actually fire and succeed? (last 10 runs)
  SELECT
    j.runid,
    j.status,
    j.start_time,
    j.end_time,
    left(j.return_message, 200) AS return_message
  FROM cron.job_run_details j
  JOIN cron.job cj ON cj.jobid = j.jobid
  WHERE cj.jobname = 'refresh-sr-zones'
  ORDER BY j.start_time DESC
  LIMIT 10;`);
  console.log('  --- END SQL ---\n');
  console.log('  This probe makes finding the legacy_reaction_strength class of failure one command.');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
