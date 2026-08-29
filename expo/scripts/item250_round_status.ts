/**
 * ITEM DD — ROUND STATUS, LIVE (read-only; anon key ONLY; no service role).
 * DD.1 annotation columns on the newest emissions (m15_*, retype_verdict_would_change).
 * DD.2 BAND_VETO_SUPPRESSED rows (STRICT candidate_name equality) -> P.3 count toward n=30.
 * DD.3 funnel counters from the diagnostics bucket's latest real export (best effort here).
 * DD.4 build marker (needs an on-device export after a rebuild — stated if unavailable).
 * DD.5 emitted / outcomes counts; B.3 decided-pair count toward 1,041.
 * PLUS: EXIT_SHADOW_LADDER count (STRICT equality) — must stay isolated from DD.2.
 */
import { createClient } from '@supabase/supabase-js';

interface Ann { signal_id: string; emitted_at: string; m15_opposed: boolean | null; m15_endorsed: boolean | null; retype_verdict_would_change: boolean | null }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM DD — ROUND STATUS (read-only, anon key)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);

  // ── DD.1 ──
  console.log('\nDD.1 — annotation columns on the newest emissions');
  const { data: newest, error: e1 } = await client.from('emitted_signals_v1')
    .select('signal_id,emitted_at,m15_opposed,m15_endorsed,retype_verdict_would_change')
    .order('emitted_at', { ascending: false }).limit(5);
  if (e1) {
    if (/does not exist|PGRST204|42703/i.test(e1.message)) console.log(`  BLOCKED-ON-APPLY residual: ${e1.message}`);
    else console.log(`  ERROR: ${e1.message}`);
  } else {
    const rows = (newest ?? []) as Ann[];
    for (const r of rows) console.log(`  ${r.emitted_at} m15_opposed=${r.m15_opposed} m15_endorsed=${r.m15_endorsed} retype=${r.retype_verdict_would_change}`);
    const anyPopulated = rows.some(r => r.m15_opposed !== null || r.retype_verdict_would_change !== null);
    console.log(anyPopulated
      ? '  -> first annotated emission FOUND (closes S.1/Q live-row proofs).'
      : '  BLOCKED-ON-MARKET: no emission has run the annotation code yet (market closed; newest rows predate 018/019 application).');
  }

  // ── DD.2 + EXIT_SHADOW_LADDER isolation ──
  console.log('\nDD.2 — BAND_VETO_SUPPRESSED shadow rows (P.3 abort gate; STRICT candidate_name equality)');
  const { count: suppCount, error: e2 } = await client.from('shadow_candidates_v1').select('evaluated_at', { count: 'exact', head: true }).eq('candidate_name', 'BAND_VETO_SUPPRESSED');
  if (e2) console.log(`  ERROR: ${e2.message}`);
  else {
    console.log(`  count = ${suppCount ?? 0} toward P.3 n=30 (filter: candidate_name = 'BAND_VETO_SUPPRESSED' AND NOTHING broader)`);
    const { data: lastSup, error: e2b } = await client.from('shadow_candidates_v1').select('evaluated_at,direction,entry,inputs').eq('candidate_name', 'BAND_VETO_SUPPRESSED').order('evaluated_at', { ascending: false }).limit(1);
    if (e2b) console.log(`  ERROR: ${e2b.message}`);
    else if (lastSup && lastSup.length > 0) console.log(`  newest row: ${JSON.stringify(lastSup[0]).slice(0, 400)}`);
    else console.log('  NO BAND_VETO_SUPPRESSED row yet — BLOCKED-ON-MARKET (no vetoed candidate since the veto shipped).');
  }
  const { count: ladCount, error: e2c } = await client.from('shadow_candidates_v1').select('evaluated_at', { count: 'exact', head: true }).eq('candidate_name', 'EXIT_SHADOW_LADDER');
  if (e2c) console.log(`  EXIT_SHADOW_LADDER count ERROR: ${e2c.message}`);
  else console.log(`  EXIT_SHADOW_LADDER rows (exit promotion gate, n of 60): ${ladCount ?? 0} — isolation verified: counted with the STRICT opposite filter.`);

  // ── DD.3 — funnel counters from the diagnostics bucket's latest real export ──
  console.log('\nDD.3 — funnel counters from a REAL diagnostics export (storage bucket, public object)');
  try {
    const base = process.env.EXPO_PUBLIC_SUPABASE_URL!.replace(/\/$/, '');
    const res = await fetch(`${base}/storage/v1/object/public/diagnostics/latest.txt`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const m = text.match(/generated[^\n]*|\bsuppressed\b[^\n]*|\bemitted\b[^\n]*/gi) ?? [];
    console.log(`  fetched latest.txt (${text.length} bytes); funnel-relevant lines:`);
    for (const l of m.slice(0, 12)) console.log(`    ${l.trim().slice(0, 160)}`);
  } catch (err: unknown) {
    console.log(`  BLOCKED (no export reachable from this sandbox): ${err instanceof Error ? err.message : String(err)}`);
    console.log('  The funnel invariant (generated == emitted + suppressed) must be read from an on-device export — DD.3 stays BLOCKED-ON-REBUILD/MARKET for this round.');
  }

  // ── DD.4 — build marker ──
  console.log('\nDD.4 — build marker: BLOCKED-ON-REBUILD. babel.config.js is restored at the working tree');
  console.log('  (EE.2, guard EXIT=0), but no on-device export exists from a bundle built AFTER the');
  console.log('  restoration — until one does, any export would print the pre-restore placeholders.');

  // ── DD.5 — counts ──
  console.log('\nDD.5 — corpus counts');
  const { count: emitted, error: e5a } = await client.from('emitted_signals_v1').select('signal_id', { count: 'exact', head: true });
  const { count: outcomes, error: e5b } = await client.from('trade_outcomes_v1').select('signal_id', { count: 'exact', head: true });
  console.log(`  emitted_signals_v1: ${e5a ? 'ERROR ' + e5a.message : emitted}`);
  console.log(`  trade_outcomes_v1:  ${e5b ? 'ERROR ' + e5b.message : outcomes}`);
  if (!e5b && outcomes !== null) {
    const decided = outcomes ?? 0;
    console.log(`  B.3 decided-pair count proxy: ${decided} of the required 1,041 (${(100 * decided / 1041).toFixed(1)}%)`);
    console.log('  (proxy = resolved outcome rows; the B.3 gate counts decided PAIRS — item233 basis — so this is an upper bound, stated as such.)');
  }
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
