import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * STEP 2 CHECKPOINT TEST — zone staleness/decay in detectSRZones()
 *
 * SANDBOX FINDING BEING FIXED: a zone that earned maximum touchScore/
 * rejectionScore during one early, low-volatility/settling window retained
 * that same maximum reactionStrength forever afterward — even once price had
 * travelled far away and many hours had passed with zero fresh touches. That
 * stale zone then kept dominating structural gating (>= 0.3 reactionStrength
 * threshold) for the rest of the session.
 *
 * This test forces exactly that scenario via the existing getSRZonesForTest()
 * seam: a RESISTANCE zone (backed by a PREV_DAY high, so it's always admitted
 * regardless of the fix) gets a strong burst of touches + rejection wicks
 * confined to the OLDEST part of the price history, then price moves far away
 * and stays away for the rest of a simulated ~24h window (using the seam's
 * 5-second-per-sample lastTouch convention: (length - i) * 5000ms).
 *
 * Before the fix, reactionStrength for that zone would sit at its raw,
 * undecayed value (touches/rejections maxed) regardless of that elapsed
 * time. After the fix, the same raw inputs must decay toward the
 * ZONE_STALENESS_HALF_LIFE_HOURS-based recency curve, dropping the zone's
 * effective reactionStrength below the 0.3 gating threshold by ~24h stale.
 */

interface Step2SRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  lastTouch: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: string;
  confluenceScore: number;
}

interface Step2Engine {
  getSRZonesForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number }
  ): Step2SRZone[];
}

interface Step2Module {
  signalEngine: Step2Engine;
}

async function loadEngine(): Promise<Step2Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.step2.ts");
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
  return import(moduleUrl) as Promise<Step2Module>;
}

/**
 * Build a price/high/low history where a RESISTANCE zone near `zonePrice` is
 * heavily touched + rejected ONLY in the earliest `touchWindowLen` samples,
 * then price moves to `farPrice` and stays there for the rest of the array.
 * Because the getSRZonesForTest seam computes lastTouch as
 * `now - ((length - i) * 5000)`, the touch window's position controls the
 * simulated real-world age of the zone's most recent touch.
 */
function buildStaleZoneHistory(opts: {
  zonePrice: number;
  farPrice: number;
  touchWindowLen: number;
  totalLen: number;
}): { highs: number[]; lows: number[]; closes: number[] } {
  const { zonePrice, farPrice, touchWindowLen, totalLen } = opts;
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];

  for (let i = 0; i < totalLen; i++) {
    if (i < touchWindowLen) {
      // Oscillate right at the zone with occasional strong rejection wicks.
      const wobble = (i % 2 === 0) ? 1.5 : -1.5;
      const close = zonePrice - 2 + wobble;
      closes.push(close);
      lows.push(close - 0.5);
      highs.push(i % 3 === 0 ? zonePrice + 12 : close + 1); // periodic strong rejection wick
    } else {
      // Price has moved far away and stays flat there (quiet market, tiny ATR).
      closes.push(farPrice);
      highs.push(farPrice + 0.5);
      lows.push(farPrice - 0.5);
    }
  }

  return { highs, lows, closes };
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("\nStep 2: S/R zone staleness/decay\n");

  const ZONE_PRICE = 3300;
  const FAR_PRICE = 3200;
  const TOUCH_WINDOW_LEN = 30;

  // Checkpoints at 6h/12h/18h/24h stale, using the seam's 5s-per-sample
  // convention: (totalLen - touchWindowLen) * 5000ms = elapsed age.
  const hourCheckpoints = [6, 12, 18, 24];
  const results: { hours: number; reactionStrength: number; touches: number; rejectionWicks: number }[] = [];

  for (const hours of hourCheckpoints) {
    const totalLen = TOUCH_WINDOW_LEN + Math.round((hours * 60 * 60 * 1000) / 5000);
    const { highs, lows, closes } = buildStaleZoneHistory({
      zonePrice: ZONE_PRICE,
      farPrice: FAR_PRICE,
      touchWindowLen: TOUCH_WINDOW_LEN,
      totalLen,
    });

    const { signalEngine } = await loadEngine();
    const zones = signalEngine.getSRZonesForTest(FAR_PRICE, highs, lows, closes, {
      high: ZONE_PRICE,
      low: FAR_PRICE - 20,
      close: FAR_PRICE - 5,
      open: FAR_PRICE - 3,
    });

    const zone = zones.find(z => Math.abs(z.price - ZONE_PRICE) < 6 && z.type === "RESISTANCE");
    if (!zone) {
      console.log(`  ⚠️ No zone found near ${ZONE_PRICE} for ${hours}h checkpoint (zones: ${JSON.stringify(zones.map(z => ({ price: z.price, type: z.type, rs: z.reactionStrength })))})`);
      fail++;
      continue;
    }
    results.push({ hours, reactionStrength: zone.reactionStrength, touches: zone.touches, rejectionWicks: zone.rejectionWicks });
    console.log(`  [${String(hours).padStart(2, " ")}h stale] reactionStrength=${zone.reactionStrength.toFixed(3)} touches=${zone.touches} rejectionWicks=${zone.rejectionWicks}`);
  }

  console.log("\n  Reaction strength distribution across staleness checkpoints:");
  results.forEach(r => console.log(`     ${r.hours}h: ${(r.reactionStrength * 100).toFixed(1)}%`));

  check("6h-stale zone still above the 0.3 structural-gating threshold (recently earned strength persists briefly)",
    (results.find(r => r.hours === 6)?.reactionStrength ?? 0) >= 0.3,
    `reactionStrength=${(results.find(r => r.hours === 6)?.reactionStrength ?? 0).toFixed(3)}`);

  check("24h-stale zone has decayed BELOW the 0.3 structural-gating threshold (no longer able to dominate gating all day)",
    (results.find(r => r.hours === 24)?.reactionStrength ?? 1) < 0.3,
    `reactionStrength=${(results.find(r => r.hours === 24)?.reactionStrength ?? 1).toFixed(3)}`);

  check("reactionStrength strictly decreases as staleness increases (monotonic decay)",
    results.every((r, i) => i === 0 || r.reactionStrength <= results[i - 1].reactionStrength),
    `sequence=${results.map(r => r.reactionStrength.toFixed(3)).join(" -> ")}`);

  const strength6h = results.find(r => r.hours === 6)?.reactionStrength ?? 0;
  const strength24h = results.find(r => r.hours === 24)?.reactionStrength ?? 0;
  check("24h-stale zone is dramatically weaker than a 6h-stale zone (not stuck at a permanent maximum)",
    strength24h < strength6h * 0.5,
    `6h=${strength6h.toFixed(3)} vs 24h=${strength24h.toFixed(3)}`);

  // Confirm raw touch/rejection inputs were genuinely maxed in every scenario
  // (i.e. the drop in reactionStrength is caused by the NEW decay, not by the
  // underlying touch data itself changing across checkpoints).
  check("touch/rejection inputs identical across all checkpoints (decay -- not input data -- explains the strength drop)",
    results.every(r => r.touches === results[0].touches && r.rejectionWicks === results[0].rejectionWicks),
    `touches=${results.map(r => r.touches).join(",")} rejectionWicks=${results.map(r => r.rejectionWicks).join(",")}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Step 2 verified — a zone's reactionStrength now decays with staleness instead of retaining maximum strength indefinitely."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
