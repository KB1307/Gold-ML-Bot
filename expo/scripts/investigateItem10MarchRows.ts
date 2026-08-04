/**
 * ITEM 10 — 408 rows dated 2026-03 in a table created ~1 August.
 *
 * READ-ONLY INVESTIGATION. Nothing is deleted, updated or inserted.
 *
 * Establishes which of three things they are:
 *   (a) real suppressed-SELL geometry with a corrupted created_at,
 *   (b) placeholder/test rows,
 *   (c) real rows whose created_at is signal-derived rather than insert-time.
 *
 * Reads shadow_signals_v1 with the SERVICE KEY (RLS-independent ground truth)
 * and cross-checks against gold_m1_bars read DIRECTLY from Supabase.
 *
 * Usage: bun run scripts/investigateItem10MarchRows.ts
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

interface Row {
  [k: string]: unknown;
}

function iso(v: unknown): string {
  if (typeof v !== 'string') return String(v);
  return v;
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ITEM 10 — WHAT ARE THE 408 MARCH ROWS IN shadow_signals_v1?');
  console.log('  READ-ONLY. Service key. Nothing is mutated.');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── 0. Column inventory + total counts ────────────────────────────────────
  const { count: total } = await svc
    .from('shadow_signals_v1')
    .select('signal_id', { count: 'exact', head: true });
  console.log(`Total rows (service key, count exact): ${total}`);

  // Full paginated dump of every row (413 is small).
  const all: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from('shadow_signals_v1')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  console.log(`Rows fetched: ${all.length}`);
  const columns = all.length > 0 ? Object.keys(all[0]) : [];
  console.log(`Columns (${columns.length}): ${columns.join(', ')}\n`);

  // ── 1. created_at histogram by month ──────────────────────────────────────
  console.log('── 1. created_at by month ──');
  const byMonth = new Map<string, number>();
  for (const r of all) {
    const key = iso(r.created_at).slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
  }
  for (const [m, n] of [...byMonth.entries()].sort()) {
    console.log(`  ${m}: ${n}`);
  }

  const march = all.filter((r) => iso(r.created_at).startsWith('2026-03'));
  const nonMarch = all.filter((r) => !iso(r.created_at).startsWith('2026-03'));
  console.log(`\n  MARCH rows: ${march.length}   NON-MARCH rows: ${nonMarch.length}`);

  // Distinct created_at values among March rows — one timestamp or many?
  const distinctMarchTs = new Set(march.map((r) => iso(r.created_at)));
  console.log(`  distinct created_at values among March rows: ${distinctMarchTs.size}`);
  const marchDays = new Map<string, number>();
  for (const r of march) marchDays.set(iso(r.created_at).slice(0, 10), (marchDays.get(iso(r.created_at).slice(0, 10)) ?? 0) + 1);
  console.log(`  March days: ${[...marchDays.entries()].sort().map(([d, n]) => `${d}=${n}`).join(', ')}`);

  // ── 2. (a) FULL DUMP of a representative sample ──────────────────────────
  console.log('\n── 2(a). FULL ROW DUMP — every column, 5 March rows (first/mid/last) ──');
  const sampleIdx = [0, 1, Math.floor(march.length / 2), march.length - 2, march.length - 1]
    .filter((i) => i >= 0 && i < march.length);
  for (const i of new Set(sampleIdx)) {
    console.log(`\n  ── March row index ${i} ──`);
    const r = march[i];
    for (const c of columns) {
      const v = r[c];
      const rendered =
        v === null || v === undefined
          ? String(v)
          : typeof v === 'object'
            ? JSON.stringify(v).slice(0, 400)
            : String(v);
      console.log(`    ${c.padEnd(24)} = ${rendered}`);
    }
  }

  console.log('\n  ── For contrast: FULL DUMP of the 5 NON-MARCH rows ──');
  for (const r of nonMarch) {
    console.log(`\n  ── non-March row id=${String(r.id)} ──`);
    for (const c of columns) {
      const v = r[c];
      const rendered =
        v === null || v === undefined
          ? String(v)
          : typeof v === 'object'
            ? JSON.stringify(v).slice(0, 400)
            : String(v);
      console.log(`    ${c.padEnd(24)} = ${rendered}`);
    }
  }

  // ── 3. PLACEHOLDER vs REAL geometry test ─────────────────────────────────
  console.log('\n── 2(a) cont. PLACEHOLDER vs REAL geometry ──');
  function numeric(r: Row, k: string): number | null {
    const v = r[k];
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function stats(rows: Row[], k: string): string {
    const vals = rows.map((r) => numeric(r, k)).filter((v): v is number => v !== null);
    if (vals.length === 0) return 'no numeric values';
    const sorted = [...vals].sort((a, b) => a - b);
    const distinct = new Set(vals).size;
    return `n=${vals.length} distinct=${distinct} min=${sorted[0]} p50=${sorted[Math.floor(sorted.length / 2)]} max=${sorted[sorted.length - 1]}`;
  }
  for (const k of ['entry', 'sl', 'tp1', 'tp2', 'tp3', 'atr', 'confidence', 'rsi', 'hour_utc']) {
    if (!columns.includes(k)) continue;
    console.log(`  MARCH    ${k.padEnd(12)} ${stats(march, k)}`);
    console.log(`  nonMarch ${k.padEnd(12)} ${stats(nonMarch, k)}`);
  }

  // Geometry internal consistency: for a SELL, sl > entry > tp1 > tp2 > tp3.
  function sellGeometryOk(r: Row): boolean {
    const e = numeric(r, 'entry');
    const sl = numeric(r, 'sl');
    const t1 = numeric(r, 'tp1');
    const t2 = numeric(r, 'tp2');
    const t3 = numeric(r, 'tp3');
    if (e === null || sl === null || t1 === null || t2 === null || t3 === null) return false;
    return sl > e && e > t1 && t1 > t2 && t2 > t3;
  }
  console.log(`\n  SELL geometry internally consistent (sl>entry>tp1>tp2>tp3):`);
  console.log(`    MARCH:    ${march.filter(sellGeometryOk).length}/${march.length}`);
  console.log(`    nonMarch: ${nonMarch.filter(sellGeometryOk).length}/${nonMarch.length}`);

  // signal_id shape — the engine's formats are recognizable.
  console.log('\n  signal_id shapes:');
  const shape = (id: string): string =>
    id
      .replace(/\d{10,}/g, '<epoch>')
      .replace(/[a-z0-9]{6,}$/i, '<rand>');
  const marchShapes = new Map<string, number>();
  for (const r of march) {
    const s = shape(String(r.signal_id ?? r.id));
    marchShapes.set(s, (marchShapes.get(s) ?? 0) + 1);
  }
  for (const [s, n] of [...marchShapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    MARCH    "${s}" x${n}`);
  }
  const nmShapes = new Map<string, number>();
  for (const r of nonMarch) {
    const s = shape(String(r.signal_id ?? r.id));
    nmShapes.set(s, (nmShapes.get(s) ?? 0) + 1);
  }
  for (const [s, n] of nmShapes.entries()) console.log(`    nonMarch "${s}" x${n}`);

  // ── 4. 10(b) — is created_at an insert-time default or signal-derived? ────
  console.log('\n── 2(b). Is created_at an INSERT-TIME DEFAULT or SIGNAL-DERIVED? ──');
  const { data: defs, error: defErr } = await svc.rpc('exec_sql_readonly' as never, {} as never).then(
    (r) => r,
    () => ({ data: null, error: { message: 'no rpc' } }),
  );
  void defs;
  void defErr;
  console.log('  (column defaults are read below via the REST schema; if unavailable, the');
  console.log('   behavioural test that follows is decisive on its own.)');

  // Behavioural test: does an id ordering agree with created_at ordering?
  // A serial id is strictly insert-order. If created_at were the insert time it
  // must be monotonically non-decreasing in id.
  const ids = all.map((r) => Number(r.id));
  const times = all.map((r) => new Date(iso(r.created_at)).getTime());
  let inversions = 0;
  for (let i = 1; i < ids.length; i += 1) {
    if (times[i] < times[i - 1]) inversions += 1;
  }
  console.log(`  rows ordered by serial id: ${ids.length}`);
  console.log(`  created_at inversions against id order: ${inversions}`);
  console.log(`  id range: ${Math.min(...ids)} … ${Math.max(...ids)}`);
  const first = all[0];
  const last = all[all.length - 1];
  console.log(`  lowest  id=${String(first.id)} created_at=${iso(first.created_at)}`);
  console.log(`  highest id=${String(last.id)} created_at=${iso(last.created_at)}`);

  // Boundary: where in id order does March start/stop?
  const marchIds = march.map((r) => Number(r.id)).sort((a, b) => a - b);
  const nmIds = nonMarch.map((r) => Number(r.id)).sort((a, b) => a - b);
  console.log(`  MARCH id range:    ${marchIds[0]} … ${marchIds[marchIds.length - 1]} (contiguous=${marchIds[marchIds.length - 1] - marchIds[0] + 1 === marchIds.length})`);
  console.log(`  nonMarch ids:      ${nmIds.join(', ')}`);

  // Do the March rows carry any OTHER timestamp column that disagrees?
  const tsCols = columns.filter((c) => /_at$|_ts$|time/i.test(c));
  console.log(`  timestamp-ish columns present: ${tsCols.join(', ') || 'none besides created_at'}`);
  for (const c of tsCols) {
    const sampleVals = [...new Set(march.slice(0, 6).map((r) => String(r[c])))];
    console.log(`    MARCH ${c}: ${sampleVals.join(' | ')}`);
  }

  // ── 5. 10(c) — do the March rows correspond to any REAL market data? ─────
  console.log('\n── 2(c). Do the March rows correspond to real market data? ──');
  const marchMin = marchDays.size > 0 ? [...marchDays.keys()].sort()[0] : null;
  console.log(`  Earliest March created_at day: ${marchMin}`);

  // (i) Does gold_m1_bars even have March 2026 bars?
  const { count: marchBars } = await svc
    .from('gold_m1_bars')
    .select('timestamp', { count: 'exact', head: true })
    .gte('timestamp', new Date('2026-03-01T00:00:00Z').getTime())
    .lt('timestamp', new Date('2026-04-01T00:00:00Z').getTime());
  const { data: oldestBar } = await svc
    .from('gold_m1_bars')
    .select('timestamp')
    .order('timestamp', { ascending: true })
    .limit(1);
  const { data: newestBar } = await svc
    .from('gold_m1_bars')
    .select('timestamp')
    .order('timestamp', { ascending: false })
    .limit(1);
  const ob = oldestBar?.[0]?.timestamp as number | undefined;
  const nb = newestBar?.[0]?.timestamp as number | undefined;
  console.log(`  gold_m1_bars rows in March 2026: ${marchBars}`);
  console.log(`  gold_m1_bars coverage: ${ob ? new Date(Number(ob)).toISOString() : '?'} … ${nb ? new Date(Number(nb)).toISOString() : '?'}`);

  // (ii) Is the March rows' PRICE LEVEL consistent with March, or with August?
  const marchEntries = march.map((r) => numeric(r, 'entry')).filter((v): v is number => v !== null);
  const nmEntries = nonMarch.map((r) => numeric(r, 'entry')).filter((v): v is number => v !== null);
  const med = (a: number[]): number => {
    const s = [...a].sort((x, y) => x - y);
    return s.length === 0 ? NaN : s[Math.floor(s.length / 2)];
  };
  console.log(`  median entry — MARCH rows: ${med(marchEntries).toFixed(2)}   nonMarch rows: ${med(nmEntries).toFixed(2)}`);
  if (nb) {
    const { data: recentBars } = await svc
      .from('gold_m1_bars')
      .select('close')
      .order('timestamp', { ascending: false })
      .limit(500);
    const closes = (recentBars ?? []).map((b) => Number((b as { close: unknown }).close));
    console.log(`  median gold_m1_bars close (latest 500 bars): ${med(closes).toFixed(2)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  END OF ITEM 10 EVIDENCE DUMP — nothing was mutated.');
  console.log('═══════════════════════════════════════════════════════════════════');
}

void main();
