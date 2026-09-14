/**
 * ITEM 5 (five-fix prompt, 2026-09-14) — SHIP/NO-SHIP measurement gate for the
 * directional consensus veto, closed via OFFLINE label recomputation.
 *
 * BLOCKER being resolved: `ltf_trend` was never persisted to emitted_signals_v1
 * (NULL on every row), so the stored-label measurement in
 * verify_items2_3_5_gates.ts was UNDECIDABLE (vetoed set n=0). The gate reads
 * detectHTFTrend + detectLTFTrend at emission; htf_trend IS stored (same
 * detector, same call — verified in pushEmittedSignalRecord), so only LTF needs
 * recomputation:
 *
 *   LTF := barLTFTrend(series, 0.25)  — the ENGINE'S OWN exported detector
 *   (barIndicators.ts:255; detectLTFTrend calls exactly this at 0.25), fed the
 *   M5 series reconstructed the SAME way the engine builds it (aggregateBars
 *   M1→M5, gold_m1_bars). Per emission the series is sliced to bars that were
 *   FULLY CLOSED at emission (bar open + 5 min <= emitted_at), capped at the
 *   live BAR_M5_LOOKBACK=1000, and the live guards mirrored: < 60 bars →
 *   'NEUTRAL' (getDirectionalM5 stand-aside), newest closed bar > 15 min stale
 *   → 'NEUTRAL'. Residual approximation vs the live in-memory series: the slice
 *   uses only sealed bars (the engine's aggregateBars output is sealed too) and
 *   freshness is evaluated against emission time instead of wall clock.
 *
 * VETO condition (verbatim from the shipped gate): BUY & htf BEARISH & ltf
 * BEARISH & rsi not < 30; SELL & htf BULLISH & ltf BULLISH & rsi not > 70.
 * SHIP GATE: vetoed-set WR HIGHER than remaining-set WR → Item 5 must NOT ship.
 *
 * Read-only — no writes anywhere.
 * Run: cd expo && bun scripts/verify_item5_ltf_recompute.ts
 */
import { createClient } from "@supabase/supabase-js";
import { aggregateBars, sealBarSeries, barLTFTrend } from "../services/barIndicators";
import type { Bar } from "../services/barIndicators";

interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  atr: number | null;
  htf_trend: string | null;
  rsi: number | null;
}

interface OutcomeRow {
  signal_id: string;
  result: string;
  realized_r: number | null;
}

const M5_MS = 5 * 60_000;
const LIVE_LOOKBACK = 1000; // BAR_M5_LOOKBACK (post-FG)
const MIN_BARS = 60; // getDirectionalM5 minimum
const STALE_MS = 15 * 60_000; // BAR_MAX_AGE_M5_MS

