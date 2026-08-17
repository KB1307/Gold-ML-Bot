/**
 * ITEM 82 ROUND 3B — CORRECTIONS 19 and 20.
 *
 * READ-ONLY against Supabase via the anon key (DATA-SOURCE RULE). No writes.
 *
 * CORRECTION 19 — G-B22 was closed on a projection last round ("expected to drop
 * to ~0.9"). An expectation is not a measurement. This script executes the SHIPPED
 * zone-scoring formula against real `gold_m1_bars` at BOTH widths and measures:
 *   - touches-per-bar at the OLD width (atr * 0.30) and the NEW width (atr * 0.12)
 *   - the true reversal rate per zone at the NEW width
 *   - corr(legacy reaction_strength, trueRate) and corr(NEW reaction_strength,
 *     trueRate) at the NEW width
 * The second correlation is the only thing that actually proves B21 worked. It was
 * never computed last round, so B21 shipped unverified.
 *
 * A NOTE ON WHAT THIS DOES AND DOES NOT ESTABLISH. This measures the shipped
 * FORMULA executed against real bars. It does NOT read post-change values out of
 * `sr_zones_v1`, because that table is only written by the deployed Edge Function
 * and the new width has not been deployed. Both numbers are therefore measurements
 * of the algorithm, not of the live table.
 *
 * CORRECTION 20 — the prior C19 margin measurement was internally impossible: it
 * reported margins of 6.7 to 40 ATR (about $14 to $85) while the resolution code it
 * quoted filters candidate zones to |price - currentPrice| <= 3.0, a $3.00 window.
 * A $14 margin cannot exist inside a $3 window. The prior method also substituted
 * the CURRENT zone snapshot for all signals.
 *
 * This redoes it correctly: `emitted_signals_v1.sr_zones_snapshot` holds the
 * HISTORICAL per-signal zone array (163 of 417 rows), so the margin is computed
 * from the zones the signal actually saw, restricted to the same 3.0 proximity
 * window the engine uses.
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

/** signalEngine.ts:524 — the proximity window the resolution code actually uses. */
const NEAR_ZONE_CONFLUENCE_PROXIMITY = 3.0;

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

interface ScoredZone {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  rejectionWicks: number;
  /** B21's NEW formula: rejection-weighted, touchScore removed entirely. */
  reactionStrength: number;
  /** The pre-B21 formula, retained so both can be scored against the same trueRate. */
  legacyReactionStrength: number;
  confluenceScore: number;
}

/**
 * Executes the shipped clustering + scoring at a caller-supplied touch width.
 *
 * `touchAtrMult` is the parameter B22 changed (0.30 -> 0.12). The CLUSTER merge
 * width is deliberately held at atr * 0.5 exactly as shipped, so narrowing the
 * touch width does not fragment zones into near-duplicates.
 */
function computeZones(bars: Bar[], now: number, touchAtrMult: number): { zones: ScoredZone[]; atr: number; touchWidth: number } {
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const timestamps = bars.map((b) => b.timestamp);
  const currentPrice = closes[closes.length - 1];
  const atr = computeATR(bars);
  const touchWidth = Math.max(atr * touchAtrMult, currentPrice * 0.0001);
  const mergeWidth = Math.max(atr * 0.5, currentPrice * 0.0001);

  const candidates: { price: number; source: string }[] = [];
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
    candidates.push({ price: yHigh, source: 'PREV_DAY' });
    candidates.push({ price: yLow, source: 'PREV_DAY' });
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
    candidates.push({ price: Math.max(...wIdx.map((t) => highs[t.i])), source: 'WEEKLY' });
    candidates.push({ price: Math.min(...wIdx.map((t) => lows[t.i])), source: 'WEEKLY' });
  }

  const clustered: { price: number; sources: Set<string> }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < mergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
    } else {
      clustered.push({ price: c.price, sources: new Set([c.source]) });
    }
  }

  const HALF_LIFE_HOURS = 18;
  const zones: ScoredZone[] = [];
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

    // Pre-B21 formula (touch-weighted = PRESENCE).
    const rawLegacy = Math.min(1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 +
      Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + confluenceBonus);
    // B21 formula as shipped: touchScore dropped, rejection weighted 0.5.
    const rawNew = Math.min(1,
      rejectionScore * 0.5 + rejectionSizeScore * 0.3 + Math.min(1, confluenceScore / 3) * 0.2);

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / 3_600_000 : 0;
    const decay = lastTouchTs > 0 ? Math.pow(0.5, ageHours / HALF_LIFE_HOURS) : 1;

    if (touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? 'RESISTANCE' : 'SUPPORT',
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(Math.min(1, rawNew * decay).toFixed(3)),
        legacyReactionStrength: parseFloat(Math.min(1, rawLegacy * decay).toFixed(3)),
        confluenceScore,
      });
    }
  }
  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return { zones: zones.slice(0, 32), atr, touchWidth };
}

