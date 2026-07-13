/**
 * FINAL CONFIRMATION for the Tiingo-removal pass: a REAL live call that
 * deliberately forces the shortened fallback chain (backend -> TwelveData ->
 * Swissquote-synthetic) to actually run end-to-end, with 2 tiers instead of
 * the old 3. This is not a mechanism/synthetic-bars test like the prior
 * verification script - it makes genuine network calls and reports the real
 * console output.
 *
 * How the fallback is forced: `fetchHistoricalData` (lib/trpc.ts) first tries
 * the backend tRPC route. In this sandbox there is no live backend process
 * running behind EXPO_PUBLIC_RORK_API_BASE_URL, so that leg fails/times out
 * exactly like it would on-device when local bars are insufficient and the
 * backend is briefly unreachable - which is precisely the scenario that
 * makes `getAuditBars` fall through to the direct client-side chain
 * (TwelveData -> Swissquote-synthetic, since Tiingo IEX was removed).
 */
import { fetchHistoricalData } from "../lib/trpc";

const fromTime = Date.now() - 2 * 60 * 60 * 1000; // last 2h
const toTime = Date.now();

async function main() {
  console.log("=== FINAL VERIFICATION: forcing the shortened fallback chain (TwelveData -> Swissquote) ===");
  console.log(`Window: ${new Date(fromTime).toISOString()} -> ${new Date(toTime).toISOString()}\n`);

  const bars = await fetchHistoricalData({ fromTime, toTime, timeoutMs: 8000 });

  console.log(`\n=== RESULT ===`);
  console.log(`Bars returned: ${bars.length}`);
  if (bars.length > 0) {
    console.log(`First bar: ${JSON.stringify(bars[0])}`);
    console.log(`Last bar: ${JSON.stringify(bars[bars.length - 1])}`);
  }
}

main().catch((e) => {
  console.error("Verification script error:", e);
  process.exit(1);
});
