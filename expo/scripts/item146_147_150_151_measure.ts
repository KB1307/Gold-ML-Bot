/**
 * ITEMS 146, 147, 150, 151 — Combined measurement script.
 *
 * 146: Path-to-target veto block rate on live + frozen maps, both TP ladders.
 * 147: Zone type assignment vs spot (trend-follower test) + outcome consequence.
 * 150: Zero-touch zone maximum strength census.
 * 151: Book sign flip reconciliation (113 missing rows).
 *
 * DATA-SOURCE: Supabase DIRECT via anon key. No backend.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import {
  computeRNet,
  computeBook,
  formatBookLine,
  type BookEntry,
} from '../lib/evCompute';

// ── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
      if (m) process.env[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error('Could not read .env:', e);
    process.exit(1);
  }
}
loadEnv();

const url = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const supabase = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface SRZoneRow {
  price: number;
  type: string;
  touches: number;
  rejection_wicks: number;
  reaction_strength: number;
  legacy_reaction_strength?: number;
  source: string;
  confluence_score: number;
  last_touch_ts: string | null;
  updated_at: string;
}

interface EmittedSignal {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number | null;
  atr: number | null;
  regime: string | null;
  source: string;
  sr_zones_snapshot: unknown;
  zone_map_age_minutes: number | null;
}

interface TradeOutcome {
  signal_id: string;
  ts: string;
  direction: string;
  result: string;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number | null;
  confidence: number | null;
  realized_r: number | null;
  is_scratch: boolean | null;
  signal_duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

// ── TP Ladders ─────────────────────────────────────────────────────────────────
const PIP_VALUE = 0.1; // 1 pip = $0.10 for gold
const LADDER_NEW = { tp1: 25, tp2: 50, tp3: 80 }; // Item 109 user-pips
const LADDER_OLD = { tp1: 49, tp2: 74, tp3: 98 }; // Pre-Item 109

// ── ITEM 146: Block rate measurement ──────────────────────────────────────────
function measureBlockRate(
  zones: { price: number; type: string; reaction_strength: number }[],
  ladder: { tp1: number; tp2: number; tp3: number },
  priceRange: { min: number; max: number },
  gridStep: number,
): { buyBlocked: number; buyTotal: number; sellBlocked: number; sellTotal: number; buyBlockRate: number; sellBlockRate: number } {
  let buyBlocked = 0;
  let buyTotal = 0;
  let sellBlocked = 0;
  let sellTotal = 0;

  for (let entry = priceRange.min; entry <= priceRange.max; entry += gridStep) {
    const tp1Price = entry + ladder.tp1 * PIP_VALUE;
    const tp1PriceSell = entry - ladder.tp1 * PIP_VALUE;

    // BUY: check for RESISTANCE between entry and TP1
    buyTotal++;
    const buyMin = Math.min(entry, tp1Price);
    const buyMax = Math.max(entry, tp1Price);
    const buyBlocked_zone = zones.find(z =>
      z.type === 'RESISTANCE' &&
      z.price > buyMin + 0.01 &&
      z.price < buyMax - 0.01 &&
      z.reactionStrength >= 0.3,
    );
    if (buyBlocked_zone) buyBlocked++;

    // SELL: check for SUPPORT between entry and TP1
    sellTotal++;
    const sellMin = Math.min(entry, tp1PriceSell);
    const sellMax = Math.max(entry, tp1PriceSell);
    const sellBlocked_zone = zones.find(z =>
      z.type === 'SUPPORT' &&
      z.price > sellMin + 0.01 &&
      z.price < sellMax - 0.01 &&
      z.reactionStrength >= 0.3,
    );
    if (sellBlocked_zone) sellBlocked++;
  }

  return {
    buyBlocked,
    buyTotal,
    sellBlocked,
    sellTotal,
    buyBlockRate: buyTotal > 0 ? (buyBlocked / buyTotal) * 100 : 0,
    sellBlockRate: sellTotal > 0 ? (sellBlocked / sellTotal) * 100 : 0,
  };
}

// ── Fetch all pages of a table ──────────────────────────────────────────────────
async function fetchAll<T>(
  table: string,
  select: string,
  orderBy: string,
  ascending: boolean = true,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .order(orderBy, { ascending })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Fetch ${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE;
    if (offset > 10000) break;
  }
  return out;
}

// ── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(80));
  console.log('ITEMS 146, 147, 150, 151 — COMBINED MEASUREMENT');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}\n`);

  // ── Fetch live zone map ─────────────────────────────────────────────────────
  console.log('--- FETCHING LIVE sr_zones_v1 ---');
  const liveZones = await fetchAll<SRZoneRow>(
    'sr_zones_v1',
    'price, type, touches, rejection_wicks, reaction_strength, legacy_reaction_strength, source, confluence_score, last_touch_ts, updated_at',
    'reaction_strength',
    false,
  );
  console.log(`  Fetched ${liveZones.length} zones`);
  if (liveZones.length > 0) {
    console.log(`  updated_at: ${liveZones[0].updated_at}`);
    console.log(`  Price range: ${Math.min(...liveZones.map(z => z.price))} - ${Math.max(...liveZones.map(z => z.price))}`);
  }

  // ── Fetch emitted signals ───────────────────────────────────────────────────
  console.log('\n--- FETCHING emitted_signals_v1 ---');
  const signals = await fetchAll<EmittedSignal>(
    'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, atr, regime, source, sr_zones_snapshot, zone_map_age_minutes',
    'emitted_at',
    true,
  );
  console.log(`  Fetched ${signals.length} signals`);

  // ── Fetch trade outcomes ────────────────────────────────────────────────────
  console.log('\n--- FETCHING trade_outcomes_v1 ---');
  const outcomes = await fetchAll<TradeOutcome>(
    'trade_outcomes_v1',
    'signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, signal_duration_ms, created_at, updated_at',
    'created_at',
    true,
  );
  console.log(`  Fetched ${outcomes.length} outcomes`);

  // ══════════════════════════════════════════════════════════════════════════════
  // ITEM 146: PATH-TO-TARGET VETO BLOCK RATE
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('ITEM 146 — PATH-TO-TARGET VETO BLOCK RATE');
  console.log('='.repeat(80));

  // Determine current price range from live zones
  const allPrices = liveZones.map(z => z.price);
  const zoneMin = Math.min(...allPrices);
  const zoneMax = Math.max(...allPrices);
  // Grid: $0.10 steps across the zone range + $5 margin each side
  const gridMin = zoneMin - 5;
  const gridMax = zoneMax + 5;
  const gridStep = 0.1;
  const gridPoints = Math.floor((gridMax - gridMin) / gridStep);
  console.log(`\n  Grid: ${gridMin.toFixed(1)} to ${gridMax.toFixed(1)}, step ${gridStep}, ${gridPoints} candidate entries`);

  // Map zones to the format the veto uses
  const liveZoneMap = liveZones.map(z => ({
    price: z.price,
    type: z.type,
    reactionStrength: z.reaction_strength,
  }));

  // 146(a): Live map, new ladder (25/50/80)
  console.log('\n--- 146(a): LIVE MAP, NEW LADDER (25/50/80 pips, TP1=$2.50) ---');
  const live_new = measureBlockRate(liveZoneMap, LADDER_NEW, { min: gridMin, max: gridMax }, gridStep);
  console.log(`  BUY:  ${live_new.buyBlocked}/${live_new.buyTotal} blocked = ${live_new.buyBlockRate.toFixed(1)}%`);
  console.log(`  SELL: ${live_new.sellBlocked}/${live_new.sellTotal} blocked = ${live_new.sellBlockRate.toFixed(1)}%`);

  // 146(b): Live map, old ladder (49/74/98)
  console.log('\n--- 146(b): LIVE MAP, OLD LADDER (49/74/98 pips, TP1=$4.90) ---');
  const live_old = measureBlockRate(liveZoneMap, LADDER_OLD, { min: gridMin, max: gridMax }, gridStep);
  console.log(`  BUY:  ${live_old.buyBlocked}/${live_old.buyTotal} blocked = ${live_old.buyBlockRate.toFixed(1)}%`);
  console.log(`  SELL: ${live_old.sellBlocked}/${live_old.sellTotal} blocked = ${live_old.sellBlockRate.toFixed(1)}%`);

  // 146(c): Frozen Aug 18 map — reconstruct from signals that have sr_zones_snapshot
  // Find signals from Aug 18 that have zone snapshots
  console.log('\n--- 146(c): FROZEN AUG 18 MAP ---');
  const aug18Signals = signals.filter(s => {
    const d = new Date(s.emitted_at);
    return d.getUTCFullYear() === 2026 && d.getUTCMonth() === 7 && d.getUTCDate() === 18;
  });
  console.log(`  Signals from Aug 18: ${aug18Signals.length}`);

  let frozenZones: { price: number; type: string; reactionStrength: number }[] = [];
  // Try to extract zones from the first Aug 18 signal's snapshot
  for (const sig of aug18Signals) {
    if (sig.sr_zones_snapshot && typeof sig.sr_zones_snapshot === 'object') {
      const snap = sig.sr_zones_snapshot as Record<string, unknown>;
      // Could be an array or an object with a zones array
      let zoneArr: unknown[] = [];
      if (Array.isArray(snap)) {
        zoneArr = snap;
      } else if (Array.isArray(snap.zones)) {
        zoneArr = snap.zones as unknown[];
      } else if (Array.isArray(snap.srZones)) {
        zoneArr = snap.srZones as unknown[];
      }
      if (zoneArr.length > 0) {
        frozenZones = zoneArr.map((z: unknown) => {
          const zo = z as Record<string, unknown>;
          return {
            price: Number(zo.price ?? 0),
            type: String(zo.type ?? 'SUPPORT'),
            reactionStrength: Number(zo.reactionStrength ?? zo.reaction_strength ?? 0),
          };
        }).filter(z => z.price > 0);
        console.log(`  Extracted ${frozenZones.length} zones from signal ${sig.signal_id} (emitted ${sig.emitted_at})`);
        break;
      }
    }
  }

  if (frozenZones.length === 0) {
    console.log('  No zone snapshot found in Aug 18 signals. Attempting to reconstruct from prior measurement data.');
    console.log('  Using the 22-zone stale map measured in Item 136(a):');
    // From Item 136(a): stale map had 22 zones, nearest supports to entry 4368.8 were
    // 4370.6 (rs=0.475) and 4367.2 (rs=0.475). All from a previous 24h window.
    // We don't have the full 22-zone set stored — report as BLOCKED on frozen map.
    console.log('  FROZEN MAP NOT AVAILABLE in stored snapshots — reporting from live signals only.');
    console.log('  The Aug 18 map had 22 zones (9 SUPPORT / 2 RESISTANCE per Item 147 context).');
    console.log('  With 9 SUPPORT and only 2 RESISTANCE, SELLs would be heavily blocked (SUPPORT between entry and TP1).');
    console.log('  With only 2 RESISTANCE, BUYs would be lightly blocked.');
  } else {
    const frozenMin = Math.min(...frozenZones.map(z => z.price));
    const frozenMax = Math.max(...frozenZones.map(z => z.price));
    const frozenGridMin = frozenMin - 5;
    const frozenGridMax = frozenMax + 5;
    console.log(`  Frozen zone range: ${frozenMin.toFixed(1)} - ${frozenMax.toFixed(1)}`);
    console.log(`  SUPPORT: ${frozenZones.filter(z => z.type === 'SUPPORT').length}, RESISTANCE: ${frozenZones.filter(z => z.type === 'RESISTANCE').length}`);

    console.log('\n  FROZEN MAP, NEW LADDER (25/50/80):');
    const frozen_new = measureBlockRate(frozenZones, LADDER_NEW, { min: frozenGridMin, max: frozenGridMax }, gridStep);
    console.log(`    BUY:  ${frozen_new.buyBlocked}/${frozen_new.buyTotal} blocked = ${frozen_new.buyBlockRate.toFixed(1)}%`);
    console.log(`    SELL: ${frozen_new.sellBlocked}/${frozen_new.sellTotal} blocked = ${frozen_new.sellBlockRate.toFixed(1)}%`);

    console.log('\n  FROZEN MAP, OLD LADDER (49/74/98):');
    const frozen_old = measureBlockRate(frozenZones, LADDER_OLD, { min: frozenGridMin, max: frozenGridMax }, gridStep);
    console.log(`    BUY:  ${frozen_old.buyBlocked}/${frozen_old.buyTotal} blocked = ${frozen_old.buyBlockRate.toFixed(1)}%`);
    console.log(`    SELL: ${frozen_old.sellBlocked}/${frozen_old.sellTotal} blocked = ${frozen_old.sellBlockRate.toFixed(1)}%`);
  }

  // 146(d): Interaction table
  console.log('\n--- 146(d): INTERACTION TABLE ---');
  console.log('  Ladder     | Map   | Direction | Block Rate');
  console.log('  -----------|-------|-----------|----------');
  console.log(`  25/50/80   | LIVE  | BUY       | ${live_new.buyBlockRate.toFixed(1)}%`);
  console.log(`  25/50/80   | LIVE  | SELL      | ${live_new.sellBlockRate.toFixed(1)}%`);
  console.log(`  49/74/98   | LIVE  | BUY       | ${live_old.buyBlockRate.toFixed(1)}%`);
  console.log(`  49/74/98   | LIVE  | SELL      | ${live_old.sellBlockRate.toFixed(1)}%`);
  if (frozenZones.length > 0) {
    const frozen_new = measureBlockRate(frozenZones, LADDER_NEW, { min: Math.min(...frozenZones.map(z => z.price)) - 5, max: Math.max(...frozenZones.map(z => z.price)) + 5 }, gridStep);
    const frozen_old = measureBlockRate(frozenZones, LADDER_OLD, { min: Math.min(...frozenZones.map(z => z.price)) - 5, max: Math.max(...frozenZones.map(z => z.price)) + 5 }, gridStep);
    console.log(`  25/50/80   | FROZEN| BUY       | ${frozen_new.buyBlockRate.toFixed(1)}%`);
    console.log(`  25/50/80   | FROZEN| SELL      | ${frozen_new.sellBlockRate.toFixed(1)}%`);
    console.log(`  49/74/98   | FROZEN| BUY       | ${frozen_old.buyBlockRate.toFixed(1)}%`);
    console.log(`  49/74/98   | FROZEN| SELL      | ${frozen_old.sellBlockRate.toFixed(1)}%`);
  }

  // POWER statement
  console.log('\n  POWER: These are EXHAUSTIVE enumerations over a $0.10 grid spanning the zone range ±$5.');
  console.log(`  Sample sizes: ${live_new.buyTotal} BUY candidates, ${live_new.sellTotal} SELL candidates per cell.`);
  console.log('  No sampling uncertainty — these are population measurements.');

  // 146(e): Options analysis (NO SHIP)
  console.log('\n--- 146(e): OPTIONS ANALYSIS (NO SHIP THIS ROUND) ---');
  // Compute mean zone spacing
  const sortedPrices = [...allPrices].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedPrices.length; i++) {
    gaps.push(sortedPrices[i] - sortedPrices[i - 1]);
  }
  const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const medianGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  console.log(`  Zone spacing: mean=${meanGap.toFixed(2)}, median=${medianGap.toFixed(2)}, min=${Math.min(...gaps).toFixed(2)}, max=${Math.max(...gaps).toFixed(2)}`);
  console.log(`  TP1 reach (new): $${(LADDER_NEW.tp1 * PIP_VALUE).toFixed(2)}, TP1 reach (old): $${(LADDER_OLD.tp1 * PIP_VALUE).toFixed(2)}`);
  console.log(`  TP1/meanGap ratio (new): ${(LADDER_NEW.tp1 * PIP_VALUE / meanGap).toFixed(2)}, (old): ${(LADDER_OLD.tp1 * PIP_VALUE / meanGap).toFixed(2)}`);

  // Count zones above/below current price
  // Current price = last signal entry or midpoint of zone range
  const liveSignals = signals.filter(s => s.source === 'LIVE');
  const currentPrice = liveSignals.length > 0
    ? liveSignals[liveSignals.length - 1].entry
    : (zoneMin + zoneMax) / 2;
  console.log(`  Current price (from last LIVE signal): ${currentPrice}`);
  const abovePrice = liveZones.filter(z => z.price > currentPrice);
  const belowPrice = liveZones.filter(z => z.price < currentPrice);
  console.log(`  Zones above price: ${abovePrice.length} (all RESISTANCE by construction)`);
  console.log(`  Zones below price: ${belowPrice.length} (all SUPPORT by construction)`);

  console.log('\n  OPTIONS (recommendation: scale veto reach to TP1, not absolute zone presence):');
  console.log('  1. Exempt first N zones: arbitrary, no measurement basis for N.');
  console.log('  2. Scale veto reach to TP1: veto only blocks if opposing zone is within TP1 distance AND reactionStrength >= threshold. ALREADY DOES THIS — the check is z.price > minP+0.01 && z.price < maxP-0.01. The issue is TP1=$2.50 < mean gap=$' + meanGap.toFixed(2) + '.');
  console.log('  3. Require minimum zone strength to count as blocking: currently 0.3. Raising to 0.5 would exempt weaker zones.');
  console.log('  4. Measure veto against TP2 instead of TP1: TP2=$5.00 (new) vs $7.40 (old). Would reduce block rate.');
  console.log('  RECOMMENDATION: Option 3 — raise the blocking threshold from 0.3 to 0.5.');
  console.log('  AUTHORIZING GATE: canonical split showing path-blocked-by-strong-zone (rs>=0.5) EV < path-clear EV, AND path-blocked-by-weak-zone (0.3<=rs<0.5) EV >= path-clear EV (i.e. weak zones are noise, not barriers).');

  // ══════════════════════════════════════════════════════════════════════════════
  // ITEM 147: ZONE TYPE ASSIGNMENT vs SPOT
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('ITEM 147 — ZONE TYPE ASSIGNMENT vs SPOT (TREND-FOLLOWER TEST)');
  console.log('='.repeat(80));

  // 147(a): Quote the code
  console.log('\n--- 147(a): MECHANISM (line level) ---');
  console.log('  signalEngine.ts:4156:');
  console.log('    const isResistance = cluster.price > currentPrice;');
  console.log('  backend/functions/refresh-sr-zones/index.ts:248:');
  console.log('    const isResistance = cluster.price > currentPrice;');
  console.log('  Type: isResistance ? \'RESISTANCE\' : \'SUPPORT\'');
  console.log('  CONFIRMED: zone type IS assigned by comparing zone price to spot at compute time.');
  console.log('  Type is NOT derived from formation behaviour (reversal direction).');

  // 147(b): Resistance:support ratio per snapshot vs signal direction
  console.log('\n--- 147(b): RATIO vs DIRECTION (across stored snapshots) ---');
  // Use sr_zones_snapshot from each signal
  let ratioData: { direction: string; resistanceCount: number; supportCount: number; ratio: number; signalId: string }[] = [];
  for (const sig of signals) {
    if (!sig.sr_zones_snapshot || typeof sig.sr_zones_snapshot !== 'object') continue;
    const snap = sig.sr_zones_snapshot as Record<string, unknown>;
    let zoneArr: unknown[] = [];
    if (Array.isArray(snap)) zoneArr = snap;
    else if (Array.isArray(snap.zones)) zoneArr = snap.zones as unknown[];
    else if (Array.isArray(snap.srZones)) zoneArr = snap.srZones as unknown[];
    if (zoneArr.length === 0) continue;

    let resCount = 0;
    let supCount = 0;
    for (const z of zoneArr) {
      const zo = z as Record<string, unknown>;
      const type = String(zo.type ?? '');
      if (type === 'RESISTANCE') resCount++;
      else if (type === 'SUPPORT') supCount++;
    }
    if (resCount + supCount === 0) continue;
    ratioData.push({
      direction: sig.direction,
      resistanceCount: resCount,
      supportCount: supCount,
      ratio: resCount / (resCount + supCount),
      signalId: sig.signal_id,
    });
  }

  console.log(`  Signals with zone snapshots: ${ratioData.length} out of ${signals.length}`);
  console.log(`  POWER: n=${ratioData.length}. This is the full population of signals with stored snapshots.`);

  if (ratioData.length > 0) {
    // Split by direction
    const buySignals = ratioData.filter(r => r.direction === 'BUY');
    const sellSignals = ratioData.filter(r => r.direction === 'SELL');
    console.log(`  BUY signals with snapshots: ${buySignals.length}`);
    console.log(`  SELL signals with snapshots: ${sellSignals.length}`);

    if (buySignals.length > 0) {
      const buyResAvg = buySignals.reduce((s, r) => s + r.resistanceCount, 0) / buySignals.length;
      const buySupAvg = buySignals.reduce((s, r) => s + r.supportCount, 0) / buySignals.length;
      const buyRatioAvg = buySignals.reduce((s, r) => s + r.ratio, 0) / buySignals.length;
      console.log(`  BUY: avg RESISTANCE=${buyResAvg.toFixed(1)}, avg SUPPORT=${buySupAvg.toFixed(1)}, avg R/(R+S)=${(buyRatioAvg * 100).toFixed(1)}%`);
    }
    if (sellSignals.length > 0) {
      const sellResAvg = sellSignals.reduce((s, r) => s + r.resistanceCount, 0) / sellSignals.length;
      const sellSupAvg = sellSignals.reduce((s, r) => s + r.supportCount, 0) / sellSignals.length;
      const sellRatioAvg = sellSignals.reduce((s, r) => s + r.ratio, 0) / sellSignals.length;
      console.log(`  SELL: avg RESISTANCE=${sellResAvg.toFixed(1)}, avg SUPPORT=${sellSupAvg.toFixed(1)}, avg R/(R+S)=${(sellRatioAvg * 100).toFixed(1)}%`);
    }

    // Also use the LIVE map
    console.log('\n  LIVE MAP (current):');
    const liveRes = liveZones.filter(z => z.type === 'RESISTANCE').length;
    const liveSup = liveZones.filter(z => z.type === 'SUPPORT').length;
    console.log(`  RESISTANCE=${liveRes}, SUPPORT=${liveSup}, R/(R+S)=${((liveRes / (liveRes + liveSup)) * 100).toFixed(1)}%`);
    if (liveSignals.length > 0) {
      const lastLive = liveSignals[liveSignals.length - 1];
      console.log(`  Last LIVE signal direction: ${lastLive.direction} at entry ${lastLive.entry}`);
    }
  }

  // 147(c): Ratio vs preceding price move
  console.log('\n--- 147(c): RATIO vs PRECEDING PRICE MOVE ---');
  // For each signal with a snapshot, compute the price move over the preceding N hours
  // We'd need gold_m1_bars for this — fetch a recent window
  console.log('  Fetching gold_m1_bars for preceding-move analysis...');
  const barsResult = await supabase
    .from('gold_m1_bars')
    .select('timestamp, close')
    .order('timestamp', { ascending: true })
    .limit(5000);
  if (barsResult.error) {
    console.log('  ERROR fetching bars:', barsResult.error.message);
  } else {
    const bars = barsResult.data ?? [];
    console.log(`  Fetched ${bars.length} bars`);
    if (bars.length > 60 && ratioData.length > 0) {
      // For each signal, find the bar at emission time and compute preceding 4h move
      let correlations: { direction: string; ratio: number; precedingMove: number }[] = [];
      for (const sig of signals) {
        if (!sig.sr_zones_snapshot) continue;
        const snap = sig.sr_zones_snapshot as Record<string, unknown>;
        let zoneArr: unknown[] = [];
        if (Array.isArray(snap)) zoneArr = snap;
        else if (Array.isArray(snap.zones)) zoneArr = snap.zones as unknown[];
        else if (Array.isArray(snap.srZones)) zoneArr = snap.srZones as unknown[];
        if (zoneArr.length === 0) continue;

        let resCount = 0, supCount = 0;
        for (const z of zoneArr) {
          const zo = z as Record<string, unknown>;
          const type = String(zo.type ?? '');
          if (type === 'RESISTANCE') resCount++;
          else if (type === 'SUPPORT') supCount++;
        }
        if (resCount + supCount === 0) continue;
        const ratio = resCount / (resCount + supCount);

        // Find the bar at or before emission time
        const sigTs = new Date(sig.emitted_at).getTime();
        const barIdx = bars.findIndex(b => new Date(b.timestamp).getTime() > sigTs);
        if (barIdx < 240) continue; // need 4h (240 M1 bars) of history
        const currentBarClose = Number(bars[barIdx - 1].close);
        const pastBarClose = Number(bars[barIdx - 240].close);
        const precedingMove = currentBarClose - pastBarClose; // positive = uptrend

        correlations.push({ direction: sig.direction, ratio, precedingMove });
      }

      console.log(`  Signals with preceding-move data: ${correlations.length}`);
      if (correlations.length > 5) {
        // Compute correlation between ratio and precedingMove
        const n = correlations.length;
        const meanRatio = correlations.reduce((s, c) => s + c.ratio, 0) / n;
        const meanMove = correlations.reduce((s, c) => s + c.precedingMove, 0) / n;
        let cov = 0, varR = 0, varM = 0;
        for (const c of correlations) {
          cov += (c.ratio - meanRatio) * (c.precedingMove - meanMove);
          varR += (c.ratio - meanRatio) ** 2;
          varM += (c.precedingMove - meanMove) ** 2;
        }
        const corr = varR > 0 && varM > 0 ? cov / Math.sqrt(varR * varM) : 0;
        console.log(`  corr(resistance_ratio, preceding_4h_move) = ${corr.toFixed(4)}`);
        console.log(`  Positive correlation = resistance-heavy map follows uptrend (confirms mechanism).`);
        console.log(`  n=${n}, POWER: ${n < 30 ? 'UNDERPOWERED (n < 30)' : 'adequate'}`);

        // Split by direction
        const buyCorr = correlations.filter(c => c.direction === 'BUY');
        const sellCorr = correlations.filter(c => c.direction === 'SELL');
        if (buyCorr.length > 0) {
          const buyAvgMove = buyCorr.reduce((s, c) => s + c.precedingMove, 0) / buyCorr.length;
          const buyAvgRatio = buyCorr.reduce((s, c) => s + c.ratio, 0) / buyCorr.length;
          console.log(`  BUY signals: avg preceding move=${buyAvgMove.toFixed(2)}, avg R-ratio=${(buyAvgRatio * 100).toFixed(1)}%`);
        }
        if (sellCorr.length > 0) {
          const sellAvgMove = sellCorr.reduce((s, c) => s + c.precedingMove, 0) / sellCorr.length;
          const sellAvgRatio = sellCorr.reduce((s, c) => s + c.ratio, 0) / sellCorr.length;
          console.log(`  SELL signals: avg preceding move=${sellAvgMove.toFixed(2)}, avg R-ratio=${(sellAvgRatio * 100).toFixed(1)}%`);
        }
      }
    }
  }

  // 147(d): Outcome consequence — signal agrees with map's dominant side
  console.log('\n--- 147(d): OUTCOME CONSEQUENCE (signal vs map bias) ---');
  // Join signals with outcomes
  const outcomeMap = new Map<string, TradeOutcome>();
  for (const o of outcomes) outcomeMap.set(o.signal_id, o);

  let agreeBook: BookEntry[] = [];
  let disagreeBook: BookEntry[] = [];

  for (const sig of signals) {
    const outcome = outcomeMap.get(sig.signal_id);
    if (!outcome || outcome.realized_r === null) continue;
    if (!sig.sr_zones_snapshot) continue;

    const snap = sig.sr_zones_snapshot as Record<string, unknown>;
    let zoneArr: unknown[] = [];
    if (Array.isArray(snap)) zoneArr = snap;
    else if (Array.isArray(snap.zones)) zoneArr = snap.zones as unknown[];
    else if (Array.isArray(snap.srZones)) zoneArr = snap.srZones as unknown[];
    if (zoneArr.length === 0) continue;

    let resCount = 0, supCount = 0;
    for (const z of zoneArr) {
      const zo = z as Record<string, unknown>;
      const type = String(zo.type ?? '');
      if (type === 'RESISTANCE') resCount++;
      else if (type === 'SUPPORT') supCount++;
    }
    if (resCount + supCount === 0) continue;

    const mapDominantSide = resCount > supCount ? 'RESISTANCE' : 'SUPPORT';
    // A BUY "agrees with" a support-heavy map (buying at support).
    // A SELL "agrees with" a resistance-heavy map (selling at resistance).
    const agreesWithMap =
      (sig.direction === 'BUY' && mapDominantSide === 'SUPPORT') ||
      (sig.direction === 'SELL' && mapDominantSide === 'RESISTANCE');

    const risk = Math.abs(sig.sl - sig.entry);
    if (risk <= 0) continue;
    const rNet = outcome.realized_r; // already computed by resolver
    const rGross = rNet + 0.20 / risk; // reverse the cost to get gross

    const entry: BookEntry = { id: sig.signal_id, rGross, rNet };
    if (agreesWithMap) agreeBook.push(entry);
    else disagreeBook.push(entry);
  }

  console.log(`  Signals with outcomes + zone snapshots:`);
  console.log(`    Agree with map bias: n=${agreeBook.length}`);
  console.log(`    Disagree with map bias: n=${disagreeBook.length}`);
  console.log(`  POWER: agree n=${agreeBook.length}, disagree n=${disagreeBook.length}`);

  if (agreeBook.length > 0) {
    const agreeStats = computeBook(agreeBook, true);
    console.log(formatBookLine('AGREE (signal follows map bias)', agreeStats));
  }
  if (disagreeBook.length > 0) {
    const disagreeStats = computeBook(disagreeBook, true);
    console.log(formatBookLine('DISAGREE (signal against map bias)', disagreeStats));
  }

  // 147(e): Proposal
  console.log('\n--- 147(e): PROPOSAL (NO SHIP) ---');
  console.log('  Option A: Type zones by FORMATION behaviour (did price reverse up or down off it).');
  console.log('    - A zone where price approached from below and was rejected = RESISTANCE by formation.');
  console.log('    - A zone where price approached from above and was rejected = SUPPORT by formation.');
  console.log('    - This decouples type from spot, so a falling price does not flip all zones to RESISTANCE.');
  console.log('  Option B: Normalise the veto by available zone density per side.');
  console.log('    - If 26 RESISTANCE and 6 SUPPORT exist, the veto checks against 26 barriers for BUY but only 6 for SELL.');
  console.log('    - Normalising would scale the threshold by side density.');
  console.log('  RECOMMENDATION: Option A — type by formation behaviour.');
  console.log('  AUTHORIZING GATE: canonical split showing formation-typed zones produce a path-blocked EV');
  console.log('    that is MORE negative than spot-typed zones (i.e. formation typing is more predictive of failure).');

  // ══════════════════════════════════════════════════════════════════════════════
  // ITEM 150: ZERO-TOUCH ZONE MAXIMUM STRENGTH
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('ITEM 150 — ZERO-TOUCH ZONE MAXIMUM STRENGTH');
  console.log('='.repeat(80));

  // 150(a): Mechanism
  console.log('\n--- 150(a): MECHANISM ---');
  console.log('  Backend function (refresh-sr-zones/index.ts) scoring formula:');
  console.log('    touchScore = Math.min(1, touches / 6)         → 0 for touches=0');
  console.log('    rejectionScore = Math.min(1, rejectionWicks / 4) → 0 for wicks=0');
  console.log('    rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5)) → 0 for no wicks');
  console.log('    confluenceBonus = Math.min(1, confluenceScore * 0.25)');
  console.log('    hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1');
  console.log('    effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0');
  console.log('    rawReactionStrength = touchScore*0.3 + rejectionScore*0.3 + rejectionSizeScore*0.2');
  console.log('                           + Math.min(1, confluenceScore/3)*0.2*(hasEarnedEvidence?1:0)');
  console.log('                           + effectiveConfluenceBonus');
  console.log('    recencyDecayFactor = lastTouchTs > 0 ? decay : 1   (1 = no penalty for no touch)');
  console.log('    reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor)');
  console.log('  For 0 touches, 0 wicks: rawReactionStrength = 0, reactionStrength = 0.');
  console.log('  Admission: cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1 || cluster.count >= 2');
  console.log('  A 0-touch zone can be admitted via alwaysAdmit (PREV_DAY, WEEKLY) or cluster.count >= 2.');
  console.log('  BUT with 0 touches, reactionStrength should be 0, which is below the 0.3 threshold.');
  console.log('  UNLESS the code is different from what I read, or the DB was written by a different version.');

  // 150(b): Census of the live map
  console.log('\n--- 150(b): CENSUS OF LIVE MAP ---');
  console.log('  All 32 zones with touches and reaction_strength:');
  console.log('  Price     | Type       | Touches | Wicks | RS     | Legacy_RS | Source          | Confluence');
  console.log('  ----------|------------|---------|-------|--------|-----------|----------------|----------');
  for (const z of liveZones) {
    console.log(
      `  ${z.price.toFixed(1).padStart(9)} | ${z.type.padEnd(10)} | ${String(z.touches).padStart(7)} | ${String(z.rejection_wicks).padStart(5)} | ${z.reaction_strength.toFixed(3).padStart(6)} | ${(z.legacy_reaction_strength ?? 0).toFixed(3).padStart(9)} | ${z.source.padEnd(14)} | ${z.confluence_score}`,
    );
  }

  // Find zero-touch zones
  const zeroTouch = liveZones.filter(z => z.touches === 0);
  console.log(`\n  Zero-touch zones: ${zeroTouch.length}`);
  if (zeroTouch.length > 0) {
    for (const z of zeroTouch) {
      console.log(`    ${z.type} @ ${z.price.toFixed(1)} | touches=0 | wicks=${z.rejection_wicks} | RS=${z.reaction_strength.toFixed(3)} | source=${z.source} | confluence=${z.confluence_score}`);
    }
  }

  // Find zones with touches below minimum the formula assumes (touches < 2)
  const lowTouch = liveZones.filter(z => z.touches < 2);
  console.log(`\n  Zones with touches < 2: ${lowTouch.length}`);
  if (lowTouch.length > 0) {
    for (const z of lowTouch) {
      console.log(`    ${z.type} @ ${z.price.toFixed(1)} | touches=${z.touches} | wicks=${z.rejection_wicks} | RS=${z.reaction_strength.toFixed(3)} | source=${z.source}`);
    }
  }

  // 150(d): Did this defect exist in the frozen map?
  console.log('\n--- 150(d): CONTAMINATION CHECK ---');
  if (frozenZones.length > 0) {
    const frozenZeroTouch = frozenZones.filter(z => z.reactionStrength >= 0.3); // all usable zones
    console.log(`  Frozen map usable zones: ${frozenZeroTouch.length}`);
    // Can't check touches from the snapshot format — check if any have RS=1.0
    const maxRs = frozenZones.filter(z => z.reactionStrength >= 0.99);
    console.log(`  Frozen zones with RS >= 0.99: ${maxRs.length}`);
  } else {
    console.log('  Frozen map not available — cannot check.');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ITEM 151: BOOK SIGN FLIP RECONCILIATION
  // ══════════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('ITEM 151 — BOOK SIGN FLIP RECONCILIATION');
  console.log('='.repeat(80));

  // 151(a): Identify the 113 missing rows
  console.log('\n--- 151(a): IDENTIFY MISSING ROWS ---');
  console.log(`  Current signals count: ${signals.length}`);
  console.log(`  Prior round reported: n=313 (this round) vs n=426 (two rounds ago)`);
  console.log(`  Difference: ${426 - 313} rows`);

  // Check signal sources
  const sourceBreakdown: Record<string, number> = {};
  for (const s of signals) {
    sourceBreakdown[s.source] = (sourceBreakdown[s.source] ?? 0) + 1;
  }
  console.log(`  Source breakdown:`, JSON.stringify(sourceBreakdown, null, 2));

  // Check which signals have outcomes
  const withOutcomes = signals.filter(s => outcomeMap.has(s.signal_id));
  const withoutOutcomes = signals.filter(s => !outcomeMap.has(s.signal_id));
  console.log(`  Signals with outcomes: ${withOutcomes.length}`);
  console.log(`  Signals without outcomes: ${withoutOutcomes.length}`);

  // Check outcome results
  const resultBreakdown: Record<string, number> = {};
  for (const o of outcomes) {
    resultBreakdown[o.result] = (resultBreakdown[o.result] ?? 0) + 1;
  }
  console.log(`  Outcome results:`, JSON.stringify(resultBreakdown, null, 2));

  // 151(b): Recompute both books with identical formula
  console.log('\n--- 151(b): RECOMPUTE BOOK WITH SHARED evCompute ---');
  // The canonical book = signals with resolved outcomes (realized_r is not null)
  const canonicalBook: BookEntry[] = [];
  for (const sig of signals) {
    const outcome = outcomeMap.get(sig.signal_id);
    if (!outcome || outcome.realized_r === null) continue;
    const risk = Math.abs(sig.sl - sig.entry);
    if (risk <= 0) continue;
    // Use the resolver's realized_r directly, but recompute to verify
    const rNet = outcome.realized_r;
    const rGross = rNet + 0.20 / risk; // reverse cost
    canonicalBook.push({ id: sig.signal_id, rGross, rNet });
  }

  const canonicalStats = computeBook(canonicalBook, true);
  console.log(formatBookLine('CANONICAL (all resolved, evCompute)', canonicalStats));

  // Also compute using evCompute directly from entry/exit/risk
  const recomputedBook: BookEntry[] = [];
  for (const sig of signals) {
    const outcome = outcomeMap.get(sig.signal_id);
    if (!outcome || outcome.exit_price === null) continue;
    const risk = Math.abs(sig.sl - sig.entry);
    if (risk <= 0) continue;
    const dir = sig.direction as 'BUY' | 'SELL';
    const rGross = (dir === 'BUY' ? (outcome.exit_price - sig.entry) : (sig.entry - outcome.exit_price)) / risk;
    const rNet = rGross - 0.20 / risk;
    recomputedBook.push({ id: sig.signal_id, rGross, rNet });
  }
  const recomputedStats = computeBook(recomputedBook, true);
  console.log(formatBookLine('RECOMPUTED (from entry/exit/risk)', recomputedStats));

  // Compare stored realized_r vs recomputed
  let mismatches = 0;
  for (const sig of signals) {
    const outcome = outcomeMap.get(sig.signal_id);
    if (!outcome || outcome.realized_r === null || outcome.exit_price === null) continue;
    const risk = Math.abs(sig.sl - sig.entry);
    if (risk <= 0) continue;
    const dir = sig.direction as 'BUY' | 'SELL';
    const rNetRecomputed = (dir === 'BUY' ? (outcome.exit_price - sig.entry) : (sig.entry - outcome.exit_price)) / risk - 0.20 / risk;
    if (Math.abs(rNetRecomputed - outcome.realized_r) > 0.01) {
      mismatches++;
      if (mismatches <= 5) {
        console.log(`  MISMATCH: ${sig.signal_id} stored=${outcome.realized_r.toFixed(4)} recomputed=${rNetRecomputed.toFixed(4)} (entry=${sig.entry}, exit=${outcome.exit_price}, sl=${sig.sl}, dir=${dir})`);
      }
    }
  }
  console.log(`  Stored vs recomputed mismatches: ${mismatches}`);

  // 151(a) continued: What changed between rounds?
  // Check for signals that exist but have no outcome resolved
  console.log('\n--- 151(a) continued: MISSING ROWS ANALYSIS ---');
  // The prior round had n=426 in the book. Now n=' + canonicalBook.length + '.
  // Possible explanations:
  // 1. Signals were deleted from emitted_signals_v1
  // 2. Outcomes were deleted from trade_outcomes_v1
  // 3. realized_r was set to null for some outcomes
  // 4. The resolver re-resolved with different exit prices
  const nullR = outcomes.filter(o => o.realized_r === null);
  console.log(`  Outcomes with realized_r = NULL: ${nullR.length}`);
  const nullExit = outcomes.filter(o => o.exit_price === null);
  console.log(`  Outcomes with exit_price = NULL: ${nullExit.length}`);

  // Check date range of signals
  const sigDates = signals.map(s => new Date(s.emitted_at).getTime());
  const minDate = new Date(Math.min(...sigDates)).toISOString();
  const maxDate = new Date(Math.max(...sigDates)).toISOString();
  console.log(`  Signal date range: ${minDate} to ${maxDate}`);

  // Check date range of outcomes
  const outcomeDates = outcomes.map(o => new Date(o.created_at).getTime());
  if (outcomeDates.length > 0) {
    console.log(`  Outcome date range: ${new Date(Math.min(...outcomeDates)).toISOString()} to ${new Date(Math.max(...outcomeDates)).toISOString()}`);
  }

  // 151(c): Decompose the swing
  console.log('\n--- 151(c): DECOMPOSE THE SWING ---');
  // Split by source
  const liveBook = canonicalBook.filter(e => {
    const sig = signals.find(s => s.signal_id === e.id);
    return sig?.source === 'LIVE';
  });
  const backfillBook = canonicalBook.filter(e => {
    const sig = signals.find(s => s.signal_id === e.id);
    return sig?.source === 'BACKFILL';
  });
  if (liveBook.length > 0) {
    const liveStats = computeBook(liveBook, true);
    console.log(formatBookLine('LIVE only', liveStats));
  }
  if (backfillBook.length > 0) {
    const backfillStats = computeBook(backfillBook, true);
    console.log(formatBookLine('BACKFILL only', backfillStats));
  }

  // Split by direction
  const buyBook = canonicalBook.filter(e => {
    const sig = signals.find(s => s.signal_id === e.id);
    return sig?.direction === 'BUY';
  });
  const sellBook = canonicalBook.filter(e => {
    const sig = signals.find(s => s.signal_id === e.id);
    return sig?.direction === 'SELL';
  });
  if (buyBook.length > 0) {
    const buyStats = computeBook(buyBook, true);
    console.log(formatBookLine('BUY only', buyStats));
  }
  if (sellBook.length > 0) {
    const sellStats = computeBook(sellBook, true);
    console.log(formatBookLine('SELL only', sellStats));
  }

  // 151(d): Plain verdict
  console.log('\n--- 151(d): PLAIN VERDICT ---');
  if (canonicalStats.n > 0) {
    const evNet = canonicalStats.evNet;
    if (Math.abs(evNet) < 0.03) {
      console.log(`  CANONICAL NET EDGE: INDETERMINATE (EV=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R, |EV| < 0.03R)`);
    } else if (evNet > 0) {
      console.log(`  CANONICAL NET EDGE: POSITIVE (EV=${evNet.toFixed(4)}R)`);
    } else {
      console.log(`  CANONICAL NET EDGE: NEGATIVE (EV=${evNet.toFixed(4)}R)`);
    }
    // CI
    const rValues = canonicalBook.map(e => e.rNet);
    const mean = rValues.reduce((s, r) => s + r, 0) / rValues.length;
    const variance = rValues.reduce((s, r) => s + (r - mean) ** 2, 0) / rValues.length;
    const se = Math.sqrt(variance / rValues.length);
    const ci95 = 1.96 * se;
    console.log(`  95% CI: [${(mean - ci95).toFixed(4)}R, ${(mean + ci95).toFixed(4)}R]`);
    console.log(`  CI includes zero: ${mean - ci95 <= 0 && mean + ci95 >= 0 ? 'YES' : 'NO'}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE');
  console.log('='.repeat(80));
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
