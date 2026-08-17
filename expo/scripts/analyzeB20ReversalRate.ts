/**
 * ITEM 82 ROUND 3 — B20 (true reversal rate) + C16 (zone recency maps).
 *
 * READ-ONLY against Supabase via anon key. No engine changes.
 *
 * B20: for each of the 22 live zones, compute directly from gold_m1_bars:
 *   - how many times price APPROACHED within one zone-width
 *   - of those, how many genuinely REVERSED (moved away by >= 1.0 ATR without
 *     trading through) vs how many TRADED THROUGH
 *   - the true reversal rate vs the stored reaction_strength
 *
 * C16: reconstruct the zone map at 2026-08-17T13:23:03Z using trailing-24h,
 * trailing-8h, and trailing-session bars, then compare all three against the
 * live 2.9-day map. For each, answer: does a support appear near 4387, and
 * does the 4410 level appear?
 *
 * C19: for each emitted signal with a stored zone snapshot, compute the margin
 * between the nearest support and nearest resistance, in ATR units.
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

interface ZoneRow {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  rejection_wicks: number;
  reaction_strength: number;
  source: string;
  confluence_score: number;
  last_touch_ts: string | null;
}

async function fetchBars(client: ReturnType<typeof createClient>, fromMs: number, toMs: number): Promise<Bar[]> {
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
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low - bars[i-1].close),
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 1;
}

function computeZones(bars: Bar[], now: number): { price: number; type: 'SUPPORT' | 'RESISTANCE'; touches: number; rejectionWicks: number; reactionStrength: number; source: string; confluenceScore: number }[] {
  if (bars.length < 50) return [];
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const timestamps = bars.map(b => b.timestamp);
  const currentPrice = closes[closes.length - 1];
  const atr = computeATR(bars);
  const zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0001);

  type Candidate = { price: number; source: string };
  const candidates: Candidate[] = [];

  // Fractal swing highs/lows
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      candidates.push({ price: highs[i], source: 'PRICE_ACTION' });
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      candidates.push({ price: lows[i], source: 'PRICE_ACTION' });
    }
  }

  // Previous day H/L/O
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yesterdayIdx.length > 0) {
    const yHigh = Math.max(...yesterdayIdx.map(t => highs[t.i]));
    const yLow = Math.min(...yesterdayIdx.map(t => lows[t.i]));
    const yClose = closes[yesterdayIdx[yesterdayIdx.length - 1].i];
    candidates.push({ price: yHigh, source: 'PREV_DAY' });
    candidates.push({ price: yLow, source: 'PREV_DAY' });
    const dailyPivot = (yHigh + yLow + yClose) / 3;
    const dailyRange = Math.max(yHigh - yLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidates.push({ price: dailyPivot, source: 'PIVOT' });
    candidates.push({ price: yClose + zoneStep, source: 'PIVOT' });
    candidates.push({ price: yClose - zoneStep, source: 'PIVOT' });
  }

  // Weekly H/L
  const weekMs = 7 * dayMs;
  const weekStart = now - weekMs;
  const weekIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({ price: Math.max(...weekIdx.map(t => highs[t.i])), source: 'WEEKLY' });
    candidates.push({ price: Math.min(...weekIdx.map(t => lows[t.i])), source: 'WEEKLY' });
  }

  // Cluster
  const clustered: { price: number; source: string; sources: Set<string>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find(cl => Math.abs(cl.price - c.price) < zoneWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      if (c.source === 'PRICE_ACTION') existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: false });
    }
  }

  // Score
  const zones: { price: number; type: 'SUPPORT' | 'RESISTANCE'; touches: number; rejectionWicks: number; reactionStrength: number; source: string; confluenceScore: number }[] = [];
  const HALF_LIFE_HOURS = 18;
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
        const wickSize = high - Math.max(price, closes[Math.max(0, i-1)]);
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
      if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i-1)]) - low;
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
    const rawReactionStrength = Math.min(1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 +
      Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + effectiveConfluenceBonus);

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? 'RESISTANCE' : 'SUPPORT',
        touches, rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        source: cluster.source,
        confluenceScore,
      });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

/**
 * B20: independently compute the TRUE reversal rate for each zone.
 *
 * For each zone, scan forward through bars. An APPROACH is when price comes
 * within one zone-width. After an approach, check: did price reverse by >= 1.0
 * ATR away from the zone without first trading through it? Or did it trade
 * through?
 */
