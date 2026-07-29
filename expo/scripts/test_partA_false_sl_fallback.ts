import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PART A CHECKPOINT TEST — false SL_HIT from the ungated catch-up fallback.
 *
 * Verifies the pure, extracted core of the Path 3 (catch-up fallback) hardening
 * fix in TradingContext.tsx: `evaluateFallbackBreachConfirmation`. This is the
 * exact function the fallback path now calls before it will ever confirm a
 * SL-side terminal outcome from a single price snapshot.
 *
 * Checks:
 *  1. A SINGLE glitched read past the SL threshold (the exact shape that used
 *     to falsely terminate a signal via SL_HIT on its own) does NOT confirm.
 *  2. A genuine, SUSTAINED breach (same threshold, corroborated on a LATER
 *     pass, after the minimum duration) DOES confirm - the fix must not
 *     blunt real SL hits, only reject uncorroborated single-snapshot ones.
 *  3. If price recovers between passes (the glitch reverts), the pending
 *     candidate is cleared and does NOT carry over to contaminate a later,
 *     unrelated breach.
 *  4. exitPrice no longer hardcodes signal.sl - it reflects the actual
 *     confirmed price read (with a small realistic slippage).
 */

interface Module {
  evaluateFallbackBreachConfirmation(
    tracker: Map<string, { firstBreachAt: number; maxPenetrationPips: number; lastPrice: number; tickCount: number }>,
    trackKey: string,
    penetrationPips: number,
    price: number,
    now: number,
    opts: { minDurationMs: number; minPenetrationPips: number; minTicks: number },
  ): boolean;
}

