/**
 * ITEM 7 — PROVE THE SHADOW SUMMARY READ IS NOW DIRECT AND COMPLETE.
 *
 * SECTION 6 reported 5 rows while shadow_signals_v1 actually held 413, because
 * the summary was fetched through the 503-prone Rork backend route
 * (`shadow.summary`). The fix repoints that read DIRECTLY at Supabase via the
 * anon key, exactly as was done for the TIER_0 zone read.
 *
 * VERIFICATION (three independent sources, all pasted):
 *   1. SERVICE-KEY count  — ground truth, `count: 'exact'` (never a row-limited
 *      length, which is how a 1000-row cap hides itself).
 *   2. ANON DIRECT read   — the REAL `fetchShadowSellSummary()` from
 *      services/shadowSignalService.ts, imported, not reimplemented.
 *   3. BACKEND route      — the retired path, probed live so its current state is
 *      recorded rather than assumed.
 *
 * Then it renders SECTION 6 through the REAL `buildDiagnosticsExportText`.
 *
 * DATA-SOURCE RULE: the anon path is the product path. The service key appears
 * here ONLY as the out-of-band control count, in a Node script that is never in
 * the client bundle.
 */

import { mock } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const store = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string): Promise<string | null> => store.get(k) ?? null,
    setItem: async (k: string, v: string): Promise<void> => { store.set(k, v); },
    removeItem: async (k: string): Promise<void> => { store.delete(k); },
  },
}));

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

async function main(): Promise<void> {
  const env = loadEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  console.log("=== ITEM 7 — SHADOW SUMMARY: DIRECT SUPABASE READ vs SERVICE-KEY CONTROL ===");
  console.log("");

  // 1. Service-key control count (ground truth).
  const svc = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const since30 = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
  const total = await svc
    .from("shadow_signals_v1")
    .select("*", { count: "exact", head: true });
  const last30 = await svc
    .from("shadow_signals_v1")
    .select("*", { count: "exact", head: true })
    .gte("created_at", since30);

  console.log(`[1] SERVICE KEY count(*) all time : ${total.count ?? "error: " + total.error?.message}`);
  console.log(`[1] SERVICE KEY count(*) last 30d : ${last30.count ?? "error: " + last30.error?.message}`);
  console.log("");

  // 2. The REAL product read path.
  const { fetchShadowSellSummary } = await import("../services/shadowSignalService");
  const summary = await fetchShadowSellSummary(30);
  console.log(`[2] ANON DIRECT fetchShadowSellSummary(30).count : ${summary?.count ?? "null (read failed)"}`);
  console.log(`[2] dateRange : ${summary?.dateRange ? `${summary.dateRange.oldest} .. ${summary.dateRange.newest}` : "null"}`);
  console.log(`[2] sessionBreakdown : ${JSON.stringify(summary?.sessionBreakdown ?? null)}`);
  console.log(`[2] htfBreakdown : ${JSON.stringify(summary?.htfBreakdown ?? null)}`);
  console.log("");

  const reconciles = summary !== null && summary.count === (last30.count ?? -1);
  console.log(`RECONCILIATION: anon-direct count === service-key count -> ${reconciles ? "PASS" : "FAIL"}`);
  console.log("");

  // 3. The retired backend route, probed live.
  const bases = [env.EXPO_PUBLIC_RORK_API_BASE_URL, env.EXPO_PUBLIC_RORK_FUNCTIONS_URL].filter(
    (b): b is string => typeof b === "string" && b.length > 0,
  );
  for (const base of bases) {
    const url = `${base.replace(/\/$/, "")}/api/trpc/shadow.summary?input=${encodeURIComponent(
      JSON.stringify({ json: { days: 30 } }),
    )}`;
    try {
      const res = await fetch(url);
      const text = await res.text();
      let count = "n/a";
      try {
        const parsed = JSON.parse(text) as { result?: { data?: { json?: { count?: number } } } };
        count = String(parsed.result?.data?.json?.count ?? "n/a");
      } catch {
        count = "unparseable";
      }
      console.log(`[3] RETIRED BACKEND ROUTE ${base} -> HTTP ${res.status}, count=${count}`);
    } catch (error: unknown) {
      console.log(
        `[3] RETIRED BACKEND ROUTE ${base} -> transport error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log("");

  // 4. SECTION 6 as the export actually renders it, through the REAL builder.
  const { buildDiagnosticsExportText } = await import("../services/diagnosticsExport");
  type ExportInput = Parameters<typeof buildDiagnosticsExportText>[0];
  const text = buildDiagnosticsExportText({
    signalHistory: [],
    modelWeights: null,
    modelHealth: {
      modelHealthScore: 80,
      featureCorrelationStatus: "OK",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "NONE",
      daysSinceRetrain: 1,
      retrainingRecommended: false,
      retrainScheduled: false,
      retrainScheduledAtMs: null,
      retrainScheduledReason: null,
      featureImportanceDrift: [],
    } as unknown as ExportInput["modelHealth"],
    performanceMetrics: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      expectancy: 0,
      averageWin: 0,
      averageLoss: 0,
      totalProfit: 0,
      totalLoss: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
    } as unknown as ExportInput["performanceMetrics"],
    shadowSellSummary: summary,
    shadowWriteFailures: 0,
    shadowWriteSuccesses: 0,
  });
  const start = text.indexOf("SECTION 6");
  console.log("--- SECTION 6 as rendered (first 1200 chars) ---");
  console.log(text.slice(start - 71, start + 1200));

  if (!reconciles) process.exit(1);
}

void main();
