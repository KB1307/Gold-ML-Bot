import { economicCalendarRouter } from "../backend/trpc/routes/economicCalendar";

/**
 * Verifies the error-masking fix in economicCalendar.ts:
 * - Any fetch failure (network error, timeout, non-OK status incl. 403) with
 *   no usable cache must report source: "UNAVAILABLE", never "FMP" + [].
 * - A genuine successful fetch (even with 0 matching events) must report
 *   source: "FMP".
 * - A failure that occurs while a stale cache exists still serves that
 *   stale-but-real data as source: "FMP" (cached: true) rather than
 *   discarding it - this is a deliberate, distinct case from "no cache at
 *   all", not a masking bug.
 *
 * NOTE: calendarCache is a module-level singleton inside economicCalendar.ts,
 * so test order matters within this single process run - each test's
 * fetch mock is set up right before its call, and cache-state comments below
 * describe the situation that call is exercising.
 */
async function main() {
  const originalFetch = global.fetch;
  const originalKey = process.env.FMP_API_KEY;
  const originalDateNow = Date.now;
  let pass = 0;
  let fail = 0;
  const check = (label: string, cond: boolean, detail: string) => {
    if (cond) { pass++; console.log(`  PASS ${label}: ${detail}`); }
    else { fail++; console.error(`  FAIL ${label}: ${detail}`); }
  };

  process.env.FMP_API_KEY = "test-key-doesnt-matter";

  // ---- Test 1: network error, no cache yet -> UNAVAILABLE ----
  (global as any).fetch = async () => { throw new Error("simulated network failure"); };
  const r1 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 1 (network error, no cache):", JSON.stringify(r1));
  check("T1", r1.source === "UNAVAILABLE" && r1.events.length === 0, `source=${r1.source}`);

  // ---- Test 2: 403 HTTP error, still no cache -> UNAVAILABLE ----
  (global as any).fetch = async () => ({
    ok: false, status: 403, text: async () => JSON.stringify({ "Error Message": "Legacy Endpoint" }),
  });
  const r2 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 2 (403, no cache):", JSON.stringify(r2));
  check("T2", r2.source === "UNAVAILABLE" && r2.events.length === 0, `source=${r2.source}`);

  // ---- Test 3: genuine successful fetch with real events -> FMP, correctly filtered, populates cache ----
  (global as any).fetch = async () => ({
    ok: true, status: 200,
    json: async () => [
      { event: "Non-Farm Payrolls", date: new Date(Date.now() + 3600_000).toISOString(), country: "US", currency: "USD", impact: "High" },
      { event: "Some Low Impact Thing", date: new Date().toISOString(), country: "DE", currency: "EUR", impact: "Low" },
    ],
  });
  const r3 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 3 (success, real events):", JSON.stringify(r3));
  check("T3", r3.source === "FMP" && r3.events.length === 1 && r3.events[0].name === "Non-Farm Payrolls", `source=${r3.source} events=${r3.events.length}`);

  // ---- Test 4: cache still fresh (<45min) -> served directly, no fetch needed, still FMP ----
  (global as any).fetch = async () => { throw new Error("should not be called - cache should short-circuit"); };
  const r4 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 4 (fresh cache, no fetch attempted):", JSON.stringify(r4));
  check("T4", r4.source === "FMP" && r4.cached === true && r4.events.length === 1, `source=${r4.source} cached=${r4.cached}`);

  // ---- Test 5: cache now stale (simulate 46min elapsed), fetch fails -> stale cache still served as FMP (not UNAVAILABLE) ----
  const futureNow = originalDateNow() + 46 * 60 * 1000;
  Date.now = () => futureNow;
  (global as any).fetch = async () => { throw new Error("simulated failure with stale cache present"); };
  const r5 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 5 (stale cache + fetch failure -> should still serve stale FMP data):", JSON.stringify(r5));
  check("T5", r5.source === "FMP" && r5.cached === true && r5.events.length === 1, `source=${r5.source} cached=${r5.cached}`);
  Date.now = originalDateNow;

  // ---- Test 6: missing API key entirely -> UNAVAILABLE (separate from fetch-failure path) ----
  // Force cache expiry again so the key-check path is actually reached.
  const futureNow2 = originalDateNow() + 100 * 60 * 1000;
  Date.now = () => futureNow2;
  process.env.FMP_API_KEY = "";
  const r6 = await economicCalendarRouter.createCaller({} as any).getUpcomingEvents();
  console.log("TEST 6 (no API key, cache stale/ignored by design since key check comes first):", JSON.stringify(r6));
  // Note: current code checks fresh-cache first, then key. Since cache is now stale (>45min old),
  // it proceeds to the key check, which correctly short-circuits to UNAVAILABLE with no events.
  check("T6", r6.source === "UNAVAILABLE", `source=${r6.source}`);
  Date.now = originalDateNow;

  global.fetch = originalFetch;
  process.env.FMP_API_KEY = originalKey;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Test harness crashed:", e);
  process.exitCode = 1;
});
