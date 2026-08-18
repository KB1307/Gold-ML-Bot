/**
 * ITEMS 96 & 97 — PATH-TO-TARGET + ZONE DENSITY MEASUREMENT.
 *
 * 96(a): Across all signals with a stored zone snapshot, compute path-blocked
 *        vs path-clear (SELL: any SUPPORT between entry and TP1; BUY: any
 *        RESISTANCE between entry and TP1). Report canonical outcome split.
 * 97(a): Measure zone-density: distribution of gaps between adjacent same-side
 *        zones in ATR. Report what fraction sit within 2 ATR of another.
 *
 * DATA-SOURCE RULE: emitted_signals_v1 + gold_m1_bars + trade_outcomes_v1
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
    tp1: Number(row.tp1 ?? 0),
    tp2: Number(row.tp2 ?? 0),
    tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1),
    atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'),
    rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''),
    hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null,
    attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'),
    ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false,
    breakevenTime: undefined,
    slPips: 70,
    tp1Pips: 49,
    tp2Pips: 74,
    tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBarsInRange(
  client: ReturnType<typeof createClient>,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
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

interface ZoneSnapshot {
  price: number;
  type: string; // 'SUPPORT' | 'RESISTANCE'
  touches: number;
  rejectionWicks?: number;
  reactionStrength: number;
  confluenceScore?: number;
  source?: string;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEMS 96 & 97 — PATH-TO-TARGET + ZONE DENSITY MEASUREMENT');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1. Fetch all emitted_signals_v1 with sr_zones_snapshot
  console.log('\n  Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`    ${allSignals.length} rows total`);

  // Filter to signals with a zone snapshot
  const withZones = allSignals.filter(r => {
    const snap = r.sr_zones_snapshot;
    return snap !== null && snap !== undefined && Array.isArray(snap) && (snap as unknown[]).length > 0;
  });
  console.log(`    ${withZones.length} rows with a zone snapshot`);

  // 2. Fetch all bars
  console.log('  Fetching gold_m1_bars...');
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const allBars = await fetchAllBarsInRange(client, barsFromMs, barsToMs);
  console.log(`    ${allBars.length} bars`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTimestamps = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTimestamps) {
      if (ts < fromMs) continue;
      if (ts > toMs) break;
      const b = barsByMinute.get(ts);
      if (b) out.push(b);
    }
    return out;
  }

  // 3. Resolve each signal canonically
  console.log('  Resolving all signals canonically...');
  const canonicalResults = new Map<string, { status: string; outcomeResult: 'WIN' | 'LOSS' | null; exitPrice: number; entry: number; sl: number; tp1: number; direction: string; atr: number }>();
  const origConsoleLog = console.log;
  for (const row of withZones) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const barsFrom = sigTs - 60_000;
    const barsTo = sigTs + 4 * 60 * 60 * 1000;
    const bars = barsInWindow(barsFrom, Math.min(barsTo, barsToMs));
    if (bars.length === 0) continue;
    try {
      console.log = () => {};
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(barsTo, barsToMs) });
      console.log = origConsoleLog;
      const atr = Number(row.atr ?? 0);
      canonicalResults.set(sig.id, {
        status: result.newStatus,
        outcomeResult: result.outcomeResult,
        exitPrice: result.exitPrice,
        entry: sig.entryPrice,
        sl: sig.sl,
        tp1: sig.tp1,
        direction: sig.type,
        atr,
      });
    } catch {
      console.log = origConsoleLog;
    }
  }
  console.log = origConsoleLog;
  console.log(`    ${canonicalResults.size} signals resolved`);

  // 4. ITEM 96(a): PATH-BLOCKED VS PATH-CLEAR
  console.log(`\n${line}`);
  console.log('ITEM 96(a) — PATH-TO-TARGET CHECK: CANONICAL SPLIT');
  console.log(line);

  function isPathBlocked(
    direction: string,
    entry: number,
    tp1: number,
    zones: ZoneSnapshot[],
  ): { blocked: boolean; blockingZone: ZoneSnapshot | null } {
    // For a BUY: is there a RESISTANCE between entry and TP1?
    // For a SELL: is there a SUPPORT between entry and TP1?
    const opposingType = direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const minP = Math.min(entry, tp1);
    const maxP = Math.max(entry, tp1);
    for (const z of zones) {
      if (z.type !== opposingType) continue;
      // Zone must sit STRICTLY between entry and TP1 (not at either)
      if (z.price > minP + 0.01 && z.price < maxP - 0.01) {
        return { blocked: true, blockingZone: z };
      }
    }
    return { blocked: false, blockingZone: null };
  }

  let blockedDecided = 0, blockedWin = 0, blockedLoss = 0;
  let clearDecided = 0, clearWin = 0, clearLoss = 0;
  let blockedR: number[] = [];
  let clearR: number[] = [];
  let blockedCount = 0, clearCount = 0;
  let blockedNoOutcome = 0, clearNoOutcome = 0;

  for (const row of withZones) {
    const sigId = String(row.signal_id);
    const canonical = canonicalResults.get(sigId);
    if (!canonical) continue;
    const snap = row.sr_zones_snapshot as unknown[];
    const zones: ZoneSnapshot[] = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return {
        price: Number(zo.price),
        type: String(zo.type).toUpperCase(),
        touches: Number(zo.touches ?? 0),
        reactionStrength: Number(zo.reactionStrength ?? 0),
        confluenceScore: zo.confluenceScore !== undefined ? Number(zo.confluenceScore) : undefined,
      };
    });
    const { blocked } = isPathBlocked(canonical.direction, canonical.entry, canonical.tp1, zones);
    if (blocked) blockedCount++; else clearCount++;

    if (canonical.outcomeResult === null) {
      if (blocked) blockedNoOutcome++; else clearNoOutcome++;
      continue;
    }
    const risk = Math.abs(canonical.entry - canonical.sl);
    if (risk <= 0) continue;
    const r = canonical.direction === 'BUY'
      ? (canonical.exitPrice - canonical.entry) / risk
      : (canonical.entry - canonical.exitPrice) / risk;

    if (blocked) {
      blockedDecided++;
      blockedR.push(r);
      if (canonical.outcomeResult === 'WIN') blockedWin++; else blockedLoss++;
    } else {
      clearDecided++;
      clearR.push(r);
      if (canonical.outcomeResult === 'WIN') clearWin++; else clearLoss++;
    }
  }

  const blockedWR = blockedDecided > 0 ? (blockedWin / blockedDecided) * 100 : 0;
  const clearWR = clearDecided > 0 ? (clearWin / clearDecided) * 100 : 0;
  const blockedEV = blockedDecided > 0 ? blockedR.reduce((s, r) => s + r, 0) / blockedDecided : 0;
  const clearEV = clearDecided > 0 ? clearR.reduce((s, r) => s + r, 0) / clearDecided : 0;

  console.log(`  Path-BLOCKED: n=${blockedDecided}  WR=${blockedWR.toFixed(1)}%  EV=${blockedEV >= 0 ? '+' : ''}${blockedEV.toFixed(4)}R  (no-outcome: ${blockedNoOutcome}, total: ${blockedCount})`);
  console.log(`  Path-CLEAR : n=${clearDecided}  WR=${clearWR.toFixed(1)}%  EV=${clearEV >= 0 ? '+' : ''}${clearEV.toFixed(4)}R  (no-outcome: ${clearNoOutcome}, total: ${clearCount})`);
  console.log(`  ΔWR = ${(clearWR - blockedWR).toFixed(1)}%  ΔEV = ${(clearEV - blockedEV).toFixed(4)}R`);

  // Power: n for a two-proportion test
  const totalDecided96 = blockedDecided + clearDecided;
  console.log(`  POWER: n=${totalDecided96} decided (${blockedDecided} blocked / ${clearDecided} clear)`);

  // 95% CI for the difference in proportions (Wilson interval approximation)
  if (blockedDecided >= 5 && clearDecided >= 5) {
    const p1 = blockedWin / blockedDecided;
    const p2 = clearWin / clearDecided;
    const se = Math.sqrt(p1 * (1 - p1) / blockedDecided + p2 * (1 - p2) / clearDecided);
    const ciLow = (p2 - p1) - 1.96 * se;
    const ciHigh = (p2 - p1) + 1.96 * se;
    console.log(`  95% CI for ΔWR: [${(ciLow * 100).toFixed(1)}%, ${(ciHigh * 100).toFixed(1)}%]`);
  }

  // 5. ITEM 97(a): ZONE DENSITY
  console.log(`\n${line}`);
  console.log('ITEM 97(a) — ZONE DENSITY: GAP DISTRIBUTION');
  console.log(line);

  const allGaps: number[] = []; // in ATR
  let totalSameSidePairs = 0;
  let within2ATR = 0;

  for (const row of withZones) {
    const snap = row.sr_zones_snapshot as unknown[];
    const zones: ZoneSnapshot[] = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return {
        price: Number(zo.price),
        type: String(zo.type).toUpperCase(),
        touches: Number(zo.touches ?? 0),
        reactionStrength: Number(zo.reactionStrength ?? 0),
      };
    });
    const atr = Number(row.atr ?? 0);
    if (atr <= 0) continue;

    // Separate by side
    const supports = zones.filter(z => z.type === 'SUPPORT').sort((a, b) => a.price - b.price);
    const resistances = zones.filter(z => z.type === 'RESISTANCE').sort((a, b) => a.price - b.price);

    for (const arr of [supports, resistances]) {
      for (let i = 0; i < arr.length - 1; i++) {
        const gap = Math.abs(arr[i + 1].price - arr[i].price);
        const gapAtr = gap / atr;
        allGaps.push(gapAtr);
        totalSameSidePairs++;
        if (gapAtr < 2.0) within2ATR++;
      }
    }
  }

  allGaps.sort((a, b) => a - b);
  console.log(`  Total same-side adjacent pairs: ${totalSameSidePairs}`);
  console.log(`  Within 2 ATR: ${within2ATR} (${totalSameSidePairs > 0 ? ((within2ATR / totalSameSidePairs) * 100).toFixed(1) : 0}%)`);
  if (allGaps.length > 0) {
    const p10 = allGaps[Math.floor(allGaps.length * 0.10)];
    const p25 = allGaps[Math.floor(allGaps.length * 0.25)];
    const p50 = allGaps[Math.floor(allGaps.length * 0.50)];
    const p75 = allGaps[Math.floor(allGaps.length * 0.75)];
    const p90 = allGaps[Math.floor(allGaps.length * 0.90)];
    console.log(`  Gap distribution (ATR): p10=${p10.toFixed(2)}  p25=${p25.toFixed(2)}  p50=${p50.toFixed(2)}  p75=${p75.toFixed(2)}  p90=${p90.toFixed(2)}  min=${allGaps[0].toFixed(2)}  max=${allGaps[allGaps.length - 1].toFixed(2)}`);
    // How many at 1.5 ATR or less
    const within15 = allGaps.filter(g => g < 1.5).length;
    const within1 = allGaps.filter(g => g < 1.0).length;
    const within05 = allGaps.filter(g => g < 0.5).length;
    console.log(`  Within 1.5 ATR: ${within15} (${totalSameSidePairs > 0 ? ((within15 / totalSameSidePairs) * 100).toFixed(1) : 0}%)`);
    console.log(`  Within 1.0 ATR: ${within1} (${totalSameSidePairs > 0 ? ((within1 / totalSameSidePairs) * 100).toFixed(1) : 0}%)`);
    console.log(`  Within 0.5 ATR: ${within05} (${totalSameSidePairs > 0 ? ((within05 / totalSameSidePairs) * 100).toFixed(1) : 0}%)`);
  }

  // 6. ITEM 97 — Live map zone count
  console.log(`\n  Live map zone count (from most recent snapshot):`);
  const recentWithZones = withZones.filter(r => {
    const snap = r.sr_zones_snapshot as unknown[];
    return Array.isArray(snap) && snap.length > 0;
  }).sort((a, b) => String(b.emitted_at).localeCompare(String(a.emitted_at)));
  if (recentWithZones.length > 0) {
    const snap = recentWithZones[0].sr_zones_snapshot as unknown[];
    const zones = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return { price: Number(zo.price), type: String(zo.type).toUpperCase(), touches: Number(zo.touches ?? 0), reactionStrength: Number(zo.reactionStrength ?? 0) };
    });
    console.log(`    total=${zones.length}  SUPPORT=${zones.filter(z => z.type === 'SUPPORT').length}  RESISTANCE=${zones.filter(z => z.type === 'RESISTANCE').length}`);
    for (const z of zones.sort((a, b) => a.price - b.price)) {
      console.log(`    ${z.type} ${z.price.toFixed(1)} t=${z.touches} r=${(z.reactionStrength * 100).toFixed(0)}%`);
    }
  }

  // 7. ITEM 96 — Opposing zone count in proximity window
  console.log(`\n${line}`);
  console.log('ITEM 96(c) — OPPOSING ZONE IN PROXIMITY WINDOW');
  console.log(line);

  let withOpposing = 0, withoutOpposing = 0;
  const PROXIMITY = 3.0;

  for (const row of withZones) {
    const sigId = String(row.signal_id);
    const canonical = canonicalResults.get(sigId);
    if (!canonical) continue;
    const snap = row.sr_zones_snapshot as unknown[];
    const zones: ZoneSnapshot[] = snap.map((z: unknown) => {
      const zo = z as Record<string, unknown>;
      return { price: Number(zo.price), type: String(zo.type).toUpperCase(), touches: Number(zo.touches ?? 0), reactionStrength: Number(zo.reactionStrength ?? 0) };
    });
    // Same proximity as the engine (NEAR_ZONE_CONFLUENCE_PROXIMITY = 3.0)
    const nearZones = zones.filter(z => Math.abs(z.price - canonical.entry) <= PROXIMITY);
    const hasSupport = nearZones.some(z => z.type === 'SUPPORT');
    const hasResistance = nearZones.some(z => z.type === 'RESISTANCE');
    if (hasSupport && hasResistance) withOpposing++;
    else withoutOpposing++;
  }
  console.log(`  Signals with BOTH sides in $${PROXIMITY} proximity: ${withOpposing}`);
  console.log(`  Signals with only one side (or none): ${withoutOpposing}`);

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item96_97 measurement failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
