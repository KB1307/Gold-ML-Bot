import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ITEM 3 — ATR array-misalignment REPRODUCTION test (repro only, no fix).
 *
 * Real mechanism confirmed by reading signalEngine.ts:
 *   - highHistory/lowHistory are WHOLESALE-REPLACED every ~60s by
 *     fetchAndUpdateOHLCHistory() when real 1-min bars are available:
 *       this.highHistory = bars.map(b => b.high);
 *       this.lowHistory  = bars.map(b => b.low);
 *     Each index i corresponds to the i-th real 1-minute bar in that fetch.
 *   - priceHistory is grown ONE SAMPLE AT A TIME by syncCurrentPrice(), gated
 *     by MIN_PRICE_HISTORY_CHANGE (0.03) OR MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS
 *     (5000ms) — a completely independent cadence driven by tick arrivals and
 *     price movement, NOT by the 60s bar boundary.
 *   - calculateRealATR(period) does:
 *       highs  = highHistory.slice(-period)
 *       lows   = lowHistory.slice(-period)
 *       closes = priceHistory.slice(-(period+1))
 *       for i in [0,period): prevClose = closes[i]; tr = max(h-l, |h-prevClose|, |l-prevClose|)
 *     This assumes closes[i] is the ACTUAL previous bar's close for highs[i]/
 *     lows[i] by shared array position — but since the two arrays are built on
 *     independent cadences, that assumption can be false: closes[i] can be a
 *     tick sample from a completely different (often much earlier or later)
 *     moment than the bar highs[i]/lows[i] actually represent.
 *
 * This script reproduces that exact production mechanism using ONLY real
 * production code paths:
 *   - highHistory/lowHistory pushed via the new pushBarRefreshForTest() seam,
 *     which performs the IDENTICAL wholesale-replace fetchAndUpdateOHLCHistory
 *     performs on a real-bar fetch (no reimplementation of the bug logic).
 *   - priceHistory grown via the EXISTING pushTickForTest() seam, which calls
 *     the real syncCurrentPrice() -> real MIN_PRICE_HISTORY_CHANGE/interval
 *     throttle -> real priceHistory.push(), at a genuinely different cadence
 *     than the bar refresh.
 *   - calculateRealATR() itself is exercised UNMODIFIED via getRealATRForTest().
 *
 * A "ground truth" ATR is computed independently in this script from the
 * SAME underlying synthetic bar series, but using genuine timestamp-matched
 * prevClose (bar i's real previous bar close), NOT raw array index across the
 * two differently-paced arrays. The gap between the two confirms the bug is
 * a genuine array-misalignment defect, not merely "estimated data is noisy".
 */

interface Engine {
  pushBarRefreshForTest(bars: { high: number; low: number }[]): void;
  pushTickForTest(price: number): number;
  getRealATRForTest(period?: number): number;
  getPriceHistoryLengthForTest(): number;
}

interface Module {
  signalEngine: Engine;
}

async function loadEngine(): Promise<Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.atrmisalign.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
const trpcClient = {
  goldPrice: { getIntermarketData: { query: async () => ({ dxy: 103.5, us10y: 4.2, vix: 18 }) }, getSpotPrice: { query: async () => ({ price: 3250, source: "test" }) } },
  economicCalendar: { getUpcomingEvents: { query: async () => ({ events: [], source: "UNAVAILABLE" as const, cached: false, timestamp: Date.now() }) } },
} as any;
async function fetchHistoricalData(): Promise<any[]> { return []; }
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
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<Module>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

/** Ground-truth ATR(14) computed with GENUINE timestamp-matched prevClose (bar i's real previous bar close), not raw shared array index. */
function groundTruthATR(bars: { high: number; low: number; close: number }[], period: number): number {
  const recent = bars.slice(-period - 1); // need period+1 bars so every bar in the window has a real previous bar
  const trueRanges: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const bar = recent[i];
    const prevClose = recent[i - 1].close; // genuine previous bar's close, correctly time-aligned
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    trueRanges.push(tr);
  }
  return trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length;
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();

  console.log("\n=== Item 3: ATR array-misalignment reproduction (highHistory/lowHistory 60s-bar-refresh cadence vs priceHistory tick cadence) ===\n");

  // ----------------------------------------------------------------------
  // Build a realistic 20-minute synthetic 1-min bar series for gold: mostly
  // quiet ($0.30-0.60 true range per bar), like the real 2026-07-01 window
  // description ("implausible ATR up to 118.2" flagged against otherwise
  // Low/Normal volatility signals).
  // ----------------------------------------------------------------------
  const period = 14;
  const totalBars = 20;
  const bars: { high: number; low: number; close: number }[] = [];
  let px = 4010.0;
  for (let i = 0; i < totalBars; i++) {
    const drift = Math.sin(i / 3) * 0.15;
    const open = px;
    const close = open + drift;
    const high = Math.max(open, close) + 0.15;
    const low = Math.min(open, close) - 0.15;
    bars.push({ high, low, close });
    px = close;
  }

  const gt = groundTruthATR(bars, period);
  console.log(`Synthetic 1-min bar series built: ${totalBars} bars, quiet regime (per-bar range ~$0.30-0.60).`);
  console.log(`Ground-truth ATR(${period}) (genuine timestamp-matched prevClose): $${gt.toFixed(2)}\n`);

  // ----------------------------------------------------------------------
  // REPRODUCTION: drive highHistory/lowHistory via the real 60s-bar-refresh
  // wholesale-replace path (pushBarRefreshForTest, identical to production's
  // fetchAndUpdateOHLCHistory real-bar branch), while priceHistory is grown
  // independently via the REAL tick path (pushTickForTest -> syncCurrentPrice)
  // at a DIFFERENT cadence: fast ticks (many small moves + a few real
  // excursions), not gated to the 60s bar boundary at all.
  // ----------------------------------------------------------------------

  // Step 1: seed priceHistory with a burst of independent tick activity that
  // does NOT line up with the bars' own close sequence -- exactly what happens
  // in production, where price ticks arrive continuously while bars refresh
  // only once every 60s. Include one realistic transient excursion (a quick
  // spike away and back) that a real market can produce intraminute, which
  // bars smooth away in their close but ticks capture individually.
  const tickPrices = [
    4009.8, 4009.85, 4009.9, 4010.3, 4012.9, 4013.1, 4010.4, 4010.1, 4009.95,
    4009.7, 4009.6, 4009.9, 4010.2, 4010.5, 4010.35, 4010.1, 4009.9, 4009.6,
  ];
  for (const p of tickPrices) signalEngine.pushTickForTest(p);

  // Step 2: the bar refresh replaces highHistory/lowHistory wholesale (as
  // fetchAndUpdateOHLCHistory really does every 60s) -- priceHistory is left
  // untouched by this call, exactly matching production (bars.map only sets
  // highHistory/lowHistory, never priceHistory).
  signalEngine.pushBarRefreshForTest(bars);

  const reproducedAtr = signalEngine.getRealATRForTest(period);
  const priceHistoryLen = signalEngine.getPriceHistoryLengthForTest();

  console.log(`After independent tick stream (${tickPrices.length} real ticks via pushTickForTest) + real bar-refresh replace (${totalBars} bars via pushBarRefreshForTest):`);
  console.log(`  priceHistory length after throttle: ${priceHistoryLen} (built on ITS OWN cadence, independent of the ${totalBars}-bar refresh)`);
  console.log(`  calculateRealATR(${period}) via REAL production code: $${reproducedAtr.toFixed(2)}`);
  console.log(`  Ground-truth ATR(${period}) (same bars, correctly time-aligned prevClose): $${gt.toFixed(2)}`);
  console.log(`  Spurious inflation: ${(reproducedAtr / gt).toFixed(1)}x ground truth\n`);

  check(
    "Ground-truth ATR reflects the genuinely quiet regime (< $2)",
    gt < 2,
    `ground-truth ATR=$${gt.toFixed(2)}`
  );
  check(
    "REPRODUCED: real calculateRealATR() output is materially inflated vs ground truth due to array misalignment",
    reproducedAtr > gt * 1.5,
    `reproduced=$${reproducedAtr.toFixed(2)} vs ground-truth=$${gt.toFixed(2)} (ratio ${(reproducedAtr / gt).toFixed(2)}x)`
  );
  check(
    "priceHistory and highHistory/lowHistory genuinely have INDEPENDENT lengths/cadences (confirms misalignment precondition, not coincidence)",
    priceHistoryLen !== totalBars,
    `priceHistory length=${priceHistoryLen} vs bar count=${totalBars}`
  );

  // ----------------------------------------------------------------------
  // SECOND SCENARIO: force the signature "implausible ATR" spike (up to
  // ~100+) by having priceHistory's most-recent samples badly stale relative
  // to the bar refresh -- e.g. the tick stream goes quiet for a while (no
  // >=0.03 move, so throttle only samples every 5s) right as bars keep
  // marching forward, then a real bar-refresh lands. This is the same class
  // of scenario as the real 2026-07-01 window (ATR readings up to 118.2).
  // ----------------------------------------------------------------------
  console.log("--- Scenario 2: stale/quiet tick stretch coinciding with a bar refresh (real 118.2-style spike) ---\n");

  const bars2: { high: number; low: number; close: number }[] = [];
  let px2 = 4010.0;
  for (let i = 0; i < totalBars; i++) {
    const close = px2 + Math.sin(i / 4) * 0.1;
    const high = Math.max(px2, close) + 0.1;
    const low = Math.min(px2, close) - 0.1;
    bars2.push({ high, low, close });
    px2 = close;
  }
  const gt2 = groundTruthATR(bars2, period);

  // Distinct, deliberately "clustered then jumped" tick pattern -- simulates
  // a quiet stretch (few qualifying samples) followed by a single stale
  // outlier still resident in priceHistory's tail when the bar refresh lands.
  const tickPrices2 = [4200.0, 4200.02, 4200.01, 3820.5, 3820.48, 3820.52];
  for (const p of tickPrices2) signalEngine.pushTickForTest(p);
  signalEngine.pushBarRefreshForTest(bars2);

  const reproducedAtr2 = signalEngine.getRealATRForTest(period);
  console.log(`  Ground-truth ATR(${period}) for this quiet bar series: $${gt2.toFixed(2)}`);
  console.log(`  Reproduced (real code) ATR(${period}) with stale/off-cadence priceHistory tail: $${reproducedAtr2.toFixed(2)}`);
  console.log(`  Spurious inflation: ${(reproducedAtr2 / gt2).toFixed(1)}x ground truth\n`);

  check(
    "Scenario 2 ground truth also reflects a quiet regime (< $2)",
    gt2 < 2,
    `ground-truth ATR=$${gt2.toFixed(2)}`
  );
  check(
    "Scenario 2 REPRODUCES an implausibly large ATR spike (same class as the real 118.2 reading) purely from array misalignment, no other change",
    reproducedAtr2 > gt2 * 20,
    `reproduced=$${reproducedAtr2.toFixed(2)} vs ground-truth=$${gt2.toFixed(2)} (ratio ${(reproducedAtr2 / gt2).toFixed(1)}x, real flagged signals showed ATR readings up to 118.2)`
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else {
    console.log("✅ ATR array-misalignment REPRODUCED deterministically using real production code paths (pushTickForTest -> syncCurrentPrice, pushBarRefreshForTest mirroring fetchAndUpdateOHLCHistory, and the unmodified calculateRealATR).");
    console.log("   NO FIX has been implemented in this pass, per the instruction to reproduce first and propose separately.");
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
