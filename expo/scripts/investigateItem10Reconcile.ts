/**
 * ITEM 10 — RECONCILIATION: are the 408 March rows SIMULATION output?
 *
 * READ-ONLY. Tests the hypothesis mechanically rather than by inspection:
 *   H: the rows were written by `scripts/runSignalSimulation.ts`, whose fake
 *      clock starts at SIMULATION_START_MS = Date.UTC(2026, 2, 17, 20, 0, 0)
 *      (= 2026-03-17T20:00:00Z), advances in STEP_MS = 30_000 increments, and
 *      whose synthetic price band is ~$3010-3055.
 *
 * Predictions if H is true:
 *   P1. every created_at lies on a 30-second boundary from SIMULATION_START_MS
 *   P2. every created_at >= SIMULATION_START_MS
 *   P3. the epoch embedded in signal_id equals created_at exactly (the row's
 *       created_at is the SIGNAL's createdAt, not the insert time)
 *   P4. entries lie inside the synthetic band, and OUTSIDE the real gold range
 *       that gold_m1_bars held on those dates (it holds no March bars at all)
 *   P5. serial ids place these rows AFTER the July live rows, i.e. they were
 *       INSERTED later while carrying earlier timestamps
 *
 * Usage: bun run scripts/investigateItem10Reconcile.ts
 */
import { createClient } from '@supabase/supabase-js';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

const SIMULATION_START_MS = Date.UTC(2026, 2, 17, 20, 0, 0);
const STEP_MS = 30_000;
const WARMUP_MS = 90 * 60 * 1000;
const SYNTHETIC_BAND = { lo: 3005, hi: 3060 };

interface Row {
  id: number;
  signal_id: string;
  created_at: string;
  entry: number;
  atr: number;
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ITEM 10 — RECONCILIATION AGAINST THE SIMULATION HARNESS');
  console.log(`  SIMULATION_START_MS = ${SIMULATION_START_MS} (${new Date(SIMULATION_START_MS).toISOString()})`);
  console.log(`  STEP_MS = ${STEP_MS}   synthetic band = $${SYNTHETIC_BAND.lo}-${SYNTHETIC_BAND.hi}`);
  console.log('  READ-ONLY. Nothing is mutated.');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await svc
      .from('shadow_signals_v1')
      .select('id, signal_id, created_at, entry, atr')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as unknown as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  const march = rows.filter((r) => r.created_at.startsWith('2026-03'));
  const july = rows.filter((r) => !r.created_at.startsWith('2026-03'));
  console.log(`rows: ${rows.length}   March: ${march.length}   non-March: ${july.length}\n`);

