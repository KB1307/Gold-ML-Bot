/**
 * ITEM S + Q + P LIVE STATUS (read-only; anon key only).
 * S.1: first live emission with M15 annotation fields populated (019 applied).
 * S.2: B.3 pair counts (emitted / outcomes).
 * S.3: observed band-rule fire rate among populated rows.
 * Q:   retype_verdict_would_change column existence / population (018 status).
 * P:   shadow_candidates_v1 row count (BAND_VETO_SUPPRESSED).
 */
import { createClient } from '@supabase/supabase-js';

const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

async function main(): Promise<void> {
  console.log('===== ITEM S — ROUND STATUS (live queries, anon key) =====');
  console.log(`run at: ${new Date().toISOString()}`);

  // S.2 — pair counts
  const { count: emitted } = await client.from('emitted_signals_v1').select('signal_id', { count: 'exact', head: true });
  const { count: outcomes } = await client.from('trade_outcomes_v1').select('signal_id', { count: 'exact', head: true });
  console.log(`S.2 B.3 pairs: emitted=${emitted} outcomes=${outcomes}`);

  // S.1 — first M15-annotated row
  const { data: m15, error: m15err } = await client.from('emitted_signals_v1')
    .select('signal_id,emitted_at,direction,entry,m15_opposed,m15_endorsed,m15_zone_context')
    .not('m15_opposed', 'is', null)
    .order('emitted_at', { ascending: false })
    .limit(3);
  if (m15err) console.log(`S.1 query error: ${m15err.message}`);
  if (m15 && m15.length > 0) {
    console.log('S.1 M15-annotated live rows (newest first):');
    for (const r of m15) console.log(`  ${JSON.stringify(r)}`);
  } else {
    console.log('S.1: no row with m15_opposed populated yet -> BLOCKED-ON-EMISSION (the annotation ships with this round\'s code; the next real emission annotates)');
  }

  // S.3 — band rule fire rate
  const { data: bv } = await client.from('emitted_signals_v1').select('band_veto_would_fire');
  const populated = (bv ?? []).filter((r: { band_veto_would_fire: unknown }) => r.band_veto_would_fire !== null && r.band_veto_would_fire !== undefined);
  const fired = populated.filter((r: { band_veto_would_fire: unknown }) => r.band_veto_would_fire === true);
  console.log(`S.3 band_veto_would_fire: populated=${populated.length} fired=${fired.length} rate=${populated.length ? ((100 * fired.length / populated.length)).toFixed(1) + '%' : 'n/a'}`);

  // Q — column status
  const { data: q, error: qerr } = await client.from('emitted_signals_v1').select('signal_id,retype_verdict_would_change').limit(1);
  if (qerr) console.log(`Q live check: ERROR -> ${qerr.message} -> migration 018 NOT YET APPLIED (write-site self-heal strips the field until then)`);
  else console.log(`Q live check: column EXISTS; sample=${JSON.stringify(q)}`);

  // P — shadow count
  const { count: sh } = await client.from('shadow_candidates_v1').select('id', { count: 'exact', head: true });
  console.log(`P shadow_candidates_v1 rows=${sh ?? 'query-failed'}`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
