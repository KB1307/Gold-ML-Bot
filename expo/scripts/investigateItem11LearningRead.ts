/**
 * ITEM 11 — learning.getOutcomes: a BACKEND-DEPENDENT READ feeding the learning
 * corpus -> model weights -> SECTION 2.
 *
 * INVESTIGATE ONLY. No production file is modified by this script.
 *
 * (a) what actually happens on a 503 — probed against the LIVE backend
 * (b) whether current model_weights_v1 values could come from a truncated corpus
 * (c) the sizes involved, so the repoint proposal is derived not assumed
 *
 * Usage: bun run scripts/investigateItem11LearningRead.ts
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const API = (process.env.EXPO_PUBLIC_RORK_API_BASE_URL ?? '').replace(/\/$/, '');
const FUNCS = (process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL ?? '').replace(/\/$/, '');

const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

async function probe(origin: string, n: number): Promise<{ statuses: number[]; sample: string }> {
  const statuses: number[] = [];
  let sample = '';
  const input = encodeURIComponent(JSON.stringify({ json: { limit: 300 } }));
  for (let i = 0; i < n; i += 1) {
    try {
      const r = await fetch(`${origin}/api/trpc/learning.getOutcomes?input=${input}`, {
        headers: { 'x-trpc-source': 'item11-probe' },
      });
      statuses.push(r.status);
      if (!sample) sample = (await r.text()).slice(0, 240);
    } catch {
      statuses.push(0);
    }
  }
  return { statuses, sample };
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ITEM 11 — learning.getOutcomes ON THE 503-PRONE BACKEND');
  console.log('  INVESTIGATE ONLY. Nothing implemented.');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── (a) LIVE availability of the read path ────────────────────────────────
  console.log('── (a) LIVE probe of the backend read path ──');
  for (const [label, origin] of [['API_BASE_URL', API], ['FUNCTIONS_URL', FUNCS]] as const) {
    if (!origin) {
      console.log(`  ${label}: not configured`);
      continue;
    }
    const { statuses, sample } = await probe(origin, 12);
    const ok = statuses.filter((s) => s === 200).length;
    console.log(`  ${label} ${origin}`);
    console.log(`    statuses: ${statuses.join(' ')}`);
    console.log(`    200: ${ok}/12   non-200: ${12 - ok}/12`);
    console.log(`    first body: ${sample.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  // ── (b) how big is the durable corpus, and what does the 300-row pull miss ─
  console.log('\n── (b) trade_outcomes_v1: size and pull-window coverage ──');
  const { count: total, error: cErr } = await svc
    .from('trade_outcomes_v1')
    .select('signal_id', { count: 'exact', head: true });
  if (cErr) {
    console.log(`  service-key count FAILED: ${cErr.message}`);
  } else {
    console.log(`  rows (service key, count exact): ${total}`);
  }

  const { count: anonCount, error: aErr } = await anon
    .from('trade_outcomes_v1')
    .select('signal_id', { count: 'exact', head: true });
  console.log(`  rows visible to ANON (RLS SELECT): ${aErr ? `ERROR ${aErr.message}` : anonCount}`);

  const { data: rows, error: rErr } = await svc
    .from('trade_outcomes_v1')
    .select('signal_id, ts, direction, result, realized_r, confidence, feature_schema_version')
    .order('ts', { ascending: false })
    .limit(1000);
  if (rErr) {
    console.log(`  row fetch FAILED: ${rErr.message}`);
  } else {
    const list = rows ?? [];
    console.log(`  fetched: ${list.length}`);
    if (list.length > 0) {
      console.log(`  newest ts: ${String(list[0].ts)}`);
      console.log(`  oldest ts (of fetched): ${String(list[list.length - 1].ts)}`);
      const byResult = new Map<string, number>();
      const byDir = new Map<string, number>();
      const bySchema = new Map<string, number>();
      for (const r of list) {
        byResult.set(String(r.result), (byResult.get(String(r.result)) ?? 0) + 1);
        byDir.set(String(r.direction), (byDir.get(String(r.direction)) ?? 0) + 1);
        bySchema.set(String(r.feature_schema_version), (bySchema.get(String(r.feature_schema_version)) ?? 0) + 1);
      }
      console.log(`  result mix:   ${[...byResult.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
      console.log(`  direction:    ${[...byDir.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);
      console.log(`  featureSchema:${[...bySchema.entries()].map(([k, v]) => `v${k}=${v}`).join(' ')}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  END — investigation only.');
  console.log('═══════════════════════════════════════════════════════════════════');
}

void main();
