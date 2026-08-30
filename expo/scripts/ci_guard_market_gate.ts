/**
 * ci_guard_market_gate — UU/XX.2.
 *
 * FAILS the check run if the emission path stops consuming the shared
 * market-hours predicate (getGoldMarketClock), or if a second, divergent
 * session/hours calculation appears on the emission path. This is the guard
 * class the sixth-strip and golden guards use: real source assertions plus
 * mutated-fixture self-tests so the detector cannot silently rot.
 *
 * Exit code 0 = pass, 1 = fail. Wired for CI and pre-build runs.
 */
import { readFileSync } from "node:fs";

const ENGINE_PATH = new URL("../services/signalEngine.ts", import.meta.url).pathname;

interface CheckResult {
  failures: string[];
}

/** Pure checker so the self-tests can run it against mutated fixtures. */
export function checkMarketGateSource(source: string): CheckResult {
  const failures: string[] = [];

  // 1. The emission guard must obtain the clock from the SHARED predicate.
  if (!source.includes("marketClock = getGoldMarketClock();")) {
    failures.push(
      "emission path does not consume the shared predicate: 'marketClock = getGoldMarketClock();' not found in generateSignal — the weekend gate has regressed (this is exactly how the 2026-08-29/30 closed-market emission happened).",
    );
  }

  // 2. The gate must reject closed markets with the named-condition log.
  if (!source.includes("REJECTED: MARKET_CLOSED — condition=")) {
    failures.push("market-gate rejection log 'REJECTED: MARKET_CLOSED — condition=' not found — closed-market rejections would be silent.");
  }

  // 3. The fail-safe (UU.3) must be present: unknown state => STAND ASIDE.
  if (!source.includes("MARKET_GATE_FAILSAFE")) {
    failures.push("market-gate fail-safe ('MARKET_GATE_FAILSAFE') not found — a throwing/non-boolean clock would no longer force a stand-aside.");
  }

  // 4. The daily-close slice must exist ONLY inside getGoldMarketClock:
  //    after stripping line comments, exactly TWO occurrences of the name —
  //    the definition and the single call. Any third occurrence means a
  //    divergent session/hours calculation has appeared (duplicate-constant class).
  const codeOnly = source
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  const occurrences = codeOnly.match(/isWithinDailyMarketClose\(/g) ?? [];
  if (occurrences.length !== 2) {
    failures.push(
      `isWithinDailyMarketClose( occurrences = ${occurrences.length} after comment-strip (must be exactly 2: the definition + the single call inside getGoldMarketClock) — a divergent session/hours calculation has appeared (duplicate-constant class).`,
    );
  }

  // 5. The shared predicate must remain exported for the price-feed gate.
  if (!source.includes("export function isGoldMarketOpen")) {
    failures.push("export function isGoldMarketOpen not found — the goldWebSocketService price-feed gate consumes this; its removal breaks the feed gate.");
  }

  return { failures };
}

function runSelfTests(): boolean {
  // Fixture A — the shipped gate (must PASS).
  const good = `
    let marketClock: GoldMarketClock;
    marketClock = getGoldMarketClock();
    if (!marketClock.isMarketOpen) { console.log(\`REJECTED: MARKET_CLOSED — condition=\${x}\`); return null; }
    export function isGoldMarketOpen(now: Date = new Date()): boolean { return getGoldMarketClock(now).isMarketOpen; }
    function isWithinDailyMarketClose(date: Date = new Date()): boolean { return true; }
    const isDailyCloseBreak = isWithinDailyMarketClose(now);
    MARKET_GATE_FAILSAFE marker
  `;
  const a = checkMarketGateSource(good);
  if (a.failures.length !== 0) {
    console.error("  self-test A FAILED: the correct gate was rejected:", a.failures);
    return false;
  }

  // Fixture B — the 2026-08-29/30 defect: emission gated on the daily slice only.
  const defect = good.replace("marketClock = getGoldMarketClock();", "marketClock = { isMarketOpen: true, isSaturday: false, isFridayClose: false, isSundayBeforeOpen: false, isDailyCloseBreak: false } as GoldMarketClock;");
  const b = checkMarketGateSource(defect);
  if (b.failures.length === 0) {
    console.error("  self-test B FAILED: a gated-off emission path was accepted.");
    return false;
  }

  // Fixture C — duplicate-constant class: a second call of the daily slice.
  const dup = good.replace("MARKET_GATE_FAILSAFE marker", "if (isWithinDailyMarketClose()) { return null; } MARKET_GATE_FAILSAFE marker");
  const c = checkMarketGateSource(dup);
  if (c.failures.length === 0) {
    console.error("  self-test C FAILED: a second bare isWithinDailyMarketClose() call was accepted.");
    return false;
  }

  console.log("  self-test: correct gate accepted, gated-off + duplicate-constant fixtures rejected (3/3)");
  return true;
}

function main(): void {
  let source: string;
  try {
    source = readFileSync(ENGINE_PATH, "utf8");
  } catch (err) {
    console.error(`✗ cannot read ${ENGINE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!runSelfTests()) {
    console.error("\n✗ ci_guard_market_gate FAILED — the detector itself is broken. Do not ship.");
    process.exit(1);
  }

  const { failures } = checkMarketGateSource(source);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ✗ signalEngine.ts: ${f}`);
    console.error("\n✗ ci_guard_market_gate FAILED — the market gate has regressed. Do not ship.");
    process.exit(1);
  }

  console.log("  signalEngine.ts        : emission path consumes getGoldMarketClock; rejection + fail-safe logs present");
  console.log("  daily-close slice      : exactly one bare isWithinDailyMarketClose() call (inside getGoldMarketClock)");
  console.log("  price-feed gate export : isGoldMarketOpen exported for goldWebSocketService");
  console.log("\n✅ ci_guard_market_gate PASSED — the weekend market gate is wired to the shared predicate.");
  process.exit(0);
}

main();
