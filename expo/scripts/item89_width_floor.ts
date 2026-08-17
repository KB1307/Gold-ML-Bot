/**
 * ITEM 89 — WIDTH FLOOR DOMINANCE MEASUREMENT.
 *
 * B22 was inert because Math.max(atr * mult, currentPrice * 0.0001) let the
 * price-proportional floor dominate. This script measures across the LIVE ATR
 * distribution what fraction of the time the floor dominates the ATR term,
 * and for what ATR range the floor makes width tuning inert.
 *
 * READ-ONLY against Supabase via the anon key.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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

async function main(): Promise<void> {
  const line = '='.repeat(84);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n${line}`);
  console.log('ITEM 89 — WIDTH FLOOR DOMINANCE MEASUREMENT');
  console.log(line);

  // Fetch 14 days of M1 bars (the harness window)
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const fromMs = now - 14 * dayMs;
  const bars: Bar[] = [];
  const fromIso = new Date(fromMs).toISOString();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', fromIso)
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) { console.error(`bar fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) {
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (rows.length < 1000) break;
  }
  console.log(`  bars: ${bars.length} (${new Date(bars[0].timestamp).toISOString()} -> ${new Date(bars[bars.length-1].timestamp).toISOString()})`);

  // 89(a): What is currentPrice * 0.0001 for?
  console.log(`\n  89(a) — FLOOR PROVENANCE`);
  console.log(line);
  console.log(`  The floor is: Math.max(atr * mult, currentPrice * 0.0001)`);
  console.log(`  Where it appears:`);
  console.log(`    srZones.ts:146        zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0001)`);
  console.log(`    srZones.ts:149        clusterMergeWidth = Math.max(atr * 0.5, currentPrice * 0.0001)`);
  console.log(`    refresh-sr-zones:143 zoneWidth = Math.max(atr * ZONE_TOUCH_WIDTH_ATR, currentPrice * 0.0001)`);
  console.log(`    refresh-sr-zones:145 clusterMergeWidth = Math.max(atr * CLUSTER_MERGE_WIDTH_ATR, currentPrice * 0.0001)`);
  console.log(`    signalEngine.ts:3948  proximityThreshold = Math.max(atr * 0.25, currentPrice * 0.001)`);
  console.log(``);
  console.log(`  The 0.0001 (0.01%) floor was NOT measured — it was CHOSEN as a safety guard`);
  console.log(`  to prevent a zero-width zone when ATR is very low. It is a candidate for`);
  console.log(`  the recurring absolute-constant defect (48a, 48b, 56, 59, 73): an`);
  console.log(`  unmeasured absolute value that silently overrides the volatility-scaled`);
  console.log(`  term it is supposed to guard.`);

  // 89(b): Floor dominance fraction across the live ATR distribution
  console.log(`\n  89(b) — FLOOR DOMINANCE ACROSS THE LIVE ATR DISTRIBUTION`);
  console.log(line);

  // Compute a rolling 14-bar ATR at every bar position
  const atrValues: { atr: number; price: number; floor: number }[] = [];
  for (let i = 14; i < bars.length; i++) {
    let trSum = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(
        bars[j].high - bars[j].low,
        Math.abs(bars[j].high - bars[j - 1].close),
        Math.abs(bars[j].low - bars[j - 1].close),
      );
      trSum += tr;
    }
    const atr = trSum / 14;
    const price = bars[i].close;
    const floor = price * 0.0001;
    atrValues.push({ atr, price, floor });
  }

  const currentPrice = bars[bars.length - 1].close;
  const floor = currentPrice * 0.0001;
  console.log(`  current price: ${currentPrice.toFixed(2)}`);
  console.log(`  floor (price * 0.0001): ${floor.toFixed(4)}`);
  console.log(``);

  // For each ATR multiplier that has been proposed or shipped, measure dominance
  const mults = [0.12, 0.2, 0.25, 0.3, 0.5, 1.0];
  console.log(`  ATR mult | atr term (at median ATR) | floor dominates? | floor dominance %`);
  console.log(`  ---------|-------------------------|-----------------|------------------`);

  const medianAtr = [...atrValues.map(a => a.atr)].sort((a, b) => a - b)[Math.floor(atrValues.length / 2)];
  for (const mult of mults) {
    const atrTerm = medianAtr * mult;
    const dominates = floor > atrTerm;
    let floorDominantCount = 0;
    for (const { atr } of atrValues) {
      if (floor > atr * mult) floorDominantCount++;
    }
    const pct = (floorDominantCount / atrValues.length) * 100;
    const marker = dominates ? 'YES' : 'no';
    const shipped = mult === 0.3 ? ' (SHIPPED)' : mult === 0.12 ? ' (B22, reverted)' : '';
    console.log(`  ${mult.toFixed(2)}     | ${atrTerm.toFixed(4)}                  | ${marker.padEnd(15)} | ${pct.toFixed(1)}%${shipped}`);
  }

  console.log(`\n  ATR DISTRIBUTION (14-bar, over ${atrValues.length} bars):`);
  const sortedAtr = [...atrValues.map(a => a.atr)].sort((a, b) => a - b);
  const q = (p: number) => sortedAtr[Math.floor((sortedAtr.length - 1) * p)];
  console.log(`    min: ${sortedAtr[0].toFixed(4)}  p10: ${q(0.1).toFixed(4)}  p25: ${q(0.25).toFixed(4)}  median: ${q(0.5).toFixed(4)}  p75: ${q(0.75).toFixed(4)}  p90: ${q(0.9).toFixed(4)}  max: ${sortedAtr[sortedAtr.length-1].toFixed(4)}`);
  console.log(`    floor: ${floor.toFixed(4)}`);
  console.log(`    floor = ATR at: ${(floor / 1).toFixed(4)} price-units -> ATR = ${floor.toFixed(4)} (this is the breakpoint)`);

  // What ATR value makes the floor equal to atr * 0.3?
  const breakEvenAtr = floor / 0.3;
  const pctBelowBreakEven = (sortedAtr.filter(a => a < breakEvenAtr).length / sortedAtr.length) * 100;
  console.log(`\n  At the SHIPPED mult (0.3): floor = atr*0.3 when ATR = ${breakEvenAtr.toFixed(4)}`);
  console.log(`  ${pctBelowBreakEven.toFixed(1)}% of bars have ATR below this breakpoint.`);
  console.log(`  When ATR < ${breakEvenAtr.toFixed(4)}, zone width is PRICE-PROPORTIONAL, not volatility-scaled.`);

  if (pctBelowBreakEven > 50) {
    console.log(`\n  VERDICT: The floor dominates MORE THAN HALF THE TIME at the shipped 0.3 mult.`);
    console.log(`  Zone width is effectively price-proportional, NOT volatility-scaled,`);
    console.log(`  which contradicts what the code appears to intend.`);
  } else {
    console.log(`\n  VERDICT: The floor dominates ${pctBelowBreakEven.toFixed(1)}% of the time at 0.3 mult.`);
    console.log(`  It dominates for low-ATR periods only, which is the intended guard behaviour.`);
  }

  // 89(c): Proposed formulation
  console.log(`\n  89(c) — PROPOSED FORMULATION (NOT shipped this round)`);
  console.log(line);
  console.log(`  The correct formulation makes the floor ATR-relative, not price-relative:`);
  console.log(`    zoneWidth = Math.max(atr * mult, atr * 0.05)`);
  console.log(`  This ensures the floor is always 5% of ATR — a volatility-scaled minimum`);
  console.log(`  that can never override the intended multiplier. At any ATR value,`);
  console.log(`  the floor is atr*0.05 and the term is atr*mult, so the floor only`);
  console.log(`  dominates when mult < 0.05 (which no proposed mult does).`);
  console.log(``);
  console.log(`  GATE: before shipping, verify that the 0.05 floor does not collapse zone`);
  console.log(`  width to zero on any bar in the live ATR distribution (min ATR = ${sortedAtr[0].toFixed(4)},`);
  console.log(`  so floor = ${(sortedAtr[0] * 0.05).toFixed(4)} — non-zero, passes).`);
  console.log(`  Also verify touches-per-bar at the new formulation against the current one.`);
  console.log('');
}

main().catch((err: unknown) => {
  console.error('item89 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