function isVetoed(direction: string, htf: string | null, ltf: string, rsi: number | null): boolean {
  if (direction === 'BUY') return htf === 'BEARISH' && ltf === 'BEARISH' && (rsi === null || rsi >= 30);
  if (direction === 'SELL') return htf === 'BULLISH' && ltf === 'BULLISH' && (rsi === null || rsi <= 70);
  return false;
}

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // 1. Last 50 emissions (kept in chronological order).
  const { data: recent, error: recentErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, atr, htf_trend, rsi')
    .order('emitted_at', { ascending: false })
    .limit(50);
  if (recentErr) throw new Error(`recent fetch: ${recentErr.message}`);
  const last50 = (recent ?? []).slice().reverse() as EmittedRow[];
  console.log(`last 50 emissions: ${last50[0]?.emitted_at ?? '—'} → ${last50[last50.length - 1]?.emitted_at ?? '—'}`);
  const missingHtf = last50.filter(r => r.htf_trend === null).length;
  console.log(`stored htf labels present: ${50 - missingHtf}/50 (missing: ${missingHtf})`);

  // 2. M1 bars covering the window (oldest emission − 3 days for the 1000-bar warm-up).
  const oldest = Date.parse(last50[0].emitted_at) - 3 * 24 * 3_600_000;
  const m1: Bar[] = [];
  for (let offset = 0; offset < 40_000; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(oldest).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`m1 fetch: ${error.message}`);
    const page = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of page) {
      m1.push({ timestamp: Date.parse(r.timestamp), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (page.length < 1000) break;
  }
  console.log(`M1 bars fetched: ${m1.length} (${new Date(m1[0]?.timestamp ?? 0).toISOString()} → ${new Date(m1[m1.length - 1]?.timestamp ?? 0).toISOString()})`);
  const m5 = aggregateBars(m1, 5);
  console.log(`M5 series (aggregateBars, engine's own aggregator): ${m5.length} bars`);

  // 3. Recompute LTF per emission + classify the veto.
  const ltfBySignal = new Map<string, { ltf: string; barsUsed: number }>();
  for (const row of last50) {
    const emittedAt = Date.parse(row.emitted_at);
    let closed = m5.filter(b => b.timestamp + M5_MS <= emittedAt);
    if (closed.length > LIVE_LOOKBACK) closed = closed.slice(-LIVE_LOOKBACK);
    let ltf: string;
    if (closed.length < MIN_BARS || emittedAt - closed[closed.length - 1].timestamp > STALE_MS + M5_MS) {
      ltf = 'NEUTRAL'; // live getDirectionalM5 stand-aside guards, mirrored
    } else {
      ltf = barLTFTrend(sealBarSeries(closed), 0.25);
    }
    ltfBySignal.set(row.signal_id, { ltf, barsUsed: closed.length });
  }
  const dist = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
  for (const v of ltfBySignal.values()) dist[v.ltf as keyof typeof dist] += 1;
  console.log(`recomputed LTF distribution: BULLISH ${dist.BULLISH} / BEARISH ${dist.BEARISH} / NEUTRAL ${dist.NEUTRAL}`);

  // 4. Outcomes join.
  const ids = last50.map(r => r.signal_id);
  const outcomeMap = new Map<string, OutcomeRow>();
  const { data: outs, error: outErr } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, result, realized_r')
    .in('signal_id', ids);
  if (outErr) throw new Error(`outcome fetch: ${outErr.message}`);
  for (const o of (outs ?? []) as OutcomeRow[]) outcomeMap.set(o.signal_id, o);

  // 5. Vetoed vs remaining.
  const vetoed: { row: EmittedRow; ltf: string; outcome?: OutcomeRow }[] = [];
  const remaining: { row: EmittedRow; ltf: string; outcome?: OutcomeRow }[] = [];
  for (const row of last50) {
    const { ltf } = ltfBySignal.get(row.signal_id)!;
    const outcome = outcomeMap.get(row.signal_id);
    if (isVetoed(row.direction, row.htf_trend, ltf, row.rsi)) vetoed.push({ row, ltf, outcome });
    else remaining.push({ row, ltf, outcome });
  }
  const stats = (arr: { outcome?: OutcomeRow }[]) => {
    const decided = arr.filter(x => x.outcome && (x.outcome.result === 'WIN' || x.outcome.result === 'LOSS'));
    const wins = decided.filter(x => x.outcome!.result === 'WIN').length;
    const ev = decided.reduce((s, x) => s + (x.outcome!.realized_r ?? 0), 0);
    return { decided: decided.length, wins, wr: decided.length ? (wins / decided.length) * 100 : NaN, evR: decided.length ? ev / decided.length : NaN };
  };
  const v = stats(vetoed);
  const rem = stats(remaining);
  console.log(`\nVETOED set: n=${vetoed.length}, decided=${v.decided}, WR=${Number.isNaN(v.wr) ? '—' : v.wr.toFixed(1) + '%'}, EV=${Number.isNaN(v.evR) ? '—' : v.evR.toFixed(3) + 'R'}`);
  for (const x of vetoed) {
    console.log(`   ${x.row.emitted_at.slice(0, 16)} ${x.row.direction} @ ${Number(x.row.entry).toFixed(1)} htf=${x.row.htf_trend} ltf(rec)=${x.ltf} rsi=${x.row.rsi ?? '—'} → ${x.outcome ? `${x.outcome.result} (${x.outcome.realized_r ?? '—'}R)` : 'open'}`);
  }
  console.log(`REMAINING set: n=${remaining.length}, decided=${rem.decided}, WR=${Number.isNaN(rem.wr) ? '—' : rem.wr.toFixed(1) + '%'}, EV=${Number.isNaN(rem.evR) ? '—' : rem.evR.toFixed(3) + 'R'}`);

  // 6. The two named verification signals.
  const s3 = last50.find(r => r.direction === 'BUY' && Math.abs(Number(r.entry) - 4275.4) < 0.05);
  if (s3) {
    const ltf = ltfBySignal.get(s3.signal_id)!.ltf;
    console.log(`VERIFY #3 (BUY @ 4275.4): htf=${s3.htf_trend} ltf(rec)=${ltf} rsi=${s3.rsi} → vetoed=${isVetoed(s3.direction, s3.htf_trend, ltf, s3.rsi)} (expected TRUE)`);
  } else {
    console.log('VERIFY #3 (BUY @ 4275.4): row not in the last 50');
  }
  const s1 = last50.find(r => r.direction === 'SELL' && Math.abs(Number(r.entry) - 4309.6) < 0.05);
  if (s1) {
    const ltf = ltfBySignal.get(s1.signal_id)!.ltf;
    console.log(`VERIFY #1 (SELL @ 4309.6): htf=${s1.htf_trend} ltf(rec)=${ltf} → vetoed=${isVetoed(s1.direction, s1.htf_trend, ltf, s1.rsi)} (expected FALSE — HTF BEARISH, gate needs BULLISH)`); 
  } else {
    console.log('VERIFY #1 (SELL @ 4309.6): row not in the last 50');
  }

  // 7. SHIP GATE.
  if (!Number.isNaN(v.wr) && !Number.isNaN(rem.wr) && v.decided > 0) {
    const noShip = v.wr > rem.wr;
    console.log(`\nSHIP GATE: vetoed WR ${v.wr.toFixed(1)}% (n=${v.decided}) vs remaining WR ${rem.wr.toFixed(1)}% (n=${rem.decided}) → ${noShip ? 'VETOED SET BETTER — ITEM 5 MUST NOT SHIP' : 'gate PASSES — Item 5 ships'}`);
  } else {
    console.log(`\nSHIP GATE: UNDECIDABLE — vetoed decided=${v.decided} (need ≥ 1 decided outcome per side; open signals excluded)`);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
