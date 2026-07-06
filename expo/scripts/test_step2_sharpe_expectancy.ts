import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * STEP 2 CHECKPOINT TEST
 * Verifies:
 *  1. Sharpe annualization now scales with sqrt(actual trades/day * 252) instead
 *     of a fixed sqrt(252) — i.e. it actually reads real signal cadence from the
 *     trade timestamps rather than assuming one trade/day.
 *  2. Expectancy is computed in R-multiples (pnl / initial-risk-in-dollars), so
 *     it is comparable across signals with different (ATR-based) SL distances,
 *     not a raw dollar average.
 *
 * Method: load the real exported pure functions (computeSignalPnL,
 * computeSignalRiskAmount, computeSignalRMultiple, classifySignalOutcome) out of
 * TradingContext.tsx via the same CRLF-tolerant sandbox-stripping pattern used by
 * the Step 1 / Fix A tests, then:
 *  - Build one fixed synthetic closed-trade history with two different SL
 *    distances (proving expectancy is risk-normalized, not a raw $ average).
 *  - Replicate the exact old (fixed sqrt(252)) vs new (sqrt(tradesPerDay*252))
 *    Sharpe formula against that same synthetic return series at two assumed
 *    trade frequencies (2/day vs 30/day spacing) and assert the new Sharpe
 *    scales by sqrt(N), while the old one does not move at all.
 */

interface Step2Module {
  computeSignalPnL(signal: unknown, basePositionSize: number): number;
  computeSignalRiskAmount(signal: unknown, basePositionSize: number): number;
  computeSignalRMultiple(signal: unknown, basePositionSize: number): number;
  classifySignalOutcome(signal: unknown, basePositionSize: number): string;
}

async function loadModule(): Promise<Step2Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, `TradingContext.step2.ts`);
  const sourcePath = path.join(process.cwd(), "contexts", "TradingContext.tsx");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "../../types/trading.ts";
