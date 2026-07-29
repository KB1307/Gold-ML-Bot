import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PHASE 2b CHECKPOINT TEST — the remaining open items from the forensic audit.
 *
 * Covers, with real assertions rather than a code re-read:
 *   Item 2 (R-relative post-TP1 profit lock)  — geometry + scope invariance
 *   B4 (sweep redefinition)                   — penetration + reclaim + timeliness
 *   B5 (un-clamped zone evidence)             — dwell no longer inflates touches,
 *                                               and evidence beyond the old cap
 *                                               still increases strength
 *   C3 (BE-scratch label re-targeting)        — ~0R exits flagged, not WINs
 *   C4 (direction-bucketed calibration)       — penalty only on the losing side
 */

interface SRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  lastTouch: number;
  rejectionWicks: number;
  avgRejectionSize: number;
  reactionStrength: number;
  source: string;
  confluenceScore: number;
}

interface SweepResult {
  sweeps: {
    type: string;
    sessionType: string;
    sweepPrice: number;
    reversalConfirmed: boolean;
    strength: number;
    penetrationDepth?: number;
    reclaimLatencyMs?: number;
  }[];
  pending: number;
}

interface EngineSeams {
  getSRZonesForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number },
  ): SRZone[];
  getRealATRForTest(period?: number): number;
  evaluateSessionSweepForTest(params: {
    sessionType: "ASIAN" | "LONDON" | "NY";
    type: "HIGH_SWEEP" | "LOW_SWEEP";
    level: number;
    currentPrice: number;
    now: number;
    baseStrength?: number;
  }): SweepResult;
  resetSweepStateForTest(): void;
  resetOutcomesForTest(): void;
  getStoredOutcomesForTest(): { result: "WIN" | "LOSS"; realizedR?: number; isScratch?: boolean; direction?: "BUY" | "SELL" }[];
  getDirectionalExpectancyForTest(): { BUY: { n: number; meanR: number }; SELL: { n: number; meanR: number } };
  getDirectionalCalibrationPenaltyForTest(direction: "BUY" | "SELL"): number;
  recordTradeOutcome(
    signalId: string,
    entryPrice: number,
    exitPrice: number,
    result: "WIN" | "LOSS",
    features?: unknown,
    misleadingFeatures?: unknown,
    signalDuration?: number,
    confidence?: number,
    stopDistance?: number,
  ): Promise<void>;
}

interface ResolverModule {
  getPostTP1LockPrice(signal: {
    type: string;
    entryPrice: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
  }): number;
  POST_TP1_PROFIT_LOCK_R: number;
}

async function loadEngine(): Promise<{ signalEngine: EngineSeams }> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.phase2b.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
const trpcClient = {} as any;
const Platform = { OS: "web" as const };
type StoredTradeOutcome = any;
const sandboxLearningStoreOutcomes: unknown[] = [];
async function appendOutcomeToStore(outcome: unknown): Promise<void> { sandboxLearningStoreOutcomes.push(outcome); }
async function getAllOutcomesFromStore(): Promise<unknown[]> { return sandboxLearningStoreOutcomes.slice(); }
async function getOutcomeCountFromStore(): Promise<number> { return sandboxLearningStoreOutcomes.length; }
async function pruneOutcomeStoreToCap(cap: number): Promise<void> { if (sandboxLearningStoreOutcomes.length > cap) sandboxLearningStoreOutcomes.splice(0, sandboxLearningStoreOutcomes.length - cap); }
async function migrateLegacyOutcomesIfEmpty(legacy: unknown[]): Promise<number> {
  if (sandboxLearningStoreOutcomes.length > 0) return 0;
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  sandboxLearningStoreOutcomes.push(...legacy);
  return legacy.length;
}
async function appendDiagnosticEvent(_event: unknown): Promise<void> {}
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<{ signalEngine: EngineSeams }>;
}