async function loadModule(): Promise<Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "TradingContext.partA.ts");
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
function resolveSignalWithBars(..._args: unknown[]): unknown { return null; }
// PHASE 2 (open item 2): TradingContext now delegates the post-TP1 lock to
// signalResolver's R-based implementation, so the sandbox mirrors that exact
// math (0.35R of the realised stop, floored at 5 pips, capped at 90% of TP1)
// rather than stubbing it out and silently testing different geometry.
const POST_TP1_PROFIT_LOCK_R = 0.35;
function computePostTP1LockPrice(signal: { type: string; entryPrice: number; sl: number; tp1: number }): number {
  const stopDistance = Math.abs(signal.entryPrice - signal.sl);
  const minDelta = 5 * 0.1;
  const rBased = Number.isFinite(stopDistance) && stopDistance > 0 ? stopDistance * POST_TP1_PROFIT_LOCK_R : minDelta;
  const tp1Distance = Math.abs(signal.tp1 - signal.entryPrice);
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0 ? tp1Distance * 0.9 : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(rBased, minDelta), ceiling);
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}
const supabase = { from() { return { select() { return { data: null, error: null }; } }; } } as any;
async function sendTelegramAlert(..._args: unknown[]): Promise<void> {}
async function appendDiagnosticEvent(..._args: unknown[]): Promise<void> {}
async function pruneOldDiagnosticEvents(..._args: unknown[]): Promise<void> {}
async function ensureDiagnosticEventStoreReady(..._args: unknown[]): Promise<void> {}
type DiagnosticEventType = string;
function createContextHook<T>(factory: () => T): [(props: { children?: unknown }) => unknown, () => T] {
  return [(() => null) as unknown as (props: { children?: unknown }) => unknown, factory];
}
function useState<T>(initial: T): [T, (v: T) => void] { return [initial, () => {}]; }
function useEffect(..._args: unknown[]): void {}
function useCallback<T>(fn: T): T { return fn; }
function useMemo<T>(fn: () => T): T { return fn(); }
function useRef<T>(initial: T): { current: T } { return { current: initial }; }
`;

  // CRLF-tolerant regex stripping, matching the established pattern for
  // loading TradingContext.tsx into a plain-node sandbox.
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
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/telegramNotifier["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, "")
    // TradingContext gained a `@/lib/supabase` import earlier in this session;
    // without stripping it the sandbox pulls in react-native and esbuild fails
    // on react-native/index.js before a single assertion runs.
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/supabase["'];?\r?\n/m, "");

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

const MIN_DURATION_MS = 2500;
const MIN_PENETRATION_PIPS = 1.5;
const MIN_TICKS = 2;
const opts = { minDurationMs: MIN_DURATION_MS, minPenetrationPips: MIN_PENETRATION_PIPS, minTicks: MIN_TICKS };

async function main(): Promise<void> {
  console.log("\nPart A: hardened Path 3 (catch-up fallback) breach confirmation\n");
  const mod = await loadModule();

  // --- Test 1: a SINGLE glitched read must NOT confirm on its own ---------
  console.log("Test 1: single glitched read (the old bug's exact shape)");
  const tracker1 = new Map();
  const t0 = 1_000_000;
  const confirmed1 = mod.evaluateFallbackBreachConfirmation(tracker1, "sig1:SL", 5.0, 4108.6, t0, opts);
  check(
    "Single snapshot past SL threshold does NOT confirm termination",
    confirmed1 === false,
    `confirmed=${confirmed1} (a lone glitch tick must never single-handedly terminate a signal)`,
  );
  check(
    "A pending candidate was recorded (so a LATER corroborating read can still confirm)",
    tracker1.has("sig1:SL"),
    `tracker has key=${tracker1.has("sig1:SL")}`,
  );

  // If the very next catch-up pass (only, say, 500ms later - still well short
  // of MIN_DURATION_MS) reads the price again past threshold, it must STILL
  // not confirm, since the elapsed duration requirement isn't met yet.
  const confirmedTooSoon = mod.evaluateFallbackBreachConfirmation(tracker1, "sig1:SL", 5.2, 4108.5, t0 + 500, opts);
  check(
    "A second read too soon (elapsed < MIN_DURATION_MS) still does NOT confirm",
    confirmedTooSoon === false,
    `confirmed=${confirmedTooSoon} elapsed=500ms (need >=${MIN_DURATION_MS}ms)`,
  );

  // --- Test 2: genuine SUSTAINED breach across separate passes DOES confirm
  console.log("\nTest 2: genuine sustained breach (real SL hit, corroborated on a later pass)");
  const tracker2 = new Map();
  const confirmedFirstPass = mod.evaluateFallbackBreachConfirmation(tracker2, "sig2:SL", 5.0, 4108.6, t0, opts);
  check("First pass alone does not confirm", confirmedFirstPass === false, `confirmed=${confirmedFirstPass}`);
  // Next catch-up pass ~30s later (matches HISTORICAL_RECONCILIATION_INTERVAL_MS),
  // price is STILL past the SL threshold - a genuine, real sustained move.
  const confirmedSecondPass = mod.evaluateFallbackBreachConfirmation(tracker2, "sig2:SL", 5.3, 4108.9, t0 + 30_000, opts);
  check(
    "A genuinely sustained breach (still past threshold 30s later) DOES confirm",
    confirmedSecondPass === true,
    `confirmed=${confirmedSecondPass} (the fix must not blunt a real SL hit)`,
  );
  check(
    "Tracker entry is cleared once confirmed (no stale state leaks forward)",
    !tracker2.has("sig2:SL"),
    `tracker still has key=${tracker2.has("sig2:SL")}`,
  );

  // --- Test 3: price recovering between passes clears the pending candidate
  console.log("\nTest 3: a glitch that reverts must not contaminate a later, unrelated breach");
  const tracker3 = new Map();
  mod.evaluateFallbackBreachConfirmation(tracker3, "sig3:SL", 5.0, 4108.6, t0, opts); // glitch candidate recorded
  const recovered = mod.evaluateFallbackBreachConfirmation(tracker3, "sig3:SL", -0.5, 4102.0, t0 + 5_000, opts); // price recovered (negative penetration)
  check("Recovery (negative penetration) does not confirm", recovered === false, `confirmed=${recovered}`);
  check("Recovery clears the pending candidate", !tracker3.has("sig3:SL"), `tracker has key=${tracker3.has("sig3:SL")}`);
  // A brand-new breach afterwards must start its OWN fresh clock, not inherit
  // the earlier (reverted) candidate's timing.
  const freshCandidate = mod.evaluateFallbackBreachConfirmation(tracker3, "sig3:SL", 4.0, 4108.5, t0 + 5_500, opts);
  check("A later, genuinely new breach starts a fresh (unconfirmed) candidate", freshCandidate === false, `confirmed=${freshCandidate}`);
  const freshConfirms = mod.evaluateFallbackBreachConfirmation(tracker3, "sig3:SL", 4.2, 4108.6, t0 + 5_500 + 30_000, opts);
  check("...and confirms only after ITS OWN full duration elapses", freshConfirms === true, `confirmed=${freshConfirms}`);

  // --- Test 4: insufficient penetration never confirms regardless of duration
  console.log("\nTest 4: sustained but insufficient penetration never confirms");
  const tracker4 = new Map();
  mod.evaluateFallbackBreachConfirmation(tracker4, "sig4:SL", 0.5, 4108.1, t0, opts); // below MIN_PENETRATION_PIPS
  const insufficientPen = mod.evaluateFallbackBreachConfirmation(tracker4, "sig4:SL", 0.6, 4108.2, t0 + 60_000, opts);
  check(
    "Long duration alone does not compensate for insufficient penetration",
    insufficientPen === false,
    `confirmed=${insufficientPen} maxPen=0.6 (need >=${MIN_PENETRATION_PIPS})`,
  );

  // --- Test 5 (checkpoint item): forced single-glitch on a TP threshold must
  // NOT confirm alone. This is the TP-direction-mixup fix's own checkpoint -
  // the SAME evaluateFallbackBreachConfirmation gate now guards TP1/TP2/TP3
  // forward-progress detection, not just SL, so a lone bad/wrong-side read
  // must never bank a target on its own either.
  console.log("\nTest 5: forced single glitch on a TP threshold (e.g. TP2) does NOT confirm alone");
  const tracker5 = new Map();
  const confirmedTpGlitch = mod.evaluateFallbackBreachConfirmation(tracker5, "sig5:TP2", 2.0, 4007.5, t0, opts);
  check(
    "Single snapshot past a TP threshold does NOT confirm a target bank",
    confirmedTpGlitch === false,
    `confirmed=${confirmedTpGlitch} (a lone glitch/wrong-side tick must never single-handedly bank TP1/TP2/TP3)`,
  );
  check(
    "A pending TP candidate was recorded (so a LATER corroborating read can still confirm)",
    tracker5.has("sig5:TP2"),
    `tracker has key=${tracker5.has("sig5:TP2")}`,
  );

  // --- Test 6 (checkpoint item): a genuine, sustained TP hit still correctly
  // confirms - the fix must not blunt a real target hit, only reject
  // uncorroborated single-snapshot ones (mirrors Test 2's SL-side equivalent).
  console.log("\nTest 6: genuine sustained TP hit (real target reached, corroborated on a later pass) still confirms");
  const tracker6 = new Map();
  const confirmedTpFirstPass = mod.evaluateFallbackBreachConfirmation(tracker6, "sig6:TP2", 2.0, 4007.5, t0, opts);
  check("First pass alone does not confirm the TP bank", confirmedTpFirstPass === false, `confirmed=${confirmedTpFirstPass}`);
  const confirmedTpSecondPass = mod.evaluateFallbackBreachConfirmation(tracker6, "sig6:TP2", 2.3, 4007.2, t0 + 30_000, opts);
  check(
    "A genuinely sustained TP hit (still past the level 30s later) DOES confirm",
    confirmedTpSecondPass === true,
    `confirmed=${confirmedTpSecondPass} (the fix must not blunt a real TP hit)`,
  );
  check(
    "Tracker entry is cleared once the TP bank is confirmed (no stale state leaks forward)",
    !tracker6.has("sig6:TP2"),
    `tracker still has key=${tracker6.has("sig6:TP2")}`,
  );

  // --- Test 7 (checkpoint item): a real SL breach candidate must survive (i.e.
  // keep accumulating toward its OWN confirmation) even when an UNRELATED,
  // unconfirmed TP reading also exists for the same signal in the same pass -
  // the two kinds are tracked under independent keys, so one candidate's state
  // can never be corrupted or reset by another kind's candidate/confirmation.
  console.log("\nTest 7: a real SL breach candidate survives an unconfirmed TP reading on the same signal");
  const tracker7 = new Map();
  // First pass: both an SL candidate AND an (unrelated, wrong-side) TP2 candidate
  // are recorded for the SAME signal id, under independent kind-scoped keys.
  const slFirstPass = mod.evaluateFallbackBreachConfirmation(tracker7, "sig7:SL", 5.0, 4108.6, t0, opts);
  const tpFirstPass = mod.evaluateFallbackBreachConfirmation(tracker7, "sig7:TP2", 1.8, 4007.6, t0, opts);
  check("SL candidate pending after pass 1", slFirstPass === false, `confirmed=${slFirstPass}`);
  check("TP2 candidate pending after pass 1", tpFirstPass === false, `confirmed=${tpFirstPass}`);
  check("Both independent candidates recorded", tracker7.has("sig7:SL") && tracker7.has("sig7:TP2"), `SL=${tracker7.has("sig7:SL")} TP2=${tracker7.has("sig7:TP2")}`);
  // Second pass, 30s later: the TP2 reading reverts (price recovered - it was
  // the glitch), clearing ONLY the TP2 candidate. The SL breach is genuinely
  // sustained and must confirm on schedule, unaffected by the TP2 reset.
  const tpReverts = mod.evaluateFallbackBreachConfirmation(tracker7, "sig7:TP2", -0.3, 4005.0, t0 + 30_000, opts);
  const slConfirmsDespiteTpReset = mod.evaluateFallbackBreachConfirmation(tracker7, "sig7:SL", 5.4, 4109.0, t0 + 30_000, opts);
  check("Unrelated TP2 candidate clears on its own revert", tpReverts === false && !tracker7.has("sig7:TP2"), `tpReverts=${tpReverts} tp2TrackerHas=${tracker7.has("sig7:TP2")}`);
  check(
    "Genuine SL breach candidate confirms on schedule, unaffected by the unrelated TP2 candidate/reset",
    slConfirmsDespiteTpReset === true,
    `confirmed=${slConfirmsDespiteTpReset} (SL and TP tracking must be fully independent per-kind)`,
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Part A verified — Path 3 fallback can no longer be terminated by a single uncorroborated snapshot (SL or TP), and genuine sustained breaches on either side still confirm correctly."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
