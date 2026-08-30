/**
 * UU.4 — FORCED-CLOCK PROOF of the market gate on the REAL emission path.
 *
 * Clock injection method (stated for the checkpoint): the gate reads the clock
 * via getGoldMarketClock(), whose default parameter evaluates `new Date()` AT
 * CALL TIME. This script replaces the GLOBAL Date constructor with a subclass
 * fixed to each test instant (constructor + static now()), then calls the REAL
 * signalEngine.generateSignal(). No engine code is modified for the test; the
 * real clock is restored by process exit.
 *
 * Runtime note: bun cannot parse react-native's Flow-typed entry point, so the
 * ONLY bridge between the runner and the real engine is a Bun runtime plugin
 * stubbing the react-native / AsyncStorage boundary (Platform.OS, no-op
 * storage). The engine module itself is imported UNMODIFIED. The same pattern
 * is documented in item57_realbar_replay_harness.ts ("react-native import ...
 * unparseable by bun/node").
 */
import type { TradingSignal } from "@/types/trading";

// ── Bun runtime plugin: stub ONLY the RN boundary ────────────────────────────
interface BunModuleResult {
  exports?: unknown;
  loader?: string;
}
interface BunPluginBuild {
  module(specifier: string, init: () => BunModuleResult): void;
}
interface BunGlobal {
  plugin(plugin: { name: string; setup(build: BunPluginBuild): void }): void;
}
const Bun_ = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
if (!Bun_) throw new Error("Bun runtime required for the RN-boundary stub");

const noopAsync = async (): Promise<null> => null;
const asyncStorageStub = {
  getItem: noopAsync,
  setItem: async (): Promise<null> => null,
  removeItem: noopAsync,
  mergeItem: noopAsync,
  multiGet: async (): Promise<[][]> => [],
  multiSet: async (): Promise<null> => null,
  multiRemove: async (): Promise<null> => null,
  getAllKeys: async (): Promise<string[]> => [],
};

const reactNativeStub = {
  Platform: {
    OS: "web",
    select: <T,>(specifics: { native?: T; default?: T; web?: T; ios?: T; android?: T }): T | undefined =>
      specifics.web ?? specifics.default,
    Version: 0,
  },
  NativeModules: {},
  AppState: { addEventListener: (): { remove: () => void } => ({ remove: (): void => undefined }) },
  Dimensions: { get: (): { width: number; height: number } => ({ width: 390, height: 844 }) },
  InteractionManager: { runAfterInteractions: (cb: () => void): void => cb() },
};

Bun_.plugin({
  name: "uu4-rn-boundary-stub",
  setup(build: BunPluginBuild) {
    build.module("react-native", () => ({
      exports: { ...reactNativeStub, default: reactNativeStub },
      loader: "object",
    }));
    build.module("@react-native-async-storage/async-storage", () => ({
      exports: { ...asyncStorageStub, default: asyncStorageStub },
      loader: "object",
    }));
  },
});

// ── Forced clock ─────────────────────────────────────────────────────────────
const RealDate: DateConstructor = Date;
let fixedMs = 0;

class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    super(...(args.length > 0 ? (args as ConstructorParameters<DateConstructor>) : ([fixedMs] as ConstructorParameters<DateConstructor>)));
  }
  static now(): number {
    return fixedMs;
  }
}
(globalThis as unknown as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

// ── Cases ────────────────────────────────────────────────────────────────────
interface GateCase {
  name: string;
  utc: number;
  expected: string;
}

const CASES: GateCase[] = [
  { name: "SATURDAY 12:00 UTC", utc: Date.UTC(2026, 7, 29, 12, 0), expected: "REJECT condition=SATURDAY" },
  { name: "SUNDAY 12:00 UTC (before open)", utc: Date.UTC(2026, 7, 30, 12, 0), expected: "REJECT condition=SUNDAY_BEFORE_OPEN" },
  { name: "FRIDAY 23:00 UTC (after Friday close)", utc: Date.UTC(2026, 7, 28, 23, 0), expected: "REJECT condition=FRIDAY_CLOSE" },
  { name: "SUNDAY 21:00 UTC (1h before open)", utc: Date.UTC(2026, 7, 30, 21, 0), expected: "REJECT condition=SUNDAY_BEFORE_OPEN" },
  { name: "MONDAY 12:00 UTC (market OPEN)", utc: Date.UTC(2026, 7, 31, 12, 0), expected: "NO rejection — normal evaluation" },
  { name: "TUESDAY 21:15 UTC (daily break)", utc: Date.UTC(2026, 8, 1, 21, 15), expected: "REJECT condition=DAILY_BREAK" },
];

interface EngineShape {
  generateSignal(
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number; minConfidence: number },
    accountBalance: number,
    activeSignals: TradingSignal[],
  ): Promise<TradingSignal | null>;
  getMarketGateRejectionCounts(): Record<string, number>;
}

async function runCase(engine: EngineShape, c: GateCase): Promise<void> {
  fixedMs = c.utc;
  console.log(`\n### CASE: ${c.name} — expected: ${c.expected}`);
  const d = new RealDate(fixedMs);
  console.log(`### injected clock = ${d.toISOString()} (getUTCDay=${d.getUTCDay()} 0=Sun..6=Sat)`);
  const t0 = RealDate.now();
  try {
    const result: unknown = await Promise.race([
      engine.generateSignal({ tp1Pips: 30, tp2Pips: 60, tp3Pips: 90, slPips: 70, minConfidence: 1 }, 10000, []),
      new Promise((_res, rej) => setTimeout(() => rej(new Error("UU.4 case timeout (120s) — evaluation still running; gate outcome is already visible in the log lines above")), 120_000)),
    ]);
    if (result === null) {
      console.log("### generateSignal returned: null (no signal)");
    } else {
      const s = result as { type?: string; entryPrice?: number };
      console.log(`### generateSignal returned: SIGNAL type=${s.type ?? "?"} entryPrice=${s.entryPrice ?? "?"}`);
    }
  } catch (err) {
    console.log(`### generateSignal threw (evaluation continued PAST the market gate): ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`### wall time ${((RealDate.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`### funnel after case: ${JSON.stringify(engine.getMarketGateRejectionCounts())}`);
}

async function main(): Promise<void> {
  console.log("UU.4 FORCED-CLOCK MARKET-GATE PROOF — real generateSignal, six injected instants");
  // Dynamic import AFTER plugin registration so the RN boundary is stubbed
  // before the engine module graph loads.
  const mod = (await import("../services/signalEngine")) as { signalEngine: EngineShape };
  const engine = mod.signalEngine;
  for (const c of CASES) {
    await runCase(engine, c);
  }
  console.log("\nUU.4 COMPLETE — funnel totals:", JSON.stringify(engine.getMarketGateRejectionCounts()));
  process.exit(0);
}

void main();
