import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const env: Record<string,string> = {};
for (const line of readFileSync('.env','utf8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq < 0) continue;
  env[t.slice(0,eq)] = t.slice(eq+1).replace(/^["']|["']$/g,'');
}
async function main(): Promise<void> {
  const c = createClient(env.EXPO_PUBLIC_SUPABASE_URL!, env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth:{autoRefreshToken:false,persistSession:false} });
  const { data, error } = await c.from('trade_outcomes_v1').select('signal_id, ts, result, realized_r, is_scratch');
  if (error) { console.error(error.message); process.exit(1); }
  const rows = data ?? [];
  const counts = new Map<string,number>();
  for (const r of rows) counts.set(r.result ?? 'NULL', (counts.get(r.result ?? 'NULL') ?? 0) + 1);
  console.log('n =', rows.length);
  for (const [k,v] of [...counts.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);
  const today = rows.filter(r => Date.parse(r.ts) >= Date.parse('2026-08-25T22:00:00Z'));
  for (const r of today) console.log(`  TODAY ${r.ts} ${r.signal_id} result=${r.result} r=${r.realized_r} scratch=${r.is_scratch}`);
}
main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