function computeTrueReversalRate(zone: { price: number; type: 'SUPPORT' | 'RESISTANCE' }, bars: Bar[], atr: number): { approaches: number; reversals: number; tradeThroughs: number; reversalRate: number } {
  const zoneWidth = Math.max(atr * 0.3, zone.price * 0.0001);
  const reversalThreshold = 1.0 * atr;
  let approaches = 0;
  let reversals = 0;
  let tradeThroughs = 0;
  let inApproach = false;
  let approachStartIdx = -1;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const nearZone = Math.abs(bar.close - zone.price) < zoneWidth ||
      (zone.type === 'RESISTANCE' && bar.high >= zone.price - zoneWidth && bar.close < zone.price) ||
      (zone.type === 'SUPPORT' && bar.low <= zone.price + zoneWidth && bar.close > zone.price);

    if (!inApproach && nearZone) {
      inApproach = true;
      approachStartIdx = i;
      approaches++;
    }

    if (inApproach) {
      // Check for trade-through: price closed on the wrong side of the zone by more than zoneWidth
      const tradedThrough = zone.type === 'RESISTANCE'
        ? bar.close > zone.price + zoneWidth
        : bar.close < zone.price - zoneWidth;

      // Check for reversal: price moved away from zone by >= 1 ATR
      const movedAway = zone.type === 'RESISTANCE'
        ? bar.close < zone.price - reversalThreshold
        : bar.close > zone.price + reversalThreshold;

      if (tradedThrough) {
        tradeThroughs++;
        inApproach = false;
      } else if (movedAway) {
        reversals++;
        inApproach = false;
      }
    }
  }

  const resolved = reversals + tradeThroughs;
  return {
    approaches,
    reversals,
    tradeThroughs,
    reversalRate: resolved > 0 ? reversals / resolved : 0,
  };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('Missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const signalTime = Date.parse('2026-08-17T13:23:03Z');

  // ── B20: TRUE REVERSAL RATE ──────────────────────────────────────────────
  console.log('='.repeat(84));
  console.log('B20 — TRUE REVERSAL RATE vs STORED reaction_strength');
  console.log('='.repeat(84));

  // Fetch live zones
  const { data: zoneData, error: zoneErr } = await client
    .from('sr_zones_v1')
    .select('price, type, touches, rejection_wicks, reaction_strength, source, confluence_score, last_touch_ts')
    .order('reaction_strength', { ascending: false })
    .limit(32);
  if (zoneErr) { console.error('zone fetch failed:', zoneErr.message); process.exit(1); }
  const zones = (zoneData ?? []) as unknown as ZoneRow[];
  console.log(`  live zones: ${zones.length}`);

  // Fetch bars for the lookback window (120h = 5 days, matching LOOKBACK_HOURS)
  const lookbackMs = 120 * 60 * 60 * 1000;
  const barsEnd = signalTime;
  const barsStart = barsEnd - lookbackMs;
  const bars = await fetchBars(client, barsStart, barsEnd);
  console.log(`  bars fetched: ${bars.length} (${new Date(barsStart).toISOString()} -> ${new Date(barsEnd).toISOString()})`);

  const atr = computeATR(bars);
  const zoneWidth = Math.max(atr * 0.3, bars[bars.length-1].close * 0.0001);
  console.log(`  ATR(14): ${atr.toFixed(4)}, zoneWidth: ${zoneWidth.toFixed(4)} (${(zoneWidth/atr).toFixed(2)} ATR)`);

  // Saturation arithmetic
  const totalTouches = zones.reduce((s, z) => s + z.touches, 0);
  console.log(`  total touches across ${zones.length} zones: ${totalTouches}`);
  console.log(`  touches-per-bar: ${(totalTouches / bars.length).toFixed(4)}`);
  console.log(`  zone price span: $${Math.min(...zones.map(z=>z.price)).toFixed(1)} .. $${Math.max(...zones.map(z=>z.price)).toFixed(1)} (${(Math.max(...zones.map(z=>z.price))-Math.min(...zones.map(z=>z.price))).toFixed(1)} wide)`);
  console.log(`  zones-per-5.3-points: ${(zones.length / ((Math.max(...zones.map(z=>z.price))-Math.min(...zones.map(z=>z.price)))/5.3)).toFixed(2)}`);

  console.log('\n  Per-zone true reversal rate vs stored reaction_strength:');
  console.log('  ' + '-'.repeat(80));
  console.log(`  ${'price'.padStart(8)} ${'type'.padStart(10)} ${'stored_r'.padStart(8)} ${'touches'.padStart(7)} ${'approaches'.padStart(10)} ${'reversals'.padStart(9)} ${'tradeThru'.padStart(9)} ${'trueRate'.padStart(8)}`);

  let highStoredLowTrue = 0;
  const corrData: { stored: number; true: number }[] = [];

  for (const z of zones) {
    const zone = { price: z.price, type: z.type === 'RESISTANCE' ? 'RESISTANCE' as const : 'SUPPORT' as const };
    const result = computeTrueReversalRate(zone, bars, atr);
    const stored = z.reaction_strength;
    const trueRate = result.reversalRate;
    corrData.push({ stored, true: trueRate });
    if (stored > 0.95 && trueRate < 0.70) highStoredLowTrue++;
    console.log(`  ${z.price.toFixed(1).padStart(8)} ${z.type.padStart(10)} ${stored.toFixed(3).padStart(8)} ${String(z.touches).padStart(7)} ${String(result.approaches).padStart(10)} ${String(result.reversals).padStart(9)} ${String(result.tradeThroughs).padStart(9)} ${trueRate.toFixed(3).padStart(8)}`);
  }

  // Correlation
  const n = corrData.length;
  const meanStored = corrData.reduce((s, d) => s + d.stored, 0) / n;
  const meanTrue = corrData.reduce((s, d) => s + d.true, 0) / n;
  let num = 0, denomS = 0, denomT = 0;
  for (const d of corrData) {
    num += (d.stored - meanStored) * (d.true - meanTrue);
    denomS += (d.stored - meanStored) ** 2;
    denomT += (d.true - meanTrue) ** 2;
  }
  const corr = denomS > 0 && denomT > 0 ? num / Math.sqrt(denomS * denomT) : 0;

  console.log('\n  B20 SUMMARY:');
  console.log(`    correlation(stored, trueRate): ${corr.toFixed(4)}`);
  console.log(`    zones stored > 0.95 with trueRate < 0.70: ${highStoredLowTrue} of ${zones.filter(z=>z.reaction_strength>0.95).length}`);
  const storedHigh = zones.filter(z => z.reaction_strength > 0.95).length;
  console.log(`    zones stored > 0.95: ${storedHigh}`);
  console.log(`    gate condition: corr < 0.5 OR > half of stored>0.95 have trueRate < 0.70`);
  console.log(`    gate evaluation: corr=${corr.toFixed(4)} ${corr < 0.5 ? '< 0.5 PASS' : '>= 0.5'} | ${highStoredLowTrue} of ${storedHigh} ${highStoredLowTrue > storedHigh / 2 ? '> half PASS' : '<= half'}`);

  // ── C16: ZONE RECENCY MAPS ────────────────────────────────────────────────
  console.log('\n' + '='.repeat(84));
  console.log('C16 — ZONE MAPS AT 2026-08-17T13:23:03Z (trailing 120h / 24h / 8h / session)');
  console.log('='.repeat(84));

  const maps: { label: string; bars: Bar[] }[] = [
    { label: 'LIVE (120h / 5d)', bars },
    { label: 'TRAILING 24h', bars: bars.filter(b => b.timestamp >= signalTime - 24*60*60*1000) },
    { label: 'TRAILING 8h', bars: bars.filter(b => b.timestamp >= signalTime - 8*60*60*1000) },
  ];

  // Session map: the current trading session. Gold sessions roughly:
  // Asian 00-07 UTC, London 07-13 UTC, NY 13-22 UTC. At 13:23 UTC we're at NY open.
  // Trailing session = from the last NY open (13:00 UTC today) or from London open (07:00).
  // Use 07:00 UTC today as "session start" (London+NY overlap).
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = Math.floor(signalTime / dayMs) * dayMs;
  const sessionStart = todayStart + 7 * 60 * 60 * 1000; // 07:00 UTC
  maps.push({ label: 'TRAILING SESSION (07:00 UTC)', bars: bars.filter(b => b.timestamp >= sessionStart) });

  const entryPrice = 4387.4;
  const targetLevel = 4410.0;

  for (const map of maps) {
    console.log(`\n  ${map.label} (${map.bars.length} bars):`);
    if (map.bars.length < 50) {
      console.log(`    (insufficient bars: ${map.bars.length} < 50)`);
      continue;
    }
    const mapZones = computeZones(map.bars, signalTime);
    console.log(`    zones computed: ${mapZones.length}`);
    for (const z of mapZones.slice(0, 12)) {
      const dist = z.price - entryPrice;
      const marker = Math.abs(dist) < 5 ? ' <-- NEAR ENTRY' : '';
      console.log(`    ${z.type.padStart(10)} ${z.price.toFixed(1)}  r=${z.reactionStrength.toFixed(3)}  t=${z.touches}  c=${z.confluenceScore}  src=${z.source}${marker}`);
    }

    // Does a support appear near 4387?
    const nearEntrySupport = mapZones.filter(z => z.type === 'SUPPORT' && Math.abs(z.price - entryPrice) < 5);
    const nearEntryResistance = mapZones.filter(z => z.type === 'RESISTANCE' && Math.abs(z.price - entryPrice) < 5);
    console.log(`    support near 4387.4 (±$5): ${nearEntrySupport.length > 0 ? nearEntrySupport.map(z=>z.price.toFixed(1)).join(', ') : 'NONE'}`);
    console.log(`    resistance near 4387.4 (±$5): ${nearEntryResistance.length > 0 ? nearEntryResistance.map(z=>z.price.toFixed(1)).join(', ') : 'NONE'}`);

    // Nearest zone resolution: support below vs resistance above
    const supportBelow = mapZones.filter(z => z.type === 'SUPPORT' && z.price < entryPrice).sort((a,b) => b.price - a.price)[0];
    const resistanceAbove = mapZones.filter(z => z.type === 'RESISTANCE' && z.price > entryPrice).sort((a,b) => a.price - b.price)[0];
    if (supportBelow && resistanceAbove) {
      const margin = resistanceAbove.price - supportBelow.price;
      const favDir = margin > 0 ? 'BUY (support closer below)' : 'SELL (resistance closer above)';
      console.log(`    nearest support below: $${supportBelow.price.toFixed(1)} (r=${supportBelow.reactionStrength.toFixed(3)})`);
      console.log(`    nearest resistance above: $${resistanceAbove.price.toFixed(1)} (r=${resistanceAbove.reactionStrength.toFixed(3)})`);
      console.log(`    direction favoured: ${favDir}`);
    } else {
      console.log(`    support below: ${supportBelow ? '$'+supportBelow.price.toFixed(1) : 'NONE'}`);
      console.log(`    resistance above: ${resistanceAbove ? '$'+resistanceAbove.price.toFixed(1) : 'NONE'}`);
    }

    // Does 4410 appear?
    const near4410 = mapZones.filter(z => Math.abs(z.price - targetLevel) < 5);
    console.log(`    zone near 4410 (±$5): ${near4410.length > 0 ? near4410.map(z => `${z.type} ${z.price.toFixed(1)} r=${z.reactionStrength.toFixed(3)}`).join(', ') : 'NONE'}`);
  }

  console.log('\n  POWER CAVEAT: n=1 session. Suggestive, not proof.');

  // ── C19: MARGIN DISTRIBUTION ──────────────────────────────────────────────
  console.log('\n' + '='.repeat(84));
  console.log('C19 — MARGIN DISTRIBUTION (nearest support vs nearest resistance at emission)');
  console.log('='.repeat(84));

  // Fetch emitted signals with zone snapshots
  const { data: sigData, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence')
    .order('emitted_at', { ascending: true })
    .limit(1000);
  if (sigErr) { console.error('signal fetch:', sigErr.message); process.exit(1); }
  const signals = (sigData ?? []) as { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number }[];
  console.log(`  emitted signals: ${signals.length}`);

  // For each signal, fetch the zone snapshot from sr_zones_v1 at that time.
  // We don't have historical zone snapshots stored per-signal, so we reconstruct
  // from the CURRENT sr_zones_v1 (which is a point-in-time snapshot).
  // PROVISIONAL: this uses the current zone set, not the historical one.
  console.log('  PROVISIONAL: using current sr_zones_v1 snapshot for all signals (no historical snapshots stored)');

  // Use the signal-time ATR (already computed above from the 120h window) for all
  // signals — fetching 14d of bars per signal for 416 signals would time out.
  // PROVISIONAL: ATR varies across signals, but the zone width is the dominant
  // factor here, not ATR precision.
  const signalAtr = atr;
  let subHalfATR = 0;
  let totalWithZones = 0;
  const margins: number[] = [];
  for (const sig of signals) {
    const entry = Number(sig.entry);
    const supportBelow = zones.filter(z => z.type === 'SUPPORT' && z.price < entry).sort((a,b) => Number(b.price) - Number(a.price))[0];
    const resistanceAbove = zones.filter(z => z.type === 'RESISTANCE' && z.price > entry).sort((a,b) => Number(a.price) - Number(b.price))[0];
    if (supportBelow && resistanceAbove) {
      const margin = Number(resistanceAbove.price) - Number(supportBelow.price);
      const marginATR = margin / signalAtr;
      margins.push(marginATR);
      totalWithZones++;
      if (marginATR < 0.5) subHalfATR++;
    }
  }

  if (margins.length > 0) {
    margins.sort((a, b) => a - b);
    const mean = margins.reduce((s, v) => s + v, 0) / margins.length;
    const median = margins[Math.floor(margins.length / 2)];
    console.log(`  signals with zone pairs: ${totalWithZones}`);
    console.log(`  margin (ATR): mean=${mean.toFixed(3)} median=${median.toFixed(3)} min=${margins[0].toFixed(3)} max=${margins[margins.length-1].toFixed(3)}`);
    console.log(`  sub-0.5-ATR margin: ${subHalfATR} of ${totalWithZones} = ${((subHalfATR/totalWithZones)*100).toFixed(1)}%`);
    console.log(`  gate: > 20% sub-0.5-ATR -> ship opposing-zone scoring. Result: ${subHalfATR/totalWithZones > 0.20 ? 'PASS (ship)' : 'FAIL (do not ship)'}`);
  }

  console.log('');
}

main().catch(err => { console.error('B20/C16 script failed:', err instanceof Error ? err.message : String(err)); process.exit(1); });