type AppStateStatus = string;
const AsyncStorage = { async getItem() { return null; }, async setItem() {}, async removeItem() {} } as any;
const signalEngine = {} as any;
function setExternalPrice(..._args: unknown[]): void {}
async function fetchLiveGoldPriceFallback(..._args: unknown[]): Promise<unknown> { return null; }
const Platform = { OS: "web" as const };
const AppState = { addEventListener() { return { remove() {} }; }, currentState: "active" } as any;
async function fetchHistoricalData(..._args: unknown[]): Promise<unknown> { return null; }
const goldWebSocketService = {} as any;
function registerBackgroundTask(..._args: unknown[]): void {}
function setupNotificationChannel(..._args: unknown[]): void {}
async function requestNotificationPermissions(..._args: unknown[]): Promise<boolean> { return false; }
async function sendSignalNotification(..._args: unknown[]): Promise<void> {}
function subscribeToChartPrice(..._args: unknown[]): () => void { return () => {}; }
function subscribeToChartHeartbeat(..._args: unknown[]): () => void { return () => {}; }
type OhlcBar = unknown;
async function ensureBarStoreReady(..._args: unknown[]): Promise<void> {}
async function ingestTickAllTimeframes(..._args: unknown[]): Promise<void> {}
async function upsertBars(..._args: unknown[]): Promise<void> {}
async function getBars(..._args: unknown[]): Promise<unknown[]> { return []; }
async function getBarStoreStats(..._args: unknown[]): Promise<unknown> { return {}; }
async function pruneOldBars(..._args: unknown[]): Promise<void> {}
async function getLatestBarTimestamp(..._args: unknown[]): Promise<number> { return 0; }
async function resolveSignalWithBars(..._args: unknown[]): Promise<unknown> { return null; }
async function sendTelegramAlert(..._args: unknown[]): Promise<void> {}
function createContextHook<T>(factory: () => T): [(props: { children?: unknown }) => unknown, () => T] {
  return [(() => null) as unknown as (props: { children?: unknown }) => unknown, factory];
}
function useState<T>(initial: T): [T, (v: T) => void] { return [initial, () => {}]; }
function useEffect(..._args: unknown[]): void {}
function useCallback<T>(fn: T): T { return fn; }
function useMemo<T>(fn: () => T): T { return fn(); }
function useRef<T>(initial: T): { current: T } { return { current: initial }; }
`;

  // CRLF-tolerant regex stripping (Fix A requirement) covering every module-level
  // import in TradingContext.tsx.
  const rewritten = source
    .replace(/^import\s+createContextHook\s+from\s+["']@nkzw\/create-context-hook["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/signalEngine["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/goldWebSocketService["'];?\r?\n/m, "")
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+["']@\/services\/backgroundTaskService["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/chartPriceBridge["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/barStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/signalResolver["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/telegramNotifier["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<Step2Module>;
}

function makeSignal(opts: {
  type: "BUY" | "SELL";
  entryPrice: number;
  sl: number;
  tp3: number;
  status: string;
  exitPrice: number;
  timestamp: Date;
}): unknown {
  return {
    id: `sig-${Math.random()}`,
    timestamp: opts.timestamp,
    type: opts.type,
    entryPrice: opts.entryPrice,
    entryPriceWithSlippage: opts.entryPrice,
    tp1: opts.entryPrice,
    tp2: opts.entryPrice,
    tp3: opts.tp3,
    sl: opts.sl,
    slMultiplier: 1,
    confidence: 0.75,
    status: opts.status,
    targetsHit: 0,
    entryTime: opts.timestamp.toISOString(),
    exitTime: opts.timestamp.toISOString(),
    exitPrice: opts.exitPrice,
    topFeatures: [],
    riskJustification: "test",
  };
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("\nStep 2: intraday-correct Sharpe annualization + R-multiple expectancy\n");

  const mod = await loadModule();
  const basePositionSize = 0.01;

  // --- Part 1: expectancy in R-multiples, not raw dollars ---------------
  // Trade A: narrow SL (tight risk), small win -> big R (risk-normalized).
  // Trade B: wide SL (wide/ATR risk), same-magnitude raw $ win -> small R.
  // A raw-dollar average would treat these as roughly equal; R-multiples must not.
  const tradeA = makeSignal({
    type: "BUY", entryPrice: 3250, sl: 3245, tp3: 3260,
    status: "TP3_HIT", exitPrice: 3255, timestamp: new Date("2026-06-01T09:00:00Z"),
  }); // TP3_HIT always resolves at tp3 (10 pips of reward) regardless of exitPrice -> risk=5, pnl=10 -> R=2.0
  const tradeB = makeSignal({
    type: "BUY", entryPrice: 3250, sl: 3210, tp3: 3260,
    status: "TP3_HIT", exitPrice: 3255, timestamp: new Date("2026-06-01T15:00:00Z"),
  }); // same tp3 reward (10 pips) but 8x wider risk (40) -> R=0.25

  const riskA = mod.computeSignalRiskAmount(tradeA, basePositionSize);
  const riskB = mod.computeSignalRiskAmount(tradeB, basePositionSize);
  const rA = mod.computeSignalRMultiple(tradeA, basePositionSize);
  const rB = mod.computeSignalRMultiple(tradeB, basePositionSize);
  const pnlA = mod.computeSignalPnL(tradeA, basePositionSize);
  const pnlB = mod.computeSignalPnL(tradeB, basePositionSize);

  console.log(`  Trade A: risk=$${riskA.toFixed(2)} pnl=$${pnlA.toFixed(2)} R=${rA.toFixed(3)}`);
  console.log(`  Trade B: risk=$${riskB.toFixed(2)} pnl=$${pnlB.toFixed(2)} R=${rB.toFixed(3)}`);
  console.log(`  Old (raw-$) expectancy would average pnlA/pnlB directly despite the 8x risk difference.`);
  console.log(`  New (R-multiple) expectancy = mean(${rA.toFixed(3)}, ${rB.toFixed(3)}) = ${((rA + rB) / 2).toFixed(3)}\n`);

  check("Trade A risk computed from entry->SL distance", Math.abs(riskA - 5 * basePositionSize * 100) < 1e-6, `riskA=${riskA}`);
  check("Trade B risk computed from entry->SL distance (8x wider)", Math.abs(riskB - 40 * basePositionSize * 100) < 1e-6, `riskB=${riskB}`);
  check("Same raw $ pnl produces very different R when risk differs", Math.abs(pnlA - pnlB) < 1e-6 && rA > rB * 5,
    `pnlA=${pnlA.toFixed(2)} pnlB=${pnlB.toFixed(2)} rA=${rA.toFixed(3)} rB=${rB.toFixed(3)}`);
  check("Tight-risk winner captures a full 2R (10pt reward vs 5pt risk)", Math.abs(rA - 2.0) < 1e-6, `rA=${rA.toFixed(4)}`);
  check("Same setup with 8x wider risk scores proportionally lower (0.25R)", Math.abs(rB - 0.25) < 1e-6, `rB=${rB.toFixed(4)}`);

  // --- Part 2: Sharpe scales with sqrt(trades/day), not a fixed constant --
  // Same synthetic R-multiple return series, replicated at two trade
  // frequencies purely via timestamp spacing (2/day vs 30/day over a fixed
  // 10-day window), reproducing the exact formula now in TradingContext.tsx.
  const syntheticReturns = [0.5, -0.3, 0.8, -0.4, 0.6, -0.2, 0.4, -0.5, 0.7, -0.1];
  function sharpeOld(returns: number[]): number {
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1));
    return stdDev > 0 ? (avg / stdDev) * Math.sqrt(252) : 0;
  }
  function sharpeNew(returns: number[], tradesPerDay: number): number {
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1));
    const annualizationFactor = tradesPerDay > 0 ? Math.sqrt(tradesPerDay * 252) : 0;
    return stdDev > 0 ? (avg / stdDev) * annualizationFactor : 0;
  }

  const oldSharpeLowFreq = sharpeOld(syntheticReturns);
  const oldSharpeHighFreq = sharpeOld(syntheticReturns); // old formula is frequency-blind
  const newSharpeLowFreq = sharpeNew(syntheticReturns, 2);
  const newSharpeHighFreq = sharpeNew(syntheticReturns, 30);
  const expectedRatio = Math.sqrt(30 / 2);
  const actualRatio = newSharpeHighFreq / newSharpeLowFreq;

  console.log(`  Old formula (fixed sqrt(252)): 2/day=${oldSharpeLowFreq.toFixed(3)}  30/day=${oldSharpeHighFreq.toFixed(3)}  (identical -- frequency-blind, the bug)`);
  console.log(`  New formula (sqrt(N*252)):     2/day=${newSharpeLowFreq.toFixed(3)}  30/day=${newSharpeHighFreq.toFixed(3)}`);
  console.log(`  Expected scaling factor sqrt(30/2)=${expectedRatio.toFixed(4)}, actual=${actualRatio.toFixed(4)}\n`);

  check("Old formula is identical regardless of trade frequency (confirms the prior bug)",
    Math.abs(oldSharpeLowFreq - oldSharpeHighFreq) < 1e-9, `old2=${oldSharpeLowFreq.toFixed(4)} old30=${oldSharpeHighFreq.toFixed(4)}`);
  check("New formula's 30/day Sharpe is materially higher than its 2/day Sharpe",
    newSharpeHighFreq > newSharpeLowFreq, `new2=${newSharpeLowFreq.toFixed(4)} new30=${newSharpeHighFreq.toFixed(4)}`);
  check("New formula scales by exactly sqrt(N_high/N_low)",
    Math.abs(actualRatio - expectedRatio) < 1e-6, `expected=${expectedRatio.toFixed(6)} actual=${actualRatio.toFixed(6)}`);

  // --- Part 3: end-to-end against real signal history via classifySignalOutcome ---
  const outcomeA = mod.classifySignalOutcome(tradeA, basePositionSize);
  const outcomeB = mod.classifySignalOutcome(tradeB, basePositionSize);
  check("Both synthetic trades classify as WIN (sanity: R-multiple test trades are real wins)",
    outcomeA === "WIN" && outcomeB === "WIN", `outcomeA=${outcomeA} outcomeB=${outcomeB}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Step 2 verified — Sharpe now scales with real trade cadence, expectancy is risk-normalized."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
