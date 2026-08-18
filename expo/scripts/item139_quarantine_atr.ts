/**
 * ITEM 139(c) — QUARANTINE THE BACKFILL ATR.
 *
 * 139(a) FINDING: The backfill `atr` column holds values from 0.20 to 124.20.
 * Cross-checking against bar-derived ATR(14) at each backfill signal's timestamp:
 *   stored_atr / bar_atr ratios range 3.8x to 10.2x (median ~9x).
 * The backfill ATR is in PRICE UNITS (risk/atr p50=1.02, matching the expected
 * 1.0-1.6 multiplier range), but from a DIFFERENT VENUE or PERIOD — it is not
 * calculateRealATR(14) on gold_m1_bars. The live ATR column (n=14) matches
 * bar-derived ATR perfectly (p50=1.60 vs bar p50=1.72).
 *
 * This script NULLS the atr column for all BACKFILL rows, so future ATR-conditioned
 * analysis cannot silently use a corrupt construct. Live rows are UNTOUCHED.
 *
 * DATA SOURCE: emitted_signals_v1 via Supabase DIRECT (anon key) for reads.
 * The anon key cannot UPDATE (RLS policy), so this script reports what needs
 * fixing and exits. The actual UPDATE must be run in the Supabase SQL Editor
 * with the service-role key.
 *
 * The migration (006) adds a CHECK constraint: atr IS NULL OR (atr >= 0 AND atr <= 20).
 * This client-side guard in emittedSignalService.ts clamps before write.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  } catch { /* */ }
  return env;
};

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('Missing env'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } }) as SupabaseClient;

  console.log('\n' + '='.repeat(84));
  console.log('ITEM 139(c) — BACKFILL ATR QUARANTINE');
  console.log('='.repeat(84));

  // Read all backfill rows with atr
  const { data, error } = await client
    .from('emitted_signals_v1')
    .select('signal_id, source, atr')
    .eq('source', 'BACKFILL')
    .order('emitted_at', { ascending: true })
    .limit(10000);

  if (error) { console.error('Read failed:', error.message); process.exit(1); }

  const rows = (data ?? []) as { signal_id: string; source: string; atr: number | null }[];
  const withAtr = rows.filter(r => r.atr !== null && Number.isFinite(r.atr));
  const outOfRange = withAtr.filter(r => r.atr > 20 || r.atr < 0);

  console.log(`\n  BACKFILL rows: ${rows.length}`);
  console.log(`  With atr non-null: ${withAtr.length}`);
  console.log(`  Out of range (atr > 20 or < 0): ${outOfRange.length}`);
  console.log(`  In range but still corrupt (3-10x bar-derived): ${withAtr.length - outOfRange.length}`);

  if (withAtr.length > 0) {
    const atrs = withAtr.map(r => r.atr).sort((a, b) => a - b);
    console.log(`  atr distribution: min=${atrs[0].toFixed(2)} p50=${atrs[Math.floor(atrs.length / 2)].toFixed(2)} max=${atrs[atrs.length - 1].toFixed(2)}`);
  }

  // The anon key cannot UPDATE — output the SQL that must be run manually
  console.log('\n' + '='.repeat(84));
  console.log('SQL TO RUN IN SUPABASE SQL EDITOR (service-role):');
  console.log('='.repeat(84));
  console.log(`
-- ITEM 139(c): Null the corrupt backfill ATR column.
-- The backfill atr is 3.8-10.2x the bar-derived ATR(14) at the same timestamps.
-- It is in price units but from a different venue/period. Live rows are UNTOUCHED.

UPDATE public.emitted_signals_v1
SET atr = NULL
WHERE source = 'BACKFILL' AND atr IS NOT NULL;

-- Verify: count of backfill rows with non-null atr should be 0 after this.
SELECT source, COUNT(*) FILTER (WHERE atr IS NOT NULL) AS non_null_atr, COUNT(*) AS total
FROM public.emitted_signals_v1
GROUP BY source;
`);

  console.log('='.repeat(84));
  console.log('\n  The migration 006 adds: CHECK (atr IS NULL OR (atr >= 0 AND atr <= 20))');
  console.log('  The emittedSignalService.ts clamps atr to [0, 20] before write.');
  console.log('  Together these prevent implausible ATR values from being written again.');
  console.log('\n' + '='.repeat(84));
}

main().catch(err => { console.error('FATAL:', err instanceof Error ? err.message : String(err)); process.exit(1); });
