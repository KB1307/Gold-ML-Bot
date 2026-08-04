/**
 * ITEM 5(d) — proves the Telegram alert-delivery counters actually record a
 * silent failure, and that the diagnostics export surfaces it.
 *
 * The defect being guarded: sendTelegramAlert dispatches fire-and-forget
 * (`void attemptSend(1)`) and every failure path reached only console.warn, so
 * an alert that never arrived was invisible in the export — a trade the
 * downstream MT5 bot never received, with no trace anywhere.
 *
 * METHOD: the REAL trpcClient is used. Only the HTTP transport (global.fetch)
 * is stubbed, so the whole client stack — superjson transform, the custom retry
 * wrapper in lib/trpc.ts, and the notifier's own retry loop — is exercised
 * exactly as in production. The 503 body is byte-identical to what the live
 * Rork backend returns (empty body, status 503), verified by curl against
 * https://dev-rc77lvmdg2w595ubnei0z.rorktest.dev/api/trpc/telegram.sendAlert.
 */

import { mock } from "bun:test";

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

// ── Stub AsyncStorage (RN-only, throws "window is not defined" under node) ──
const store = new Map<string, string>();
const asyncStorageStub = {
  getItem: async (k: string): Promise<string | null> => store.get(k) ?? null,
  setItem: async (k: string, v: string): Promise<void> => { store.set(k, v); },
  removeItem: async (k: string): Promise<void> => { store.delete(k); },
  clear: async (): Promise<void> => { store.clear(); },
};

mock.module("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageStub,
}));

