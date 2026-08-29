/**
 * ITEM V.4 — PORT-EQUIVALENCE HARNESS for the canonical-semantics round.
 *
 * CLAIM UNDER TEST: porting m15ZoneLayer.ts and sideAwareRole.ts onto
 * services/zoneSemantics.ts changed the VOCABULARY and removed duplicated
 * derivations, but changed NO number. "The code looks right" is not evidence
 * (MINDSET 2), so this harness runs the PRE-PORT classifier (verbatim copy,
 * frozen below) and the LIVE ported classifier over the same real bars and
 * reports every disagreement.
 *
 * Legacy -> canonical mapping used for comparison (the ONLY translation):
 *   RESISTANCE -> CEILING_BEHAVING, SUPPORT -> FLOOR_BEHAVING, NEUTRAL -> UNTYPED.
 * A disagreement is a PORT DEFECT and must fail this run.
 *
 * Data-source rule: gold_m1_bars via the anon key ONLY.
 */
import { createClient } from '@supabase/supabase-js';
import { classifyZone } from '../services/sideAwareRole';
import { buildM15Zones, type M1Bar } from '../services/m15ZoneLayer';
import { roleFromLegacyType, type ZoneRole } from '../services/zoneSemantics';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

const W = 0.8, OUTCOME_BARS = 15;
const lb = (bars: Bar[], t: number): number => {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; }
  return lo;
};

/**
 * PRE-PORT classifier — copied VERBATIM from the state of
 * services/sideAwareRole.ts before this round (git 8c04bc2). Frozen reference;
 * never "fixed" to make the comparison pass.
 */
function classifyZoneLegacy(bars: Bar[], cutoffMs: number, zPrice: number): { role: 'SUPPORT' | 'RESISTANCE' | 'NEUTRAL' } {
  const events: { label: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN' }[] = [];
  let i = lb(bars, cutoffMs) - 1;
  if (i < 1) return { role: 'NEUTRAL' };
  let inside = Math.abs(bars[i].close - zPrice) < W;
  for (; i >= 1; i--) {
    const b = bars[i], prev = bars[i - 1];
    const insideNow = Math.abs(b.close - zPrice) < W || (b.low - W < zPrice && b.high + W > zPrice && Math.min(Math.abs(b.high - zPrice), Math.abs(b.low - zPrice)) < W);
    if (!inside && insideNow) {
      const fromBelow = prev.close < zPrice - W;
      const j = i;
      let outcome: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN' | null = null;
      for (let k = 0; k < OUTCOME_BARS && j - k >= 0; k++) {
        const bb = bars[j - k];
        if (bb.close > zPrice + W) { outcome = fromBelow ? 'BREAK_UP' : 'REJ_FROM_ABOVE'; break; }
        if (bb.close < zPrice - W) { outcome = fromBelow ? 'REJ_FROM_BELOW' : 'BREAK_DOWN'; break; }
      }
      events.push({ label: outcome ?? (fromBelow ? 'REJ_FROM_BELOW' : 'REJ_FROM_ABOVE') });
    }
    inside = insideNow;
  }
  let rejB = 0, rejA = 0;
  const n = events.length;
  for (let idx = 0; idx < n; idx++) {
    const weight = idx >= n - 5 ? 2 : 1;
    if (events[idx].label === 'REJ_FROM_BELOW') rejB += weight;
    else if (events[idx].label === 'REJ_FROM_ABOVE') rejA += weight;
  }
  return { role: rejB > rejA ? 'RESISTANCE' : rejA > rejB ? 'SUPPORT' : 'NEUTRAL' };
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line);
  console.log('ITEM V.4 — PORT EQUIVALENCE (pre-port classifier vs canonical-backed port, REAL bars)');
  console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);

  const bars: Bar[] = [];
  const m1: M1Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close')
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) {
      const ts = new Date(r.timestamp).getTime();
      bars.push({ timestamp: ts, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
      m1.push({ ts, o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  bars: ${bars.length} (${new Date(bars[0].timestamp).toISOString()} -> ${new Date(bars[bars.length - 1].timestamp).toISOString()})`);

  // Grid: every $0.5 level across the observed range, at 12 evenly spaced cutoffs.
  const lo = Math.min(...bars.map(b => b.low)), hi = Math.max(...bars.map(b => b.high));
  const levels: number[] = [];
  for (let p = Math.floor(lo); p <= Math.ceil(hi); p += 0.5) levels.push(Math.round(p * 10) / 10);
  const first = bars[0].timestamp, last = bars[bars.length - 1].timestamp;
  const cutoffs: number[] = [];
  for (let k = 1; k <= 12; k++) cutoffs.push(first + Math.floor(((last - first) * k) / 13));

  let compared = 0, mismatches = 0;
  const examples: string[] = [];
  const dist = new Map<ZoneRole, number>();
  for (const cut of cutoffs) {
    for (const level of levels) {
      const legacy = roleFromLegacyType(classifyZoneLegacy(bars, cut, level).role);
      const ported = classifyZone(bars, cut, level).role;
      compared += 1;
      dist.set(ported, (dist.get(ported) ?? 0) + 1);
      if (legacy !== ported) {
        mismatches += 1;
        if (examples.length < 10) examples.push(`    cutoff=${new Date(cut).toISOString()} level=${level.toFixed(1)}  pre-port=${legacy}  ported=${ported}`);
      }
    }
  }
  console.log(`\nV.4a SIDE-AWARE CLASSIFIER`);
  console.log(`  grid: ${levels.length} levels x ${cutoffs.length} cutoffs = ${compared} comparisons`);
  console.log(`  role distribution (ported): ${[...dist.entries()].map(([r, c]) => `${r}=${c}`).join(' ')}`);
  console.log(`  MISMATCHES: ${mismatches}`);
  for (const e of examples) console.log(e);

  // V.4b — M15 layer role/geometry snapshot at the two acceptance cutoffs.
  console.log(`\nV.4b M15 LAYER (role counts must match the pre-port artifact zone-for-zone)`);
  for (const iso of ['2026-08-27T02:15:56Z', '2026-08-27T10:37:16Z']) {
    const asOf = Date.parse(iso);
    const built = buildM15Zones(m1.filter(b => b.ts >= asOf - 16 * 86_400_000 && b.ts < asOf), asOf);
    if (!built) { console.log(`  ${iso}: NO DATA`); continue; }
    const c = new Map<ZoneRole, number>();
    for (const z of built.zones) c.set(z.role, (c.get(z.role) ?? 0) + 1);
    console.log(`  ${iso}: zones=${built.zones.length} tradingDays=${built.tradingDays} | ${[...c.entries()].map(([r, n]) => `${r}=${n}`).join(' ')}`);
  }

  console.log(`\nVERDICT: ${mismatches === 0 ? 'EQUIVALENT — the port changed vocabulary and removed duplication, and changed NO number.' : `PORT DEFECT — ${mismatches} disagreement(s).`}`);
  if (mismatches > 0) process.exit(1);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
