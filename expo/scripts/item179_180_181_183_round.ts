/**
 * ITEMS 179 / 180 / 181 / 183 — measurement round (2026-08-21).
 *
 * 179(e) baseline + 183(a): feature-populated trend by day; clean-row accrual
 *       rate over the last 7 days from the DATA; revised n=200 date.
 * 180(b): reconstruct the zone map at the 4565 signal's emission timestamp from
 *       gold_m1_bars (verbatim computeZones port, 120h lookback) and check the
 *       user's three demand shelves.
 * 180(c): near/far entry-quality split re-measured on LIVE maps only, using
 *       bar-derived ATR (stored backfill atr is NULL/corrupt). POWER FIRST.
 * 181(a): computeMarketStructure() + findNearbyUnmitigatedOBs() over the 24h
 *       preceding the 4565 signal. BoS/ChoCh levels vs the user's shelves.
 * 181(b): BoS-flip zone vs generic zone split on the canonical population.
 * 183(c): attention weight table — per-feature Pearson r vs realized_r with
 *       Fisher CI (Item 163 method), sorted by weight; CONTEXT-side flagged.
 *
 * MEASUREMENT ONLY — anon key, Supabase DIRECT.
 * DATA-SOURCE RULE: gold_m1_bars + sr_zones snapshots + trade_outcomes_v1 +
 * emitted_signals_v1 reads = Supabase DIRECT via anon key.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { computeMarketStructure, findNearbyUnmitigatedOBs } from '../services/marketStructure';

function loadEnv() {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

/* ───────────────────────── shared types & ports ───────────────────────── */

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface ZoneSnap { price: number; type: string; reactionStrength: number; touches: number; rejectionWicks: number; source: string; confluenceScore: number }
interface OutcomeRow { signal_id: string; ts: string; result: string; realized_r: number | null; is_scratch: boolean | null; features: Record<string, unknown> | null }
interface SignalRow {
  signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL'; entry: number;
  atr: number | null; source: string;
  sr_zones_snapshot: unknown; attention_scores: unknown;
}
interface AttentionEntry { side: string; score: number; feature: string; signedScore: number; opposesSignal: boolean }

/** ATR(14) — verbatim port of the item137 calculateRealATR port. */
function computeATR14(bars: { high: number; low: number; close: number }[], endIdx: number, period = 14): number | null {
  if (endIdx < period) return null;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

/** Verbatim port of srZones.ts computeZonesFromBars() (computeAndWriteZones.ts:117-269). */
function computeZones(bars: Bar[], now: number): ZoneSnap[] {
  if (bars.length < 50) return [];
  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const closes = bars.map((b) => Number(b.close));
  const timestamps = bars.map((b) => b.timestamp);
  const currentPrice = closes[closes.length - 1];
  const ZONE_STALENESS_HALF_LIFE_HOURS = 18;

  let atrSum = 0;
  let atrCount = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atrSum += tr;
    atrCount++;
  }
  const atr = atrCount > 0 ? atrSum / atrCount : currentPrice * 0.001;
  const ZONE_WIDTH_FLOOR_PCT = 0.0001;
  const zoneWidth = Math.max(atr * 0.3, currentPrice * ZONE_WIDTH_FLOOR_PCT);

  type Candidate = { price: number; source: string; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      candidates.push({ price: highs[i], source: 'PRICE_ACTION' });
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      candidates.push({ price: lows[i], source: 'PRICE_ACTION' });
    }
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yesterdayIdx.length > 0) {
    const yHigh = Math.max(...yesterdayIdx.map((t) => highs[t.i]));
    const yLow = Math.min(...yesterdayIdx.map((t) => lows[t.i]));
    const yOpen = closes[yesterdayIdx[0].i];
    const yClose = closes[yesterdayIdx[yesterdayIdx.length - 1].i];
    candidates.push({ price: yHigh, source: 'PREV_DAY', alwaysAdmit: true });
    candidates.push({ price: yLow, source: 'PREV_DAY', alwaysAdmit: true });
    candidates.push({ price: yOpen, source: 'PREV_DAY', alwaysAdmit: true });
    const dailyPivot = (yHigh + yLow + yClose) / 3;
    const dailyRange = Math.max(yHigh - yLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidates.push({ price: dailyPivot, source: 'PIVOT' });
    candidates.push({ price: yClose + zoneStep, source: 'PIVOT' });
    candidates.push({ price: yClose - zoneStep, source: 'PIVOT' });
  }
  const weekMs = 7 * dayMs;
  const weekStart = now - weekMs;
  const weekIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({ price: Math.max(...weekIdx.map((t) => highs[t.i])), source: 'WEEKLY', alwaysAdmit: true });
    candidates.push({ price: Math.min(...weekIdx.map((t) => lows[t.i])), source: 'WEEKLY', alwaysAdmit: true });
  }

  const clustered: { price: number; source: string; sources: Set<string>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < zoneWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      if (c.source === 'PRICE_ACTION') existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit });
    }
  }

  const zones: ZoneSnap[] = [];
  for (const cluster of clustered) {
    let touches = 0;
    let rejectionWicks = 0;
    let totalRejectionSize = 0;
    let lastTouchTs = 0;
    const isResistance = cluster.price > currentPrice;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i];
      const high = highs[i];
      const low = lows[i];
      if (Math.abs(price - cluster.price) < zoneWidth) {
        touches++;
        lastTouchTs = timestamps[i];
      }
      if (isResistance && high >= cluster.price - zoneWidth && price < cluster.price) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
      if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i - 1)]) - low;
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
    }
    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const confluenceScore = cluster.sources.size;
    const confluenceBonus = Math.min(1, confluenceScore * 0.25);
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
    const rawReactionStrength = Math.min(
      1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 +
        Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + effectiveConfluenceBonus,
    );
    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);
    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? 'RESISTANCE' : 'SUPPORT',
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        source: cluster.source,
        confluenceScore,
      });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

