/**
 * ITEM 85 — THE OUTCOME-DERIVED REVERSAL METRIC.
 *
 * The engine's largest single scoring feature (`sr_zone_strong_reversal`, +37.50%
 * on the 17 Aug signal) keys off `reactionStrength`. Both formulas for that metric
 * are NEGATIVELY correlated with the true reversal rate:
 *   corr(legacy reaction_strength, trueRate) = -0.2506
 *   corr(new    reaction_strength, trueRate) = -0.2601
 *
 * This script builds the alternative: reaction_strength := reversals /
 * decided_approaches, computed directly from bars. It then tests whether that
 * metric PERSISTS FORWARD — does a zone's reversal rate in one period predict its
 * reversal rate in a LATER period? An in-sample correlation of 1.0 is trivially
 * true and proves nothing.
 *
 * DESIGN — two non-overlapping windows:
 *   Window 1 (in-sample):  t-10d → t-5d  → compute zones + their reversal rate
 *   Window 2 (held-out):   t-5d  → now    → measure each zone's forward reversal rate
 *
 *   corr(reversal_rate_w1, reversal_rate_w2) is the held-out correlation.
 *
 * READ-ONLY against Supabase via the anon key (DATA-SOURCE RULE).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return env;
};

async function fetchBars(
  client: ReturnType<typeof createClient>,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const out: Bar[] = [];
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', fromIso)
      .lte('timestamp', toIso)
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) {
      out.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

function computeATR(bars: Bar[]): number {
  if (bars.length < 2) return 1;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 1;
}

interface Zone {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  legacyReactionStrength: number;
  confluenceScore: number;
  source: string;
}

/**
 * Compute zones from bars — verbatim port of the Edge Function's clustering +
 * scoring, holding touchAtrMult at the shipped 0.3 and the floor at
 * currentPrice * 0.0001. This is the SAME algorithm analyzeRound3B.ts uses.
 */
function computeZones(bars: Bar[], now: number): { zones: Zone[]; atr: number; touchWidth: number } {
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const timestamps = bars.map((b) => b.timestamp);
  const currentPrice = closes[closes.length - 1];
  const atr = computeATR(bars);
  const touchWidth = Math.max(atr * 0.3, currentPrice * 0.0001);
  const mergeWidth = Math.max(atr * 0.5, currentPrice * 0.0001);

  const candidates: { price: number; source: string; alwaysAdmit?: boolean }[] = [];
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
  const yIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yIdx.length > 0) {
    const yHigh = Math.max(...yIdx.map((t) => highs[t.i]));
    const yLow = Math.min(...yIdx.map((t) => lows[t.i]));
    const yClose = closes[yIdx[yIdx.length - 1].i];
    candidates.push({ price: yHigh, source: 'PREV_DAY', alwaysAdmit: true });
    candidates.push({ price: yLow, source: 'PREV_DAY', alwaysAdmit: true });
    const dailyPivot = (yHigh + yLow + yClose) / 3;
    const dailyRange = Math.max(yHigh - yLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidates.push({ price: dailyPivot, source: 'PIVOT' });
    candidates.push({ price: yClose + zoneStep, source: 'PIVOT' });
    candidates.push({ price: yClose - zoneStep, source: 'PIVOT' });
  }
  const weekStart = now - 7 * dayMs;
  const wIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= weekStart);
  if (wIdx.length > 0) {
    candidates.push({ price: Math.max(...wIdx.map((t) => highs[t.i])), source: 'WEEKLY', alwaysAdmit: true });
    candidates.push({ price: Math.min(...wIdx.map((t) => lows[t.i])), source: 'WEEKLY', alwaysAdmit: true });
  }

  const clustered: { price: number; sources: Set<string>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < mergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
    } else {
      clustered.push({ price: c.price, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit });
    }
  }

  const HALF_LIFE_HOURS = 18;
  const zones: Zone[] = [];
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
      if (Math.abs(price - cluster.price) < touchWidth) {
        touches++;
        lastTouchTs = timestamps[i];
      }
      if (isResistance && high >= cluster.price - touchWidth && price < cluster.price) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > touchWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; }
      }
      if (!isResistance && low <= cluster.price + touchWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i - 1)]) - low;
        if (wickSize > touchWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; }
      }
    }

    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const confluenceScore = cluster.sources.size;
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const confluenceBonus = hasEarnedEvidence ? Math.min(1, confluenceScore * 0.25) : 0;

    const rawLegacy = Math.min(1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 +
      Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + confluenceBonus);
    const rawNew = Math.min(1,
      rejectionScore * 0.5 + rejectionSizeScore * 0.3 + Math.min(1, confluenceScore / 3) * 0.2);

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / 3_600_000 : 0;
    const decay = lastTouchTs > 0 ? Math.pow(0.5, ageHours / HALF_LIFE_HOURS) : 1;

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? 'RESISTANCE' : 'SUPPORT',
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(Math.min(1, rawNew * decay).toFixed(3)),
        legacyReactionStrength: parseFloat(Math.min(1, rawLegacy * decay).toFixed(3)),
        confluenceScore,
        source: [...cluster.sources].sort().join(','),
      });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return { zones: zones.slice(0, 32), atr, touchWidth };
}