  // P1 — 30-second grid alignment from the simulation's fake epoch.
  const onGrid = march.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return (t - SIMULATION_START_MS) % STEP_MS === 0;
  });
  const julyOnGrid = july.filter((r) => {
    const t = new Date(r.created_at).getTime();
    return (t - SIMULATION_START_MS) % STEP_MS === 0;
  });
  console.log(`P1 30s-grid aligned to SIMULATION_START_MS:`);
  console.log(`   MARCH    ${onGrid.length}/${march.length} (${pct(onGrid.length, march.length)})`);
  console.log(`   nonMarch ${julyOnGrid.length}/${july.length} (${pct(julyOnGrid.length, july.length)})`);

  // P2 — inside the simulated window, and how far in.
  const offsets = march.map((r) => new Date(r.created_at).getTime() - SIMULATION_START_MS);
  const minOff = Math.min(...offsets);
  const maxOff = Math.max(...offsets);
  console.log(`\nP2 offset from SIMULATION_START_MS:`);
  console.log(`   min = ${(minOff / 3_600_000).toFixed(2)}h   max = ${(maxOff / 3_600_000).toFixed(2)}h`);
  console.log(`   all >= 0: ${offsets.every((o) => o >= 0)}`);
  console.log(`   all >= warmup (${WARMUP_MS / 3_600_000}h): ${offsets.every((o) => o >= WARMUP_MS)}`);
  console.log(`   implied run length: a ${Math.ceil((maxOff - WARMUP_MS) / 3_600_000)}h observed window would reach the newest row`);

  // P3 — signal_id epoch vs created_at.
  let idEpochMatches = 0;
  let idEpochMismatch: string[] = [];
  for (const r of march) {
    const m = /^signal_(\d+)_/.exec(r.signal_id);
    if (!m) continue;
    const embedded = Number(m[1]);
    const created = new Date(r.created_at).getTime();
    if (embedded === created) idEpochMatches += 1;
    else if (idEpochMismatch.length < 3) idEpochMismatch.push(`${r.signal_id} embedded=${embedded} created_at=${created} delta=${created - embedded}ms`);
  }
  console.log(`\nP3 signal_id epoch === created_at:`);
  console.log(`   MARCH ${idEpochMatches}/${march.length} (${pct(idEpochMatches, march.length)})`);
  if (idEpochMismatch.length > 0) console.log(`   mismatches: ${idEpochMismatch.join(' | ')}`);
  let julyMatches = 0;
  for (const r of july) {
    const m = /^signal_(\d+)_/.exec(r.signal_id);
    if (!m) continue;
    if (Math.abs(Number(m[1]) - new Date(r.created_at).getTime()) <= 2) julyMatches += 1;
  }
  console.log(`   nonMarch ${julyMatches}/${july.length} (within 2ms)`);

  // P4 — price band, and whether gold_m1_bars has ANY March coverage.
  const inBand = march.filter((r) => Number(r.entry) >= SYNTHETIC_BAND.lo && Number(r.entry) <= SYNTHETIC_BAND.hi);
  console.log(`\nP4 entry inside the synthetic band $${SYNTHETIC_BAND.lo}-${SYNTHETIC_BAND.hi}:`);
  console.log(`   MARCH ${inBand.length}/${march.length} (${pct(inBand.length, march.length)})`);
  const { count: marchBars } = await svc
    .from('gold_m1_bars')
    .select('timestamp', { count: 'exact', head: true })
    .gte('timestamp', '2026-03-01T00:00:00Z')
    .lt('timestamp', '2026-04-01T00:00:00Z');
  const { data: oldest } = await svc.from('gold_m1_bars').select('timestamp, close').order('timestamp', { ascending: true }).limit(1);
  const { data: newest } = await svc.from('gold_m1_bars').select('timestamp, close').order('timestamp', { ascending: false }).limit(1);
  console.log(`   gold_m1_bars rows in March 2026: ${marchBars ?? 0}`);
  console.log(`   gold_m1_bars coverage: ${oldest?.[0]?.timestamp} (close ${oldest?.[0]?.close}) … ${newest?.[0]?.timestamp} (close ${newest?.[0]?.close})`);

  // P5 — insertion order vs claimed time.
  const marchIds = march.map((r) => r.id);
  const julyIds = july.map((r) => r.id);
  console.log(`\nP5 serial id (true insert order) vs claimed created_at:`);
  console.log(`   nonMarch (July, LIVE) ids: ${julyIds.join(', ')}  -> created_at ${july[0]?.created_at} … ${july[july.length - 1]?.created_at}`);
  console.log(`   MARCH ids: ${Math.min(...marchIds)} … ${Math.max(...marchIds)}`);
  console.log(`   every March id > every July id: ${Math.min(...marchIds) > Math.max(...julyIds)}`);
  console.log(`   => the March-dated rows were INSERTED AFTER the 31 July live rows.`);

  // ATR: the synthetic series is far smoother than real gold.
  const marchAtr = march.map((r) => Number(r.atr)).sort((a, b) => a - b);
  const julyAtr = july.map((r) => Number(r.atr)).sort((a, b) => a - b);
  console.log(`\nATR distribution:`);
  console.log(`   MARCH    min=${marchAtr[0]} p50=${marchAtr[Math.floor(marchAtr.length / 2)]} max=${marchAtr[marchAtr.length - 1]}`);
  console.log(`   nonMarch min=${julyAtr[0]} p50=${julyAtr[Math.floor(julyAtr.length / 2)]} max=${julyAtr[julyAtr.length - 1]}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  END — nothing was mutated, nothing deleted.');
  console.log('═══════════════════════════════════════════════════════════════════');
}

void main();
