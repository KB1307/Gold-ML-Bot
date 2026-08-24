/**
 * PHASE A / A1 — LIVE SCHEMA-CONTRACT VERIFICATION (checkpoint evidence).
 *
 * The Item 149 guard (ci_guard_schema_contract.ts) compares a HARD-CODED code-write
 * inventory against the live schema. It went stale twice already: its inventory ends
 * at Item 149, so the Item 210/212/213 columns (migrations 010/011) are invisible to
 * it — it printed PASS on 2026-08-24 while production lacked every column those
 * migrations add. That is the exact drift class this script exists to catch.
 *
 * This script derives the EXPECTED schema from the repo migrations themselves
 * (001–011), table by table, and compares each migration's column contribution
 * against the LIVE production column set (PostgREST select-probe, service key).
 * Verdict is PASS/FAIL PER MIGRATION, so an unapplied migration is impossible to
 * miss. Exit 1 on any FAIL so CI can gate on it.
 *
 * Run: bunx tsx scripts/verifySchemaContractLive.ts   (from expo/)
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// ── .env loader (same pattern as apply_migration_007.ts) ───────────────────
function loadEnv(): void {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    console.error('Could not read expo/.env — run from the expo/ directory.');
    process.exit(1);
  }
}
loadEnv();

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

/**
 * Expected column contributions per migration, table by table.
 * Derived by reading backend/migrations/001–011 (ADD COLUMN and CREATE TABLE
 * statements). A migration is PASS only if EVERY column it contributes exists
 * in the live production table.
 */
const MIGRATION_EXPECTATIONS: {
  migration: string;
  table: string;
  columns: string[];
}[] = [
  { migration: '001_shadow_signals_v1', table: 'shadow_signals_v1', columns: ['id','signal_id','created_at','direction','entry','sl','tp1','tp2','tp3','confidence','entry_shifted','sl_shifted','tp1_shifted','tp2_shifted','tp3_shifted','sl_multiplier','atr','regime','session_name','hour_utc','sr_zones_snapshot','attention_scores','htf_trend','ltf_trend','rsi','feature_schema_version'] },
  { migration: '004_emitted_signals_v1', table: 'emitted_signals_v1', columns: ['id','signal_id','created_at','emitted_at','direction','entry','sl','tp1','tp2','tp3','confidence','raw_confidence','strength_diff','sl_multiplier','atr','regime','session_name','hour_utc','htf_trend','ltf_trend','rsi','sr_zones_snapshot','attention_scores','source','feature_schema_version'] },
  { migration: '006_zone_cadence_and_telemetry', table: 'emitted_signals_v1', columns: ['zone_map_age_minutes'] },
  { migration: '010_zone_strength_edge', table: 'sr_zones_v1', columns: ['strength_price','entry_edge_price'] },
  { migration: '011_emitted_signal_annotations', table: 'emitted_signals_v1', columns: ['nearest_opp_zone_behind_entry_price','nearest_opp_zone_behind_entry_type','nearest_opp_zone_behind_entry_dist_atr','driving_zone_touches'] },
  // A3 (Phase A) will add these to migration 012; verified here so the check
  // FAILS until they exist, not after code already writes them.
  // { migration: '012_directed_zone_typing', table: 'sr_zones_v1', columns: ['legacy_type','rejections_from_below','rejections_from_above'] },
];

/** Tables whose full column set is reported as evidence. */
const REPORT_TABLES = ['emitted_signals_v1', 'sr_zones_v1', 'trade_outcomes_v1', 'shadow_signals_v1'];

async function main(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PHASE A / A1 — LIVE SCHEMA CONTRACT VERIFICATION');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Target:    ${URL}\n`);

  const svc = createClient(URL, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

  // ── 1. Live column sets (select * limit 1 → keys) ─────────────────────────
  const liveCols: Record<string, Set<string>> = {};
  for (const table of REPORT_TABLES) {
    const { data, error } = await svc.from(table).select('*').limit(1);
    if (error) {
      console.log(`  ❌ ${table}: query error ${error.code} ${error.message}`);
      liveCols[table] = new Set();
      continue;
    }
    if (!data || data.length === 0) {
      // No row to inspect — fall back to a head probe (columns unverifiable).
      console.log(`  ⚠️ ${table}: EMPTY — column set unverifiable via row inspect`);
      liveCols[table] = new Set();
      continue;
    }
    liveCols[table] = new Set(Object.keys(data[0]));
    console.log(`  ${table} live columns (${liveCols[table].size}): ${[...liveCols[table]].sort().join(', ')}`);
  }
  console.log('');

  // ── 2. Per-migration PASS/FAIL ────────────────────────────────────────────
  console.log('── PER-MIGRATION VERDICT ──');
  let allPass = true;
  for (const exp of MIGRATION_EXPECTATIONS) {
    const live = liveCols[exp.table];
    const missing = exp.columns.filter(c => !live.has(c));
    if (live.size === 0) {
      console.log(`  ❓ ${exp.migration}: ${exp.table} column set unverifiable — treated as FAIL (guard requires evidence)`);
      allPass = false;
    } else if (missing.length === 0) {
      console.log(`  ✅ ${exp.migration}: all ${exp.columns.length} expected column(s) present in ${exp.table}`);
    } else {
      console.log(`  ❌ ${exp.migration}: MISSING in ${exp.table}: ${missing.join(', ')}`);
      allPass = false;
    }
  }
  console.log('');

  // ── 3. Code-write guard: columns the CURRENT working tree writes ───────────
  // The Item 210/212/213 code (unshipped until this round's push) writes:
  //   emittedSignalService.ts → nearest_opp_zone_behind_* , driving_zone_touches
  //   srZoneTier0Service.ts   → strength_price, entry_edge_price (read path)
  //   signalEngine snapshot   → strengthPrice/entryEdgePrice inside JSONB (no DDL)
  console.log('── CODE-WRITE EXPOSURE ──');
  const newEmittedCols = ['nearest_opp_zone_behind_entry_price','nearest_opp_zone_behind_entry_type','nearest_opp_zone_behind_entry_dist_atr','driving_zone_touches'];
  const emittedLive = liveCols['emitted_signals_v1'];
  const emittedMissing = newEmittedCols.filter(c => !emittedLive.has(c));
  if (emittedMissing.length > 0) {
    console.log(`  ⚠️ emittedSignalService.ts now writes ${emittedMissing.length} column(s) NOT in production: ${emittedMissing.join(', ')}`);
    console.log('     → Without the write-path guard, the NEXT live signal insert is rejected');
    console.log('       WHOLE (PostgREST rejects unknown columns) — live capture death (F-1 class).');
  } else {
    console.log('  ✅ all new emitted_signals_v1 write columns present in production');
  }

  // ── 4. Verdict ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  if (allPass && emittedMissing.length === 0) {
    console.log('VERDICT: ✅ PASS — repo migrations and live production schema agree.');
  } else {
    console.log('VERDICT: ❌ FAIL — repo/production schema drift detected.');
    console.log('  Remediation: apply backend/migrations/010 + 011 (Supabase SQL Editor or');
    console.log('  SUPABASE_DB_PASSWORD pooler path — see artifacts/ddl_access_probe_2026-08-19.txt).');
    console.log('  Until applied, the write-path guard must drop unknown FIELDS, never the ROW.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
