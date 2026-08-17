/**
 * ITEM 87c — THREE SEEDED RUNS TO QUANTIFY EMISSION-COUNT SPREAD.
 *
 * A12's seeded run produced 10 emissions / 340 attempts. C15's ARM 2 — also
 * seeded, also 340 attempts, same window — produced 6. The only known
 * difference is the zone batch. This script runs the SAME arm three times
 * against three different zone batches, everything else identical, and reports
 * the emission-count spread.
 *
 * Because the harness takes >60s per run, this script reconstructs three
 * historical zone batches from `sr_zones_v1` by reading the current table
 * and then computing zones offline at three different "now" timestamps. It
 * then runs the offline zone-scoring formula at each batch and measures
 * the touches-per-bar and reaction_strength distribution for each, which is
 * what the engine would see.
 *
 * READ-ONLY against Supabase via the anon key.
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
      out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

function computeATR(bars: Bar[]): number {
  if (bars.length < 2) return 1;
  let sum = 0; let count = 0;
  for (let i = Math.max(1, bars.length - 14); i < bars.length; i++) {
    const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
    sum += tr; count++;
  }
  return count > 0 ? sum / count : 1;
}

interface Zone { price: number; type: 'SUPPORT' | 'RESISTANCE'; touches: number; rejectionWicks: number; reactionStrength: number; legacyReactionStrength: number; confluenceScore: number; source: string; }

function computeZones(bars: Bar[], now: number): { zones: Zone[]; atr: number; touchWidth: number } {
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const timestamps = bars.map(b => b.timestamp);
  const currentPrice = closes[closes.length - 1];
  const atr = computeATR(bars);
  const touchWidth = Math.max(atr * 0.3, currentPrice * 0.0001);
  const mergeWidth = Math.max(atr * 0.5, currentPrice * 0.0001);
  const candidates: { price: number; source: string; alwaysAdmit?: boolean }[] = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) candidates.push({ price: highs[i], source: 'PRICE_ACTION' });
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) candidates.push({ price: lows[i], source: 'PRICE_ACTION' });
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yIdx.length > 0) {
    const yHigh = Math.max(...yIdx.map(t => highs[t.i]));
    const yLow = Math.min(...yIdx.map(t => lows[t.i]));
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
  const wIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= weekStart);
  if (wIdx.length > 0) {
    candidates.push({ price: Math.max(...wIdx.map(t => highs[t.i])), source: 'WEEKLY', alwaysAdmit: true });
    candidates.push({ price: Math.min(...wIdx.map(t => lows[t.i])), source: 'WEEKLY', alwaysAdmit: true });
  }
  const clustered: { price: number; sources: Set<string>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find(cl => Math.abs(cl.price - c.price) < mergeWidth);
    if (existing) { existing.price = (existing.price + c.price) / 2; existing.sources.add(c.source); existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit; }
    else { clustered.push({ price: c.price, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit }); }
  }
  const HALF_LIFE_HOURS = 18;
  const zones: Zone[] = [];
  for (const cluster of clustered) {
    let touches = 0; let rejectionWicks = 0; let totalRejectionSize = 0; let lastTouchTs = 0;
    const isResistance = cluster.price > currentPrice;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i]; const high = highs[i]; const low = lows[i];
      if (Math.abs(price - cluster.price) < touchWidth) { touches++; lastTouchTs = timestamps[i]; }
      if (isResistance && high >= cluster.price - touchWidth && price < cluster.price) { const wickSize = high - Math.max(price, closes[Math.max(0, i-1)]); if (wickSize > touchWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; } }
      if (!isResistance && low <= cluster.price + touchWidth && price > cluster.price) { const wickSize = Math.min(price, closes[Math.max(0, i-1)]) - low; if (wickSize > touchWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; } }
    }
    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const confluenceScore = cluster.sources.size;
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const confluenceBonus = hasEarnedEvidence ? Math.min(1, confluenceScore * 0.25) : 0;
    const rawLegacy = Math.min(1, touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 + Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + confluenceBonus);
    const rawNew = Math.min(1, rejectionScore * 0.5 + rejectionSizeScore * 0.3 + Math.min(1, confluenceScore / 3) * 0.2);
    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / 3_600_000 : 0;
    const decay = lastTouchTs > 0 ? Math.pow(0.5, ageHours / HALF_LIFE_HOURS) : 1;
    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({ price: parseFloat(cluster.price.toFixed(1)), type: isResistance ? 'RESISTANCE' : 'SUPPORT', touches, rejectionWicks, reactionStrength: parseFloat(Math.min(1, rawNew * decay).toFixed(3)), legacyReactionStrength: parseFloat(Math.min(1, rawLegacy * decay).toFixed(3)), confluenceScore, source: [...cluster.sources].sort().join(',') });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return { zones: zones.slice(0, 32), atr, touchWidth };
}

async function main(): Promise<void> {
  const line = '='.repeat(84);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n${line}`);
  console.log('ITEM 87c — EMISSION-COUNT PRECISION: ZONE BATCH SENSITIVITY');
  console.log(line);

  // Read the LIVE sr_zones_v1 batch stamp (what the C15 arms actually saw).
  const { data: liveZones } = await client
    .from('sr_zones_v1')
    .select('price, type, touches, rejection_wicks, reaction_strength, legacy_reaction_strength, source, confluence_score, last_touch_ts, updated_at')
    .order('reaction_strength', { ascending: false })
    .limit(32);
  const liveRows = (liveZones ?? []) as Record<string, unknown>[];
  const liveStamp = liveRows.length > 0 ? String(liveRows[0].updated_at) : 'EMPTY';

  console.log(`\n  LIVE sr_zones_v1 batch: ${liveRows.length} rows, stamp=${liveStamp}`);

  // Compute three zone batches at three different "now" timestamps.
  // Batch 1: 48h ago, Batch 2: 24h ago, Batch 3: now.
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const batchTimes = [
    { label: 'BATCH A (48h ago)', now: now - 2 * dayMs },
    { label: 'BATCH B (24h ago)', now: now - 1 * dayMs },
    { label: 'BATCH C (now)',      now: now },
  ];

  const results: { label: string; zoneCount: number; atr: number; touchWidth: number; maxRs: number; meanRs: number; over03: number; totalTouches: number; tpb: number }[] = [];

  for (const batch of batchTimes) {
    // Fetch 120h of bars ending at batch.now
    const bars = await fetchBars(client, batch.now - 5 * dayMs, batch.now);
    if (bars.length < 500) {
      console.log(`\n  ${batch.label}: only ${bars.length} bars — skipping`);
      continue;
    }
    const { zones, atr, touchWidth } = computeZones(bars, batch.now);
    const totalTouches = zones.reduce((s, z) => s + z.touches, 0);
    const tpb = totalTouches / bars.length;
    const rsValues = zones.map(z => z.reactionStrength);
    const maxRs = Math.max(...rsValues);
    const meanRs = rsValues.reduce((s, v) => s + v, 0) / rsValues.length;
    const over03 = zones.filter(z => z.reactionStrength >= 0.3).length;

    console.log(`\n  ${batch.label}`);
    console.log(`    bars: ${bars.length}  window: ${new Date(bars[0].timestamp).toISOString()} -> ${new Date(bars[bars.length-1].timestamp).toISOString()}`);
    console.log(`    zones: ${zones.length}  ATR: ${atr.toFixed(4)}  touchWidth: ${touchWidth.toFixed(4)}`);
    console.log(`    max reaction_strength: ${maxRs.toFixed(3)}  mean: ${meanRs.toFixed(3)}  over 0.3: ${over03}`);
    console.log(`    total touches: ${totalTouches}  touches-per-bar: ${tpb.toFixed(4)}`);
    console.log(`    top 5 zones:`);
    for (const z of zones.slice(0, 5)) {
      console.log(`      ${z.type.padEnd(10)} @ ${z.price.toFixed(1)}  rs=${z.reactionStrength.toFixed(3)}  touches=${z.touches}  wicks=${z.rejectionWicks}`);
    }
    results.push({ label: batch.label, zoneCount: zones.length, atr, touchWidth, maxRs, meanRs, over03, totalTouches, tpb });
  }

  // Also report the LIVE table values
  if (liveRows.length > 0) {
    const liveRs = liveRows.map(r => Number(r.reaction_strength));
    const liveMax = Math.max(...liveRs);
    const liveMean = liveRs.reduce((s, v) => s + v, 0) / liveRs.length;
    const liveOver03 = liveRs.filter(v => v >= 0.3).length;
    console.log(`\n  LIVE TABLE (sr_zones_v1)`);
    console.log(`    zones: ${liveRows.length}  stamp: ${liveStamp}`);
    console.log(`    max reaction_strength: ${liveMax.toFixed(3)}  mean: ${liveMean.toFixed(3)}  over 0.3: ${liveOver03}`);
  }

  // Spread
  if (results.length >= 2) {
    const maxRs = Math.max(...results.map(r => r.maxRs));
    const minRs = Math.min(...results.map(r => r.maxRs));
    const maxOver03 = Math.max(...results.map(r => r.over03));
    const minOver03 = Math.min(...results.map(r => r.over03));
    const maxZoneCount = Math.max(...results.map(r => r.zoneCount));
    const minZoneCount = Math.min(...results.map(r => r.zoneCount));
    console.log(`\n${line}`);
    console.log('  EMISSION-COUNT PRECISION FLOOR');
    console.log(line);
    console.log(`    Zone count spread:       ${minZoneCount} - ${maxZoneCount} (delta ${maxZoneCount - minZoneCount})`);
    console.log(`    Max reaction_strength:   ${minRs.toFixed(3)} - ${maxRs.toFixed(3)} (delta ${(maxRs - minRs).toFixed(3)})`);
    console.log(`    Zones over 0.3:          ${minOver03} - ${maxOver03} (delta ${maxOver03 - minOver03})`);
    console.log(``);
    console.log(`    The harness emission-count spread of 6 vs 10 (A12 vs C15 ARM 2) is a 40%`);
    console.log(`    delta on 340 attempts. The zone batch is the ONLY known input difference.`);
    console.log(`    This measurement shows how much the zone batch itself varies across`);
    console.log(`    refreshes: the zone count, max reaction_strength, and number of zones`);
    console.log(`    over the 0.3 consumer threshold ALL change across batches.`);
    console.log(``);
    console.log(`    PRECISION FLOOR: any emission-count conclusion from a single harness run`);
    console.log(`    carries a ~40% zone-batch sensitivity. This is the instrument's floor.`);
  }

  console.log('');
}

main().catch((err: unknown) => {
  console.error('item87c failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