/** Pearson r + Fisher CI (Item 163 method). */
function pearsonWithCI(pairs: Array<[number, number]>): { n: number; r: number; lo: number; hi: number } | null {
  const n = pairs.length;
  if (n < 10) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const num = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = Math.sqrt(pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0) * pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0));
  if (den <= 0) return null;
  const r = num / den;
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(n - 3);
  const lo = Math.tanh(z - 1.96 * se);
  const hi = Math.tanh(z + 1.96 * se);
  return { n, r, lo, hi };
}

function summarizeR(values: number[]): { n: number; wr: number; ev: number; ciLo: number; ciHi: number; wilsonLo: number; wilsonHi: number } {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const se = sd / Math.sqrt(n);
  const wins = values.filter((v) => v > 0).length;
  // Wilson 95% CI for the win rate.
  const p = wins / n;
  const z = 1.96;
  const denomW = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denomW;
  const halfW = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denomW;
  return { n, wr: p * 100, ev: mean, ciLo: mean - 1.96 * se, ciHi: mean + 1.96 * se, wilsonLo: (centre - halfW) * 100, wilsonHi: (centre + halfW) * 100 };
}

async function fetchAllBars(): Promise<Bar[]> {
  const out: Bar[] = [];
  let offset = 0;
  for (let page = 0; page < 120; page++) {
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch failed: ${error.message}`);
    const batch = (data ?? []) as Array<{ timestamp: string; open: number; high: number; low: number; close: number }>;
    for (const r of batch) {
      out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return out;
}

async function main() {
  const TARGET = 'signal_1787295208116_i44ilxit7';
  const TARGET_EMITTED_MS = Date.parse('2026-08-21T06:53:28.117Z');
  const TARGET_ENTRY = 4566.3;
  const TARGET_ATR = 1.9;
  const USER_SHELVES: Array<[string, number, number]> = [
    ['shelf1 ~4508-4512', 4505, 4515],
    ['shelf2 ~4528-4532', 4525, 4535],
    ['shelf3 ~4547-4551', 4544, 4554],
  ];

  console.log('=== fetching bars + signals + outcomes (anon, DIRECT) ===');
  const bars = await fetchAllBars();
  const { data: sigsRaw } = await supabase
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, atr, source, sr_zones_snapshot, attention_scores')
    .order('emitted_at', { ascending: true });
  const sigs = (sigsRaw ?? []) as SignalRow[];
  const { data: outcomesRaw } = await supabase.from('trade_outcomes_v1').select('signal_id, ts, result, realized_r, is_scratch, features');
  const outcomes = (outcomesRaw ?? []) as OutcomeRow[];
  const outcomeById = new Map(outcomes.map((o) => [o.signal_id, o]));
  console.log(`bars=${bars.length} signals=${sigs.length} outcomes=${outcomes.length}`);

  /* ─────────── 179(e) baseline + 183(a): feature trend + accrual ─────────── */
  console.log('\n=== 183(a) FEATURE-POPULATED TREND BY DAY (trade_outcomes_v1) ===');
  const byDay = new Map<string, { total: number; populated: number; clean: number }>();
  for (const o of outcomes) {
    const day = o.ts.slice(0, 10);
    const f = o.features ?? {};
    const populated = typeof (f as Record<string, unknown>).atr === 'number' && (f as Record<string, unknown>).atr !== null;
    const clean = populated && o.is_scratch !== true && typeof o.realized_r === 'number' && o.result !== null;
    const d = byDay.get(day) ?? { total: 0, populated: 0, clean: 0 };
    d.total += 1;
    if (populated) d.populated += 1;
    if (clean) d.clean += 1;
    byDay.set(day, d);
  }
  const days = [...byDay.keys()].sort();
  for (const day of days.slice(-10)) {
    const d = byDay.get(day)!;
    console.log(`  ${day}: total=${d.total} populated=${d.populated} clean=${d.clean}`);
  }
  const last7Start = '2026-08-14';
  const last7 = days.filter((d) => d >= last7Start);
  const clean7 = last7.reduce((s, d) => s + byDay.get(d)!.clean, 0);
  const totalClean = [...byDay.values()].reduce((s, d) => s + d.clean, 0);
  const totalPopulated = [...byDay.values()].reduce((s, d) => s + d.populated, 0);
  const ratePerDay = clean7 / 7;
  const rowsTo200 = Math.max(0, 200 - totalClean);
  const daysTo200 = ratePerDay > 0 ? rowsTo200 / ratePerDay : Infinity;
  console.log(`  CLEAN accrual last 7d (ts>=${last7Start}): ${clean7} rows => ${ratePerDay.toFixed(2)}/day`);
  console.log(`  totals: populated=${totalPopulated}/${outcomes.length} (${((totalPopulated / outcomes.length) * 100).toFixed(1)}%) clean=${totalClean}`);
  console.log(`  revised n=200: ${totalClean} clean now, need ${rowsTo200} more => ~${Number.isFinite(daysTo200) ? daysTo200.toFixed(0) : 'inf'} days => ~${Number.isFinite(daysTo200) ? new Date(Date.now() + daysTo200 * 86400e3).toISOString().slice(0, 10) : 'never'} at current rate`);

  /* ─────────── 180(b): zone map reconstruction at the 4565 signal ─────────── */
  console.log('\n=== 180(b) ZONE MAP RECONSTRUCTION at emission 2026-08-21T06:53:28Z (120h lookback, verbatim computeZones port) ===');
  const lookbackStart = TARGET_EMITTED_MS - 120 * 3600e3;
  const windowBars = bars.filter((b) => b.timestamp >= lookbackStart && b.timestamp <= TARGET_EMITTED_MS);
  console.log(`  window bars: ${windowBars.length} (${new Date(lookbackStart).toISOString()} → ${new Date(TARGET_EMITTED_MS).toISOString()})`);
  const recon = computeZones(windowBars, TARGET_EMITTED_MS);
  console.log(`  reconstructed zones: ${recon.length}`);
  const reconSup = recon.filter((z) => z.type === 'SUPPORT');
  const reconRes = recon.filter((z) => z.type === 'RESISTANCE');
  console.log(`  SUPPORT=${reconSup.length} RESISTANCE=${reconRes.length} (0 opposing for BUY => ${reconRes.length === 0 ? 'CONFIRMED' : 'REFUTED'})`);
  for (const [label, lo, hi] of USER_SHELVES) {
    const inRange = recon.filter((z) => z.price >= lo && z.price <= hi);
    console.log(`  ${label}: ${inRange.length === 0 ? 'ABSENT from reconstruction' : inRange.map((z) => `${z.price} ${z.type} rs=${z.reactionStrength} t=${z.touches} w=${z.rejectionWicks}`).join(' | ')}`);
  }
  console.log('  nearest SUPPORT zones below entry:');
  for (const z of reconSup.filter((z) => z.price < TARGET_ENTRY).sort((a, b) => b.price - a.price).slice(0, 6)) {
    console.log(`    ${z.price} rs=${z.reactionStrength} touches=${z.touches} wicks=${z.rejectionWicks} src=${z.source}`);
  }
  // Why is shelf1 absent? Report swing-low candidates near 4505-4515 regardless of admission.
  const candLows = windowBars
    .map((b, i) => ({ i, low: b.low }))
    .filter(({ i }) => i >= 2 && i < windowBars.length - 2)
    .filter(({ i }) =>
      windowBars[i].low < windowBars[i - 1].low && windowBars[i].low < windowBars[i - 2].low &&
      windowBars[i].low < windowBars[i + 1].low && windowBars[i].low < windowBars[i + 2].low)
    .filter(({ low }) => low >= 4500 && low <= 4520)
    .map(({ i, low }) => `${low.toFixed(1)}@${new Date(windowBars[i].timestamp).toISOString().slice(5, 16)}`);
  console.log(`  swing-low fractals in 4500-4520 window: ${candLows.length === 0 ? 'NONE (price never printed a fractal low there in the 120h window)' : candLows.join(', ')}`);
  const priceMin = Math.min(...windowBars.map((b) => b.low));
  const priceMax = Math.max(...windowBars.map((b) => b.high));
  console.log(`  120h price range: ${priceMin.toFixed(1)} → ${priceMax.toFixed(1)}`);

  /* ─────────── 181(a): market structure at the 4565 signal ─────────── */
  console.log('\n=== 181(a) MARKET STRUCTURE 24h preceding the 4565 signal (computeMarketStructure lookback=5) ===');
  const structBars = bars.filter((b) => b.timestamp >= TARGET_EMITTED_MS - 24 * 3600e3 && b.timestamp <= TARGET_EMITTED_MS);
  console.log(`  24h bars: ${structBars.length}`);
  const structure = computeMarketStructure(structBars, 5);
  console.log(`  prevailingTrend=${structure.prevailingTrend} events=${structure.structureEvents.length} OBs=${structure.orderBlocks.length}`);
  for (const ev of structure.structureEvents) {
    console.log(`    ${ev.type} ${ev.direction} @ ${new Date(ev.timestamp).toISOString().slice(5, 16)} swingBroken=${ev.swingBroken.toFixed(1)} breakout=${ev.breakoutPrice.toFixed(1)}`);
  }
  const unmit = findNearbyUnmitigatedOBs(structure, TARGET_ENTRY, TARGET_ATR, 3);
  console.log(`  unmitigated OBs within 3 ATR of ${TARGET_ENTRY}: ${unmit.length}`);
  for (const ob of unmit) {
    console.log(`    ${ob.direction} OB [${ob.low.toFixed(1)} - ${ob.high.toFixed(1)}] ${new Date(ob.startTime).toISOString().slice(5, 16)}→${new Date(ob.endTime).toISOString().slice(5, 16)}`);
  }
  for (const [label, lo, hi] of USER_SHELVES) {
    const flipLevels = structure.structureEvents.filter((ev) => ev.swingBroken >= lo - 1 && ev.swingBroken <= hi + 1);
    const obHits = structure.orderBlocks.filter((ob) => ob.high >= lo && ob.low <= hi);
    console.log(`  ${label}: BoS/ChoCh swingBroken coincidences=${flipLevels.map((e) => `${e.type}/${e.direction}@${e.swingBroken.toFixed(1)}`).join(',') || 'none'} | OB overlaps=${obHits.map((o) => `${o.direction}[${o.low.toFixed(1)}-${o.high.toFixed(1)}]`).join(',') || 'none'}`);
  }

  /* ─────────── 180(c): near/far entry-quality split on LIVE maps ─────────── */
  console.log('\n=== 180(c) ENTRY-QUALITY NEAR/FAR SPLIT — LIVE MAPS ONLY, BAR-DERIVED ATR ===');
  const liveResolved = sigs.filter((s) => {
    const o = outcomeById.get(s.signal_id);
    return s.source === 'LIVE' && o !== undefined && o.is_scratch !== true && typeof o.realized_r === 'number' && Array.isArray(s.sr_zones_snapshot);
  });
  console.log(`  POWER FIRST: LIVE resolved (non-scratch, realized_r) with snapshots: n=${liveResolved.length}. At n≈20 total, a near/far split gives ~10/10 — ANY split is underpowered (a 20pp WR difference is not detectable; MDE for WR at n=10/arm ≈ ±40pp). State n before reading any result.`);
  type EQ = { distAtr: number; r: number };
  const eq: EQ[] = [];
  for (const s of liveResolved) {
    const zones = s.sr_zones_snapshot as ZoneSnap[];
    const sameSide = s.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const sameSideZones = zones.filter((z) => z.type === sameSide && (z.reactionStrength ?? 0) >= 0.3);
    if (sameSideZones.length === 0) continue;
    const nearest = sameSideZones.sort((a, b) => Math.abs(a.price - s.entry) - Math.abs(b.price - s.entry))[0];
    const sigMs = Date.parse(s.emitted_at);
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (bars[i].timestamp <= sigMs) { barIdx = i; break; }
    }
    if (barIdx < 14) continue;
    const barAtr = computeATR14(bars, barIdx, 14);
    if (barAtr === null || barAtr <= 0) continue;
    eq.push({ distAtr: Math.abs(s.entry - nearest.price) / barAtr, r: outcomeById.get(s.signal_id)!.realized_r as number });
  }
  console.log(`  entry-quality records with same-side zones: n=${eq.length}`);
  const near = eq.filter((e) => e.distAtr <= 1.0);
  const far = eq.filter((e) => e.distAtr > 1.0);
  for (const [label, arr] of [['near (≤1.0 ATR)', near], ['far (>1.0 ATR)', far]] as const) {
    if (arr.length === 0) { console.log(`  ${label}: n=0`); continue; }
    const st = summarizeR(arr.map((e) => e.r));
    console.log(`  ${label}: n=${st.n} WR=${st.wr.toFixed(1)}% (Wilson [${st.wilsonLo.toFixed(1)},${st.wilsonHi.toFixed(1)}]) EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R CI=[${st.ciLo.toFixed(3)},${st.ciHi.toFixed(3)}]`);
  }
  console.log('  fine buckets (item137 method):');
  for (const [label, lo, hi] of [['0-0.5', 0, 0.5], ['0.5-1.0', 0.5, 1.0], ['1.0-1.5', 1.0, 1.5], ['1.5-2.0', 1.5, 2.0], ['2.0-3.0', 2.0, 3.0], ['3.0+', 3.0, 999]] as const) {
    const bucket = eq.filter((e) => e.distAtr >= lo && e.distAtr < hi);
    if (bucket.length === 0) { console.log(`    ${label} ATR: n=0`); continue; }
    const st = summarizeR(bucket.map((e) => e.r));
    console.log(`    ${label} ATR: n=${st.n} WR=${st.wr.toFixed(1)}% EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R`);
  }

  /* ─────────── 181(b): BoS-flip zone vs generic zone ─────────── */
  console.log('\n=== 181(b) BoS-FLIP ZONE vs GENERIC ZONE — canonical population ===');
  const canon = sigs.filter((s) => {
    const o = outcomeById.get(s.signal_id);
    return o !== undefined && o.is_scratch !== true && typeof o.realized_r === 'number' && Array.isArray(s.sr_zones_snapshot) && (s.sr_zones_snapshot as ZoneSnap[]).length > 0;
  });
  console.log(`  POWER FIRST: canonical resolved with snapshots: n=${canon.length}. A two-arm split at this n (if it splits ~evenly) has MDE ≈ ±0.35R on EV — only large effects detectable.`);
  type BF = { flip: boolean; r: number };
  const bf: BF[] = [];
  for (const s of canon) {
    const zones = s.sr_zones_snapshot as ZoneSnap[];
    const sameSide = s.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const sameSideZones = zones.filter((z) => z.type === sameSide && (z.reactionStrength ?? 0) >= 0.3);
    if (sameSideZones.length === 0) continue;
    const nearest = sameSideZones.sort((a, b) => Math.abs(a.price - s.entry) - Math.abs(b.price - s.entry))[0];
    const sigMs = Date.parse(s.emitted_at);
    const winBars = bars.filter((b) => b.timestamp >= sigMs - 24 * 3600e3 && b.timestamp <= sigMs);
    if (winBars.length < 50) continue;
    const st = computeMarketStructure(winBars, 5);
    const tol = 1.0;
    const coincides = st.structureEvents.some((ev) =>
      Math.abs(ev.swingBroken - nearest.price) <= tol || Math.abs(ev.breakoutPrice - nearest.price) <= tol);
    bf.push({ flip: coincides, r: outcomeById.get(s.signal_id)!.realized_r as number });
  }
  const flipArm = bf.filter((b) => b.flip);
  const genericArm = bf.filter((b) => !b.flip);
  console.log(`  records: n=${bf.length} (flip=${flipArm.length} generic=${genericArm.length})`);
  for (const [label, arr] of [['BoS-flip zone', flipArm], ['generic zone', genericArm]] as const) {
    if (arr.length === 0) { console.log(`  ${label}: n=0`); continue; }
    const st = summarizeR(arr.map((b) => b.r));
    console.log(`  ${label}: n=${st.n} WR=${st.wr.toFixed(1)}% EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R CI=[${st.ciLo.toFixed(3)},${st.ciHi.toFixed(3)}]`);
  }

  /* ─────────── 183(c): attention weight table with r + CI ─────────── */
  console.log('\n=== 183(c) ATTENTION WEIGHT TABLE — score vs realized_r (Pearson + Fisher CI, Item 163 method) ===');
  const pairsByFeature = new Map<string, Array<[number, number]>>();
  const sidesByFeature = new Map<string, Set<string>>();
  for (const s of sigs) {
    const o = outcomeById.get(s.signal_id);
    if (!o || o.is_scratch === true || typeof o.realized_r !== 'number') continue;
    const att = s.attention_scores as AttentionEntry[] | null;
    if (!Array.isArray(att)) continue;
    for (const e of att) {
      if (typeof e.score !== 'number' || typeof e.feature !== 'string') continue;
      const key = e.feature;
      if (!pairsByFeature.has(key)) { pairsByFeature.set(key, []); sidesByFeature.set(key, new Set()); }
      pairsByFeature.get(key)!.push([e.score, o.realized_r as number]);
      sidesByFeature.get(key)!.add(e.side);
    }
  }
  const rows: Array<{ feature: string; medianW: number; maxW: number; sides: string; stat: { n: number; r: number; lo: number; hi: number } | null }> = [];
  for (const [feature, pairs] of pairsByFeature) {
    const sorted = pairs.map((p) => p[0]).sort((a, b) => a - b);
    const medianW = sorted[Math.floor(sorted.length / 2)];
    rows.push({ feature, medianW, maxW: sorted[sorted.length - 1], sides: [...sidesByFeature.get(feature)!].join('/'), stat: pearsonWithCI(pairs) });
  }
  rows.sort((a, b) => b.medianW - a.medianW);
  console.log('  feature                                        medianW  maxW    sides          n      r       CI');
  for (const r of rows) {
    const s = r.stat;
    console.log(`  ${r.feature.padEnd(46)} ${String(r.medianW).padStart(6)} ${String(r.maxW).padStart(6)}  ${r.sides.padEnd(13)} ${String(s ? s.n : pairsByFeature.get(r.feature)!.length).padStart(4)}  ${s ? (s.r >= 0 ? '+' : '') + s.r.toFixed(3) : '  n/a'}  ${s ? `[${s.lo.toFixed(3)},${s.hi.toFixed(3)}]` : '[n<10]'}`);
  }
  console.log('  NOTE: CONTEXT-side entries (volume_node, order_flow, high-liquidity) never call dir.addBuy/addSell — they never reach buySignalStrength/sellSignalStrength, i.e. never reach the directional decision.');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
