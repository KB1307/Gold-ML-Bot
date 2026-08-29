/**
 * ITEM Y.2 — EXIT SHADOW LADDER, FORWARD PAIRED RESOLUTION (write-only).
 *
 * For every emitted signal that carries the ITEM Y exit-geometry annotation
 * (regime_at_emission / mapped_sl / mapped_tp — migration 021), this script
 * resolves BOTH outcomes through the canonical path and appends ONE paired row
 * to shadow_candidates_v1:
 *   LIVE outcome   : REAL resolveSignalWithBars fromScratch (8h window,
 *                    safeBarStart = emitted_at + 60s) + lib/evCompute computeRNet.
 *   MAPPED outcome  : the IDENTICAL single-TP walk as the Y.1 measurement
 *                    (walkSingleTP imported from scripts/item248_exit_geometry_arms —
 *                    ONE instrument, verbatim, not a re-implementation): mapped SL /
 *                    mapped TP prices derived from the stored distances, conservative
 *                    same-bar tie-break (STOP taken), risk = mapped_sl distance.
 * Runs on demand after each measurement round (a bun script run from expo/); it is
 * idempotent — signals already carrying an EXIT_SHADOW_LADDER row are skipped.
 *
 * GATE ISOLATION (hard rule): this script reads and writes ONLY rows with
 * candidate_name = 'EXIT_SHADOW_LADDER' (STRICT .eq equality — never a range,
 * prefix match, or name-omitted filter). The P.3 abort gate counts ONLY
 * candidate_name = 'BAND_VETO_SUPPRESSED' rows toward its n=30; the exit
 * promotion gate counts ONLY EXIT_SHADOW_LADDER rows toward its n=60. One gate
 * can never poison the other.
 *
 * PRE-REGISTERED PROMOTION GATE (verbatim): a live exit change may be proposed
 * only when forward paired n >= 60 decided AND the chosen arm's paired-difference
 * 95% CI lower bound > 0. Until then it is observation only.
 *
 * Data-source rule: gold_m1_bars via the ANON key only; writes go to
 * shadow_candidates_v1 (anon INSERT policy, applied with corrected migration 020).
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { walkSingleTP } from './item248_exit_geometry_arms';
import type { Bar } from '../services/barIndicators';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; regime_at_emission: string | null; mapped_sl: number | null; mapped_tp: number | null }
interface ShadowRow { inputs: { signal_id?: string } | null }

const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM Y.2 — EXIT SHADOW LADDER, FORWARD PAIRED RESOLUTION (write-only)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  GATE ISOLATION: reads/writes ONLY candidate_name = \'EXIT_SHADOW_LADDER\' (strict equality).');
  console.log('  PROMOTION GATE (verbatim): a live exit change may be proposed only when forward paired');
  console.log('  n >= 60 decided AND the chosen arm\'s paired-difference 95% CI lower bound > 0. Observation only until then.');

  // ── 1. annotated rows (migration 021 columns) ──
  const rows: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,regime_at_emission,mapped_sl,mapped_tp')
      .not('mapped_sl', 'is', null)
      .order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) {
      if (/Could not find the column|does not exist|PGRST204|42703/i.test(error.message)) {
        console.log(`\nBLOCKED-ON-APPLY: migration 021 columns are not live yet (${error.message})`);
        console.log('Nothing to resolve; the annotation write-site will populate regime_at_emission / mapped_sl / mapped_tp from the next emission after 021 is applied.');
        return;
      }
      throw new Error(`annotated rows: ${error.message}`);
    }
    rows.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  annotated signals (mapped_sl NOT NULL): ${rows.length}`);
  if (rows.length === 0) {
    console.log('  No annotated rows yet — the write-site annotates from the NEXT emission (market closed / 021 unapplied). Nothing to do.');
    return;
  }

  // ── 2. already-resolved signals (STRICT candidate_name equality) ──
  const done = new Set<string>();
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('shadow_candidates_v1')
      .select('inputs')
      .eq('candidate_name', 'EXIT_SHADOW_LADDER')
      .range(o, o + 999);
    if (error) throw new Error(`existing ladder rows: ${error.message}`);
    for (const r of (data ?? []) as ShadowRow[]) { const id = r.inputs?.signal_id; if (id) done.add(id); }
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  already resolved (EXIT_SHADOW_LADDER rows): ${done.size}`);

  // ── 3. bars ──
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...rows.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(minEms - 60_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString()).order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  bars: ${bars.length} to ${new Date(barsEndMs).toISOString()}`);

  // ── 4. resolve + append paired rows ──
  let inserted = 0, undecided = 0;
  for (const s of rows) {
    if (done.has(s.signal_id)) continue;
    const ems = new Date(s.emitted_at).getTime();
    const dir = (s.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lbR(bars, ems - 60_000), lbR(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) { undecided++; continue; }
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: dir, entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const riskLive = Math.abs(+s.entry - +s.sl);
    const startIdx = lbR(bars, ems + 60_000);
    const slDist = Number(s.mapped_sl);
    const slPrice = dir === 'BUY' ? +s.entry - slDist : +s.entry + slDist;
    const tpPrice = dir === 'BUY' ? +s.entry + Number(s.mapped_tp) : +s.entry - Number(s.mapped_tp);
    const mappedExit = startIdx < bars.length ? walkSingleTP(bars, startIdx, dir, +s.entry, slPrice, tpPrice) : null;
    const liveR = r.outcomeResult !== null ? computeRNet(dir, +s.entry, r.exitPrice, riskLive) : null;
    const mappedR = mappedExit !== null ? computeRNet(dir, +s.entry, mappedExit, slDist) : null;
    if (liveR === null || mappedR === null) { undecided++; continue; }
    const { error: insErr } = await client.from('shadow_candidates_v1').insert({
      candidate_name: 'EXIT_SHADOW_LADDER',
      evaluated_at: new Date().toISOString(),
      direction: dir,
      entry: Math.round(+s.entry * 100) / 100,
      sl: Math.round(+s.sl * 100) / 100,
      tp1: Math.round(+s.tp1 * 100) / 100,
      tp2: Math.round(+s.tp2 * 100) / 100,
      tp3: Math.round(+s.tp3 * 100) / 100,
      inputs: {
        signal_id: s.signal_id,
        regime_at_emission: s.regime_at_emission,
        mapped_sl: slDist,
        mapped_tp: Number(s.mapped_tp),
        live_outcome_r: Math.round(liveR * 10000) / 10000,
        mapped_outcome_r: Math.round(mappedR * 10000) / 10000,
        paired_diff_r: Math.round((mappedR - liveR) * 10000) / 10000,
        instrument: 'live: resolveSignalWithBars fromScratch + computeRNet | mapped: walkSingleTP (item248, verbatim) + computeRNet',
        resolved_at: new Date().toISOString(),
      },
    });
    if (insErr) { console.warn(`  insert FAILED for ${s.signal_id}: ${insErr.message}`); continue; }
    inserted++;
  }
  console.log(`\n  appended EXIT_SHADOW_LADDER rows: ${inserted} | undecided (coverage/mapping): ${undecided}`);
  console.log(`  promotion-gate count: rows with candidate_name = 'EXIT_SHADOW_LADDER' AND both outcomes decided -> n=${done.size + inserted} of 60 required. Observation only until the gate is met.`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