/**
 * True reversal rate: how often does price approach a zone and REVERSE vs
 * trade through it?
 *
 * An "approach" is when price comes within `width` of the zone. After
 * approaching, the outcome is decided when price EITHER:
 *   - moves >= `reversalThreshold` AWAY from the zone (reversal), or
 *   - closes beyond `zone.price ± width` on the far side (trade-through).
 *
 * Both `width` and `reversalThreshold` are in ATR units so they scale with
 * volatility — the same unit the zone width itself uses.
 */
function trueReversalRate(
  zone: { price: number; type: 'SUPPORT' | 'RESISTANCE' },
  bars: Bar[],
  atr: number,
  width: number,
  reversalThreshold: number,
): { approaches: number; reversals: number; tradeThroughs: number; rate: number; decided: number } {
  const threshold = reversalThreshold * atr;
  let approaches = 0;
  let reversals = 0;
  let tradeThroughs = 0;
  let inApproach = false;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const near = Math.abs(b.close - zone.price) < width
      || (zone.type === 'RESISTANCE' && b.high >= zone.price - width && b.close < zone.price)
      || (zone.type === 'SUPPORT' && b.low <= zone.price + width && b.close > zone.price);

    if (!inApproach && near) { inApproach = true; approaches++; continue; }

    if (inApproach) {
      const through = zone.type === 'RESISTANCE'
        ? b.close > zone.price + width
        : b.close < zone.price - width;
      const away = zone.type === 'RESISTANCE'
        ? zone.price - b.close >= threshold
        : b.close - zone.price >= threshold;
      if (through) { tradeThroughs++; inApproach = false; }
      else if (away) { reversals++; inApproach = false; }
    }
  }
  const decided = reversals + tradeThroughs;
  return { approaches, reversals, tradeThroughs, rate: decided > 0 ? reversals / decided : 0, decided };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy);
}

const GATE_THRESHOLD = 0.3;

