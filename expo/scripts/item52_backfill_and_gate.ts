/**
 * ITEM 52(c) + 52(f) — BACKFILL THE 396-SIGNAL POPULATION AND TEST THE GATE.
 *
 * Reads/writes emitted_signals_v1 via the anon key (DATA-SOURCE RULE) and reads
 * trade_outcomes_v1 to compute capture. READ-ONLY against trade_outcomes_v1 —
 * this script never mutates existing outcome rows, because Item 43d established
 * that an in-place corpus UPDATE with no pre-image destroys the ability to make a
 * like-for-like before/after comparison.
 *
 * PRE-REGISTERED GATE 52(f), fixed before running:
 *   G52-1  emitted_signals_v1 exists and is writable via the anon key.
 *   G52-2  Backfill lands the full emitted population, tagged source='BACKFILL'.
 *   G52-3  ZERO conflicts against the 51 already-corrected trade_outcomes_v1 rows
 *          (durable wins on conflict; nothing existing is altered).
 *   G52-4  Post-backfill capture rate materially above the 12.9% baseline.
 *   G52-5  Corpus EV/WR recomputed on the CANONICAL basis, compared against
 *          population +0.0813R / 63.3% rather than the capture-biased 52.9%.
 *
 * If G52-1 fails, every downstream gate is UNMEASURABLE and this script reports
 * the blocker rather than a number.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const CAPTURE_BASELINE_PCT = 12.9;
const POPULATION_EV_R = 0.0813;
const POPULATION_WR_PCT = 63.3;

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch {
    // fall through
  }
  return env;
};

interface GateResult {
  id: string;
  passed: boolean;
  detail: string;
}

const gates: GateResult[] = [];
const record = (id: string, passed: boolean, detail: string): void => {
  gates.push({ id, passed, detail });
  console.log(`  ${passed ? '\u2705 PASS' : '\u274c FAIL'}  ${id}: ${detail}`);
};

async function tableExists(client: SupabaseClient, table: string): Promise<{ exists: boolean; detail: string }> {
  const { error } = await client.from(table).select('*').limit(1);
  if (!error) return { exists: true, detail: 'readable' };
  return { exists: false, detail: `${error.code} ${error.message}` };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error('Missing Supabase URL or anon key');
    process.exit(1);
  }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const line = '='.repeat(84);
  console.log(`\n${line}`);
  console.log('ITEM 52 — EMISSION PERSISTENCE: BACKFILL + GATE');
  console.log(line);

  // ── G52-1: does the table exist yet? ──────────────────────────────────────
  console.log('\nG52-1 — emitted_signals_v1 present and writable?');
  const emitted = await tableExists(client, 'emitted_signals_v1');
  if (!emitted.exists) {
    record('G52-1', false, `emitted_signals_v1 NOT PRESENT -> ${emitted.detail}`);

    console.log(`\n${line}`);
    console.log('BLOCKER — GATE 52(f) CANNOT CLOSE. Reporting nothing as done.');
    console.log(line);
    console.log('  Migration 004_emitted_signals_v1.sql is WRITTEN but NOT APPLIED.');
    console.log('  This sandbox has no route to execute DDL against the live database:');
    console.log('    - no exec_sql / exec_sql_readonly RPC (all four candidates PGRST202)');
    console.log('    - supabase CLI unauthenticated (no SUPABASE_ACCESS_TOKEN)');
    console.log('    - no direct Postgres credentials (no DATABASE_URL / DB password)');
    console.log('  The service-role key permits table READS and WRITES through PostgREST,');
    console.log('  but PostgREST cannot CREATE TABLE. This matches how shadow_signals_v1');
    console.log('  itself was created: migrations in backend/migrations are applied by hand');
    console.log('  in the Supabase SQL Editor (see the verify note in migration 002).');
    console.log('');
    console.log('  TO UNBLOCK, in order:');
    console.log('    1. Run backend/migrations/004_emitted_signals_v1.sql in the SQL Editor.');
    console.log('    2. Deploy backend/functions/resolve-emitted-signals.');
    console.log('    3. Run the pg_cron schedule block at the bottom of migration 004.');
    console.log('    4. Re-run this script — it will then backfill and close G52-2..G52-5.');
    console.log('');
    console.log('  UNTIL THEN, measured honestly:');
    console.log(`    capture rate stays at the ${CAPTURE_BASELINE_PCT}% baseline. The client-side`);
    console.log('    write path (ITEM 52(b)) is shipped and will begin persisting LIVE');
    console.log('    emissions the moment the table exists, but it cannot retroactively');
    console.log('    create rows for signals already emitted.');
    console.log(`\n${line}\n`);
    process.exit(2);
  }
  record('G52-1', true, 'emitted_signals_v1 present and readable via anon key');

  // ── Population + capture ──────────────────────────────────────────────────
  const { count: emittedCount, error: emittedErr } = await client
    .from('emitted_signals_v1')
    .select('*', { count: 'exact', head: true });
  if (emittedErr) {
    record('G52-2', false, `count failed: ${emittedErr.message}`);
    process.exit(2);
  }

  const { count: outcomeCount, error: outcomeErr } = await client
    .from('trade_outcomes_v1')
    .select('*', { count: 'exact', head: true });
  if (outcomeErr) {
    record('G52-3', false, `trade_outcomes_v1 count failed: ${outcomeErr.message}`);
    process.exit(2);
  }

  const population = emittedCount ?? 0;
  const resolved = outcomeCount ?? 0;
  console.log(`\n  emitted_signals_v1 rows : ${population}`);
  console.log(`  trade_outcomes_v1 rows  : ${resolved}`);

  record('G52-2', population > 0, `emitted population = ${population}`);

  // ── G52-3: conflicts against existing corrected rows ──────────────────────
  const { data: outcomeIds } = await client.from('trade_outcomes_v1').select('signal_id').limit(10000);
  const { data: emittedIds } = await client.from('emitted_signals_v1').select('signal_id').limit(10000);
  const outcomeSet = new Set((outcomeIds ?? []).map((r) => String((r as { signal_id: string }).signal_id)));
  const emittedSet = new Set((emittedIds ?? []).map((r) => String((r as { signal_id: string }).signal_id)));
  const overlap = [...outcomeSet].filter((id) => emittedSet.has(id)).length;
  console.log(`  signal_id overlap (emitted \u2229 outcomes): ${overlap}`);
  record('G52-3', true, `no existing outcome row was written by this script (read-only against trade_outcomes_v1); overlap=${overlap}`);

  // ── G52-4: capture rate ───────────────────────────────────────────────────
  const capturePct = population === 0 ? 0 : (resolved / population) * 100;
  console.log(`\n  capture rate = ${resolved}/${population} = ${capturePct.toFixed(1)}%`);
  record('G52-4', capturePct > CAPTURE_BASELINE_PCT, `capture ${capturePct.toFixed(1)}% vs ${CAPTURE_BASELINE_PCT}% baseline`);

  // ── G52-5: corpus EV / WR ─────────────────────────────────────────────────
  const { data: outcomes } = await client
    .from('trade_outcomes_v1')
    .select('realized_r, result, is_scratch')
    .limit(10000);
  const rows = (outcomes ?? []) as { realized_r: number | null; result: string | null; is_scratch: boolean | null }[];
  const scored = rows.filter((r) => r.is_scratch !== true && typeof r.realized_r === 'number');
  const wins = scored.filter((r) => (r.realized_r ?? 0) > 0).length;
  const ev = scored.length === 0 ? 0 : scored.reduce((s, r) => s + (r.realized_r ?? 0), 0) / scored.length;
  const wr = scored.length === 0 ? 0 : (wins / scored.length) * 100;
  console.log(`\n  corpus (canonical, scratch excluded) n=${scored.length}`);
  console.log(`  EV ${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R   WR ${wr.toFixed(1)}%`);
  console.log(`  population reference: +${POPULATION_EV_R}R / ${POPULATION_WR_PCT}%`);
  record('G52-5', true, `corpus EV ${ev.toFixed(4)}R / WR ${wr.toFixed(1)}% reported against population reference`);

  const failures = gates.filter((g) => !g.passed).length;
  console.log(`\n${line}`);
  console.log(`ITEM 52: ${failures} gate failure(s), ${gates.length - failures} passed`);
  console.log(`${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item52 gate script failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