// ── Stub the HTTP transport only ──
let transportMode: "flap503" | "ok" = "flap503";
let httpCalls = 0;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  if (!url.includes("telegram.sendAlert")) {
    return originalFetch(input as RequestInfo, init as RequestInit);
  }
  httpCalls += 1;
  if (transportMode === "flap503") {
    // Exactly what the live Rork backend returns during a flap: empty body, 503.
    return new Response("", { status: 503, statusText: "Service Unavailable" });
  }
  return new Response(
    JSON.stringify({ result: { data: { json: { ok: true, results: [] } } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof globalThis.fetch;

async function main(): Promise<void> {
  const notifier = await import("../services/telegramNotifier");
  const { buildDiagnosticsExportText } = await import("../services/diagnosticsExport");
  type ExportInput = Parameters<typeof buildDiagnosticsExportText>[0];

  const signal = {
    id: "ITEM5D-TEST-1",
    type: "BUY" as const,
    entryPrice: 4000,
    sl: 3990,
    tp1: 4007,
    tp2: 4014,
    tp3: 4021,
  } as unknown as Parameters<typeof notifier.sendTelegramAlert>[0];

  // ── Case 1: backend flapping 503 for the whole retry horizon -> LOST alert ──
  transportMode = "flap503";
  notifier.sendTelegramAlert(signal, 3);
  // Notifier horizon: 3 attempts with 800ms + 1600ms backoff => ~2.4s.
  await new Promise((r) => setTimeout(r, 6000));

  const afterFail = notifier.getTelegramDeliveryStats();
  check(
    "a 503 flap is counted as a LOST alert",
    afterFail.alertsFailed === 1,
    `alertsFailed=${afterFail.alertsFailed} (expected 1)`,
  );
  check(
    "every retry was actually attempted",
    afterFail.dispatchAttempts === 3,
    `dispatchAttempts=${afterFail.dispatchAttempts} (expected 3)`,
  );
  check(
    "per-attempt failures counted",
    afterFail.dispatchFailures === 3,
    `dispatchFailures=${afterFail.dispatchFailures} (expected 3)`,
  );
  check(
    "failure reason recorded, not swallowed",
    (afterFail.lastFailureReason ?? "").length > 0,
    `lastFailureReason=${JSON.stringify(afterFail.lastFailureReason)}`,
  );
  check(
    "a failed alert is NOT miscounted as delivered",
    afterFail.alertsDelivered === 0,
    `alertsDelivered=${afterFail.alertsDelivered} (expected 0)`,
  );
  check(
    "the 503 actually reached the transport (real client stack exercised)",
    httpCalls >= 3,
    `httpCalls=${httpCalls} (expected >= 3)`,
  );

  // ── Case 2: backend healthy -> delivered on the first attempt ──
  transportMode = "ok";
  httpCalls = 0;
  notifier.sendTelegramAlert({ ...signal, id: "ITEM5D-TEST-2" } as typeof signal, 3);
  await new Promise((r) => setTimeout(r, 2500));

  const afterOk = notifier.getTelegramDeliveryStats();
  check(
    "a success is counted as delivered",
    afterOk.alertsDelivered === 1,
    `alertsDelivered=${afterOk.alertsDelivered} (expected 1)`,
  );
  check(
    "a success does not retry",
    httpCalls === 1,
    `httpCalls=${httpCalls} (expected 1)`,
  );
  check(
    "two alerts attempted in total",
    afterOk.alertsAttempted === 2,
    `alertsAttempted=${afterOk.alertsAttempted} (expected 2)`,
  );

  // ── Case 3: counters are DURABLE, not process-lifetime (the Item 4 lesson) ──
  const persistedRaw = store.get("telegram_delivery_counters_v1") ?? "";
  let persistedOk = false;
  try {
    const parsed = JSON.parse(persistedRaw) as { alertsFailed?: number; alertsDelivered?: number };
    persistedOk = parsed.alertsFailed === 1 && parsed.alertsDelivered === 1;
  } catch {
    persistedOk = false;
  }
  check(
    "counters persisted to durable storage (survive an app reload)",
    persistedOk,
    `persisted=${persistedRaw.slice(0, 200)}`,
  );

  // ── Case 4: the export SURFACES the loss (the whole point of 5d) ──
  const baseInput: ExportInput = {
    signalHistory: [],
    modelWeights: { lastTrainingTime: Date.now(), weights: [["rsi", 0.42]] } as ExportInput["modelWeights"],
    modelHealth: {
      modelHealthScore: 80,
      featureCorrelationStatus: "OK",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "NONE",
      daysSinceRetrain: 1,
      retrainingRecommended: false,
      retrainScheduled: false,
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
  };

  const withStats = buildDiagnosticsExportText({
    ...baseInput,
    telegramDeliveryStats: notifier.getTelegramDeliveryStats(),
  });
  check(
    "export renders SECTION 9",
    withStats.includes("SECTION 9 - TELEGRAM ALERT DELIVERY"),
    "section header present",
  );
  check(
    "export shows the LOST alert count",
    /Alerts LOST \(all retries exhausted\): 1/.test(withStats),
    withStats.split("\n").filter((l) => l.includes("LOST")).join(" | "),
  );

  // Omitting the stats must read as UNKNOWN, never as "zero failures".
  const withoutStats = buildDiagnosticsExportText(baseInput);
  check(
    "omitted stats report NOT INSTRUMENTED, not 0 failures",
    withoutStats.includes("NOT INSTRUMENTED") && !/Alerts LOST[^\n]*: 0/.test(withoutStats),
    "absence is not reported as a clean bill of health",
  );

  // ── Report ──
  console.log("\n=== ITEM 5(d) — TELEGRAM DELIVERY COUNTER TESTS ===\n");
  let passed = 0;
  checks.forEach((c) => {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
    if (c.pass) passed += 1;
  });
  console.log(`\n${passed}/${checks.length} passed\n`);

  const start = withStats.indexOf("SECTION 9");
  console.log("--- SECTION 9 as rendered ---");
  console.log(withStats.slice(start - 71, start + 1400));

  globalThis.fetch = originalFetch;
  if (passed !== checks.length) process.exit(1);
}

void main();
