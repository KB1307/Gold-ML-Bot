/**
 * ITEM 28/29 SUPPORT SCRIPT — READ-ONLY.
 *
 * 1. Fetches the live diagnostics export artifact (Supabase Storage, anon key)
 *    to /tmp/diagnostics_export.txt so the report can quote real rows.
 * 2. Probes every place a REAL bid/ask spread could be durably recorded, and
 *    prints exactly what each one holds. This is the POWER statement for the
 *    cost question: if no store holds a spread, the answer is "no record
 *    exists", not an estimate.
 *
 * DATA-SOURCE RULE: gold_m1_bars / sr_zones_v1 / trade_outcomes_v1 are read
 * DIRECT from Supabase with the anon key. No Rork backend on any read path.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch {
      // optional file
    }
  }
  return out;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.log('BLOCKER: Supabase URL/anon key not present in env — cannot read anything DIRECT.');
    return;
  }
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };

  // ---- 1. export artifact ----
  for (const path of [
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
    '/storage/v1/object/public/diagnostics/latest.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    console.log(`EXPORT ${path} -> HTTP ${res.status}`);
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      const gen = /Generated:\s*(\S+)/.exec(text)?.[1] ?? 'unknown';
      console.log(`  bytes=${text.length}  Generated=${gen}`);
      break;
    }
  }

  // ---- 2. spread-record probes ----
  console.log('\n=== SPREAD RECORD PROBES (does ANY durable store hold bid/ask?) ===');

  // 2a. gold_m1_bars column inventory — does the bar row carry bid/ask at all?
  const barRes = await fetch(`${url}/rest/v1/gold_m1_bars?select=*&limit=1`, { headers: h });
  if (barRes.ok) {
    const rows = (await barRes.json()) as Record<string, unknown>[];
    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    console.log(`gold_m1_bars columns: ${cols.join(', ') || '(empty table)'}`);
    const spreadish = cols.filter((c) => /bid|ask|spread/i.test(c));
    console.log(`  columns matching /bid|ask|spread/: ${spreadish.length > 0 ? spreadish.join(', ') : 'NONE'}`);
  } else {
    console.log(`gold_m1_bars probe -> HTTP ${barRes.status}`);
  }

  // 2b. trade_outcomes_v1 features jsonb — does any persisted feature vector carry a spread?
  const outRes = await fetch(
    `${url}/rest/v1/trade_outcomes_v1?select=id,features&order=id.desc&limit=200`,
    { headers: h },
  );
  if (outRes.ok) {
    const rows = (await outRes.json()) as { id: unknown; features: Record<string, unknown> | null }[];
    const keys = new Set<string>();
    rows.forEach((r) => {
      if (r.features) Object.keys(r.features).forEach((k) => keys.add(k));
    });
    const spreadKeys = [...keys].filter((k) => /bid|ask|spread|cost|slippage/i.test(k));
    console.log(`trade_outcomes_v1 rows sampled: ${rows.length}, distinct feature keys: ${keys.size}`);
    console.log(`  feature keys matching /bid|ask|spread|cost|slippage/: ${spreadKeys.length > 0 ? spreadKeys.join(', ') : 'NONE'}`);
  } else {
    console.log(`trade_outcomes_v1 probe -> HTTP ${outRes.status}`);
  }

  // 2c. shadow_signals_v1 — the other durable per-signal table.
  const shRes = await fetch(`${url}/rest/v1/shadow_signals_v1?select=*&limit=1`, { headers: h });
  if (shRes.ok) {
    const rows = (await shRes.json()) as Record<string, unknown>[];
    const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
    console.log(`shadow_signals_v1 columns: ${cols.join(', ') || '(empty table)'}`);
    console.log(`  columns matching /bid|ask|spread/: ${cols.filter((c) => /bid|ask|spread/i.test(c)).join(', ') || 'NONE'}`);
  } else {
    console.log(`shadow_signals_v1 probe -> HTTP ${shRes.status}`);
  }

  // 2d. table inventory — is there ANY table whose name suggests a quote/spread log?
  const rootRes = await fetch(`${url}/rest/v1/`, { headers: h });
  if (rootRes.ok) {
    const spec = (await rootRes.json()) as { paths?: Record<string, unknown> };
    const tables = Object.keys(spec.paths ?? {})
      .filter((p) => p !== '/' && !p.startsWith('/rpc/'))
      .map((p) => p.replace(/^\//, ''));
    console.log(`REST-exposed tables (${tables.length}): ${tables.join(', ')}`);
    console.log(`  tables matching /quote|spread|tick|bid|ask|cost/: ${tables.filter((t) => /quote|spread|tick|bid|ask|cost/i.test(t)).join(', ') || 'NONE'}`);
  } else {
    console.log(`table inventory probe -> HTTP ${rootRes.status}`);
  }

  // 2e. export artifact text — is a spread printed anywhere in the diagnostics?
  try {
    const text = readFileSync('/tmp/diagnostics_export.txt', 'utf8');
    const hits = text.split('\n').filter((l) => /spread|bid|ask/i.test(l));
    console.log(`export lines mentioning spread/bid/ask: ${hits.length}`);
    hits.slice(0, 10).forEach((l) => console.log(`  ${l.trim()}`));
  } catch {
    console.log('export not on disk — skipped text probe');
  }
}

main().catch((err: unknown) => {
  console.error('FATAL', err instanceof Error ? err.message : String(err));
});