async function main(): Promise<void> {
  const line = '='.repeat(84);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials in expo/.env'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const w1Start = now - 10 * dayMs;
  const w1End = now - 5 * dayMs;
  const w2Start = now - 5 * dayMs;
  const w2End = now;

  console.log(`\n${line}`);
  console.log('ITEM 85 — OUTCOME-DERIVED REVERSAL METRIC');
  console.log(line);
  console.log(`  Window 1 (in-sample): ${new Date(w1Start).toISOString()} -> ${new Date(w1End).toISOString()}`);
  console.log(`  Window 2 (held-out) : ${new Date(w2Start).toISOString()} -> ${new Date(w2End).toISOString()}`);

  const w1Bars = await fetchBars(client, w1Start, w1End);
  const w2Bars = await fetchBars(client, w2Start, w2End);
  console.log(`  W1 bars: ${w1Bars.length}`);
  console.log(`  W2 bars: ${w2Bars.length}`);
  if (w1Bars.length < 500 || w2Bars.length < 500) {
    console.error(`BLOCKER: insufficient bars (W1=${w1Bars.length}, W2=${w2Bars.length})`);
    process.exit(1);
  }

  // Compute zones from window 1, using w1End as "now" (the end of the in-sample period).
  const { zones, atr, touchWidth } = computeZones(w1Bars, w1End);
  console.log(`  zones computed from W1: ${zones.length}  (ATR ${atr.toFixed(4)}, touchWidth ${touchWidth.toFixed(4)})`);

  // Reversal threshold: 1.0 ATR (same as analyzeRound3B.ts trueReversalRate).
  const reversalThreshold = 1.0 * atr;

  // For each zone, compute the true reversal rate in BOTH windows.
  // Only zones with >= MIN_DECIDED approaches in W1 are scored — below that the
  // rate is statistically meaningless (1/1 = 100% is not evidence).
  console.log(`\n  MIN_DECIDED floor derivation:`);
  console.log(`    A reversal rate of 0.0 or 1.0 from n=1 is uninformative (binomial SE ~0.5).`);
  console.log(`    n=3 gives SE ~0.29 — the minimum at which 0.0 vs 0.67 vs 1.0 are distinguishable.`);
  console.log(`    Floor: MIN_DECIDED = 3 (consistent with the B20 re-run in analyzeRound3B.ts).`);
  const MIN_DECIDED = 3;

  interface ZonePair {
    zone: Zone;
    w1: { approaches: number; reversals: number; tradeThroughs: number; rate: number; decided: number };
    w2: { approaches: number; reversals: number; tradeThroughs: number; rate: number; decided: number };
  }
  const pairs: ZonePair[] = [];

  console.log(`\n  ZONE-BY-ZONE REVERSAL RATES (W1 in-sample vs W2 held-out):`);
  console.log('     price       type  W1:appr  rev  thru  rate  |  W2:appr  rev  thru  rate  |  legacy    new');
  for (const z of zones) {
    const w1 = trueReversalRate(z, w1Bars, atr, touchWidth, reversalThreshold);
    const w2 = trueReversalRate(z, w2Bars, atr, touchWidth, reversalThreshold);
    if (w1.decided >= MIN_DECIDED) {
      pairs.push({ zone: z, w1, w2 });
      console.log(
        `    ${z.price.toFixed(1).padStart(8)} ${z.type.padStart(10)} ` +
        `${String(w1.approaches).padStart(5)} ${String(w1.reversals).padStart(4)} ${String(w1.tradeThroughs).padStart(5)} ${w1.rate.toFixed(3).padStart(7)}  |  ` +
        `${String(w2.approaches).padStart(5)} ${String(w2.reversals).padStart(4)} ${String(w2.tradeThroughs).padStart(5)} ${w2.rate.toFixed(3).padStart(7)}  |  ` +
        `${z.legacyReactionStrength.toFixed(3).padStart(6)} ${z.reactionStrength.toFixed(3).padStart(6)}`,
      );
    } else {
      console.log(
        `    ${z.price.toFixed(1).padStart(8)} ${z.type.padStart(10)} ` +
        `${String(w1.approaches).padStart(5)} ${String(w1.reversals).padStart(4)} ${String(w1.tradeThroughs).padStart(5)} ${w1.rate.toFixed(3).padStart(7)}  |  ` +
        `INSUFFICIENT_DATA (decided=${w1.decided} < ${MIN_DECIDED})`,
      );
    }
  }

  console.log(`\n  zones with >= ${MIN_DECIDED} decided approaches in W1: ${pairs.length} of ${zones.length}`);

  if (pairs.length < 5) {
    console.log('\n  BLOCKED: fewer than 5 zones with sufficient data. Cannot compute a meaningful correlation.');
    console.log('  The zone population is too sparse for this metric to be validated.');
    process.exit(0);
  }

  // ── 85(b): HELD-OUT CORRELATION ───────────────────────────────────────────
  const w1Rates = pairs.map((p) => p.w1.rate);
  const w2Rates = pairs.map((p) => p.w2.rate);
  const corrHeldOut = pearson(w1Rates, w2Rates);

  // Also compute in-sample correlations for the existing metrics, for comparison.
  const corrLegacyVsW1 = pearson(pairs.map((p) => p.zone.legacyReactionStrength), w1Rates);
  const corrNewVsW1 = pearson(pairs.map((p) => p.zone.reactionStrength), w1Rates);
  const corrLegacyVsW2 = pearson(pairs.map((p) => p.zone.legacyReactionStrength), w2Rates);
  const corrNewVsW2 = pearson(pairs.map((p) => p.zone.reactionStrength), w2Rates);

  console.log(`\n${line}`);
  console.log('85(b) — HELD-OUT CORRELATION');
  console.log(line);
  console.log(`  n = ${pairs.length} zones (W1 decided >= ${MIN_DECIDED})`);
  console.log(``);
  console.log(`  PRIMARY METRIC: outcome-derived reversal rate (W1 → W2)`);
  console.log(`    corr(reversal_rate_W1, reversal_rate_W2) = ${corrHeldOut.toFixed(4)}`);
  console.log(`    GATE (>= +${GATE_THRESHOLD} and positive): ${corrHeldOut >= GATE_THRESHOLD && corrHeldOut > 0 ? 'PASS' : 'FAIL'}`);
  console.log(``);
  console.log(`  COMPARISON — existing metrics vs held-out W2 reversal rate:`);
  console.log(`    corr(legacy_reaction_strength, W2 trueRate) = ${corrLegacyVsW2.toFixed(4)}`);
  console.log(`    corr(new    reaction_strength, W2 trueRate) = ${corrNewVsW2.toFixed(4)}`);
  console.log(``);
  console.log(`  IN-SAMPLE (for reference only — proves nothing about forward prediction):`);
  console.log(`    corr(legacy_reaction_strength, W1 trueRate) = ${corrLegacyVsW1.toFixed(4)}`);
  console.log(`    corr(new    reaction_strength, W1 trueRate) = ${corrNewVsW1.toFixed(4)}`);
  console.log(`    corr(reversal_rate_W1, reversal_rate_W1)   = 1.0000 (trivially true)`);

  // ── 85(c): RE-SCORE THE 17 AUG SIGNAL IF GATE PASSES ──────────────────────
  console.log(`\n${line}`);
  console.log('85(c) — RE-SCORE THE 17 AUG SIGNAL');
  console.log(line);

  // The 17 Aug signal was a SELL at ~4395 with the nearest RESISTANCE zone at
  // reactionStrength ~0.999. The contribution was:
  //   reactionBoost=0.25 (STRONG_REVERSAL)
  //   zoneMultiplier = min(1.5, 0.8 + 0.999) = 1.5
  //   finalStrength = 0.25 * 1.5 = 0.375 = +37.50%
  //
  // Fetch the LIVE stored snapshot for signal_1786972983837_ok8k8tofc to get
  // the exact zone that scored it.
  const { data: sigRow, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, atr, sr_zones_snapshot, attention_scores')
    .eq('signal_id', 'signal_1786972983837_ok8k8tofc')
    .single();
  if (sigErr || !sigRow) {
    console.log('  signal_1786972983837_ok8k8tofc not found — using the known values from prior rounds.');
    console.log('  Known: RESISTANCE zone reactionStrength=0.999, reactionBoost=0.25 (STRONG_REVERSAL)');
    // Use the known values.
    const oldRs = 0.999;
    const oldMultiplier = Math.min(1.5, 0.8 + oldRs);
    const oldContribution = 0.25 * oldMultiplier;
    console.log(`\n  OLD (anti-predictive metric):`);
    console.log(`    reactionStrength = ${oldRs.toFixed(3)}`);
    console.log(`    zoneMultiplier  = min(1.5, 0.8 + ${oldRs.toFixed(3)}) = ${oldMultiplier.toFixed(3)}`);
    console.log(`    contribution    = 0.25 * ${oldMultiplier.toFixed(3)} = ${(oldContribution * 100).toFixed(2)}%`);
    console.log(`    This is ${((oldContribution / 0.375) * 100).toFixed(1)}% of the 0.375 = +37.50% headline.`);
  } else {
    const snap = sigRow.sr_zones_snapshot as unknown;
    const zones = (Array.isArray(snap) ? snap : []) as { price?: unknown; type?: unknown; reactionStrength?: unknown; touches?: unknown }[];
    console.log(`  signal_id: ${sigRow.signal_id}`);
    console.log(`  emitted_at: ${sigRow.emitted_at}`);
    console.log(`  direction: ${sigRow.direction}`);
    console.log(`  entry: ${sigRow.entry}`);
    console.log(`  atr: ${sigRow.atr}`);
    console.log(`  zones in snapshot: ${zones.length}`);

    // Find the nearest RESISTANCE zone (the one that scored the SELL).
    const entry = Number(sigRow.entry);
    const resistances = zones
      .filter((z) => String(z.type) === 'RESISTANCE')
      .map((z) => ({ price: Number(z.price), reactionStrength: Number(z.reactionStrength), touches: Number(z.touches ?? 0) }))
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

    if (resistances.length > 0) {
      const nearest = resistances[0];
      console.log(`\n  nearest RESISTANCE zone: @ ${nearest.price.toFixed(1)} (reactionStrength=${nearest.reactionStrength.toFixed(3)}, touches=${nearest.touches})`);

      // Now compute what the outcome-derived metric would give for this zone.
      // Fetch bars around the signal time to compute the true reversal rate.
      const sigTs = new Date(sigRow.emitted_at).getTime();
      const sigBars = await fetchBars(client, sigTs - 5 * dayMs, sigTs);
      const sigAtr = computeATR(sigBars.slice(-14));
      const sigWidth = Math.max(sigAtr * 0.3, entry * 0.0001);
      const sigReversal = trueReversalRate(
        { price: nearest.price, type: 'RESISTANCE' },
        sigBars,
        sigAtr,
        sigWidth,
        1.0 * sigAtr,
      );
      const outcomeDerivedRs = sigReversal.decided >= MIN_DECIDED ? sigReversal.rate : NaN;

      console.log(`\n  OUTCOME-DERIVED metric for this zone (computed from 5d of bars before the signal):`);
      console.log(`    approaches=${sigReversal.approaches} reversals=${sigReversal.reversals} tradeThroughs=${sigReversal.tradeThroughs} decided=${sigReversal.decided}`);
      console.log(`    true reversal rate = ${outcomeDerivedRs.toFixed(3)}${sigReversal.decided < MIN_DECIDED ? ' (INSUFFICIENT_DATA)' : ''}`);

      // Old contribution
      const oldMultiplier = Math.min(1.5, 0.8 + nearest.reactionStrength);
      const oldContribution = 0.25 * oldMultiplier;
      console.log(`\n  OLD (anti-predictive metric):`);
      console.log(`    reactionStrength = ${nearest.reactionStrength.toFixed(3)}`);
      console.log(`    zoneMultiplier  = min(1.5, 0.8 + ${nearest.reactionStrength.toFixed(3)}) = ${oldMultiplier.toFixed(3)}`);
      console.log(`    contribution    = 0.25 * ${oldMultiplier.toFixed(3)} = +${(oldContribution * 100).toFixed(2)}%`);

      if (!Number.isNaN(outcomeDerivedRs)) {
        // New contribution — if the outcome-derived metric replaces reactionStrength
        const newMultiplier = Math.min(1.5, 0.8 + outcomeDerivedRs);
        const newContribution = 0.25 * newMultiplier;
        console.log(`\n  NEW (outcome-derived metric):`);
        console.log(`    reactionStrength = ${outcomeDerivedRs.toFixed(3)} (true reversal rate)`);
        console.log(`    zoneMultiplier  = min(1.5, 0.8 + ${outcomeDerivedRs.toFixed(3)}) = ${newMultiplier.toFixed(3)}`);
        console.log(`    contribution    = 0.25 * ${newMultiplier.toFixed(3)} = +${(newContribution * 100).toFixed(2)}%`);
        console.log(`\n  Does +${(oldContribution * 100).toFixed(2)}% survive? ${newContribution >= 0.15 ? 'YES (reduced but still contributes)' : 'NO (contribution collapses)'}`);
        console.log(`  Does it still support SELL? YES (zone type is RESISTANCE, direction unchanged)`);
        console.log(`  The DIRECTION does not change — only the MAGNITUDE of the boost shrinks.`);
      } else {
        console.log(`\n  NEW: INSUFFICIENT_DATA — zone would be marked INSUFFICIENT_DATA, no boost applied.`);
        console.log(`  The +${(oldContribution * 100).toFixed(2)}% would NOT survive — it drops to 0.`);
        console.log(`  Direction support for SELL would come from other features only.`);
      }
    } else {
      console.log('  No RESISTANCE zones in snapshot — cannot re-score.');
    }
  }

  console.log('');
}

main().catch((err: unknown) => {
  console.error('item85 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
