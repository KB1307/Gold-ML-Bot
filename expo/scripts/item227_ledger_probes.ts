/**
 * ITEM 227 / CHECKPOINT D support — the two things D cannot assert without asking
 * the live system:
 *   D2-BLOCKED  Item 123's blocker: is the Item 139(c) impossible-ATR contamination
 *               still present in emitted_signals_v1.atr, by SOURCE?
 *   D3/D4       the ACTUAL accrual rate of resolvable LIVE outcomes, which sets the
 *               era-mean test date. Measured, not assumed at "~12/week".
 * Read-only.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const SNAPSHOT_ERA_START_MS = Date.parse('2026-07-16T10:51:28.481Z');
/** C1's exact OB removal instant (commit 68cc662). */
const OB_REMOVAL_MS = Date.parse('2026-08-24T16:55:33Z');
/** Item 139(c): 1-min gold ATR above this is physically implausible. */
const ATR_PLAUSIBLE_MAX = 20;

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n${line}`);
  console.log('ITEM 227 / D SUPPORT PROBES (live)');
  console.log(line);
  console.log(`  run at : ${new Date().toISOString()}`);

  const { data: emitted, error } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, source, atr')
    .order('emitted_at', { ascending: true });
  if (error) { console.error(`BLOCKER: ${error.message}`); process.exit(1); }
  const rows = (emitted ?? []) as { signal_id: string; emitted_at: string; source: string; atr: number | null }[];

  // ── Item 123 blocker verification ────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('D2/BLOCKED — ITEM 123: is the Item 139(c) impossible-ATR contamination still live?');
  console.log(line);
  console.log(`  Item 139(c) found atr values up to 124.20 in the BACKFILL rows — impossible for 1-min`);
  console.log(`  gold. Item 123 (ATR-conditioned analysis) was blocked on that contamination. The only`);
  console.log(`  way to know whether it is cleared is to ask the live column, BY SOURCE:`);
  const bySource = new Map<string, { n: number; withAtr: number; nullAtr: number; max: number; implausible: number }>();
  for (const r of rows) {
    const s = r.source ?? 'UNKNOWN';
    const cur = bySource.get(s) ?? { n: 0, withAtr: 0, nullAtr: 0, max: -Infinity, implausible: 0 };
    cur.n += 1;
    if (r.atr === null || r.atr === undefined) cur.nullAtr += 1;
    else {
      cur.withAtr += 1;
      const v = Number(r.atr);
      if (v > cur.max) cur.max = v;
      if (v > ATR_PLAUSIBLE_MAX) cur.implausible += 1;
    }
    bySource.set(s, cur);
  }
  let totalImplausible = 0;
  for (const [src, v] of Array.from(bySource.entries()).sort()) {
    totalImplausible += v.implausible;
    console.log(`    source=${src.padEnd(10)} n=${String(v.n).padStart(4)}  atr present=${String(v.withAtr).padStart(4)}  atr NULL=${String(v.nullAtr).padStart(4)}  max atr=${Number.isFinite(v.max) ? v.max.toFixed(2).padStart(7) : '    n/a'}  implausible(>${ATR_PLAUSIBLE_MAX})=${v.implausible}`);
  }
  console.log(`\n  TOTAL implausible atr rows live: ${totalImplausible}`);
  const liveWithAtr = rows.filter(r => r.source === 'LIVE' && r.atr !== null && r.atr !== undefined);
  console.log(`  LIVE rows carrying a usable atr : ${liveWithAtr.length}`);
  if (totalImplausible === 0) {
    console.log(`  VERDICT: the contamination is GONE from the live table. Item 123's stated blocker no`);
    console.log(`  longer exists. Whether Item 123 is now DOABLE is a separate question of POWER: it needs`);
    console.log(`  enough LIVE rows with a usable atr to bucket, and that count is printed above.`);
  } else {
    console.log(`  VERDICT: contamination REMAINS (${totalImplausible} rows). Item 123 stays BLOCKED, and the`);
    console.log(`  blocker is now quantified rather than remembered.`);
  }

  // ── D3/D4 accrual rate ───────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('D3/D4 — MEASURED ACCRUAL RATE OF RESOLVABLE LIVE OUTCOMES (sets the era-mean test date)');
  console.log(line);
  const { data: outcomes, error: oErr } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, ts, realized_r, is_scratch')
    .limit(10000);
  if (oErr) { console.error(`BLOCKER: ${oErr.message}`); process.exit(1); }
  const outMap = new Map<string, { ts: string; realized_r: number | null; is_scratch: boolean | null }>();
  for (const o of (outcomes ?? []) as { signal_id: string; ts: string; realized_r: number | null; is_scratch: boolean | null }[]) {
    outMap.set(o.signal_id, o);
  }
  const postBoundaryLive = rows.filter(r => r.source === 'LIVE' && Date.parse(r.emitted_at) >= SNAPSHOT_ERA_START_MS);
  const decidable = postBoundaryLive.filter(r => {
    const o = outMap.get(r.signal_id);
    return o !== undefined && o.realized_r !== null && o.is_scratch !== true;
  });
  console.log(`  era boundary                       : ${new Date(SNAPSHOT_ERA_START_MS).toISOString()}`);
  console.log(`  post-boundary LIVE emissions       : ${postBoundaryLive.length}`);
  console.log(`  of those, RESOLVED non-scratch     : ${decidable.length}  <- the era-mean test's n`);

  // Weekly accrual over the last 28 days, and separately since the OB removal.
  const nowMs = Date.now();
  const last28 = decidable.filter(r => {
    const o = outMap.get(r.signal_id);
    return o ? nowMs - Date.parse(o.ts) <= 28 * 86_400_000 : false;
  });
  const sinceOb = decidable.filter(r => Date.parse(r.emitted_at) >= OB_REMOVAL_MS);
  const obDays = (nowMs - OB_REMOVAL_MS) / 86_400_000;
  console.log(`\n  resolved outcomes in the last 28 days : ${last28.length}  -> ${(last28.length / 4).toFixed(2)} per week (the PRE-removal-dominated rate)`);
  console.log(`  resolved outcomes since OB removal    : ${sinceOb.length} over ${obDays.toFixed(3)} days`);
  console.log(`                                        -> ${(sinceOb.length / obDays).toFixed(2)} per day = ${((sinceOb.length / obDays) * 7).toFixed(2)} per week (the POST-removal rate)`);
  const perWeekOld = last28.length / 4;
  const perWeekNew = (sinceOb.length / obDays) * 7;
  for (const target of [49, 60]) {
    const need = Math.max(0, target - decidable.length);
    const wOld = perWeekOld > 0 ? need / perWeekOld : Infinity;
    const wNew = perWeekNew > 0 ? need / perWeekNew : Infinity;
    console.log(`\n  to reach n=${target}: need ${need} more resolved LIVE outcomes`);
    console.log(`    at the OLD ${perWeekOld.toFixed(2)}/wk rate : ${Number.isFinite(wOld) ? `${wOld.toFixed(2)} weeks -> ${new Date(nowMs + wOld * 7 * 86_400_000).toISOString().slice(0, 10)}` : 'never at this rate'}`);
    console.log(`    at the NEW ${perWeekNew.toFixed(2)}/wk rate : ${Number.isFinite(wNew) ? `${wNew.toFixed(2)} weeks -> ${new Date(nowMs + wNew * 7 * 86_400_000).toISOString().slice(0, 10)}` : 'never at this rate'}`);
  }
  console.log(`\nDONE (read-only).\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
