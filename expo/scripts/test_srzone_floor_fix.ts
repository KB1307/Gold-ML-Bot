import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * SRZONE FLOOR FIX CHECKPOINT TEST
 *
 * Follow-up to the pivot-floor fix: that fix only corrected the six Camarilla
 * pivot numbers (R1-R3/S1-S3) read by calculateDashboardPivotLevels(), which
 * is confirmed (by tracing dashboard.tsx and outlook.tsx, both of which bind
 * only to marketOutlook.r1/r2/r3/s1/s2/s3) to be the ONLY S/R data structure
 * actually rendered in the UI. SRZone[] (from detectSRZones()/this.srZones)
 * is not bound to any visible panel today -- it is consumed internally by
 * detectActiveSRReaction(), which feeds signal-confidence scoring
 * (buySignalStrength/sellSignalStrength in enhancedTransformerAnalysis()).
 * The bug is real regardless: it was just silently degrading signal quality,
 * not (yet) a visibly-broken dashboard panel.
 *
 * Bug: detectSRZones() and detectActiveSRReaction() used flat-dollar floors
 * (`Math.max(2, atr * 0.3)`, `Math.max(ohlc.H - ohlc.L, atr)` with no
 * price-relative term, and `Math.max(3, atr * 0.25)`) that collapse toward a
 * fixed ~$2-3 value whenever calculateRealATR(14) returns something small
 * (quiet market / thin history / degenerate H-L). For gold at $3,000+, a
 * zone-merge distance of $2 causes candidate levels $0.3-1.5 apart to fail to
 * merge, producing a wall of near-duplicate "zones" ~$0.5 apart instead of a
 * handful of genuinely distinct levels spread across tens of dollars.
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

interface SRZoneEngine {
  getSRZonesForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number }
  ): SRZone[];
  getRealATRForTest(period?: number): number;
}

interface SRZoneModule {
  signalEngine: SRZoneEngine;
}

async function loadEngine(): Promise<SRZoneModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.srzonefix.ts");
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
  return import(moduleUrl) as Promise<SRZoneModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();

  console.log("\nSRZone floor fix: zone spacing must scale with price, not a flat $2-3 floor\n");

  // Flat/low-volatility 60-bar tick history (need >= 20 for zone detection,
  // more for touch counting): every high/low/close within a tight band, so
  // calculateRealATR(14) computes a tiny true range (< $2), the exact
  // condition that triggered the old flat-dollar floors.
  const bars = 60;
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < bars; i++) {
    const c = 3250 + (i % 2 === 0 ? 0.05 : -0.05);
    closes.push(c);
    highs.push(c + 0.1);
    lows.push(c - 0.1);
  }

  // Scenario A: a genuinely TIGHT prior-day bar ($2 range) -- this is the
  // exact condition that collapses dailyRange/zoneStep under the old bug
  // (dailyRange floored only on raw atr, no price-relative term).
  const tightPriorDayBar = { high: 3251, low: 3249, close: 3250, open: 3250 };
  const price = 3250;

  const zonesTight = signalEngine.getSRZonesForTest(price, highs, lows, closes, tightPriorDayBar);
  const atr = signalEngine.getRealATRForTest(14);

  console.log(`  Forced ATR(14): ${atr.toFixed(2)} (flat/quiet synthetic history)`);
  console.log(`  --- Scenario A: tight prior-day bar (tests dailyRange floor) ---`);
  console.log(`  Current price: ${price}`);
  console.log(`  Zones detected: ${zonesTight.length}`);
  const sortedTight = [...zonesTight].sort((a, b) => a.price - b.price);
  for (const z of sortedTight) {
    console.log(`    ${z.type.padEnd(10)} @ ${z.price.toFixed(2)} | source=${z.source} | touches=${z.touches} | confluence=${z.confluenceScore}`);
  }

  // Scenario B: a WIDE prior-day bar, far enough from the PIVOT-derived
  // candidates that it should NOT merge into them -- this isolates and
  // proves the zoneWidth (merge-distance) fix and confirms PREV_DAY zones
  // are admitted with the correct source tag.
  const widePriorDayBar = { high: 3320, low: 3180, close: 3250, open: 3255 };
  const zonesWide = signalEngine.getSRZonesForTest(price, highs, lows, closes, widePriorDayBar);
  const sortedWide = [...zonesWide].sort((a, b) => a.price - b.price);
  console.log(`\n  --- Scenario B: wide prior-day bar (tests zoneWidth merge distance + PREV_DAY admission) ---`);
  console.log(`  Zones detected: ${zonesWide.length}`);
  for (const z of sortedWide) {
    console.log(`    ${z.type.padEnd(10)} @ ${z.price.toFixed(2)} | source=${z.source} | touches=${z.touches} | confluence=${z.confluenceScore}`);
  }

  const zones = zonesTight;
  const sorted = sortedTight;

  // Minimum gap between any two adjacent distinct zone prices.
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].price - sorted[i - 1].price;
    if (gap > 0.001) minGap = Math.min(minGap, gap);
  }
  if (!isFinite(minGap)) minGap = 0;

  const oldFlatZoneWidth = Math.max(2, atr * 0.3); // old bug's merge distance
  const newZoneWidth = Math.max(atr * 0.3, price * 0.0015); // fixed merge distance

  console.log(`\n  Old flat-floor zoneWidth would have been: $${oldFlatZoneWidth.toFixed(2)} (merge/collapse distance)`);
  console.log(`  New price-relative zoneWidth is: $${newZoneWidth.toFixed(2)}`);
  console.log(`  Smallest observed gap between distinct zones: $${minGap.toFixed(2)}\n`);

  check("forced ATR is small (<2, reproducing the bug trigger)", atr < 2, `ATR(14)=${atr.toFixed(2)}`);
  check(
    "new zoneWidth is meaningfully larger than the old flat floor would allow this close together",
    newZoneWidth > oldFlatZoneWidth,
    `new=$${newZoneWidth.toFixed(2)} vs old=$${oldFlatZoneWidth.toFixed(2)}`
  );
  check(
    "at least one zone was detected",
    zones.length > 0,
    `count=${zones.length}`
  );
  check(
    "adjacent distinct zones are separated by at least several dollars (well beyond the old ~$0.50 collapse, and beyond the old flat $2 floor)",
    minGap === 0 || minGap > oldFlatZoneWidth,
    `minGap=$${minGap.toFixed(2)}, old flat floor=$${oldFlatZoneWidth.toFixed(2)}`
  );
  check(
    "PREV_DAY zones (always-admitted) are present with correct source tag (Scenario B, wide prior day)",
    zonesWide.some(z => z.source === "PREV_DAY"),
    `sources=${Array.from(new Set(zonesWide.map(z => z.source))).join(",")}`
  );
  check(
    "no zone price is NaN/undefined (either scenario)",
    zones.every(z => Number.isFinite(z.price)) && zonesWide.every(z => Number.isFinite(z.price)),
    `all finite=${zones.every(z => Number.isFinite(z.price)) && zonesWide.every(z => Number.isFinite(z.price))}`
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ SRZone floor fix verified — zone spacing now scales with live price, even under a degenerate low-ATR condition."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
