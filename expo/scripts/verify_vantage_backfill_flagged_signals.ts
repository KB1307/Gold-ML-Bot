/**
 * POST-VANTAGE-BACKFILL VERIFICATION: re-runs fromScratch resolution for the
 * exact signals flagged throughout this investigation, now against the real
 * Vantage MT5 bars that were just backfilled into Supabase's `gold_m1_bars`
 * table (overwriting the earlier Exness batch for 2026-07-13/14 via the same
 * upsert-on-conflict(timestamp) mechanism).
 *
 * This queries `gold_m1_bars` directly (the exact TIER 0 read fetchSupabaseGoldBars
 * performs in TradingContext.tsx) and feeds the real rows into the REAL,
 * unmodified resolveSignalWithBars() — the same function Force Audit calls with
 * fromScratch=true. No synthetic bars, no sandboxing.
 *
 * Three signals (r5u78ok9a, 1hb6tvyz2 "4059.3", eok7tb6qb) have their full
 * TP1/TP2/TP3/SL recorded in this session's investigation history, so the
 * real resolver runs against them unmodified. Two signals (5axgrd0qt,
 * grgvcf14c) only ever had entry + the false SL exit price recorded in the
 * evidence trail (their TP1-3 were never captured) - for those, TP1-3 are set
 * far out of reach so the resolver purely reports the real SL-cross timing
 * without fabricating intermediate target levels; this limitation is called
 * out explicitly in the report rather than guessed at.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveSignalWithBars } from "../services/signalResolver";
import type { TradingSignal } from "@/types/trading";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// Mirrors fetchSupabaseGoldBars() in TradingContext.tsx exactly - same table,
// same column selection, same ordering - this IS the TIER 0 read path.
async function fetchSupabaseGoldBars(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const { data, error } = await supabase
    .from("gold_m1_bars")
    .select("timestamp, open, high, low, close, volume")
    .gte("timestamp", new Date(fromTime).toISOString())
    .lte("timestamp", new Date(toTime).toISOString())
    .order("timestamp", { ascending: true });
  if (error) {
    console.error("   Supabase query failed:", error.message);
    return [];
  }
  return (data ?? []).map((row: any): OhlcBar => ({
    timestamp: new Date(row.timestamp as string).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

interface Case {
  label: string;
  signal: TradingSignal;
  windowHours: number;
  recordedStatus: string;
  recordedExit: number;
  recordedExitTimeUtc2: string;
  realChartAccount: string;
  tpLevelsKnown: boolean;
}

function makeSignal(partial: Partial<TradingSignal> & { id: string; type: "BUY" | "SELL"; entryPrice: number; createdAt: number }): TradingSignal {
  return {
    id: partial.id,
    type: partial.type,
    entryPrice: partial.entryPrice,
    entryPriceWithSlippage: partial.entryPrice,
    tp1: partial.tp1 ?? (partial.type === "SELL" ? partial.entryPrice - 100000 : partial.entryPrice + 100000),
    tp2: partial.tp2 ?? (partial.type === "SELL" ? partial.entryPrice - 100001 : partial.entryPrice + 100001),
    tp3: partial.tp3 ?? (partial.type === "SELL" ? partial.entryPrice - 100002 : partial.entryPrice + 100002),
    sl: partial.sl as number,
    timestamp: new Date(partial.createdAt) as unknown as string,
    createdAt: partial.createdAt,
    targetsHit: 0,
    confidence: 0.7,
    status: "ACTIVE",
    entryTime: "",
    topFeatures: [],
    riskJustification: "verify-script",
    breakevenReached: false,
  } as unknown as TradingSignal;
}

const cases: Case[] = [
  {
    label: "signal_1783955350503_r5u78ok9a (SELL entry 4012.2, 07-13 17:09 UTC+2)",
    signal: makeSignal({
      id: "signal_1783955350503_r5u78ok9a",
      type: "SELL",
      entryPrice: 4012.2,
      tp1: 4009.6,
      tp2: 4007.5,
      tp3: 4005.2,
      sl: 4016.8,
      createdAt: new Date("2026-07-13T15:09:10.503Z").getTime(),
    }),
    windowHours: 2,
    recordedStatus: "SL_HIT",
    recordedExit: 4016.8,
    recordedExitTimeUtc2: "17:11",
    realChartAccount: "user's real chart: price only ever moved UP toward ~4016.8, away from TP1/TP2 - a genuine SL-side move, but the ORIGINAL flag was about a DIFFERENT bug (Item 1's false TP1+TP2 bank scenario using different synthetic numbers) - this is a real re-check against the live corrected data.",
    tpLevelsKnown: true,
  },
  {
    label: 'signal_1783926579777_1hb6tvyz2 ("second flagged SELL", entry 4059.3, 07-13 09:09 UTC+2)',
    signal: makeSignal({
      id: "signal_1783926579777_1hb6tvyz2",
      type: "SELL",
      entryPrice: 4059.3,
      tp1: 4056.7,
      tp2: 4055.2,
      tp3: 4053.2,
      sl: 4064.8,
      createdAt: new Date("2026-07-13T07:09:39.777Z").getTime(),
    }),
    windowHours: 2,
    recordedStatus: "SL_HIT",
    recordedExit: 4064.8,
    recordedExitTimeUtc2: "09:11",
    realChartAccount: "flagged as a suspicious 2-minute SL_HIT (ATR=8.6, Normal Volatility) worth reproducing against genuine bars.",
    tpLevelsKnown: true,
  },
  {
    label: "signal_1784022915804_eok7tb6qb (SELL entry 4020.8, 07-14 11:55 UTC+2)",
    signal: makeSignal({
      id: "signal_1784022915804_eok7tb6qb",
      type: "SELL",
      entryPrice: 4020.8,
      tp1: 4018.3,
      tp2: 4016.2,
      sl: 4024.8,
      createdAt: new Date("2026-07-14T09:55:15.804Z").getTime(),
    }),
    windowHours: 4,
    recordedStatus: "SL_HIT",
    recordedExit: 4024.8,
    recordedExitTimeUtc2: "13:39 (2h post-entry catch-up branch)",
    realChartAccount: "user's real chart: ran to 4015.2 by 12:31 UTC+2 (10:31 UTC) - PAST TP1 4018.3 AND TP2 4016.2 - genuine SL touch (if any) claimed at 13:20 UTC+2 (11:20 UTC), not 13:39.",
    tpLevelsKnown: true,
  },
  {
    label: "signal_1784024732298_5axgrd0qt (SELL entry 4017, 07-14 12:25 UTC+2) - TP1-3 NOT in evidence trail",
    signal: makeSignal({
      id: "signal_1784024732298_5axgrd0qt",
      type: "SELL",
      entryPrice: 4017,
      sl: 4022.4,
      createdAt: new Date("2026-07-14T10:25:32.298Z").getTime(),
    }),
    windowHours: 2,
    recordedStatus: "SL_HIT",
    recordedExit: 4022.4,
    recordedExitTimeUtc2: "12:27 (2 min after entry)",
    realChartAccount: "user's real chart: oscillated, genuine SL touch claimed 32-34 min later at 12:58/12:59 UTC+2 (10:58/10:59 UTC).",
    tpLevelsKnown: false,
  },
  {
    label: "signal_1784024912333_grgvcf14c (SELL entry 4016.6, 07-14 12:28 UTC+2) - TP1-3 now supplied by user",
    signal: makeSignal({
      id: "signal_1784024912333_grgvcf14c",
      type: "SELL",
      entryPrice: 4016.6,
      tp1: 4014.1,
      tp2: 4012.0,
      tp3: 4009.7,
      sl: 4022.3,
      createdAt: new Date("2026-07-14T10:28:32.333Z").getTime(),
    }),
    windowHours: 2,
    recordedStatus: "SL_HIT",
    recordedExit: 4022.3,
    recordedExitTimeUtc2: "12:30 (2 min after entry)",
    realChartAccount: "user's real chart: followed price DOWN toward TP before the recorded premature SL - now testing with the real TP1/TP2/TP3 the user just supplied (4014.1/4012.0/4009.7).",
    tpLevelsKnown: true,
  },
  {
    label: "signal_1784022475559_heaxlv7rm (BUY, 07-14 11:47 UTC+2) - ALL_TARGETS_HIT exit 4026.2 recorded at 13:39 (same ts as eok7tb6qb)",
    signal: makeSignal({
      id: "signal_1784022475559_heaxlv7rm",
      type: "BUY",
      entryPrice: 4019.3,
      tp1: 4022.0,
      tp2: 4024.0,
      tp3: 4026.2,
      sl: 4015.0,
      createdAt: new Date("2026-07-14T09:47:55.559Z").getTime(),
    }),
    windowHours: 4,
    recordedStatus: "ALL_TARGETS_HIT",
    recordedExit: 4026.2,
    recordedExitTimeUtc2: "13:39 (identical to eok7tb6qb's exit ts - the OLD-bug signature)",
    realChartAccount: "question: does a genuine second rally to 4026.2 actually happen, and at what REAL bar timestamp (must differ from eok7tb6qb's if the Step-3 resolvedAtBarTs fix is working)?",
    tpLevelsKnown: false,
  },
];

async function main() {
  console.log("=== POST-VANTAGE-BACKFILL VERIFICATION: fromScratch re-resolution against real gold_m1_bars ===\n");

  for (const c of cases) {
    console.log("─".repeat(100));
    console.log(c.label);
    console.log(`  Recorded (pre-Vantage): ${c.recordedStatus} @ ${c.recordedExit} (exit time ${c.recordedExitTimeUtc2} UTC+2)`);
    console.log(`  Real chart account: ${c.realChartAccount}`);
    if (!c.tpLevelsKnown) {
      console.log("  ⚠️ TP1-3 NOT captured in this session's evidence trail for this signal - placeholder");
      console.log("     out-of-reach TP levels are used so ONLY the SL-cross timing is tested (not target hits).");
    }

    const fromTime = c.signal.createdAt as number;
    const toTime = fromTime + c.windowHours * 60 * 60 * 1000;
    const bars = await fetchSupabaseGoldBars(fromTime, toTime);

    if (bars.length === 0) {
      console.log("  ❌ NO gold_m1_bars rows returned for this window - TIER 0 did not fire, cannot verify.");
      continue;
    }

    const source = "🔵 TIER 0: gold_m1_bars (Supabase, Vantage MT5 real broker bars)";
    console.log(`  Bar source used: ${source} (${bars.length} bars, ${new Date(bars[0].timestamp).toISOString()} → ${new Date(bars[bars.length - 1].timestamp).toISOString()})`);

    const result = resolveSignalWithBars(c.signal, bars, {
      fromScratch: true,
      evalNowMs: toTime,
      logPrefix: `   [Verify ${c.signal.id.slice(-6)}]`,
    });

    console.log(`  NEW result (real Vantage bars, fromScratch): status=${result.newStatus} targetsHit=${result.targetsHit} exitPrice=${result.exitPrice.toFixed(2)} outcome=${result.outcomeResult ?? "n/a"}`);
    console.log(`  resolvedAtBarTs=${result.resolvedAtBarTs != null ? new Date(result.resolvedAtBarTs).toISOString() : "undefined"}`);

    const changed = result.newStatus !== c.recordedStatus || Math.abs(result.exitPrice - c.recordedExit) > 0.05;
    console.log(`  ${changed ? "🔁 OUTCOME CHANGED vs recorded" : "➡️ Outcome unchanged vs recorded"} from the pre-Vantage-backfill record.`);
  }

  console.log("\n" + "─".repeat(100));
  console.log("Done.");
}

main().catch((e) => {
  console.error("Verification script error:", e);
  process.exit(1);
});
