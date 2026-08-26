/**
 * ITEM 225 / B3 support — print the FULL persisted outbox alert for the orphan
 * emissions, so the recoverability verdict rests on the whole payload rather
 * than a truncated console line. Read-only.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const ORPHANS = [
  'signal_1787083581937_xr6mjtadq',
  'signal_1787580401459_cpid69ppf',
  'signal_1787587872040_446kz8aab',
];

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const l of readFileSync('.env', 'utf8').split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  const client = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL ?? '',
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await client
    .from('telegram_outbox_v1')
    .select('signal_id, kind, created_at, message')
    .in('signal_id', ORPHANS)
    .order('created_at', { ascending: true });
  if (error) { console.error(`BLOCKER: ${error.message}`); process.exit(1); }
  for (const r of (data ?? []) as { signal_id: string; kind: string; created_at: string; message: string }[]) {
    console.log(`\n===== ${r.signal_id}  kind=${r.kind}  created_at=${r.created_at}`);
    console.log(r.message);
  }
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
