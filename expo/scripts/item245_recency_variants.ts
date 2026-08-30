/**
 * ITEM FF — RECENCY-WEIGHTING DEFECT, QUANTIFIED (measure ONLY; NO code change).
 *
 * The defect on record (services/sideAwareRole.ts:90-107,
 * scripts/item244_semantics_port_equivalence.ts): classifyZone scans BACKWARDS
 * from the cutoff, so its event list is NEWEST-FIRST, while
 * recencyWeightedScore double-weights the TAIL of the list it is given
 * (recent = events.slice(-recencyWindow)) — i.e. the OLDEST five events. The
 * instrument's own comment always claimed "last-5 events double weight" (the
 * most RECENT five). Nothing is patched here; both variants are computed from
 * the SAME events the shipped classifier produces:
 *   (a) AS SHIPPED  : the list passed as-is (tail of newest-first = oldest five).
 *   (b) AS INTENDED : the list REVERSED (oldest-first; tail = most recent five).
 * Both scores go through the canonical roleFromScore — no parallel semantics.
 *
 * ZONE SET (fixed by the round contract): the zones the E.1 band rule actually
 * evaluates — the signal's own snapshot, touches >= 10 AND reactionStrength
 * >= 0.5, inside the TP1-path band (entry-1.0..entry+TP1dist for BUY, mirrored
 * for SELL). The Q boolean mirrored here is the shipped ITEM Q annotation
 * (emittedSignalService.ts:495-525): retype_verdict_would_change =
 * (any band zone side-aware role == blockingRoleFor(dir)) !==
 * (any band zone stored legacy type role == blockingRoleFor(dir)), on the 48h
 * window of gold_m1_bars STRICTLY before emitted_at, with the SAME coverage
 * rule (first window bar <= ems-48h AND >= 60 bars).
 *
 * POWER (MINDSET 7): every cohort line prints its MDE
 * 2.80*sigma_p*sqrt(1/n1+1/n2) BEFORE its point estimates. Bootstrap 20k,
 * seed 20260828 (same generator as item237/238/240/241).
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { classifyZone } from './item235_side_aware';
import { roleFromScore, recencyWeightedScore, roleFromLegacyType, blockingRoleFor, type ZoneRole } from '../services/zoneSemantics';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface SnapZone { price: number; touches: number; reactionStrength: number; type?: string }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);
const HOUR = 3600_000, DAY = 24 * HOUR;
const WINDOWS: { label: string; ms: number | null }[] = [{ label: '24h', ms: 24 * HOUR }, { label: '48h', ms: 48 * HOUR }, { label: '7d', ms: 7 * DAY }, { label: 'full', ms: null }];

function bootCI(flipped: number[], same: number[]): [number, number] {
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sf = 0, ss = 0;
    for (let t = 0; t < flipped.length; t++) sf += flipped[(rnd() * flipped.length) | 0];
    for (let t = 0; t < same.length; t++) ss += same[(rnd() * same.length) | 0];
    boots.push(ss / same.length - sf / flipped.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[(boots.length * 0.025) | 0], boots[(boots.length * 0.975) | 0]];
}

/** sigma_p of the pooled cohort pair, for the pre-stated MDE. */
function pooledSigma(flipped: number[], same: number[]): number {
  const pool = [...flipped, ...same];
  if (pool.length < 2) return NaN;
  return Math.sqrt(pool.reduce((a, r) => a + (r - ev(pool)) ** 2, 0) / (pool.length - 1));
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM FF — RECENCY-WEIGHTING DEFECT QUANTIFIED (variants on the SAME events; NO code change)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  variant (a) AS SHIPPED: newest-first list passed as-is -> tail = OLDEST five double-weighted');
  console.log('  variant (b) AS INTENDED: list reversed -> tail = MOST RECENT five double-weighted');
  console.log('  MDE policy: every cohort prints MDE BEFORE point estimates. Boot 20k seed 20260828.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot').or("closed_market_emission.is.null,closed_market_emission.eq.false").order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`signals: ${error.message}`);
    all.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${all.length} emitted | ${bars.length} M1 bars to ${new Date(barsEndMs).toISOString()}`);

  // ── canonical book (era-clean: snapshot-bearing decided, real resolver) ──
  interface B { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[]; rNet: number }
  const book: B[] = [];
  let exclUndecided = 0, exclNoSnap = 0;
  for (const s of all) {
    const zones = typeof s.sr_zones_snapshot === 'string' ? (JSON.parse(s.sr_zones_snapshot) as SnapZone[]) : s.sr_zones_snapshot;
    if (!zones || zones.length === 0) { exclNoSnap++; continue; }
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * HOUR, barsEndMs);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * HOUR).length;
    if (cov < 100 || wb.length === 0) { exclUndecided++; continue; }
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    if (r.outcomeResult === null) { exclUndecided++; continue; }
    book.push({ id: s.signal_id, dir: sig.type as 'BUY' | 'SELL', entry: +s.entry, tp1: +s.tp1, ems, zones, rNet: computeRNet(sig.type as 'BUY' | 'SELL', +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)) });
  }
  console.log(`  era-clean canonical population: n=${book.length} (excluded: no-snapshot ${exclNoSnap}, undecided/no-coverage ${exclUndecided})`);

  const qualifying = (z: SnapZone): boolean => Number(z.touches) >= 10 && Number(z.reactionStrength) >= 0.5;
  const inBand = (b: B, z: SnapZone): boolean => {
    const tp1d = Math.abs(b.tp1 - b.entry);
    return b.dir === 'BUY' ? z.price >= b.entry - 1.0 && z.price <= b.entry + tp1d : z.price <= b.entry + 1.0 && z.price >= b.entry - tp1d;
  };

  // ── FF.1 — both weighting variants over the SAME events ──
  console.log(`\n${line}\nFF.1 — VARIANT COMPARISON on the E.1 band-rule zone set (48h window, bars strictly before emitted_at)\n${line}`);
  let zoneTotal = 0, zoneDiffer = 0;
  let qFlips = 0;
  const marginA: Record<string, number> = {}; const marginB: Record<string, number> = {};
  const roleA: Record<string, number> = {}; const roleB: Record<string, number> = {};
  const flipExamples: string[] = [];
  let covered = 0;
  for (const b of book) {
    const bandZones = b.zones.filter(z => qualifying(z) && inBand(b, z));
    if (bandZones.length === 0) continue;
    const winStart = b.ems - 48 * HOUR;
    const win48 = bars.slice(lb(bars, winStart), lb(bars, b.ems));
    // SAME coverage rule as the shipped ITEM Q annotation: bars exist BEFORE the
    // window start (16-day lookback reaches past it) AND the 48h slice has >= 60 bars.
    if (!(lb(bars, winStart) > 0 && win48.length >= 60)) continue;
    covered++;
    const blocking = blockingRoleFor(b.dir);
    const legacyOpposes = b.zones.some(z => qualifying(z) && inBand(b, z) && roleFromLegacyType(z.type) === blocking);
    let awareA = false, awareB = false;
    for (const z of bandZones) {
      const { role, events } = classifyZone(win48, b.ems, Number(z.price));
      const labels = events.map(e => e.label);            // NEWEST-FIRST (as classifyZone produces)
      const scoreA = recencyWeightedScore(labels, 5, 2);        // (a) as-is -> tail = oldest five
      const scoreB = recencyWeightedScore([...labels].reverse(), 5, 2); // (b) reversed -> tail = most recent five
      const roleA_ = role;                                      // shipped path (identical arithmetic)
      const roleB_ = roleFromScore(scoreB);
      zoneTotal++;
      if (roleA_ !== roleB_) { zoneDiffer++; if (flipExamples.length < 12) flipExamples.push(`sig=${b.id} zone=${Number(z.price).toFixed(1)} (a)=${roleA_}(s=${scoreA}) (b)=${roleB_}(s=${scoreB}) n_events=${labels.length}`); }
      marginA[String(Math.abs(scoreA))] = (marginA[String(Math.abs(scoreA))] ?? 0) + 1;
      marginB[String(Math.abs(scoreB))] = (marginB[String(Math.abs(scoreB))] ?? 0) + 1;
      roleA[roleA_] = (roleA[roleA_] ?? 0) + 1;
      roleB[roleB_] = (roleB[roleB_] ?? 0) + 1;
      if (roleA_ === blocking) awareA = true;
      if (roleB_ === blocking) awareB = true;
    }
    const qA = awareA !== legacyOpposes;   // shipped retype_verdict_would_change
    const qB = awareB !== legacyOpposes;   // would_change under variant (b)
    if (qA !== qB) { qFlips++; if (flipExamples.length < 12 + 8) flipExamples.push(`Q-FLIP sig=${b.id} ${b.dir} rNet=${b.rNet.toFixed(4)} legacy=${legacyOpposes} awareA=${awareA} awareB=${awareB}`); }
  }
  console.log(`  signals with band-relevant zones & 48h coverage: ${covered}`);
  console.log(`  zones classified (both variants, same events): ${zoneTotal}`);
  console.log(`  zones whose ROLE differs (a) vs (b): ${zoneDiffer}`);
  console.log(`  signals whose Q retype boolean FLIPS (q_a != q_b): ${qFlips} of ${covered}`);
  const dist = (m: Record<string, number>): string => Object.entries(m).sort((x, y) => Number(x[0]) - Number(y[0])).map(([k, v]) => `|s|=${k}:${v}`).join('  ');
  console.log(`  MARGIN distribution variant (a) AS SHIPPED: ${dist(marginA) || '(none)'}`);
  console.log(`  MARGIN distribution variant (b) AS INTENDED: ${dist(marginB) || '(none)'}`);
  console.log(`  -> coin-flip roles (|score| = 1): (a) ${marginA['1'] ?? 0} of ${zoneTotal} | (b) ${marginB['1'] ?? 0} of ${zoneTotal}`);
  console.log(`  role mix (a): ${JSON.stringify(roleA)} | (b): ${JSON.stringify(roleB)}`);
  console.log('  examples (first flips):'); for (const e of flipExamples) console.log(`    ${e}`);

  // ── FF.2a — window sensitivity table under BOTH variants (item238 M.1 zone sets) ──
  console.log(`\n${line}\nFF.2a — WINDOW SENSITIVITY under both variants (item238's M.1 zone sets)\n${line}`);
  const classifyVariant = (win: Bar[], cut: number, price: number): { a: ZoneRole; b: ZoneRole } => {
    const { role, events } = classifyZone(win, cut, price);
    const labels = events.map(e => e.label);
    return { a: role, b: roleFromScore(recencyWeightedScore([...labels].reverse(), 5, 2)) };
  };
  const t1Cutoff = Date.parse('2026-08-27T02:15:56Z');
  const sig2 = all.find(s => s.emitted_at.startsWith('2026-08-27T10:37:1'));
  const z2: SnapZone[] = sig2 ? (typeof sig2.sr_zones_snapshot === 'string' ? JSON.parse(sig2.sr_zones_snapshot) as SnapZone[] : (sig2.sr_zones_snapshot ?? [])) : [];
  const c2 = sig2 ? new Date(sig2.emitted_at).getTime() : 0;
  const tables: { label: string; cut: number; zones: { price: number; type?: string }[] }[] = [
    { label: 'TEST 1 (02:15Z zones, cutoff 02:15:56Z)', cut: t1Cutoff, zones: [4641.6, 4636.9, 4635.9, 4635.3, 4633.2].map(p => ({ price: p })) },
    { label: 'TEST 2 (10:37Z snapshot zones, cutoff 10:37:16Z)', cut: c2, zones: z2.filter(z => [4583.2, 4580.9, 4579.9, 4597, 4598.3].includes(Number(z.price))).map(z => ({ price: Number(z.price), type: z.type })) },
  ];
  const short = (r: ZoneRole): string => r.replace('CEILING_BEHAVING', 'CEIL').replace('FLOOR_BEHAVING', 'FLOOR').replace('UNTYPED', 'UNTY');
  for (const t of tables) {
    console.log(`\n  ${t.label}`);
    for (const w of WINDOWS) {
      const start = w.ms === null ? 0 : t.cut - w.ms;
      const win = bars.slice(lb(bars, start), lb(bars, t.cut));
      const cells = t.zones.map(z => {
        const v = classifyVariant(win, t.cut, z.price);
        const mark = v.a !== v.b ? ' <<DIFF' : '';
        return `${z.price.toFixed(1)}: a=${short(v.a)} b=${short(v.b)}${z.type ? ` (stored ${(z.type as string).slice(0, 3)})` : ''}${mark}`;
      });
      console.log(`    ${w.label.padEnd(5)} ${cells.join('  ')}`);
    }
  }

  // ── FF.2b — G.3 counterfactual at 48h under BOTH variants (MDE FIRST) ──
  console.log(`\n${line}\nFF.2b — G.3 COUNTERFACTUAL at 48h under both variants (MDE stated BEFORE point estimates)\n${line}`);
  const g3 = (variant: 'a' | 'b'): { flipped: number[]; same: number[]; nFlip: number; nSame: number } => {
    const flipped: number[] = []; const same: number[] = [];
    for (const b of book) {
      const bandZones = b.zones.filter(z => qualifying(z) && inBand(b, z));
      if (bandZones.length === 0) continue;
      const winStart = b.ems - 48 * HOUR;
      const win48 = bars.slice(lb(bars, winStart), lb(bars, b.ems));
      if (!(lb(bars, winStart) > 0 && win48.length >= 60)) continue;
      const blocking = blockingRoleFor(b.dir);
      const legacyOpposes = b.zones.some(z => qualifying(z) && inBand(b, z) && roleFromLegacyType(z.type) === blocking);
      let aware = false;
      for (const z of bandZones) {
        const v = classifyVariant(win48, b.ems, Number(z.price));
        if (v[variant] === blocking) { aware = true; break; }
      }
      if (aware !== legacyOpposes) flipped.push(b.rNet); else same.push(b.rNet);
    }
    return { flipped, same, nFlip: flipped.length, nSame: same.length };
  };
  for (const variant of ['a', 'b'] as const) {
    const { flipped, same, nFlip, nSame } = g3(variant);
    const label = variant === 'a' ? '(a) AS SHIPPED' : '(b) AS INTENDED';
    if (!nFlip || !nSame) { console.log(`  ${label}: would-flip n=${nFlip} unchanged n=${nSame} — cohort empty, no comparison`); continue; }
    const sigmaP = pooledSigma(flipped, same);
    const mde = 2.8 * sigmaP * Math.sqrt(1 / nFlip + 1 / nSame);
    console.log(`  ${label}:  MDE ±${mde.toFixed(4)}R  (n_flip=${nFlip}, n_unchanged=${nSame}, pooled sigma=${sigmaP.toFixed(4)}R)  <-- stated BEFORE point estimates`);
    const [lo, hi] = bootCI(flipped, same);
    console.log(`     WOULD-FLIP n=${nFlip} WR=${(100 * flipped.filter(x => x > 0).length / nFlip).toFixed(1)}% EV=${ev(flipped).toFixed(4)}R | UNCHANGED n=${nSame} WR=${(100 * same.filter(x => x > 0).length / nSame).toFixed(1)}% EV=${ev(same).toFixed(4)}R`);
    console.log(`     diff (unchanged-flip) ${(ev(same) - ev(flipped) >= 0 ? '+' : '') + (ev(same) - ev(flipped)).toFixed(4)}R; boot CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
  }
  console.log(`\n  FF SCOPE: measurement only. No instrument, annotation or gate was changed.`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