async function loadResolver(): Promise<ResolverModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalResolver.phase2b.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalResolver.ts");
  const source = await readFile(sourcePath, "utf8");

  const rewritten = source
    .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+["']@\/services\/barStore["'];?\r?\n/m, "");

  const prelude = `type TradingSignal = any;
type SignalStatus = any;
type OhlcBar = any;
`;

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${prelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<ResolverModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

function makeSignal(type: "BUY" | "SELL", entry: number, stopDollars: number): {
  type: string;
  entryPrice: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
} {
  const dir = type === "BUY" ? 1 : -1;
  return {
    type,
    entryPrice: entry,
    sl: entry - dir * stopDollars,
    tp1: entry + dir * stopDollars * 0.7,
    tp2: entry + dir * stopDollars * 1.05,
    tp3: entry + dir * stopDollars * 1.4,
  };
}

/**
 * Build a close/high/low history where price makes `visits` DISTINCT entries
 * into a zone around `level`, each lasting `dwell` samples, separated by
 * excursions well outside the zone width. The final sample is always inside,
 * so staleness decay is identical across scenarios and only the touch/dwell
 * structure differs.
 */
function buildVisitHistory(level: number, away: number, visits: number, dwell: number): {
  highs: number[];
  lows: number[];
  closes: number[];
} {
  const closes: number[] = [];
  for (let v = 0; v < visits; v++) {
    for (let k = 0; k < 3; k++) closes.push(away);
    for (let k = 0; k < dwell; k++) closes.push(level);
  }
  while (closes.length < 60) closes.unshift(away);
  const highs = closes.map(c => c + 0.1);
  const lows = closes.map(c => c - 0.1);
  return { highs, lows, closes };
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();
  const resolver = await loadResolver();

  console.log("\nPHASE 2b — remaining audit open items\n");

  // ============ Item 2: R-relative post-TP1 profit lock ============
  console.log("  --- Item 2: post-TP1 profit lock is R-relative, not a fixed 15 pips ---");
  const tightBuy = makeSignal("BUY", 3000, 4.0); // 40-pip stop
  const wideBuy = makeSignal("BUY", 3000, 20.0); // 200-pip stop
  const tightSell = makeSignal("SELL", 3000, 4.0);

  const tightLock = resolver.getPostTP1LockPrice(tightBuy);
  const wideLock = resolver.getPostTP1LockPrice(wideBuy);
  const sellLock = resolver.getPostTP1LockPrice(tightSell);

  const tightLockR = (tightLock - tightBuy.entryPrice) / 4.0;
  const wideLockR = (wideLock - wideBuy.entryPrice) / 20.0;
  const oldFixedLockRTight = 1.5 / 4.0; // old 15 pips = $1.50
  const oldFixedLockRWide = 1.5 / 20.0;

  console.log(`     tight stop ($4.00): lock=${tightLock.toFixed(1)} (${tightLockR.toFixed(3)}R) | old fixed 15-pip lock would be ${oldFixedLockRTight.toFixed(3)}R`);
  console.log(`     wide stop ($20.00): lock=${wideLock.toFixed(1)} (${wideLockR.toFixed(3)}R) | old fixed 15-pip lock would be ${oldFixedLockRWide.toFixed(3)}R`);

  check("BUY lock sits at 0.35R above entry", Math.abs(tightLockR - resolver.POST_TP1_PROFIT_LOCK_R) < 1e-6, `${tightLockR.toFixed(4)}R`);
  check("SELL lock mirrors below entry", Math.abs((tightSell.entryPrice - sellLock) / 4.0 - resolver.POST_TP1_PROFIT_LOCK_R) < 1e-6, `lock=${sellLock.toFixed(1)}`);
  check(
    "lock is SCOPE-INVARIANT across stop sizes (the old fixed lock was not)",
    Math.abs(tightLockR - wideLockR) < 1e-6 && Math.abs(oldFixedLockRTight - oldFixedLockRWide) > 0.2,
    `new: ${tightLockR.toFixed(3)}R vs ${wideLockR.toFixed(3)}R | old: ${oldFixedLockRTight.toFixed(3)}R vs ${oldFixedLockRWide.toFixed(3)}R`,
  );
  check(
    "lock always sits strictly inside TP1 (can never be unreachable)",
    tightLock < tightBuy.tp1 && wideLock < wideBuy.tp1 && sellLock > tightSell.tp1,
    `tight lock ${tightLock.toFixed(1)} < tp1 ${tightBuy.tp1.toFixed(1)}`,
  );
  // The old fixed $1.50 lock vs a 20-pip ($2.00) stop: TP1 sits at 0.7R = $1.40,
  // so the lock sat BEYOND TP1 and could never be reached - it was silently
  // disabled in exactly the low-volatility regime it mattered most in.
  const veryTightBuy = makeSignal("BUY", 3000, 2.0);
  const veryTightLock = resolver.getPostTP1LockPrice(veryTightBuy);
  check(
    "old fixed 15-pip lock WOULD have sat beyond TP1 on a 20-pip stop (documents the bug)",
    3000 + 1.5 > veryTightBuy.tp1,
    `old lock 3001.5 vs tp1 ${veryTightBuy.tp1.toFixed(1)}`,
  );
  check(
    "new lock stays inside TP1 even on that 20-pip stop",
    veryTightLock < veryTightBuy.tp1,
    `new lock ${veryTightLock.toFixed(1)} < tp1 ${veryTightBuy.tp1.toFixed(1)}`,
  );

  const degenerate = { type: "BUY", entryPrice: 3000, sl: 3000, tp1: 3002, tp2: 3003, tp3: 3004 };
  check(
    "degenerate zero stop distance still yields a finite lock above entry",
    resolver.getPostTP1LockPrice(degenerate) > 3000 && Number.isFinite(resolver.getPostTP1LockPrice(degenerate)),
    `lock=${resolver.getPostTP1LockPrice(degenerate).toFixed(1)}`,
  );

  // ============ B4: sweep = penetration + reclaim + timeliness ============
  console.log("\n  --- B4: a sweep now requires penetration AND a reclaim, in time ---");
  const atr = signalEngine.getRealATRForTest(14);
  const threshold = Math.max(1.0, atr * 0.25);
  const level = 3050;
  const t0 = Date.now();
  console.log(`     ATR(14)=${atr.toFixed(2)} -> penetration threshold $${threshold.toFixed(2)} (old code used a flat $2)`);

  signalEngine.resetSweepStateForTest();
  const penetrated = signalEngine.evaluateSessionSweepForTest({
    sessionType: "ASIAN", type: "HIGH_SWEEP", level, currentPrice: level + threshold + 1, now: t0,
  });
  check(
    "penetration WITHOUT reclaim emits NO sweep (old code emitted one immediately)",
    penetrated.sweeps.length === 0 && penetrated.pending === 1,
    `sweeps=${penetrated.sweeps.length} pending=${penetrated.pending}`,
  );

  const reclaimed = signalEngine.evaluateSessionSweepForTest({
    sessionType: "ASIAN", type: "HIGH_SWEEP", level, currentPrice: level - 0.5, now: t0 + 5 * 60 * 1000,
  });
  const confirmed = reclaimed.sweeps[0];
  check(
    "reclaim back inside the level within the window CONFIRMS the sweep",
    reclaimed.sweeps.length === 1 && confirmed?.reversalConfirmed === true,
    `sweeps=${reclaimed.sweeps.length} confirmed=${confirmed?.reversalConfirmed}`,
  );
  check(
    "confirmed sweep records real penetration depth + reclaim latency",
    (confirmed?.penetrationDepth ?? 0) >= threshold && (confirmed?.reclaimLatencyMs ?? 0) === 5 * 60 * 1000,
    `depth=$${confirmed?.penetrationDepth?.toFixed(2)} latency=${((confirmed?.reclaimLatencyMs ?? 0) / 60000).toFixed(0)}min`,
  );
  check("pending penetration cleared after confirmation", reclaimed.pending === 0, `pending=${reclaimed.pending}`);

  // Breakout case: penetrate, never reclaim in time.
  signalEngine.resetSweepStateForTest();
  signalEngine.evaluateSessionSweepForTest({
    sessionType: "LONDON", type: "LOW_SWEEP", level, currentPrice: level - threshold - 1, now: t0,
  });
  const lateReclaim = signalEngine.evaluateSessionSweepForTest({
    sessionType: "LONDON", type: "LOW_SWEEP", level, currentPrice: level + 0.5, now: t0 + 46 * 60 * 1000,
  });
  check(
    "penetration reclaimed only AFTER the window is discarded as a breakout, not a sweep",
    lateReclaim.sweeps.length === 0 && lateReclaim.pending === 0,
    `sweeps=${lateReclaim.sweeps.length} pending=${lateReclaim.pending}`,
  );

  // Shallow poke below the ATR-scaled threshold must not even open a penetration.
  signalEngine.resetSweepStateForTest();
  const shallow = signalEngine.evaluateSessionSweepForTest({
    sessionType: "NY", type: "HIGH_SWEEP", level, currentPrice: level + threshold * 0.4, now: t0,
  });
  check(
    "sub-threshold poke opens no penetration (trigger scales with ATR)",
    shallow.sweeps.length === 0 && shallow.pending === 0,
    `sweeps=${shallow.sweeps.length} pending=${shallow.pending}`,
  );

  // ============ B5: dwell no longer inflates touches; evidence un-clamped ============
  console.log("\n  --- B5: distinct touch EVENTS + un-clamped evidence curves ---");
  const zoneLevel = 3251;
  const away = 3235;
  const priorDay = { high: 3251, low: 3249, close: 3250, open: 3250 };

  // One long dwell (20 consecutive samples inside) vs 20 distinct revisits.
  const dwellHist = buildVisitHistory(zoneLevel, away, 1, 20);
  const revisitHist = buildVisitHistory(zoneLevel, away, 20, 1);

  const dwellZones = signalEngine.getSRZonesForTest(3250, dwellHist.highs, dwellHist.lows, dwellHist.closes, priorDay);
  const revisitZones = signalEngine.getSRZonesForTest(3250, revisitHist.highs, revisitHist.lows, revisitHist.closes, priorDay);

  const nearest = (zones: SRZone[]): SRZone | undefined =>
    zones.slice().sort((a, b) => Math.abs(a.price - zoneLevel) - Math.abs(b.price - zoneLevel))[0];
  const dwellZone = nearest(dwellZones);
  const revisitZone = nearest(revisitZones);

  console.log(`     1 visit x 20 samples dwell -> touches=${dwellZone?.touches} reaction=${dwellZone?.reactionStrength}`);
  console.log(`     20 distinct visits x 1     -> touches=${revisitZone?.touches} reaction=${revisitZone?.reactionStrength}`);

  check(
    "a single lingering visit no longer counts as many touches (dwell != repeated tests)",
    (dwellZone?.touches ?? 99) < (revisitZone?.touches ?? 0),
    `dwell touches=${dwellZone?.touches} vs revisit touches=${revisitZone?.touches}`,
  );
  check(
    "20 genuine revisits score strictly stronger than one long dwell (old code scored them identically)",
    (revisitZone?.reactionStrength ?? 0) > (dwellZone?.reactionStrength ?? 0),
    `revisit=${revisitZone?.reactionStrength} > dwell=${dwellZone?.reactionStrength}`,
  );

  // Un-clamping: 6 vs 30 distinct touches were IDENTICAL under min(1, touches/6).
  const sixHist = buildVisitHistory(zoneLevel, away, 6, 1);
  const manyHist = buildVisitHistory(zoneLevel, away, 30, 1);
  const sixZone = nearest(signalEngine.getSRZonesForTest(3250, sixHist.highs, sixHist.lows, sixHist.closes, priorDay));
  const manyZone = nearest(signalEngine.getSRZonesForTest(3250, manyHist.highs, manyHist.lows, manyHist.closes, priorDay));
  console.log(`     6 distinct touches  -> touches=${sixZone?.touches} reaction=${sixZone?.reactionStrength}`);
  console.log(`     30 distinct touches -> touches=${manyZone?.touches} reaction=${manyZone?.reactionStrength}`);
  check(
    "evidence beyond the old cap still increases strength (6 vs 30 touches no longer tie at 1.0)",
    (manyZone?.reactionStrength ?? 0) > (sixZone?.reactionStrength ?? 0),
    `30-touch=${manyZone?.reactionStrength} > 6-touch=${sixZone?.reactionStrength}`,
  );
  check(
    "reactionStrength stays bounded in [0,1] so every downstream threshold keeps its meaning",
    [dwellZone, revisitZone, sixZone, manyZone].every(z => (z?.reactionStrength ?? 0) >= 0 && (z?.reactionStrength ?? 0) <= 1),
    `max=${Math.max(...[dwellZone, revisitZone, sixZone, manyZone].map(z => z?.reactionStrength ?? 0)).toFixed(3)}`,
  );

  // ============ C3: BE scratches are no longer labelled as WINs ============
  console.log("\n  --- C3: ~0R profit-lock scratches excluded from labels ---");
  signalEngine.resetOutcomesForTest();
  // 0.35R profit lock on a $10 stop = $3.50 -> a real (small) win, NOT a scratch.
  await signalEngine.recordTradeOutcome("lock-win", 3000, 3003.5, "WIN", {}, undefined, 60_000, 0.8, 10);
  // A near-entry protected exit -> genuine scratch.
  await signalEngine.recordTradeOutcome("scratch", 3000, 3000.5, "WIN", {}, undefined, 60_000, 0.8, 10);
  // Clean stop-out.
  await signalEngine.recordTradeOutcome("stopped", 3000, 2990, "LOSS", {}, undefined, 60_000, 0.8, 10);

  const stored = signalEngine.getStoredOutcomesForTest();
  const lockWin = stored.find(o => o.realizedR !== undefined && Math.abs((o.realizedR ?? 0) - 0.35) < 1e-6);
  const scratch = stored.find(o => Math.abs((o.realizedR ?? 0) - 0.05) < 1e-6);
  const loss = stored.find(o => o.result === "LOSS");
  console.log(`     recorded R multiples: ${stored.map(o => o.realizedR?.toFixed(2) ?? "n/a").join(", ")}`);
  check("0.05R protected exit is flagged as a SCRATCH", scratch?.isScratch === true, `isScratch=${scratch?.isScratch} R=${scratch?.realizedR}`);
  check("0.35R profit-lock exit is NOT a scratch (it is a real small win)", lockWin?.isScratch === false, `isScratch=${lockWin?.isScratch} R=${lockWin?.realizedR}`);
  check("clean -1R stop-out is NOT a scratch", loss?.isScratch === false, `isScratch=${loss?.isScratch} R=${loss?.realizedR}`);
  check(
    "direction is inferred from realised geometry without any call-site change",
    lockWin?.direction === "BUY" && loss?.direction === "BUY",
    `lockWin=${lockWin?.direction} loss=${loss?.direction}`,
  );

  // ============ C4: direction-bucketed calibration ============
  console.log("\n  --- C4: calibration penalty applies only to the losing direction ---");
  signalEngine.resetOutcomesForTest();
  // 22 losing SELLs (exit ABOVE entry on a LOSS => SELL), each -0.6R.
  for (let i = 0; i < 22; i++) {
    await signalEngine.recordTradeOutcome(`sell-${i}`, 3000, 3006, "LOSS", {}, undefined, 60_000, 0.8, 10);
  }
  // A handful of winning BUYs, below the minimum sample size.
  for (let i = 0; i < 5; i++) {
    await signalEngine.recordTradeOutcome(`buy-${i}`, 3000, 3008, "WIN", {}, undefined, 60_000, 0.8, 10);
  }

  const expectancy = signalEngine.getDirectionalExpectancyForTest();
  const sellPenalty = signalEngine.getDirectionalCalibrationPenaltyForTest("SELL");
  const buyPenalty = signalEngine.getDirectionalCalibrationPenaltyForTest("BUY");
  console.log(`     BUY  n=${expectancy.BUY.n} EV=${expectancy.BUY.meanR.toFixed(3)}R -> penalty ${(buyPenalty * 100).toFixed(1)}%`);
  console.log(`     SELL n=${expectancy.SELL.n} EV=${expectancy.SELL.meanR.toFixed(3)}R -> penalty ${(sellPenalty * 100).toFixed(1)}%`);

  check("losing direction with a sufficient sample is penalised", sellPenalty > 0, `SELL penalty=${(sellPenalty * 100).toFixed(1)}%`);
  check("penalty is capped (nudge, not a hard suppression)", sellPenalty <= 0.05 + 1e-9, `SELL penalty=${(sellPenalty * 100).toFixed(1)}%`);
  check(
    "profitable direction is NOT penalised (pooled calibration used to punish both sides equally)",
    buyPenalty === 0,
    `BUY penalty=${(buyPenalty * 100).toFixed(1)}% at n=${expectancy.BUY.n} (< 20 sample minimum)`,
  );
  check("directional expectancy reflects the recorded book", expectancy.SELL.n >= 20 && expectancy.SELL.meanR < 0, `SELL n=${expectancy.SELL.n} EV=${expectancy.SELL.meanR}`);

  // Recovery: once the short book turns positive, the penalty must decay to zero.
  for (let i = 0; i < 40; i++) {
    await signalEngine.recordTradeOutcome(`sell-win-${i}`, 3000, 2994, "WIN", {}, undefined, 60_000, 0.8, 10);
  }
  const recoveredExpectancy = signalEngine.getDirectionalExpectancyForTest();
  const recoveredPenalty = signalEngine.getDirectionalCalibrationPenaltyForTest("SELL");
  console.log(`     after 40 winning SELLs: SELL n=${recoveredExpectancy.SELL.n} EV=${recoveredExpectancy.SELL.meanR.toFixed(3)}R -> penalty ${(recoveredPenalty * 100).toFixed(1)}%`);
  check(
    "penalty self-corrects to zero once that direction's expectancy recovers",
    recoveredPenalty === 0 && recoveredExpectancy.SELL.meanR > 0,
    `penalty=${(recoveredPenalty * 100).toFixed(1)}% EV=${recoveredExpectancy.SELL.meanR.toFixed(3)}R`,
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) {
    console.error(`❌ ${fail} FAILED`);
    process.exit(1);
  }
  console.log("✅ Phase 2b verified — R-relative profit lock, reclaim-gated sweeps, un-clamped zone evidence, scratch-aware labels, and direction-bucketed calibration all behave as specified.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
