/**
 * SELL suppression test — deterministic, sandboxed.
 *
 * Uses the SAME sandboxing/import-stripping pattern as runSignalSimulation.ts
 * to avoid the react-native import issue. Monkey-patches key private methods
 * on the sandboxed engine to deterministically force a SELL through every gate
 * to the suppression check, then verifies:
 *
 *   1. With allowShortSignals=false, a qualifying SELL returns null (suppressed).
 *   2. With allowShortSignals=true, the same SELL emits normally.
 *   3. BUY signals are completely unaffected by the toggle (always emit).
 *   4. A suppressed SELL does NOT mutate: lastSignalType, lastSignalTime,
 *      lastSellSignalTime, lastBuySignalTime, lastMarketRegime,
 *      successfulSignalsGenerated, signalsGeneratedCount, signalGenerationAttempts
 *      (beyond the attempt increment that happens before the suppression check).
 *   5. A suppressed SELL does NOT consume the cooldown or active-signal lock.
 *
 * Usage: bunx tsx expo/scripts/test_sell_suppression.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { TradingSignal } from "../types/trading";

// ─── Sandbox types ──────────────────────────────────────────────────────────

interface SandboxBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SandboxContext {
  currentPrice: number;
  bars: SandboxBar[];
  getIntermarketSnapshot: (timestamp: number) => { dxy: number; us10y: number; vix: number };
}

interface SandboxSignalEngineModule {
  signalEngine: {
    loadPersistedLearningData(): Promise<unknown>;
    updateCurrentPrice(): Promise<number>;
    updateDailyOHLC(currentPrice: number): Promise<unknown>;
    getMarketOutlook(): Promise<{ isMarketOpen: boolean; currentSession: string }>;
    generateSignal(
      settings: Record<string, unknown>,
      accountBalance: number,
      activeSignals: TradingSignal[],
    ): Promise<TradingSignal | null>;
    // Internal state accessors (private fields accessed via the sandbox)
  } & Record<string, unknown>;
  setExternalPrice(price: number, source: string): void;
}

declare global {
  var __SIGNAL_SIMULATION_CONTEXT__: SandboxContext | undefined;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Captured at module load — assert must use the REAL console, not the
// engine-quieting override installed in main().
const _origLog = console.log;
const _origErr = console.error;
function assert(condition: boolean, message: string): void {
  if (!condition) {
    _origErr(`\n❌ FAIL: ${message}`);
    process.exit(1);
  }
  _origLog(`  ✅ PASS: ${message}`);
}

// ─── Sandbox builder (mirrors runSignalSimulation.ts buildSandboxModule) ────

async function buildSandboxModule(): Promise<SandboxSignalEngineModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox_sell__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.sandbox.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext, DetectedSRZone } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();

interface SandboxBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SandboxContext {
  currentPrice: number;
  bars: SandboxBar[];
  getIntermarketSnapshot: (timestamp: number) => { dxy: number; us10y: number; vix: number };
}

const getSandboxContext = (): SandboxContext => {
  const context = (globalThis as { __SIGNAL_SIMULATION_CONTEXT__?: SandboxContext }).__SIGNAL_SIMULATION_CONTEXT__;
  if (!context) {
    throw new Error("Signal simulation context not initialized");
  }
  return context;
};

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return sandboxStorage.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    sandboxStorage.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    sandboxStorage.delete(key);
  },
};

(globalThis as Record<string, unknown>).__SANDBOX_TRPC__ = {
  goldPrice: {
    getSpotPrice: {
      async query(): Promise<{ price: number; source: string }> {
        return { price: getSandboxContext().currentPrice, source: "sandbox-spot" };
      },
    },
    getHistoricalData: {
      async query(input: { fromTime: number; toTime: number }): Promise<SandboxBar[]> {
        return getSandboxContext().bars.filter((bar) => bar.timestamp >= input.fromTime && bar.timestamp <= input.toTime);
      },
    },
    getIntermarketData: {
      async query(): Promise<{ dxy: number; us10y: number; vix: number }> {
        return getSandboxContext().getIntermarketSnapshot(Date.now());
      },
    },
  },
};

const trpcClient = (globalThis as Record<string, unknown>).__SANDBOX_TRPC__ as any;

const fetchHistoricalData = async (input: { fromTime: number; toTime: number }): Promise<SandboxBar[]> => {
  return getSandboxContext().bars.filter((bar) => bar.timestamp >= input.fromTime && bar.timestamp <= input.toTime);
};

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

// Stub out pushShadowSellRecord so it doesn't try to fetch a backend URL
// during the test — we just want to verify the suppression path fires.
let shadowSellRecordPushed = false;
function pushShadowSellRecord(_record: unknown): void {
  shadowSellRecordPushed = true;
}
`;

  // Strip the same imports as runSignalSimulation.ts, plus the shadowSignalService import
  const stripImportFrom = (code: string, specifier: string): string => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^import\\s+(?:[\\w*]+\\s*,\\s*)?(?:\\{[^}]*\\}|[\\w*]+(?:\\s+as\\s+\\w+)?)\\s+from\\s+["']${escaped}["'];?\\r?\\n`, "m");
    return code.replace(pattern, "");
  };

  const rewritten = [
    "@/types/trading",
    "@react-native-async-storage/async-storage",
    "@/lib/trpc",
    "@/services/learningStore",
    "@/services/diagnosticEventStore",
    "@/services/shadowSignalService",
    "react-native",
  ].reduce(stripImportFrom, source);

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<SandboxSignalEngineModule>;
}

// ─── Test ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  SELL SUPPRESSION TEST (deterministic, sandboxed)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  // Suppress console.log from the engine during the test (it's very verbose)
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    const line = String(args[0] ?? "");
    // Only show suppression-related and key rejection lines
    if (line.includes("SELL SUPPRESSED") || line.includes("SUPPRESSION") || line.includes("SIGNAL GENERATION")) {
      origLog("  [engine]", line);
    }
  };
  console.warn = (..._args: unknown[]) => {};

  try {
    const sandboxModule = await buildSandboxModule();
    const engine = sandboxModule.signalEngine as Record<string, unknown> & {
      generateSignal(
        settings: Record<string, unknown>,
        accountBalance: number,
        activeSignals: TradingSignal[],
      ): Promise<TradingSignal | null>;
    };

    // ── Setup: provide price history and a valid current price ───────────
    const basePrice = 4050.0;
    const now = Date.now();

    // Build 200 bars of price history at $4050 with mild downtrend (favors SELL)
    const bars: SandboxBar[] = [];
    for (let i = 199; i >= 0; i--) {
      const ts = now - (i + 1) * 60_000;
      const trend = -0.02 * (200 - i);
      const noise = Math.sin(i * 0.7) * 0.3;
      const price = basePrice + trend + noise;
      bars.push({
        timestamp: ts,
        open: price,
        high: price + 0.5,
        low: price - 0.5,
        close: price,
      });
    }

    globalThis.__SIGNAL_SIMULATION_CONTEXT__ = {
      currentPrice: basePrice,
      bars,
      getIntermarketSnapshot: () => ({ dxy: 103.5, us10y: 4.2, vix: 18 }),
    };

    sandboxModule.setExternalPrice(basePrice, "test");
    await engine.updateCurrentPrice();
    await engine.updateDailyOHLC(basePrice);

    // ── Monkey-patch key methods to deterministically force a SELL ───────
    // We override methods that would otherwise non-deterministically reject
    // based on market state. The goal is to reach the suppression check at
    // line ~6451 with analysis.signalType === 'SELL' and pass all gates.

    // Override enhancedTransformerAnalysis to always return a strong SELL
    // with high confidence. This is the analysis the suppression check reads.
    (engine as Record<string, unknown>).enhancedTransformerAnalysis = function (_features: unknown) {
      return {
        signalStrength: 0.85,
        signalType: "SELL" as const,
        confidence: 0.90,
        sentimentImpact: 0,
        fibonacciAlignment: true,
        attentionScores: new Map([
          ["htf_ltf_bearish_alignment", 0.4],
          ["counter_trend_rejection_setup", 0.35],
        ]),
      };
    };

    // Override detectHTFTrend to return BEARISH (SELL is with-trend, not counter-trend)
    (engine as Record<string, unknown>).detectHTFTrend = function (_features: unknown) {
      return "BEARISH" as const;
    };

    // Override detectLTFTrend to return BEARISH
    (engine as Record<string, unknown>).detectLTFTrend = function () {
      return "BEARISH" as const;
    };

    // Override calculateMarketFeatures to return valid features that won't trip gates
    (engine as Record<string, unknown>).calculateMarketFeatures = async function () {
      return {
        asianHigh: basePrice + 2,
        asianLow: basePrice - 2,
        dailyPivot: basePrice,
        r1: basePrice + 3, r2: basePrice + 6, r3: basePrice + 9,
        s1: basePrice - 3, s2: basePrice - 6, s3: basePrice - 9,
        rsi: 72, // Overbought — favors SELL
        atr: 1.5, // Reasonable ATR
        dxyChange: -0.2,
        volumeRatio: 1.1,
        weeklyPivot: basePrice,
        fractalResistance: basePrice + 8,
        fractalSupport: basePrice - 8,
        macdHistogram: -0.3,
        emaCrossover: -0.2,
        sessionVolatilityIndex: 0.6,
        timeToSessionEnd: 120,
        fibonacci: [],
        sentiment: { fearGreedIndex: 45, sentimentLabel: "Neutral" },
        orderFlow: { imbalance: -0.15, deltaVolume: -100, cumVolDelta: -500, blockSize: 0, absorptionLevel: 0, dominantSide: "SELL" },
        volumeProfile: { poc: basePrice, valueAreaHigh: basePrice + 5, valueAreaLow: basePrice - 5, sessionHigh: basePrice + 5, sessionLow: basePrice - 5 },
        marketRegime: { type: "TRENDING", strength: 0.7 },
        priceActionPattern: "bearish_engulfing",
        candlestickPattern: "bearish_engulfing",
        supportStrength: 0.3,
        resistanceStrength: 0.7,
        srZones: [
          { price: basePrice + 5, type: "RESISTANCE", touches: 5, rejectionWicks: 2, reactionStrength: 0.08, source: "PRICE_ACTION", confluenceScore: 2, tier: "TIER_1_LOCAL" },
          { price: basePrice - 5, type: "SUPPORT", touches: 4, rejectionWicks: 1, reactionStrength: 0.06, source: "PRICE_ACTION", confluenceScore: 1, tier: "TIER_1_LOCAL" },
        ],
        activeSRReaction: null,
        intermarketData: { dxy: 103.5, us10y: 4.2, vix: 18 },
        liquidityWindow: { isHighLiquidity: true, nextWindow: 30 },
        timeWindowFactor: 0.8,
        orderBlocks: [],
        quasimodolLevels: [],
        sessionSweeps: [],
        vwap: basePrice,
        adx: 28,
        bollingerSqueeze: false,
        bollingerExpansion: false,
        bollingerBandwidth: 0.5,
      };
    };

    // Override evaluateQualityGate to always pass
    (engine as Record<string, unknown>).evaluateQualityGate = function (_analysis: unknown, _features: unknown) {
      return { passed: true, reason: "test override", tip: "", summary: "test override — quality gate auto-pass" };
    };

    // Override validateStructuralConditions to always pass
    (engine as Record<string, unknown>).validateStructuralConditions = function (_signalType: unknown, _features: unknown, _settings: unknown) {
      return { valid: true, reason: "", tip: "" };
    };

    // Override checkPriceProximity to never block
    (engine as Record<string, unknown>).checkPriceProximity = function (_active: unknown, _type: unknown, _cd: unknown) {
      return { blocked: false, reason: "", tip: "" };
    };

    // Override detectTrendChange and detectLargePriceMovement (no exceptions needed)
    (engine as Record<string, unknown>).detectTrendChange = function () { return false; };
    (engine as Record<string, unknown>).detectLargePriceMovement = function () { return false; };

    // Override detectMacroEvents — no suppression
    (engine as Record<string, unknown>).detectMacroEvents = function () { return undefined; };
    (engine as Record<string, unknown>).shouldSuppressMacroEvent = function (_e: unknown) { return false; };

    // Override computeRecentDrift to return 0 (no drift veto)
    (engine as Record<string, unknown>).computeRecentDrift = function () { return 0; };

    // Override computeRoomToSR to return a sane value
    (engine as Record<string, unknown>).computeRoomToSR = function (_type: unknown, _features: unknown) { return 200; };

    // Override calculateDynamicSlippage
    (engine as Record<string, unknown>).calculateDynamicSlippage = function (_regime: unknown, _latency: unknown) { return 0.5; };

    const BASE_SETTINGS = {
      tp1Pips: 49,
      tp2Pips: 74,
      tp3Pips: 98,
      slPips: 70,
      minConfidence: 0.68,
      useDynamicSL: true,
      maxSLPips: 90,
    };

    // ── Helper: snapshot internal state ──────────────────────────────────
    function snapshotState(): Record<string, unknown> {
      return {
        lastSignalType: (engine as Record<string, unknown>).lastSignalType,
        lastSignalTime: (engine as Record<string, unknown>).lastSignalTime,
        lastSellSignalTime: (engine as Record<string, unknown>).lastSellSignalTime,
        lastBuySignalTime: (engine as Record<string, unknown>).lastBuySignalTime,
        lastMarketRegime: (engine as Record<string, unknown>).lastMarketRegime,
        successfulSignalsGenerated: (engine as Record<string, unknown>).successfulSignalsGenerated,
        signalsGeneratedCount: (engine as Record<string, unknown>).signalsGeneratedCount,
        signalGenerationAttempts: (engine as Record<string, unknown>).signalGenerationAttempts,
        lastBuyStopOutTime: (engine as Record<string, unknown>).lastBuyStopOutTime,
        lastSellStopOutTime: (engine as Record<string, unknown>).lastSellStopOutTime,
      };
    }

    function assertStateUnchanged(before: Record<string, unknown>, after: Record<string, unknown>, label: string, fieldsToIgnore: string[] = []): void {
      for (const key of Object.keys(before)) {
        if (fieldsToIgnore.includes(key)) continue;
        const b = before[key];
        const a = after[key];
        const same = (b === a) || (Number.isNaN(b) && Number.isNaN(a));
        assert(same, `${label}: ${key} unchanged (before=${String(b)}, after=${String(a)})`);
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // TEST 1: Suppressed SELL returns null, no state mutation
    // ═════════════════════════════════════════════════════════════════════
    console.log("\nTest 1: allowShortSignals=false — SELL suppressed, returns null, no state mutation\n");

    const stateBeforeSuppress = snapshotState();
    const activeSignals: TradingSignal[] = [];

    const sellResultSuppressed = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: false },
      10000,
      activeSignals,
    );

    assert(sellResultSuppressed === null, "Suppressed SELL returns null");

    const stateAfterSuppress = snapshotState();

    // signalGenerationAttempts increments at the TOP of generateSignal (line 5940),
    // before the suppression check — that's expected and not a state mutation
    // from the suppression. All other state must be unchanged.
    assertStateUnchanged(
      stateBeforeSuppress,
      stateAfterSuppress,
      "Suppressed SELL",
      ["signalGenerationAttempts"],
    );

    // Specifically verify the critical fields are NOT mutated
    assert(
      stateAfterSuppress.lastSignalType === stateBeforeSuppress.lastSignalType,
      "lastSignalType NOT mutated by suppressed SELL",
    );
    assert(
      stateAfterSuppress.lastSignalTime === stateBeforeSuppress.lastSignalTime,
      "lastSignalTime NOT mutated by suppressed SELL",
    );
    assert(
      stateAfterSuppress.lastSellSignalTime === stateBeforeSuppress.lastSellSignalTime,
      "lastSellSignalTime NOT mutated by suppressed SELL",
    );
    assert(
      stateAfterSuppress.successfulSignalsGenerated === stateBeforeSuppress.successfulSignalsGenerated,
      "successfulSignalsGenerated NOT incremented by suppressed SELL",
    );
    assert(
      stateAfterSuppress.signalsGeneratedCount === stateBeforeSuppress.signalsGeneratedCount,
      "signalsGeneratedCount NOT incremented by suppressed SELL",
    );

    // The activeSignals array should NOT have been modified
    assert(activeSignals.length === 0, "activeSignals array NOT modified by suppressed SELL");

    // ═════════════════════════════════════════════════════════════════════
    // TEST 2: allowShortSignals=true — same SELL emits normally, state IS mutated
    // ═════════════════════════════════════════════════════════════════════
    console.log("\nTest 2: allowShortSignals=true — SELL emits normally, state IS mutated\n");

    const stateBeforeAllow = snapshotState();

    const sellResultAllowed = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: true },
      10000,
      [],
    );

    assert(sellResultAllowed !== null, "Non-suppressed SELL returns a signal (not null)");
    assert(sellResultAllowed!.type === "SELL", "Non-suppressed signal is SELL");

    const stateAfterAllow = snapshotState();

    // When allowed, the SELL SHOULD mutate state (lastSignalType, lastSignalTime, etc.)
    assert(
      stateAfterAllow.lastSignalType === "SELL",
      "lastSignalType mutated to SELL when allowed",
    );
    assert(
      stateAfterAllow.lastSignalTime !== stateBeforeAllow.lastSignalTime,
      "lastSignalTime updated when SELL allowed",
    );
    assert(
      stateAfterAllow.lastSellSignalTime !== stateBeforeAllow.lastSellSignalTime,
      "lastSellSignalTime updated when SELL allowed",
    );
    assert(
      stateAfterAllow.successfulSignalsGenerated === (stateBeforeAllow.successfulSignalsGenerated as number) + 1,
      "successfulSignalsGenerated incremented when SELL allowed",
    );

    // ═════════════════════════════════════════════════════════════════════
    // TEST 3: BUY signals are completely unaffected by the toggle
    // ═════════════════════════════════════════════════════════════════════
    console.log("\nTest 3: BUY signals unaffected by allowShortSignals toggle\n");

    // Override analysis to return BUY this time
    (engine as Record<string, unknown>).enhancedTransformerAnalysis = function (_features: unknown) {
      return {
        signalStrength: 0.85,
        signalType: "BUY" as const,
        confidence: 0.90,
        sentimentImpact: 0,
        fibonacciAlignment: true,
        attentionScores: new Map([
          ["htf_ltf_bullish_alignment", 0.4],
        ]),
      };
    };

    // Override detectHTFTrend to return BULLISH (BUY is with-trend)
    (engine as Record<string, unknown>).detectHTFTrend = function (_features: unknown) {
      return "BULLISH" as const;
    };

    // Reset cooldown by setting lastSignalTime to 0
    (engine as Record<string, unknown>).lastSignalTime = 0;
    (engine as Record<string, unknown>).lastSignalType = null;
    (engine as Record<string, unknown>).lastBuySignalTime = 0;
    (engine as Record<string, unknown>).lastSellSignalTime = 0;

    const buyResultShortsOff = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: false },
      10000,
      [],
    );

    assert(buyResultShortsOff !== null, "BUY emits with allowShortSignals=false");
    assert(buyResultShortsOff!.type === "BUY", "Signal is BUY (not suppressed by SELL toggle)");

    // Reset state for second BUY test
    (engine as Record<string, unknown>).lastSignalTime = 0;
    (engine as Record<string, unknown>).lastSignalType = null;
    (engine as Record<string, unknown>).lastBuySignalTime = 0;

    const buyResultShortsOn = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: true },
      10000,
      [],
    );

    assert(buyResultShortsOn !== null, "BUY emits with allowShortSignals=true");
    assert(buyResultShortsOn!.type === "BUY", "Signal is BUY regardless of toggle");

    // ═════════════════════════════════════════════════════════════════════
    // TEST 4: Suppressed SELL does not block the next BUY (cooldown/lock)
    // ═════════════════════════════════════════════════════════════════════
    console.log("\nTest 4: Suppressed SELL does not block subsequent BUY (cooldown/lock free)\n");

    // Reset all state
    (engine as Record<string, unknown>).lastSignalTime = 0;
    (engine as Record<string, unknown>).lastSignalType = null;
    (engine as Record<string, unknown>).lastBuySignalTime = 0;
    (engine as Record<string, unknown>).lastSellSignalTime = 0;
    (engine as Record<string, unknown>).successfulSignalsGenerated = 0;

    // Switch back to SELL analysis
    (engine as Record<string, unknown>).enhancedTransformerAnalysis = function (_features: unknown) {
      return {
        signalStrength: 0.85,
        signalType: "SELL" as const,
        confidence: 0.90,
        sentimentImpact: 0,
        fibonacciAlignment: true,
        attentionScores: new Map([["htf_ltf_bearish_alignment", 0.4]]),
      };
    };
    (engine as Record<string, unknown>).detectHTFTrend = function (_f: unknown) { return "BEARISH" as const; };

    // Generate a suppressed SELL
    const suppressedSell = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: false },
      10000,
      [],
    );
    assert(suppressedSell === null, "SELL suppressed (setup for cooldown test)");

    // Immediately switch to BUY and generate — should succeed with NO cooldown
    (engine as Record<string, unknown>).enhancedTransformerAnalysis = function (_features: unknown) {
      return {
        signalStrength: 0.85,
        signalType: "BUY" as const,
        confidence: 0.90,
        sentimentImpact: 0,
        fibonacciAlignment: true,
        attentionScores: new Map([["htf_ltf_bullish_alignment", 0.4]]),
      };
    };
    (engine as Record<string, unknown>).detectHTFTrend = function (_f: unknown) { return "BULLISH" as const; };

    const immediateBuy = await engine.generateSignal(
      { ...BASE_SETTINGS, allowShortSignals: false },
      10000,
      [],
    );

    assert(immediateBuy !== null, "BUY emits immediately after suppressed SELL (no cooldown consumed)");
    assert(immediateBuy!.type === "BUY", "Immediate post-suppression signal is BUY");

    // ═════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═════════════════════════════════════════════════════════════════════
    console.log("\n═══════════════════════════════════════════════════════════════════════");
    console.log("  ALL DETERMINISTIC TESTS PASSED");
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("\n  Confirmed:");
    console.log("    1. Suppressed SELL returns null ✓");
    console.log("    2. Suppressed SELL does NOT mutate lastSignalType/lastSignalTime/");
    console.log("       lastSellSignalTime/successfulSignalsGenerated/signalsGeneratedCount ✓");
    console.log("    3. Suppressed SELL does NOT consume cooldown or active-signal lock ✓");
    console.log("    4. BUY signals emit normally regardless of allowShortSignals ✓");
    console.log("    5. BUY emits immediately after a suppressed SELL (no cooldown) ✓");
    console.log("    6. When allowShortSignals=true, SELL emits and mutates state normally ✓");
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