/** True reversal rate: approached within one width, then moved 1 ATR away without trading through. */
function trueReversalRate(
  zone: { price: number; type: 'SUPPORT' | 'RESISTANCE' },
  bars: Bar[],
  atr: number,
  width: number,
): { approaches: number; reversals: number; tradeThroughs: number; rate: number } {
  const threshold = 1.0 * atr;
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
  return { approaches, reversals, tradeThroughs, rate: decided > 0 ? reversals / decided : 0 };
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

const quantile = (arr: number[], q: number): number => {
  if (arr.length === 0) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
};

async function main(): Promise<void> {
  const line = '='.repeat(84);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials in expo/.env'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const now = Date.now();
  const bars = await fetchBars(client, now - 5 * 24 * 60 * 60 * 1000, now);
  if (bars.length < 500) { console.error(`BLOCKER: only ${bars.length} bars`); process.exit(1); }

  console.log(`\n${line}`);
  console.log('CORRECTION 19 — G-B22 / B21 MEASURED, NOT PROJECTED');
  console.log(line);
  console.log(`  bars: ${bars.length} (${new Date(bars[0].timestamp).toISOString()} -> ${new Date(bars[bars.length - 1].timestamp).toISOString()})`);

  for (const [label, mult] of [['OLD (pre-B22)', 0.30], ['NEW (B22 as shipped)', 0.12]] as [string, number][]) {
    const { zones, atr, touchWidth } = computeZones(bars, now, mult);
    const totalTouches = zones.reduce((s, z) => s + z.touches, 0);
    const tpb = totalTouches / bars.length;
    console.log(`\n  ${label}  touchWidth = atr * ${mult.toFixed(2)} = ${touchWidth.toFixed(4)}   (ATR ${atr.toFixed(4)})`);
    console.log(`    zones: ${zones.length}   total touches: ${totalTouches}`);
    console.log(`    TOUCHES-PER-BAR: ${tpb.toFixed(4)}  ${tpb < 1.0 ? '(BELOW 1.0 — saturation cleared)' : '(ABOVE 1.0 — still saturated)'}`);

    if (mult === 0.12) {
      // The proof B21 was never given: score BOTH formulas against the same trueRate.
      const rows = zones.map((z) => {
        const tr = trueReversalRate(z, bars, atr, touchWidth);
        return { z, tr };
      }).filter((r) => r.tr.reversals + r.tr.tradeThroughs >= 3);

      console.log(`\n    B20 RE-RUN AT THE NEW WIDTH (zones with >= 3 decided approaches: ${rows.length})`);
      console.log('       price       type  legacy    new  touches  appr  rev  thru  trueRate');
      for (const r of rows.sort((a, b) => b.z.reactionStrength - a.z.reactionStrength).slice(0, 14)) {
        console.log(
          `    ${r.z.price.toFixed(1).padStart(8)} ${r.z.type.padStart(10)} ` +
          `${r.z.legacyReactionStrength.toFixed(3).padStart(6)} ${r.z.reactionStrength.toFixed(3).padStart(6)} ` +
          `${String(r.z.touches).padStart(8)} ${String(r.tr.approaches).padStart(5)} ` +
          `${String(r.tr.reversals).padStart(4)} ${String(r.tr.tradeThroughs).padStart(5)} ` +
          `${r.tr.rate.toFixed(3).padStart(9)}`,
        );
      }
      const trueRates = rows.map((r) => r.tr.rate);
      const corrLegacy = pearson(rows.map((r) => r.z.legacyReactionStrength), trueRates);
      const corrNew = pearson(rows.map((r) => r.z.reactionStrength), trueRates);
      console.log(`\n    corr(LEGACY reaction_strength, trueRate) = ${corrLegacy.toFixed(4)}`);
      console.log(`    corr(NEW    reaction_strength, trueRate) = ${corrNew.toFixed(4)}`);
      console.log(`    B21 VERDICT: ${corrNew > corrLegacy ? 'IMPROVED' : 'NOT IMPROVED'} (delta ${(corrNew - corrLegacy).toFixed(4)})`);
      const highNew = rows.filter((r) => r.z.reactionStrength > 0.95);
      const highNewBad = highNew.filter((r) => r.tr.rate < 0.70);
      console.log(`    zones NEW > 0.95 with trueRate < 0.70: ${highNewBad.length} of ${highNew.length}`);
    }
  }

  // ── CORRECTION 20 ─────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('CORRECTION 20 — C19 MARGIN, MEASURED INSIDE THE REAL 3.0 PROXIMITY WINDOW');
  console.log(line);
  console.log(`  proximity filter: NEAR_ZONE_CONFLUENCE_PROXIMITY = ${NEAR_ZONE_CONFLUENCE_PROXIMITY} (signalEngine.ts:524)`);
  console.log('  zone source: emitted_signals_v1.sr_zones_snapshot = the HISTORICAL per-signal');
  console.log('  zone array (NOT the current sr_zones_v1 snapshot the prior round substituted).');

  const sigRows: { signal_id: string; emitted_at: string; direction: string; entry: number; atr: number | null; source: string; sr_zones_snapshot: unknown }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, atr, source, sr_zones_snapshot')
      .not('sr_zones_snapshot', 'is', null)
      .order('emitted_at', { ascending: true })
      .range(offset, offset + 999);
    if (error) { console.error(`  BLOCKER: emitted_signals read failed — ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as typeof sigRows;
    sigRows.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`\n  signals with a stored zone snapshot: ${sigRows.length}`);

  let bothSides = 0;
  let noZonesInWindow = 0;
  let oneSideOnly = 0;
  const marginsAtr: number[] = [];
  const marginsUsd: number[] = [];
  const detail: { ts: string; dir: string; entry: number; sup: number; res: number; marginUsd: number; marginAtr: number }[] = [];

  for (const r of sigRows) {
    const snap = r.sr_zones_snapshot;
    const zones = (Array.isArray(snap) ? snap : []) as { price?: unknown; type?: unknown }[];
    if (zones.length === 0) { noZonesInWindow++; continue; }
    const entry = Number(r.entry);
    const atr = r.atr === null ? NaN : Number(r.atr);

    // The engine's own filter: only zones INSIDE the 3.0 proximity window.
    const inWindow = zones
      .map((z) => ({ price: Number(z.price), type: String(z.type) }))
      .filter((z) => Number.isFinite(z.price) && Math.abs(z.price - entry) <= NEAR_ZONE_CONFLUENCE_PROXIMITY);
    if (inWindow.length === 0) { noZonesInWindow++; continue; }

    const sup = inWindow.filter((z) => z.type === 'SUPPORT').sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    const res = inWindow.filter((z) => z.type === 'RESISTANCE').sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (!sup || !res) { oneSideOnly++; continue; }

    bothSides++;
    const dSup = Math.abs(sup.price - entry);
    const dRes = Math.abs(res.price - entry);
    const marginUsd = Math.abs(dSup - dRes);
    marginsUsd.push(marginUsd);
    if (Number.isFinite(atr) && atr > 0) {
      const marginAtr = marginUsd / atr;
      marginsAtr.push(marginAtr);
      detail.push({ ts: r.emitted_at, dir: r.direction, entry, sup: sup.price, res: res.price, marginUsd, marginAtr });
    }
  }

  console.log(`  no zone inside the 3.0 window      : ${noZonesInWindow}`);
  console.log(`  only ONE side inside the window    : ${oneSideOnly}  (no opposing zone -> nothing to score)`);
  console.log(`  BOTH sides inside the window       : ${bothSides}  <- the only decidable population`);
  console.log(`  of those, with a usable ATR        : ${marginsAtr.length}`);

  if (marginsUsd.length > 0) {
    console.log(`\n  margin in DOLLARS (must be <= ${NEAR_ZONE_CONFLUENCE_PROXIMITY * 2} by construction):`);
    console.log(`    min ${Math.min(...marginsUsd).toFixed(3)}  median ${quantile(marginsUsd, 0.5).toFixed(3)}  max ${Math.max(...marginsUsd).toFixed(3)}`);
  }
  if (marginsAtr.length > 0) {
    console.log(`\n  margin in ATR units:`);
    console.log(`    min ${Math.min(...marginsAtr).toFixed(3)}  median ${quantile(marginsAtr, 0.5).toFixed(3)}  max ${Math.max(...marginsAtr).toFixed(3)}`);
    const sub = marginsAtr.filter((m) => m < 0.5).length;
    const share = sub / marginsAtr.length;
    console.log(`    sub-0.5-ATR margins: ${sub} of ${marginsAtr.length} = ${(share * 100).toFixed(1)}%`);
    console.log(`\n  GATE (> 20% sub-0.5-ATR -> ship opposing-zone scoring): ${share > 0.20 ? 'PASS — SHIP' : 'FAIL — DO NOT SHIP'}`);
    console.log(`\n  closest-margin signals (the ones a scoring change would flip):`);
    for (const d of detail.sort((a, b) => a.marginAtr - b.marginAtr).slice(0, 12)) {
      console.log(`    ${d.ts}  ${d.dir.padEnd(4)} entry=${d.entry.toFixed(1)}  sup=${d.sup.toFixed(1)} res=${d.res.toFixed(1)}  margin=$${d.marginUsd.toFixed(2)} = ${d.marginAtr.toFixed(3)} ATR`);
    }
  } else {
    console.log('\n  BLOCKED: no signal has BOTH an opposing and a supporting zone inside the');
    console.log('  3.0 proximity window with a usable ATR. The gate cannot be evaluated.');
  }

  console.log('');
}

main().catch((err: unknown) => {
  console.error('analyzeRound3B failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
