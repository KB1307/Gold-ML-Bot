/**
 * ITEMS 98, 99, 100 — ENTRY QUALITY + 24H WINDOW + SHORT-HORIZON PERSISTENCE.
 *
 * 98(a): Report how the winning zone is selected (nearest vs strongest).
 * 98(b): Measure strongest-vs-nearest canonical split.
 * 99(a): Compare live 120h vs 24h zone maps.
 * 99(c): Test short-horizon zone reversal persistence (4h/8h/12h held-out).
 * 100(f): Measure OB-vs-outcome correlation (order blocks already exist in engine).
 *
 * DATA-SOURCE: emitted_signals_v1 + gold_m1_bars + trade_outcomes_v1
 * reads = Supabase DIRECT via anon key. READ-ONLY.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
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

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1 ?? 0), tp2: Number(row.tp2 ?? 0), tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1), atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'), rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''), hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null, attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'), ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false, breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchBars(client: ReturnType<typeof createClient>, fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return out;
}

interface ZoneSnap { price: number; type: string; touches: number; reactionStrength: number; }

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEMS 98, 99, 100 — ENTRY QUALITY + 24H WINDOW + PERSISTENCE');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch signals with zone snapshots
  console.log('  Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  const withZones = allSignals.filter(r => {
    const snap = r.sr_zones_snapshot;
    return snap !== null && snap !== undefined && Array.isArray(snap) && (snap as unknown[]).length > 0;
  });
  console.log(`    ${allSignals.length} total, ${withZones.length} with zone snapshot`);

  // Fetch all bars
  console.log('  Fetching bars...');
  const { data: bStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: bEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(bStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(bEnd?.[0]?.timestamp)).getTime();
  const allBars = await fetchBars(client, barsFromMs, barsToMs);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTs = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(f: number, t: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTs) { if (ts < f) continue; if (ts > t) break; const b = barsByMinute.get(ts); if (b) out.push(b); }
    return out;
  }

  // Resolve canonically
  console.log('  Resolving...');
  const canonical = new Map<string, { outcome: 'WIN' | 'LOSS' | null; exitPrice: number; entry: number; sl: number; tp1: number; direction: string; atr: number }>();
  const origLog = console.log;
  for (const row of withZones) {
    const sig = toTradingSignal(row);
    const bars = barsInWindow(sig.createdAt! - 60000, Math.min(sig.createdAt! + 4 * 3600000, barsToMs));
    if (bars.length === 0) continue;
    try {
      console.log = () => {};
      const res = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(sig.createdAt! + 4 * 3600000, barsToMs) });
      console.log = origLog;
      canonical.set(sig.id, { outcome: res.outcomeResult, exitPrice: res.exitPrice, entry: sig.entryPrice, sl: sig.sl, tp1: sig.tp1, direction: sig.type, atr: Number(row.atr ?? 0) });
    } catch { console.log = origLog; }
  }
  console.log = origLog;
  console.log(`    ${canonical.size} resolved`);

  // ── ITEM 98(b): STRONGEST VS NEAREST ZONE ──
  console.log(`\n${line}`);
  console.log('ITEM 98(b) — STRONGEST VS NEAREST ZONE: CANONICAL SPLIT');
  console.log(line);

  // For each signal: find the nearest same-side zone and the strongest same-side zone.
  // "Near the strongest" = entry within 1.5 ATR of the strongest zone.
  let nearStrongDecided = 0, nearStrongWin = 0, nearStrongLoss = 0;
  let nearWeakDecided = 0, nearWeakWin = 0, nearWeakLoss = 0;
  let nearStrongR: number[] = [], nearWeakR: number[] = [];

  for (const row of withZones) {
    const sigId = String(row.signal_id);
    const c = canonical.get(sigId);
    if (!c || c.outcome === null) continue;
    const snap = row.sr_zones_snapshot as unknown[];
    const zones: ZoneSnap[] = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return { price: Number(zo.price), type: String(zo.type).toUpperCase(), touches: Number(zo.touches ?? 0), reactionStrength: Number(zo.reactionStrength ?? 0) };
    });
    const sameSideType = c.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const sameSide = zones.filter(z => z.type === sameSideType);
    if (sameSide.length === 0) continue;

    const atr = c.atr > 0 ? c.atr : 1;
    // Nearest same-side zone
    const nearest = sameSide.reduce((min, z) => Math.abs(z.price - c.entry) < Math.abs(min.price - c.entry) ? z : min, sameSide[0]);
    // Strongest same-side zone
    const strongest = sameSide.reduce((max, z) => z.reactionStrength > max.reactionStrength ? z : max, sameSide[0]);

    const distToStrongest = Math.abs(c.entry - strongest.price) / atr;
    const distToNearest = Math.abs(c.entry - nearest.price) / atr;

    // If the strongest zone IS the nearest, skip (no disagreement to test)
    if (strongest.price === nearest.price) continue;

    const risk = Math.abs(c.entry - c.sl);
    if (risk <= 0) continue;
    const r = c.direction === 'BUY' ? (c.exitPrice - c.entry) / risk : (c.entry - c.exitPrice) / risk;

    // "Near the strongest" = within 1.5 ATR of the strongest zone
    if (distToStrongest < 1.5) {
      nearStrongDecided++;
      nearStrongR.push(r);
      if (c.outcome === 'WIN') nearStrongWin++; else nearStrongLoss++;
    } else {
      nearWeakDecided++;
      nearWeakR.push(r);
      if (c.outcome === 'WIN') nearWeakWin++; else nearWeakLoss++;
    }
  }

  const nsWR = nearStrongDecided > 0 ? (nearStrongWin / nearStrongDecided) * 100 : 0;
  const nwWR = nearWeakDecided > 0 ? (nearWeakWin / nearWeakDecided) * 100 : 0;
  const nsEV = nearStrongDecided > 0 ? nearStrongR.reduce((s, r) => s + r, 0) / nearStrongDecided : 0;
  const nwEV = nearWeakDecided > 0 ? nearWeakR.reduce((s, r) => s + r, 0) / nearWeakDecided : 0;

  console.log(`  Near STRONGEST zone (within 1.5 ATR): n=${nearStrongDecided}  WR=${nsWR.toFixed(1)}%  EV=${nsEV >= 0 ? '+' : ''}${nsEV.toFixed(4)}R`);
  console.log(`  Near WEAKER zone (not strongest):      n=${nearWeakDecided}  WR=${nwWR.toFixed(1)}%  EV=${nwEV >= 0 ? '+' : ''}${nwEV.toFixed(4)}R`);
  console.log(`  ΔWR = ${(nsWR - nwWR).toFixed(1)}%  ΔEV = ${(nsEV - nwEV).toFixed(4)}R`);
  console.log(`  POWER: n=${nearStrongDecided + nearWeakDecided} (${nearStrongDecided} near-strong / ${nearWeakDecided} near-weak)`);

  if (nearStrongDecided >= 5 && nearWeakDecided >= 5) {
    const p1 = nearStrongWin / nearStrongDecided;
    const p2 = nearWeakWin / nearWeakDecided;
    const se = Math.sqrt(p1 * (1 - p1) / nearStrongDecided + p2 * (1 - p2) / nearWeakDecided);
    console.log(`  95% CI for ΔWR: [${((p1 - p2 - 1.96 * se) * 100).toFixed(1)}%, ${((p1 - p2 + 1.96 * se) * 100).toFixed(1)}%]`);
  }

  // ── ITEM 99(c): SHORT-HORIZON ZONE REVERSAL PERSISTENCE ──
  console.log(`\n${line}`);
  console.log('ITEM 99(c) — SHORT-HORIZON ZONE REVERSAL PERSISTENCE (held-out)');
  console.log(line);

  // For each zone in each snapshot, compute its reversal rate over the FIRST half
  // of the window and test whether it predicts the reversal rate over the SECOND half.
  // Horizons: 4h, 8h, 12h.
  const horizons = [4, 8, 12];
  for (const hHours of horizons) {
    const hMs = hHours * 60 * 60 * 1000;
    const halfMs = hMs / 2;
    const pairs: { firstHalfReversalRate: number; secondHalfReversalRate: number }[] = [];

    for (const row of withZones) {
      const sigTs = new Date(String(row.emitted_at)).getTime();
      const snap = row.sr_zones_snapshot as unknown[];
      const zones: ZoneSnap[] = snap.map((z: unknown) => {
        const zo = z as Record<string, unknown>;
        return { price: Number(zo.price), type: String(zo.type).toUpperCase(), touches: Number(zo.touches ?? 0), reactionStrength: Number(zo.reactionStrength ?? 0) };
      });

      // For each zone, check if price reversed off it in the first half and second half
      for (const zone of zones) {
        const firstBars = barsInWindow(sigTs, sigTs + halfMs);
        const secondBars = barsInWindow(sigTs + halfMs, sigTs + hMs);
        if (firstBars.length < 10 || secondBars.length < 10) continue;

        // Reversal = price touched the zone and then moved away (for SUPPORT: low <= zone.price, then close > zone.price)
        const checkReversal = (bars: Bar[], zone: ZoneSnap): boolean => {
          let touched = false;
          for (const b of bars) {
            if (zone.type === 'SUPPORT') {
              if (b.low <= zone.price + 0.5) touched = true;
              if (touched && b.close > zone.price + 1.0) return true;
            } else {
              if (b.high >= zone.price - 0.5) touched = true;
              if (touched && b.close < zone.price - 1.0) return true;
            }
          }
          return false;
        };

        const firstReversed = checkReversal(firstBars, zone) ? 1 : 0;
        const secondReversed = checkReversal(secondBars, zone) ? 1 : 0;
        pairs.push({ firstHalfReversalRate: firstReversed, secondHalfReversalRate: secondReversed });
      }
    }

    if (pairs.length < 10) {
      console.log(`  ${hHours}h → ${hHours}h: insufficient pairs (${pairs.length})`);
      continue;
    }

    // Pearson correlation between first-half and second-half reversal
    const n = pairs.length;
    const mean1 = pairs.reduce((s, p) => s + p.firstHalfReversalRate, 0) / n;
    const mean2 = pairs.reduce((s, p) => s + p.secondHalfReversalRate, 0) / n;
    let num = 0, den1 = 0, den2 = 0;
    for (const p of pairs) {
      num += (p.firstHalfReversalRate - mean1) * (p.secondHalfReversalRate - mean2);
      den1 += (p.firstHalfReversalRate - mean1) ** 2;
      den2 += (p.secondHalfReversalRate - mean2) ** 2;
    }
    const corr = den1 > 0 && den2 > 0 ? num / Math.sqrt(den1 * den2) : 0;
    // 95% CI for correlation (Fisher z)
    const z = 0.5 * Math.log((1 + corr) / (1 - corr));
    const seZ = 1 / Math.sqrt(n - 3);
    const ciLow = (Math.exp(2 * (z - 1.96 * seZ)) - 1) / (Math.exp(2 * (z - 1.96 * seZ)) + 1);
    const ciHigh = (Math.exp(2 * (z + 1.96 * seZ)) - 1) / (Math.exp(2 * (z + 1.96 * seZ)) + 1);

    console.log(`  ${hHours}h → ${hHours}h: n=${n} zones, corr=${corr.toFixed(4)} (95% CI [${ciLow.toFixed(4)}, ${ciHigh.toFixed(4)}]), first-half rate=${mean1.toFixed(3)}, second-half rate=${mean2.toFixed(3)}`);
  }

  // ── ITEM 99(a): 120H VS 24H MAP COMPARISON ──
  console.log(`\n${line}`);
  console.log('ITEM 99(a) — 120H vs 24H ZONE MAP (from most recent snapshot)');
  console.log(line);

  // The zone snapshot in emitted_signals_v1 IS the 120h map (LOOKBACK_HOURS=120 in refresh-sr-zones).
  // For the 24h comparison, we compute zones from the last 24h of bars using a simple
  // swing-high/swing-low detector (the engine's detectSRZones logic is not callable
  // from a script, so this is an approximation using the same principles).
  const recentWithZones = withZones.sort((a, b) => String(b.emitted_at).localeCompare(String(a.emitted_at)));
  if (recentWithZones.length > 0) {
    const snap = recentWithZones[0].sr_zones_snapshot as unknown[];
    const zones120: ZoneSnap[] = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return { price: Number(zo.price), type: String(zo.type).toUpperCase(), touches: Number(zo.touches ?? 0), reactionStrength: Number(zo.reactionStrength ?? 0) };
    });
    console.log(`  120h map (from snapshot): ${zones120.length} zones, SUPPORT=${zones120.filter(z => z.type === 'SUPPORT').length}, RESISTANCE=${zones120.filter(z => z.type === 'RESISTANCE').length}`);
    for (const z of zones120.sort((a, b) => a.price - b.price)) {
      console.log(`    ${z.type} ${z.price.toFixed(1)} t=${z.touches} r=${(z.reactionStrength * 100).toFixed(0)}%`);
    }

    // Simple 24h zone computation: swing highs/lows from last 1440 M1 bars
    const sigTs = new Date(String(recentWithZones[0].emitted_at)).getTime();
    const bars24h = barsInWindow(sigTs - 24 * 60 * 60 * 1000, sigTs);
    const swingHighs: number[] = [];
    const swingLows: number[] = [];
    const lookback = 5;
    for (let i = lookback; i < bars24h.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (bars24h[i].high <= bars24h[i - j].high || bars24h[i].high <= bars24h[i + j].high) isHigh = false;
        if (bars24h[i].low >= bars24h[i - j].low || bars24h[i].low >= bars24h[i + j].low) isLow = false;
      }
      if (isHigh) swingHighs.push(bars24h[i].high);
      if (isLow) swingLows.push(bars24h[i].low);
    }
    // Cluster swings within $2
    const cluster = (levels: number[]): { price: number; touches: number }[] => {
      const sorted = [...levels].sort((a, b) => a - b);
      const clusters: { price: number; touches: number }[] = [];
      for (const p of sorted) {
        const existing = clusters.find(c => Math.abs(c.price - p) < 2);
        if (existing) { existing.price = (existing.price * existing.touches + p) / (existing.touches + 1); existing.touches++; }
        else clusters.push({ price: p, touches: 1 });
      }
      return clusters;
    };
    const currentPrice = Number(recentWithZones[0].entry);
    const resistanceClusters = cluster(swingHighs).filter(c => c.price > currentPrice).sort((a, b) => a.price - b.price);
    const supportClusters = cluster(swingLows).filter(c => c.price < currentPrice).sort((a, b) => b.price - a.price);
    console.log(`\n  24h map (computed from ${bars24h.length} bars): ${resistanceClusters.length + supportClusters.length} zones, SUPPORT=${supportClusters.length}, RESISTANCE=${resistanceClusters.length}`);
    for (const c of supportClusters) console.log(`    SUPPORT ${c.price.toFixed(1)} t=${c.touches}`);
    for (const c of resistanceClusters) console.log(`    RESISTANCE ${c.price.toFixed(1)} t=${c.touches}`);
  }

  // ── ITEM 100(f): ORDER BLOCK CORRELATION ──
  console.log(`\n${line}`);
  console.log('ITEM 100(f) — ORDER BLOCK vs OUTCOME CORRELATION (measure only)');
  console.log(line);
  console.log('  NOTE: The engine already has order block detection (signalEngine.ts features.orderBlocks).');
  console.log('  However, OBs are computed at generation time from live tick history, not stored in the');
  console.log('  emitted_signals_v1 snapshot. The snapshot stores srZonesSnapshot and attentionScores only.');
  console.log('  Without stored OB data per signal, the OB-vs-outcome correlation CANNOT be measured');
  console.log('  from the corpus. This is IMPOSSIBLE this round, not underpowered.');
  console.log('  Forward evidence: once Item 100(e) ships OB telemetry in the diagnostics export,');
  console.log('  future signals will carry OB data and the correlation can be measured.');

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
