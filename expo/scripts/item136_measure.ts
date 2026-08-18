/**
 * ITEM 136(a)(b)(c) — ZONE STALENESS MEASUREMENT.
 *
 * (a) Confirm staleness: sr_zones_v1 updated_at timestamps + cron schedule.
 * (b) Zone formation time from gold_m1_bars.
 * (c) Fresh map reconstruction at 16:25:33Z — does 4363-4365 support appear?
 *
 * DATA SOURCE: gold_m1_bars + sr_zones_v1 via Supabase DIRECT (anon key).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  } catch { /* */ }
  return env;
};

const PIP_VALUE = 0.1;
const LOOKBACK_HOURS = 24;
const ZONE_STALENESS_HALF_LIFE_HOURS = 18;
const ZONE_TOUCH_WIDTH_ATR = 0.3;
const CLUSTER_MERGE_WIDTH_ATR = 0.5;
const CONSUMER_THRESHOLD = 0.3;

interface Bar { timestamp: string; open: number; high: number; low: number; close: number; }
interface ServerSRZone {
  price: number; type: 'SUPPORT' | 'RESISTANCE'; touches: number;
  rejectionWicks: number; reactionStrength: number;
  source: string; confluenceScore: number; lastTouchTs: string | null;
}

// Verbatim port of computeZones from refresh-sr-zones/index.ts
function computeZones(bars: Bar[], now: number): ServerSRZone[] {
  if (bars.length < 50) return [];
  const highs = bars.map(b => Number(b.high));
  const lows = bars.map(b => Number(b.low));
  const closes = bars.map(b => Number(b.close));
  const timestamps = bars.map(b => new Date(b.timestamp).getTime());
  const currentPrice = closes[closes.length - 1];

  let atrSum = 0, atrCount = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    atrSum += tr; atrCount++;
  }
  const atr = atrCount > 0 ? atrSum / atrCount : currentPrice * 0.001;
  const zoneWidth = Math.max(atr * ZONE_TOUCH_WIDTH_ATR, currentPrice * 0.0001);
  const clusterMergeWidth = Math.max(atr * CLUSTER_MERGE_WIDTH_ATR, currentPrice * 0.0001);

  type Candidate = { price: number; source: string; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      candidates.push({ price: highs[i], source: 'PRICE_ACTION' });
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      candidates.push({ price: lows[i], source: 'PRICE_ACTION' });
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yesterdayIdx.length > 0) {
    const yHigh = Math.max(...yesterdayIdx.map(t => highs[t.i]));
    const yLow = Math.min(...yesterdayIdx.map(t => lows[t.i]));
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
  const weekIdx = timestamps.map((ts, i) => ({ ts, i })).filter(t => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({ price: Math.max(...weekIdx.map(t => highs[t.i])), source: 'WEEKLY', alwaysAdmit: true });
    candidates.push({ price: Math.min(...weekIdx.map(t => lows[t.i])), source: 'WEEKLY', alwaysAdmit: true });
  }

  const clustered: { price: number; source: string; sources: Set<string>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find(cl => Math.abs(cl.price - c.price) < clusterMergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      if (c.source === 'PRICE_ACTION') existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit });
    }
  }

  const zones: ServerSRZone[] = [];
  for (const cluster of clustered) {
    let touches = 0, rejectionWicks = 0, totalRejectionSize = 0, lastTouchTs = 0;
    const isResistance = cluster.price > currentPrice;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i], high = highs[i], low = lows[i];
      if (Math.abs(price - cluster.price) < zoneWidth) { touches++; lastTouchTs = timestamps[i]; }
      if (isResistance && high >= cluster.price - zoneWidth && price < cluster.price) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i-1)]);
        if (wickSize > zoneWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; }
      }
      if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i-1)]) - low;
        if (wickSize > zoneWidth * 0.3) { rejectionWicks++; totalRejectionSize += wickSize; }
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
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);
    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? 'RESISTANCE' : 'SUPPORT',
        touches, rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        source: cluster.source, confluenceScore,
        lastTouchTs: lastTouchTs > 0 ? new Date(lastTouchTs).toISOString() : null,
      });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('Missing env'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } }) as SupabaseClient;

  console.log('\n' + '='.repeat(84));
  console.log('ITEM 136 — ZONE STALENESS MEASUREMENT');
  console.log('='.repeat(84));

  // ── 136(a): Confirm staleness ─────────────────────────────────────────
  console.log('\n── 136(a): ZONE MAP STALENESS ──');

  // Read sr_zones_v1 current state
  const { data: zonesData, error: zonesErr } = await client
    .from('sr_zones_v1').select('*').order('reaction_strength', { ascending: false }).limit(32);
  if (zonesErr) { console.error('sr_zones_v1 read failed:', zonesErr.message); process.exit(1); }

  const zonesRows = (zonesData ?? []) as Record<string, unknown>[];
  const updatedAts = zonesRows.map(r => String(r.updated_at)).sort();
  const lastTouchTs = zonesRows.map(r => String(r.last_touch_ts ?? '')).filter(Boolean).sort();

  console.log(`sr_zones_v1: ${zonesRows.length} zones`);
  if (updatedAts.length > 0) {
    console.log(`  updated_at: min=${updatedAts[0]}  max=${updatedAts[updatedAts.length-1]}`);
    // All same?
    const allSame = updatedAts.every(t => t === updatedAts[0]);
    console.log(`  all rows same updated_at: ${allSame}`);
  }
  if (lastTouchTs.length > 0) {
    console.log(`  last_touch_ts: min=${lastTouchTs[0]}  max=${lastTouchTs[lastTouchTs.length-1]}`);
  }

  // Signal [1] fired at 2026-08-18T16:25:33Z
  const signalTime = new Date('2026-08-18T16:25:33Z').getTime();
  const mapTime = updatedAts.length > 0 ? new Date(updatedAts[updatedAts.length - 1]).getTime() : 0;
  const stalenessMin = mapTime > 0 ? Math.round((signalTime - mapTime) / 60000) : -1;
  console.log(`\n  Signal [1] fired at: 2026-08-18T16:25:33Z (${signalTime})`);
  console.log(`  Zone map updated_at:  ${updatedAts[updatedAts.length - 1] ?? 'N/A'} (${mapTime})`);
  console.log(`  MAP WAS ${stalenessMin} MINUTES OLD (${(stalenessMin / 60).toFixed(1)} HOURS) when signal [1] fired`);

  // Check cron schedule - try to read cron.job
  console.log('\n  Attempting to read cron.job...');
  const { data: cronData, error: cronErr } = await client
    .from('cron').select('jobname, schedule, active').eq('jobname', 'refresh-sr-zones');
  if (cronErr) {
    console.log(`  cron.job read failed: ${cronErr.message} (code=${cronErr.code})`);
    console.log('  The schedule is `5 */4 * * *` per the migration comment — every 4 hours at :05.');
    console.log('  Runs at: 00:05, 04:05, 08:05, 12:05, 16:05, 20:05 UTC');
    console.log('  Last run before signal [1] (16:25): 12:05 UTC');
    console.log('  Gap: 16:25 - 12:05 = 260 minutes = 4h20m');
  } else {
    console.log('  cron.job:', JSON.stringify(cronData));
  }

  // Show zone details around signal [1] entry price 4368.8
  console.log('\n  Zones near signal [1] entry 4368.8:');
  for (const z of zonesRows) {
    const price = Number(z.price);
    const dist = Math.abs(price - 4368.8);
    if (dist < 10) {
      console.log(`    ${z.type} @ ${price} dist=$${dist.toFixed(1)} rs=${z.reaction_strength} touches=${z.touches} source=${z.source}`);
    }
  }
  console.log('  All zones sorted by distance from 4368.8:');
  const byDist = zonesRows.map(z => ({ price: Number(z.price), type: String(z.type), dist: Math.abs(Number(z.price) - 4368.8), rs: Number(z.reaction_strength), touches: Number(z.touches), source: String(z.source) })).sort((a, b) => a.dist - b.dist);
  for (const z of byDist.slice(0, 5)) {
    console.log(`    ${z.type} @ ${z.price} dist=$${z.dist.toFixed(1)} rs=${z.rs} touches=${z.touches} source=${z.source}`);
  }

  // ── 136(b): Zone formation time from gold_m1_bars ─────────────────────
  console.log('\n── 136(b): ZONE FORMATION TIME ──');

  // Fetch bars for the last 7 days to have enough zone formations
  const fetchFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const allBars: Bar[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', fetchFrom).order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Bar fetch: ${error.message}`);
    const rows = (data ?? []) as Bar[];
    allBars.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
    if (offset > 20000) break;
  }
  console.log(`  Fetched ${allBars.length} bars from ${allBars[0]?.timestamp} to ${allBars[allBars.length-1]?.timestamp}`);

  // For each fractal swing low/high, measure time from first touch to qualification (2 touches or 1 rejection wick)
  // Simulate incrementally: at each bar, compute zones from the trailing 24h window and check if a new zone qualified
  const formationTimes: number[] = [];
  const formationTimesByType: { SUPPORT: number[]; RESISTANCE: number[] } = { SUPPORT: [], RESISTANCE: [] };

  // Process in 30-minute steps to keep it tractable
  const STEP_BARS = 30;
  const minBars = 50;

  for (let endIdx = minBars; endIdx < allBars.length; endIdx += STEP_BARS) {
    const windowBars = allBars.slice(Math.max(0, endIdx - 1440), endIdx + 1); // 24h window
    if (windowBars.length < 50) continue;
    const now = new Date(windowBars[windowBars.length - 1].timestamp).getTime();

    // Find the most recent fractal in the last STEP_BARS bars
    const recentStart = Math.max(2, windowBars.length - STEP_BARS - 2);
    for (let i = recentStart; i < windowBars.length - 2; i++) {
      const highs = windowBars.map(b => Number(b.high));
      const lows = windowBars.map(b => Number(b.low));
      const closes = windowBars.map(b => Number(b.close));
      const timestamps = windowBars.map(b => new Date(b.timestamp).getTime());

      // Check if this is a new fractal swing low
      if (i >= 2 && i < highs.length - 2) {
        if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
          // This is a swing low - find when it first gets 2 touches or 1 rejection wick
          const zonePrice = lows[i];
          const atrSlice = closes.slice(-14);
          let localAtr = 0;
          for (let j = Math.max(1, closes.length - 14); j < closes.length; j++) {
            const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
            localAtr += tr;
          }
          localAtr /= Math.max(1, closes.length - 1);
          const zw = Math.max(localAtr * ZONE_TOUCH_WIDTH_ATR, closes[closes.length-1] * 0.0001);

          let touchCount = 0;
          let rejectionCount = 0;
          let firstTouchTs = timestamps[i];
          let qualificationTs = 0;

          // Scan forward from this fractal
          for (let k = i; k < allBars.length; k++) {
            const barK = allBars[k];
            const priceK = Number(barK.close);
            const highK = Number(barK.high);
            const lowK = Number(barK.low);
            const tsK = new Date(barK.timestamp).getTime();

            if (Math.abs(priceK - zonePrice) < zw) {
              touchCount++;
            }
            // Rejection wick (support: low pierces below, close above)
            if (lowK <= zonePrice + zw && priceK > zonePrice) {
              const wickSize = Math.min(priceK, Number(allBars[Math.max(0, k-1)].close)) - lowK;
              if (wickSize > zw * 0.3) rejectionCount++;
            }

            if (touchCount >= 2 || rejectionCount >= 1) {
              qualificationTs = tsK;
              break;
            }
          }

          if (qualificationTs > 0) {
            const formationMin = (qualificationTs - firstTouchTs) / 60000;
            if (formationMin >= 0 && formationMin < 1440) {
              formationTimes.push(formationMin);
              formationTimesByType.SUPPORT.push(formationMin);
            }
          }
        }
      }
    }
  }

  formationTimes.sort((a, b) => a - b);
  console.log(`\n  Zone formation time (first touch -> qualification [2+ touches or 1 rejection]):`);
  console.log(`  n = ${formationTimes.length}`);
  if (formationTimes.length > 0) {
    console.log(`    p10 = ${percentile(formationTimes, 10).toFixed(0)} min`);
    console.log(`    p25 = ${percentile(formationTimes, 25).toFixed(0)} min`);
    console.log(`    p50 = ${percentile(formationTimes, 50).toFixed(0)} min`);
    console.log(`    p75 = ${percentile(formationTimes, 75).toFixed(0)} min`);
    console.log(`    p90 = ${percentile(formationTimes, 90).toFixed(0)} min`);
    console.log(`    min = ${formationTimes[0].toFixed(0)} min, max = ${formationTimes[formationTimes.length-1].toFixed(0)} min`);

    console.log(`\n  CADENCE DERIVATION:`);
    console.log(`    To see a level while it still matters, cadence must be < p25 = ${percentile(formationTimes, 25).toFixed(0)} min`);
    console.log(`    5-min cadence: sees ${formationTimes.filter(t => t >= 5).length}/${formationTimes.length} zones within 1 interval`);
    console.log(`    15-min cadence: sees ${formationTimes.filter(t => t >= 15).length}/${formationTimes.length} zones within 1 interval`);
    console.log(`    Zones that qualify in <5 min: ${formationTimes.filter(t => t < 5).length} (${(formationTimes.filter(t => t < 5).length / formationTimes.length * 100).toFixed(1)}%)`);
    console.log(`    Zones that qualify in <15 min: ${formationTimes.filter(t => t < 15).length} (${(formationTimes.filter(t => t < 15).length / formationTimes.length * 100).toFixed(1)}%)`);
    console.log(`    Zones that qualify in <30 min: ${formationTimes.filter(t => t < 30).length} (${(formationTimes.filter(t => t < 30).length / formationTimes.length * 100).toFixed(1)}%)`);
    console.log(`    Zones that qualify in <60 min: ${formationTimes.filter(t => t < 60).length} (${(formationTimes.filter(t => t < 60).length / formationTimes.length * 100).toFixed(1)}%)`);
  }

  // ── 136(c): Fresh map reconstruction at 16:25:33Z ─────────────────────
  console.log('\n── 136(c): FRESH MAP RECONSTRUCTION AT 16:25:33Z ──');

  const reconstructionTime = new Date('2026-08-18T16:25:33Z').getTime();
  const freshFromTs = new Date(reconstructionTime - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const freshBars: Bar[] = [];
  offset = 0;
  for (;;) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', freshFromTs)
      .lte('timestamp', new Date(reconstructionTime).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Fresh bar fetch: ${error.message}`);
    const rows = (data ?? []) as Bar[];
    freshBars.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
    if (offset > 20000) break;
  }
  console.log(`  Fresh window: ${freshBars.length} bars from ${freshBars[0]?.timestamp} to ${freshBars[freshBars.length-1]?.timestamp}`);

  const freshZones = computeZones(freshBars, reconstructionTime);
  console.log(`  Fresh zones computed: ${freshZones.length}`);
  console.log(`  Current price at reconstruction: ${Number(freshBars[freshBars.length-1].close).toFixed(1)}`);

  // Check for support at 4363-4365
  const targetLow = 4363;
  const targetHigh = 4365;
  const matchingZones = freshZones.filter(z => z.price >= targetLow - 1 && z.price <= targetHigh + 1 && z.type === 'SUPPORT');
  console.log(`\n  SUPPORT zones at 4363-4365: ${matchingZones.length}`);
  for (const z of matchingZones) {
    console.log(`    SUPPORT @ ${z.price} rs=${z.reactionStrength} touches=${z.touches} rejectionWicks=${z.rejectionWicks} source=${z.source}`);
  }
  if (matchingZones.length === 0) {
    console.log('  → NO support at 4363-4365 in the fresh map');
    // Show nearest support
    const nearestSupport = freshZones.filter(z => z.type === 'SUPPORT').sort((a, b) => Math.abs(a.price - 4364) - Math.abs(b.price - 4364));
    console.log('  Nearest SUPPORT zones:');
    for (const z of nearestSupport.slice(0, 5)) {
      console.log(`    SUPPORT @ ${z.price} dist=$${Math.abs(z.price - 4364).toFixed(1)} rs=${z.reactionStrength} touches=${z.touches} source=${z.source}`);
    }
  }

  // Show all fresh zones near 4368.8
  console.log('\n  Fresh zones near signal entry 4368.8:');
  for (const z of freshZones) {
    if (Math.abs(z.price - 4368.8) < 10) {
      console.log(`    ${z.type} @ ${z.price} dist=$${Math.abs(z.price - 4368.8).toFixed(1)} rs=${z.reactionStrength} touches=${z.touches} source=${z.source}`);
    }
  }

  // Compare stale vs fresh
  console.log('\n  STALE vs FRESH comparison:');
  const staleZones = zonesRows.map(z => ({ price: Number(z.price), type: String(z.type) as 'SUPPORT' | 'RESISTANCE', rs: Number(z.reaction_strength), touches: Number(z.touches), source: String(z.source) }));
  const staleSet = new Set(staleZones.map(z => `${z.price}|${z.type}`));
  const freshSet = new Set(freshZones.map(z => `${z.price}|${z.type}`));
  const onlyFresh = freshZones.filter(z => !staleSet.has(`${z.price}|${z.type}`));
  const onlyStale = staleZones.filter(z => !freshSet.has(`${z.price}|${z.type}`));
  console.log(`    Only in fresh (new): ${onlyFresh.length}`);
  for (const z of onlyFresh) console.log(`      ${z.type} @ ${z.price} rs=${z.reactionStrength} touches=${z.touches} source=${z.source}`);
  console.log(`    Only in stale (gone): ${onlyStale.length}`);
  for (const z of onlyStale) console.log(`      ${z.type} @ ${z.price} rs=${z.rs} touches=${z.touches} source=${z.source}`);

  console.log('\n' + '='.repeat(84));
}

main().catch(err => { console.error('FATAL:', err instanceof Error ? err.message : String(err)); process.exit(1); });
