/**
 * ITEM V.3 — M15 ZONE LAYER ACCEPTANCE TESTS, run through the REAL builder
 * (services/m15ZoneLayer.ts — the same module the emission annotation calls).
 *
 * (a) map at 2026-08-27T02:15Z must contain a CEILING_BEHAVING zone in 4633-4641;
 * (b) map at 2026-08-27T10:37Z must contain a FLOOR_BEHAVING zone in 4559-4572;
 * plus the full zone list for both maps.
 *
 * PORTED to canonical semantics (services/zoneSemantics.ts). The acceptance
 * CRITERIA are unchanged in meaning — "a level that has rejected upward
 * approaches" is CEILING_BEHAVING, "a level that has rejected downward
 * approaches" is FLOOR_BEHAVING. Only the vocabulary moved, and the role
 * constants now come from the canonical module instead of being typed as bare
 * strings that silently match nothing after a rename.
 */
import { createClient } from '@supabase/supabase-js';
import { buildM15Zones, m15OpposedHit, m15EndorsedHit, type M1Bar, type M15Zone } from '../services/m15ZoneLayer';
import { blockingRoleFor } from '../services/zoneSemantics';

async function fetchBars(client: ReturnType<typeof createClient>, startMs: number, endMs: number): Promise<M1Bar[]> {
  const bars: M1Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close')
      .gte('timestamp', new Date(startMs).toISOString()).lt('timestamp', new Date(endMs).toISOString())
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ ts: new Date(r.timestamp).getTime(), o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  return bars;
}

function printMap(label: string, ems: number, built: { zones: M15Zone[]; tradingDays: number } | null): void {
  console.log(`\n${label}  (asOf=${new Date(ems).toISOString()}, tradingDays=${built?.tradingDays ?? 0}, zones=${built?.zones.length ?? 0})`);
  if (!built) { console.log('  NO DATA'); return; }
  const sorted = [...built.zones].sort((a, b) => a.lo - b.lo);
  for (const z of sorted) {
    console.log(`  ${z.lo.toFixed(1)}-${z.hi.toFixed(1)}  mid=${z.mid.toFixed(2)}  n=${z.n}  rb(from-below)=${z.rb}  ra(from-above)=${z.ra}  role=${z.role}  lastUsable=${new Date(z.lastUsableTs).toISOString()}`);
  }
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM V.3 — M15 ZONE LAYER ACCEPTANCE (REAL builder: services/m15ZoneLayer.ts)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);

  const t1 = new Date('2026-08-27T02:15:56Z').getTime();
  const b1 = await fetchBars(client, t1 - 16 * 86_400_000, t1);
  const m1 = buildM15Zones(b1, t1);
  printMap('ACCEPTANCE (a) — 02:15Z failure map', t1, m1);
  // A BUY is blocked by the ceiling-behaving role — taken from the canonical
  // mapping so this assertion cannot drift from the instrument again.
  const a = m1?.zones.find(z => z.role === blockingRoleFor('BUY') && z.lo <= 4641 && z.hi >= 4633) ?? null;
  console.log(`  (a) CEILING_BEHAVING zone overlapping 4633-4641: ${a ? `YES -> ${a.lo.toFixed(1)}-${a.hi.toFixed(1)} n=${a.n} rb=${a.rb} ra=${a.ra}` : 'NO -> FAIL'}`);
  const opp1 = m1 ? m15OpposedHit(m1.zones, 'BUY', 4636.6, 4643.9) : null; // placeholder entry/tp1; the acceptance is the zone presence above
  console.log(`      (context) opposed-hit probe on the 02:15 BUY (entry 4636.6, tp1 4643.9): ${opp1 ? `${opp1.lo.toFixed(1)}-${opp1.hi.toFixed(1)} ${opp1.role}` : 'none'}`);
  const end1 = m1 ? m15EndorsedHit(m1.zones, 'BUY', 4636.6) : null;
  console.log(`      (context) endorsed-hit probe: ${end1 ? `${end1.lo.toFixed(1)}-${end1.hi.toFixed(1)} ${end1.role}` : 'none'}`);

  const t2 = new Date('2026-08-27T10:37:16Z').getTime();
  const b2 = await fetchBars(client, t2 - 16 * 86_400_000, t2);
  const m2 = buildM15Zones(b2, t2);
  printMap('ACCEPTANCE (b) — 10:37Z map', t2, m2);
  // A SELL is blocked by the floor-behaving role — same canonical mapping.
  const s = m2?.zones.find(z => z.role === blockingRoleFor('SELL') && z.lo <= 4572 && z.hi >= 4559) ?? null;
  console.log(`  (b) FLOOR_BEHAVING zone overlapping 4559-4572: ${s ? `YES -> ${s.lo.toFixed(1)}-${s.hi.toFixed(1)} n=${s.n} rb=${s.rb} ra=${s.ra}` : 'NO -> FAIL'}`);

  console.log(`\nVERDICT: (a)=${a ? 'PASS' : 'FAIL'}  (b)=${s ? 'PASS' : 'FAIL'}`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
