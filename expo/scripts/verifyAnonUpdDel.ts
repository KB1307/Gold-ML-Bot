/**
 * Sharp anon UPDATE/DELETE test — inserts a REAL row via service role, then
 * attempts anon UPDATE and DELETE against that exact row, and reads back to
 * confirm whether the row was actually modified/deleted.
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

const svc = createClient(URL, SVC, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

const row = {
  signal_id: `recon-upddel-${Date.now()}`,
  created_at: new Date().toISOString(),
  direction: 'SELL' as const,
  entry: 4050.0, sl: 3980.0, tp1: 4020.0, tp2: 3990.0, tp3: 3960.0, confidence: 0.75,
  entry_shifted: 4090.0, sl_shifted: 4020.0, tp1_shifted: 4060.0, tp2_shifted: 4030.0, tp3_shifted: 4000.0,
  sl_multiplier: 1.4, atr: 1.2, regime: 'TRENDING', session_name: 'LONDON', hour_utc: new Date().getUTCHours(),
  sr_zones_snapshot: { t: true } as Record<string, unknown>, attention_scores: { s: 1 } as Record<string, unknown>,
  htf_trend: 'BEARISH' as const, ltf_trend: 'BEARISH' as const, rsi: 42.5,
};

async function main() {
  // Insert a real row via service role
  const { data: ins, error: insErr } = await svc.from('shadow_signals_v1').insert(row).select('id, signal_id, entry').single();
  if (insErr) { console.error('insert failed', insErr.message); process.exit(1); }
  console.log(`Inserted real row: id=${ins.id} signal_id=${ins.signal_id} entry=${ins.entry}`);

  // ── ANON UPDATE against the real row ──
  console.log('\n── ANON UPDATE against real row (try to set entry=9999.0) ──');
  const { error: updErr } = await anon.from('shadow_signals_v1').update({ entry: 9999.0 }).eq('signal_id', row.signal_id);
  if (updErr) {
    console.log(`  ✅ BLOCKED: ${updErr.message}`);
  } else {
    console.log('  No error returned — checking if row was actually changed...');
  }
  const { data: rb } = await svc.from('shadow_signals_v1').select('entry').eq('signal_id', row.signal_id).single();
  console.log(`  Read-back entry=${rb?.entry} (original=4050.0, anon tried to set 9999.0)`);
  if (Number(rb?.entry) === 9999) { console.log('  ❌ ANON UPDATE SUCCEEDED — row was modified!'); }
  else { console.log('  ✅ ANON UPDATE had no effect — row unchanged (RLS blocked the write).'); }

  // ── ANON DELETE against the real row ──
  console.log('\n── ANON DELETE against real row ──');
  const { error: delErr } = await anon.from('shadow_signals_v1').delete().eq('signal_id', row.signal_id);
  if (delErr) {
    console.log(`  ✅ BLOCKED: ${delErr.message}`);
  } else {
    console.log('  No error returned — checking if row was actually deleted...');
  }
  const { data: rb2 } = await svc.from('shadow_signals_v1').select('id').eq('signal_id', row.signal_id).maybeSingle();
  if (rb2) { console.log('  ✅ Row still exists — ANON DELETE had no effect (RLS blocked).'); }
  else { console.log('  ❌ ANON DELETE SUCCEEDED — row is gone!'); }

  // Cleanup via service
  await svc.from('shadow_signals_v1').delete().eq('signal_id', row.signal_id);
  console.log('\nCleanup done (service-role delete).');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
