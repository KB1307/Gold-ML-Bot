/**
 * ITEM 109 — TP LADDER: USER PIPS vs R-DERIVED.
 *
 * 109(a): Ladder code quoted inline (see report).
 * 109(b): Re-resolve EVERY signal with user's pips (25/50/80) vs current
 *         R-derived (0.7/1.05/1.4), holding entry and SL fixed.
 * 109(e): Re-run Item 104 await-the-zone replay under the WINNING ladder.
 *
 * DATA-SOURCE RULE: reads via anon key only.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeRNet, costInR } from '../lib/evCompute';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

const PIP_VALUE = 0.1;
const USER_TP1_PIPS = 25;
const USER_TP2_PIPS = 50;
const USER_TP3_PIPS = 80;

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

function toTradingSignal(
  row: Record<string, unknown>,
  tp1Override?: number,
  tp2Override?: number,
  tp3Override?: number,
): TradingSignal {
  const dir = String(row.direction) === 'SELL' ? 'SELL' : 'BUY';
  const entry = Number(row.entry);
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: dir,
    entryPrice: entry,
    entryPriceWithSlippage: entry,
    tp1: tp1Override ?? Number(row.tp1 ?? 0),
    tp2: tp2Override ?? Number(row.tp2 ?? 0),
    tp3: tp3Override ?? Number(row.tp3 ?? 0),
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
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBars(client: ReturnType<typeof createClient>): Promise<{ bars: Bar[]; toMs: number }> {
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const fromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const toMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return { bars: out, toMs };
}

interface ResolveResult {
  rNet: number;
  rGross: number;
  isWin: boolean;
  status: string;
  targetsHit: number;
  exitPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slAfterBE: boolean;
}

function resolveAndCompute(
  sig: TradingSignal,
  bars: Bar[],
  evalNowMs: number,
): ResolveResult | null {
  const origLog = console.log;
  console.log = () => {};
  let result: ReturnType<typeof resolveSignalWithBars> | null = null;
  try {
    result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs });
  } catch {
    console.log = origLog;
    return null;
  }
  console.log = origLog;
  if (!result) return null;

  const risk = Math.abs(sig.entryPrice - sig.sl);
  if (risk <= 0) return null;

  const rGross = sig.type === 'BUY'
    ? (result.exitPrice - sig.entryPrice) / risk
    : (sig.entryPrice - result.exitPrice) / risk;
  const rNet = rGross - costInR(risk);

  const tp1Hit = result.targetsHit >= 1;
  const tp2Hit = result.targetsHit >= 2;
  const slAfterBE = result.newStatus === 'SL_AFTER_BE';

  return {
    rNet, rGross, isWin: rNet > 0,
    status: result.newStatus,
    targetsHit: result.targetsHit,
    exitPrice: result.exitPrice,
    tp1Hit, tp2Hit, slAfterBE,
  };
}

function summarize(results: ResolveResult[], label: string): void {
  const n = results.length;
  if (n === 0) {
    console.log(`  ${label}: n=0`);
    return;
  }
  const wins = results.filter(r => r.isWin);
  const losses = results.filter(r => !r.isWin);
  const wr = (wins.length / n) * 100;
  const evNet = results.reduce((s, r) => s + r.rNet, 0) / n;
  const evGross = results.reduce((s, r) => s + r.rGross, 0) / n;
  const tp1Hit = results.filter(r => r.tp1Hit).length;
  const tp2Hit = results.filter(r => r.tp2Hit).length;
  const slAfterBE = results.filter(r => r.slAfterBE).length;
  const grossWin = wins.reduce((s, r) => s + r.rGross, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r.rGross, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 999;
  const netWin = wins.reduce((s, r) => s + r.rNet, 0);
  const netLoss = Math.abs(losses.reduce((s, r) => s + r.rNet, 0));
  const pfNet = netLoss > 0 ? netWin / netLoss : 999;

  console.log(`  ${label.padEnd(36)} n=${String(n).padStart(3)}  WR=${wr.toFixed(2)}%  EV_gross=${evGross >= 0 ? '+' : ''}${evGross.toFixed(4)}R  EV_net=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`);
  console.log(`  ${' '.repeat(36)}    TP1_hit=${(tp1Hit / n * 100).toFixed(1)}% (${tp1Hit}/${n})  TP2_hit=${(tp2Hit / n * 100).toFixed(1)}% (${tp2Hit}/${n})  SL_AFTER_BE=${(slAfterBE / n * 100).toFixed(1)}% (${slAfterBE}/${n})`);
  console.log(`  ${' '.repeat(36)}    PF_gross=${pf.toFixed(3)}  PF_net=${pfNet.toFixed(3)}`);
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 109 — TP LADDER: USER PIPS vs R-DERIVED');
  console.log(line);

  // 109(a): Quote the ladder code
  console.log('\n  109(a) — LADDER CODE PROVENANCE');
  console.log(line);
  console.log('  SCALPER_TP_R_MULTIPLES = { tp1: 0.7, tp2: 1.05, tp3: 1.4 }  (signalEngine.ts:496)');
  console.log('  SCALPER_TP3_STRETCH_R = 1.5  (signalEngine.ts:497)');
  console.log('  SCALPER_TP3_STRETCH_MAX_R = 1.6  (signalEngine.ts:498)');
  console.log('');
  console.log('  Ladder computation (signalEngine.ts:8055-8073):');
  console.log('    let tp3R = SCALPER_TP_R_MULTIPLES.tp3;  // 1.4');
  console.log('    if (confidence >= 0.89 && atrUnits >= 3) tp3R = 1.6;  // stretch max');
  console.log('    else if (confidence >= 0.82 && atrUnits >= 2.5) tp3R = 1.5;  // stretch');
  console.log('    const tp1Distance = dynamicSlPips * 0.7;   // R-derived');
  console.log('    const tp2Distance = dynamicSlPips * 1.05;  // R-derived');
  console.log('    const tp3Distance = dynamicSlPips * tp3R;  // R-derived (1.4/1.5/1.6)');
  console.log('    tp1 = entry ± tp1Distance * 0.1;  // R-derived');
  console.log('    tp2 = entry ± tp2Distance * 0.1;  // R-derived');
  console.log('    tp3 = entry ± tp3Distance * 0.1;  // R-derived');
  console.log('');
  console.log('  SETTINGS PATH: settings.tp1Pips/tp2Pips/tp3Pips are NEVER read for the ladder.');
  console.log('  They appear ONLY in:');
  console.log('    - validateStructuralConditions (runway check, line 8856-8863)');
  console.log('    - computeExpectedValue (EV heuristic, line 9327)');
  console.log('    - recordNearMiss snapshots (telemetry, line 9177)');
  console.log('    - backgroundTaskService defaults (line 110-113: 30/60/90/70)');
  console.log('    - TradingContext DEFAULT_SETTINGS (line 43-46: 49/74/98/70)');
  console.log('  NONE of these set the actual tp1/tp2/tp3 on the emitted signal.');
  console.log('');
  console.log('  1.40R-STATED vs 1.60R-ACTUAL TP3 DISCREPANCY:');
  console.log('    The stretch mechanism at lines 8056-8057 overrides tp3R from 1.4 to 1.5 or 1.6');
  console.log('    when confidence >= 0.82 AND room-to-SR >= 2.5 ATR. The signal in the example');
  console.log('    had confidence high enough and enough room to SR to trigger the 1.6R stretch.');
  console.log('    The diagnostics export line (diagnosticsExport.ts:324) states "0.70/1.05/1.40"');
  console.log('    which is the BASE ladder, not the stretched one — a display inaccuracy.');
  console.log('');
  console.log('  USER SETTINGS (TradingContext.tsx:42-46):');
  console.log('    tp1Pips: 49, tp2Pips: 74, tp3Pips: 98, slPips: 70');
  console.log('  The signal in the example shows 25/50/80, which means the USER changed them');
  console.log('  in the settings UI. But the engine ignores tp1Pips/tp2Pips/tp3Pips entirely.');
  console.log('  slPips IS used (line 8032: configuredSlPips = settings.slPips * atrMultiplier).');

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch signals
  console.log('\n  Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`  ${allSignals.length} signals`);

  // Fetch bars
  console.log('  Fetching gold_m1_bars...');
  const { bars: allBars, toMs: barsToMs } = await fetchAllBars(client);
  console.log(`  ${allBars.length} bars`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTs = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTs) { if (ts < fromMs) continue; if (ts > toMs) break; const b = barsByMinute.get(ts); if (b) out.push(b); }
    return out;
  }

  // 109(b): Re-resolve every signal under BOTH ladders
  console.log(`\n${line}`);
  console.log('  109(b) — RE-RESOLVE UNDER BOTH LADDERS (POWER STATED FIRST)');
  console.log(line);

  const rDerivedResults: ResolveResult[] = [];
  const userPipsResults: ResolveResult[] = [];
  let skipped = 0;
  let noBars = 0;
  let noRisk = 0;

  for (const row of allSignals) {
    const sigTs = new Date(String(row.emitted_at)).getTime();
    const evalNow = Math.min(sigTs + 8 * 3600_000, barsToMs);
    const bars = barsInWindow(sigTs - 60_000, evalNow);
    if (bars.length === 0) { noBars++; continue; }

    const entry = Number(row.entry);
    const sl = Number(row.sl);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) { noRisk++; continue; }

    const dir = String(row.direction) === 'SELL' ? 'SELL' : 'BUY';
    const dirMult = dir === 'BUY' ? 1 : -1;

    // R-derived (stored) — use stored tp1/tp2/tp3
    const sigR = toTradingSignal(row);
    const resR = resolveAndCompute(sigR, bars, evalNow);
    if (!resR) { skipped++; continue; }
    rDerivedResults.push(resR);

    // User's pips — recompute tp1/tp2/tp3 from absolute pip distances
    const tp1User = entry + dirMult * USER_TP1_PIPS * PIP_VALUE;
    const tp2User = entry + dirMult * USER_TP2_PIPS * PIP_VALUE;
    const tp3User = entry + dirMult * USER_TP3_PIPS * PIP_VALUE;
    const sigU = toTradingSignal(row, tp1User, tp2User, tp3User);
    const resU = resolveAndCompute(sigU, bars, evalNow);
    if (!resU) { skipped++; continue; }
    userPipsResults.push(resU);
  }

  console.log(`\n  Population: ${allSignals.length} signals, ${rDerivedResults.length} resolved, ${skipped} skipped, ${noBars} no bars, ${noRisk} no risk`);
  console.log(`  POWER: n=${rDerivedResults.length} (both arms identical population)`);
  console.log(`  Resolution window: 8h from signal emission`);
  console.log(`  Cost: $0.20/trade, converted to R via risk distance (shared evCompute.ts)`);
  console.log('');

  summarize(rDerivedResults, 'R-DERIVED (current: 0.7/1.05/1.4R)');
  console.log('');
  summarize(userPipsResults, `USER PIPS (${USER_TP1_PIPS}/${USER_TP2_PIPS}/${USER_TP3_PIPS}p)`);

  // Per-status breakdown
  console.log('\n  STATUS BREAKDOWN:');
  const statuses = ['ALL_TARGETS_HIT', 'TP2_HIT', 'TP1_HIT', 'SL_AFTER_BE', 'PARTIAL_WIN_SL_HIT', 'SL_HIT', 'CLOSED', 'EXPIRED_MISSED_ENTRY', 'NEVER_FILLABLE'];
  console.log(`  ${'Status'.padEnd(22)} ${'R-derived n'.padStart(10)} ${'User-pips n'.padStart(10)}  ${'Δ'.padStart(6)}`);
  for (const st of statuses) {
    const rCount = rDerivedResults.filter(r => r.status === st).length;
    const uCount = userPipsResults.filter(r => r.status === st).length;
    if (rCount === 0 && uCount === 0) continue;
    const delta = uCount - rCount;
    console.log(`  ${st.padEnd(22)} ${String(rCount).padStart(10)} ${String(uCount).padStart(10)}  ${delta >= 0 ? '+' : ''}${String(delta).padStart(5)}`);
  }

  // Worked examples (first 5 where they differ)
  console.log('\n  WORKED EXAMPLES (first 5 where outcome differs):');
  let exampleCount = 0;
  for (let i = 0; i < allSignals.length && exampleCount < 5; i++) {
    const row = allSignals[i];
    const entry = Number(row.entry);
    const sl = Number(row.sl);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) continue;
    const dir = String(row.direction) === 'SELL' ? 'SELL' : 'BUY';
    const dirMult = dir === 'BUY' ? 1 : -1;

    const sigTs = new Date(String(row.emitted_at)).getTime();
    const evalNow = Math.min(sigTs + 8 * 3600_000, barsToMs);
    const bars = barsInWindow(sigTs - 60_000, evalNow);
    if (bars.length === 0) continue;

    const sigR = toTradingSignal(row);
    const resR = resolveAndCompute(sigR, bars, evalNow);
    if (!resR) continue;

    const tp1User = entry + dirMult * USER_TP1_PIPS * PIP_VALUE;
    const tp2User = entry + dirMult * USER_TP2_PIPS * PIP_VALUE;
    const tp3User = entry + dirMult * USER_TP3_PIPS * PIP_VALUE;
    const sigU = toTradingSignal(row, tp1User, tp2User, tp3User);
    const resU = resolveAndCompute(sigU, bars, evalNow);
    if (!resU) continue;

    if (resR.status === resU.status && Math.abs(resR.rNet - resU.rNet) < 0.01) continue;

    exampleCount++;
    const slPips = (risk / PIP_VALUE).toFixed(0);
    const tp1RPips = (Math.abs(sigR.tp1 - entry) / PIP_VALUE).toFixed(0);
    const tp1RR = (Math.abs(sigR.tp1 - entry) / risk).toFixed(2);
    console.log(`\n    ${String(row.signal_id).slice(-9)} ${dir} entry=${entry.toFixed(1)} SL=${sl.toFixed(1)} (${slPips}p)`);
    console.log(`      R-derived: TP1=${sigR.tp1.toFixed(1)} (${tp1RPips}p=${tp1RR}R) TP2=${sigR.tp2.toFixed(1)} TP3=${sigR.tp3.toFixed(1)}`);
    console.log(`        → ${resR.status} R=${resR.rNet >= 0 ? '+' : ''}${resR.rNet.toFixed(4)} (TP1=${resR.tp1Hit} TP2=${resR.tp2Hit})`);
    console.log(`      User pips: TP1=${tp1User.toFixed(1)} (${USER_TP1_PIPS}p=${(USER_TP1_PIPS * PIP_VALUE / risk).toFixed(2)}R) TP2=${tp2User.toFixed(1)} TP3=${tp3User.toFixed(1)}`);
    console.log(`        → ${resU.status} R=${resU.rNet >= 0 ? '+' : ''}${resU.rNet.toFixed(4)} (TP1=${resU.tp1Hit} TP2=${resU.tp2Hit})`);
  }

  // Winner
  const evR = rDerivedResults.reduce((s, r) => s + r.rNet, 0) / rDerivedResults.length;
  const evU = userPipsResults.reduce((s, r) => s + r.rNet, 0) / userPipsResults.length;
  console.log(`\n  WINNER on EV NET: ${evU > evR ? 'USER PIPS' : 'R-DERIVED'} (EV_user=${evU >= 0 ? '+' : ''}${evU.toFixed(4)}R vs EV_rder=${evR >= 0 ? '+' : ''}${evR.toFixed(4)}R, Δ=${(evU - evR) >= 0 ? '+' : ''}${(evU - evR).toFixed(4)}R)`);

  // 109(e): Re-run Item 104 await-the-zone replay under BOTH ladders
  console.log(`\n${line}`);
  console.log('  109(e) — AWAIT-THE-ZONE REPLAY UNDER BOTH LADDERS');
  console.log(line);

  const AWAIT_ZONE_BAND_ATR = 3.0;
  const origLog2 = console.log;

  for (const [ladderName, tpPips] of [
    ['R-DERIVED', null as null | { tp1: number; tp2: number; tp3: number }],
    ['USER-PIPS', { tp1: USER_TP1_PIPS, tp2: USER_TP2_PIPS, tp3: USER_TP3_PIPS }],
  ] as const) {
    let pathBlocked = 0;
    let converted = 0;
    let stillBlocked = 0;
    let noZone = 0;
    let origWins = 0;
    let origLosses = 0;
    let movedWins = 0;
    let movedLosses = 0;

    for (const row of allSignals) {
      const sig = toTradingSignal(row);
      const isBuy = sig.type === 'BUY';
      const entry = sig.entryPrice;
      const tp1Val = sig.tp1;
      const zones = row.sr_zones_snapshot;
      if (!zones) continue;
      let zoneArr: { type: string; price: number; reactionStrength: number; touches?: number }[] = [];
      try {
        if (typeof zones === 'string') zoneArr = JSON.parse(zones);
        else if (Array.isArray(zones)) zoneArr = zones as any;
      } catch { continue; }

      const opposingType = isBuy ? 'RESISTANCE' : 'SUPPORT';
      const sameSideType = isBuy ? 'SUPPORT' : 'RESISTANCE';
      const minP = Math.min(entry, tp1Val);
      const maxP = Math.max(entry, tp1Val);
      const blockingZone = zoneArr.find(z => z.type === opposingType && z.price > minP + 0.01 && z.price < maxP - 0.01 && (z.reactionStrength ?? 0) >= 0.3);
      if (!blockingZone) continue;
      pathBlocked++;

      const sigTs = sig.createdAt!;
      const evalNow = Math.min(sigTs + 8 * 3600_000, barsToMs);
      const bars = barsInWindow(sigTs - 60_000, evalNow);
      if (bars.length === 0) continue;

      // Resolve original
      console.log = () => {};
      let origResult: { newStatus: string; exitPrice: number } | null = null;
      try { origResult = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: evalNow }); } catch { }
      console.log = origLog2;
      if (!origResult) continue;
      const risk = Math.abs(sig.entryPrice - sig.sl);
      if (risk <= 0) continue;
      const origR = (isBuy ? (origResult.exitPrice - sig.entryPrice) : (sig.entryPrice - origResult.exitPrice)) / risk - costInR(risk);
      if (origR > 0) origWins++; else origLosses++;

      // Find strongest same-side zone within 3 ATR
      const atr = Number(row.atr ?? 1);
      const sameSideZones = zoneArr
        .filter(z => z.type === sameSideType && (z.reactionStrength ?? 0) >= 0.3)
        .filter(z => {
          const dist = Math.abs(z.price - entry);
          const distAtr = dist / Math.max(atr, 0.01);
          return distAtr <= AWAIT_ZONE_BAND_ATR && distAtr > 0.1;
        })
        .sort((a, b) => (b.reactionStrength ?? 0) - (a.reactionStrength ?? 0));

      if (sameSideZones.length === 0) { noZone++; continue; }

      const targetZone = sameSideZones[0];
      const movedEntry = Number(targetZone.price);

      // Under R-derived ladder: shift tp1 by same delta (R-based)
      // Under user-pips ladder: tp1 = movedEntry ± tp1Pips * pipValue (absolute)
      const moveDelta = movedEntry - entry;
      let movedTP1: number;
      let movedTP2: number;
      let movedTP3: number;
      let movedSL: number;

      if (tpPips === null) {
        // R-derived: shift everything by delta
        movedTP1 = tp1Val + moveDelta;
        movedTP2 = sig.tp2 + moveDelta;
        movedTP3 = sig.tp3 + moveDelta;
        movedSL = sig.sl + moveDelta;
      } else {
        // User pips: absolute distances from moved entry
        const dirMult = isBuy ? 1 : -1;
        movedTP1 = movedEntry + dirMult * tpPips.tp1 * PIP_VALUE;
        movedTP2 = movedEntry + dirMult * tpPips.tp2 * PIP_VALUE;
        movedTP3 = movedEntry + dirMult * tpPips.tp3 * PIP_VALUE;
        movedSL = movedEntry - dirMult * risk; // SL distance stays same (risk-based)
      }

      // Re-check path-to-target at MOVED entry and MOVED TP1
      const movedMinP = Math.min(movedEntry, movedTP1);
      const movedMaxP = Math.max(movedEntry, movedTP1);
      const stillBlockedZone = zoneArr.find(z => z.type === opposingType && z.price > movedMinP + 0.01 && z.price < movedMaxP - 0.01 && (z.reactionStrength ?? 0) >= 0.3);
      if (stillBlockedZone) { stillBlocked++; continue; }

      // Path clears — resolve at moved entry
      converted++;
      const movedSig = toTradingSignal(row, movedTP1, movedTP2, movedTP3);
      movedSig.entryPrice = movedEntry;
      movedSig.entryPriceWithSlippage = movedEntry;
      movedSig.sl = movedSL;

      console.log = () => {};
      let movedResult: { newStatus: string; exitPrice: number } | null = null;
      try { movedResult = resolveSignalWithBars(movedSig, bars, { fromScratch: true, evalNowMs: evalNow }); } catch { }
      console.log = origLog2;
      if (!movedResult) continue;
      const movedRisk = Math.abs(movedSig.entryPrice - movedSig.sl);
      if (movedRisk <= 0) continue;
      const movedR = (isBuy ? (movedResult.exitPrice - movedSig.entryPrice) : (movedSig.entryPrice - movedResult.exitPrice)) / movedRisk - costInR(movedRisk);
      if (movedR > 0) movedWins++; else movedLosses++;
    }

    console.log(`\n  ${ladderName}:`);
    console.log(`    Path-blocked: ${pathBlocked}  Converted: ${converted} (${pathBlocked > 0 ? (converted / pathBlocked * 100).toFixed(1) : 0}%)  Still blocked: ${stillBlocked}  No zone: ${noZone}`);
    console.log(`    ORIGINAL: n=${origWins + origLosses} W=${origWins} L=${origLosses} WR=${origWins + origLosses > 0 ? (origWins / (origWins + origLosses) * 100).toFixed(1) : 0}%`);
    console.log(`    MOVED:    n=${movedWins + movedLosses} W=${movedWins} L=${movedLosses} WR=${movedWins + movedLosses > 0 ? (movedWins / (movedWins + movedLosses) * 100).toFixed(1) : 0}%`);
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item109 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
