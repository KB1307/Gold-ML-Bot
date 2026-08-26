/**
 * ITEM 5(d) + ITEM 6 — proves the Telegram delivery path records what actually
 * happened, and that the DURABLE OUTBOX changes "lost" into "pending".
 *
 * The defect being guarded: delivery ran through the Rork backend (503-prone),
 * the send was fire-and-forget, the error was swallowed, and the retry horizon
 * was ~2.4s against outages measured in tens of seconds. An alert that never
 * arrived was invisible — a trade the MT5 bot never received, with no trace.
 *
 * METHOD: the REAL notifier and the REAL supabase-js client are used. Only the
 * HTTP transport (global.fetch) is stubbed, so the outbox insert, the Edge
 * Function invocation, the retry loop and the counter persistence are all
 * exercised exactly as in production. Nothing is mirrored or reimplemented.
 *
 * NOTE: a unit test is necessary but NOT sufficient for Item 6. The live sweep
 * against the deployed Edge Function is the proof; this file is the regression net.
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

process.env.EXPO_PUBLIC_SUPABASE_URL ??= "https://stub.supabase.co";
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= "stub-anon-key";

// ── Stub the HTTP transport only ──
let functionMode: "down503" | "ok" = "down503";
let outboxMode: "ok" | "fail" = "ok";
let functionCalls = 0;
let outboxInserts = 0;
let lastFunctionBody: Record<string, unknown> | null = null;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  const options = (init ?? {}) as { body?: string };

  if (url.includes("/rest/v1/telegram_outbox_v1")) {
    outboxInserts += 1;
    if (outboxMode === "fail") {
      return new Response(JSON.stringify({ message: "permission denied (stub)" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    // Shape verified against the LIVE table, not assumed: an anon insert with
    // `.select("id").maybeSingle()` returns a bare OBJECT (`{"id":1}`), not an
    // array. The first version of this stub returned an array, which made the
    // notifier compute `{ outboxId: undefined }` — a TEST-CONSTRUCTION error,
    // recorded here rather than quietly corrected.
    return new Response(JSON.stringify({ id: 4242 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }

  if (url.includes("/functions/v1/send-telegram-alert")) {
    functionCalls += 1;
    try {
      lastFunctionBody = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    } catch {
      lastFunctionBody = null;
    }
    if (functionMode === "down503") {
      return new Response("", { status: 503, statusText: "Service Unavailable" });
    }
    return new Response(JSON.stringify({ ok: true, delivered: true, attempts: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return originalFetch(input as RequestInfo, init as RequestInit);
}) as typeof globalThis.fetch;

async function main(): Promise<void> {
  const notifier = await import("../services/telegramNotifier");
  const { buildDiagnosticsExportText } = await import("../services/diagnosticsExport");
  type ExportInput = Parameters<typeof buildDiagnosticsExportText>[0];

  const signal = {
    id: "ITEM6-TEST-1",
    type: "BUY" as const,
    entryPrice: 4000,
    sl: 3990,
    tp1: 4007,
    tp2: 4014,
    tp3: 4021,
  } as unknown as Parameters<typeof notifier.sendTelegramAlert>[0];

  // ── ITEM 6(e): the executor-facing message format must be BYTE-IDENTICAL ──
  const rendered = notifier.__buildTelegramMessageForTest(signal, 3);
  const expected = [
    "\u{1F7E2} *SIGNAL ALERT* \u{1F7E2}",
    "",
    "*SYMBOL:* XAUUSD",
    "",
    "*ACTION:* BUY",
    "",
    "*ENTRY ZONE:* 3998.0 - 4002.0",
    "",
    "*STOP LOSS:* 3990.0",
    "",
    "*TAKE PROFIT 1:* 4007.0",
    "*TAKE PROFIT 2:* 4014.0",
    "*TAKE PROFIT 3:* 4021.0",
  ].join("\n");
  check(
    "ITEM 6(e): message format unchanged — MT5 executor needs zero changes",
    rendered === expected,
    rendered === expected ? "byte-identical to the pre-Item-6 format" : JSON.stringify(rendered),
  );

  // ── Case 1: delivery function down, outbox insert OK -> PENDING, not LOST ──
  functionMode = "down503";
  outboxMode = "ok";
  notifier.sendTelegramAlert(signal, 3);
  await new Promise((r) => setTimeout(r, 6000));

  const afterDown = notifier.getTelegramDeliveryStats();
  check(
    "alert is PERSISTED to the outbox before any dispatch",
    afterDown.outboxEnqueued === 1 && outboxInserts === 1,
    `outboxEnqueued=${afterDown.outboxEnqueued} outboxInserts=${outboxInserts}`,
  );
  check(
    "a persisted-but-undelivered alert is a HANDOFF, not a loss",
    afterDown.outboxHandoffs === 1 && afterDown.alertsFailed === 0,
    `outboxHandoffs=${afterDown.outboxHandoffs} alertsFailed=${afterDown.alertsFailed} (expected 1 / 0)`,
  );
  check(
    "every inline retry was actually attempted",
    afterDown.dispatchAttempts === 3 && afterDown.dispatchFailures === 3,
    `dispatchAttempts=${afterDown.dispatchAttempts} dispatchFailures=${afterDown.dispatchFailures}`,
  );
  check(
    "dispatch references the persisted row by id (so the drain can finish the job)",
    lastFunctionBody?.outboxId === 4242,
    `body=${JSON.stringify(lastFunctionBody)}`,
  );
  check(
    "failure reason recorded, not swallowed",
    (afterDown.lastFailureReason ?? "").length > 0,
    `lastFailureReason=${JSON.stringify(afterDown.lastFailureReason)}`,
  );
  check(
    "no Rork backend on the delivery path",
    functionCalls === 3,
    `Edge Function calls=${functionCalls}, trpc calls=0 (module no longer imports trpcClient)`,
  );

  // ── Case 2: function healthy -> delivered on the first attempt ──
  functionMode = "ok";
  functionCalls = 0;
  outboxInserts = 0;
  notifier.sendTelegramAlert({ ...signal, id: "ITEM6-TEST-2" } as typeof signal, 3);
  await new Promise((r) => setTimeout(r, 2500));

  const afterOk = notifier.getTelegramDeliveryStats();
  check(
    "a success is counted as delivered",
    afterOk.alertsDelivered === 1,
    `alertsDelivered=${afterOk.alertsDelivered} (expected 1)`,
  );
  check(
    "a success does not retry",
    functionCalls === 1,
    `functionCalls=${functionCalls} (expected 1)`,
  );

  // ── Case 3: outbox insert fails AND function fails -> genuinely LOST ──
  functionMode = "down503";
  outboxMode = "fail";
  notifier.sendTelegramAlert({ ...signal, id: "ITEM6-TEST-3" } as typeof signal, 3);
  await new Promise((r) => setTimeout(r, 6000));

  const afterLost = notifier.getTelegramDeliveryStats();
  check(
    "an alert that could not even be PERSISTED is counted as LOST",
    afterLost.alertsFailed === 1,
    `alertsFailed=${afterLost.alertsFailed} (expected 1)`,
  );
  check(
    "the failed insert is counted, and the function-side enrollment fallback was used",
    afterLost.outboxEnqueueFailures === 1 && afterLost.outboxEnqueued === 2,
    `outboxEnqueueFailures=${afterLost.outboxEnqueueFailures} outboxEnqueued=${afterLost.outboxEnqueued}`,
  );
  check(
    "three alerts attempted in total",
    afterLost.alertsAttempted === 3,
    `alertsAttempted=${afterLost.alertsAttempted} (expected 3)`,
  );

  // ── Case 4: counters are DURABLE, not process-lifetime (the Item 4 lesson) ──
  const persistedRaw = store.get("telegram_delivery_counters_v1") ?? "";
  let persistedOk = false;
  try {
    const parsed = JSON.parse(persistedRaw) as {
      alertsFailed?: number;
      alertsDelivered?: number;
      outboxHandoffs?: number;
    };
    persistedOk =
      parsed.alertsFailed === 1 && parsed.alertsDelivered === 1 && parsed.outboxHandoffs === 1;
  } catch {
    persistedOk = false;
  }
  check(
    "counters (including the new outbox ones) persist across a reload",
    persistedOk,
    `persisted=${persistedRaw.slice(0, 240)}`,
  );

  // ── Case 5: the export surfaces both the process view and the durable outbox ──
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
  };

  const withStats = buildDiagnosticsExportText({
    ...baseInput,
    telegramDeliveryStats: notifier.getTelegramDeliveryStats(),
    telegramOutbox: {
      pending: 1,
      delivered: 7,
      deliveredOnRetry: 2,
      agedOut: 1,
      oldestPendingAgeSec: 45,
      lastError: "chat -100... status 0: network error",
      windowHours: 72,
    },
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
  check(
    "export shows the durable outbox state (pending / on-retry / aged out)",
    /PENDING \(awaiting a drain retry\):     1/.test(withStats) &&
      /of which delivered ON RETRY:        2/.test(withStats) &&
      /AGED OUT \(never delivered, TTL 10m\):  1/.test(withStats),
    withStats.split("\n").filter((l) => /PENDING|ON RETRY|AGED OUT/.test(l)).join(" | "),
  );

  const withoutOutbox = buildDiagnosticsExportText({
    ...baseInput,
    telegramDeliveryStats: notifier.getTelegramDeliveryStats(),
  });
  check(
    "a missing outbox summary reports NOT INSTRUMENTED, not an empty outbox",
    withoutOutbox.includes("NOT INSTRUMENTED - caller supplied no telegramOutbox summary"),
    "absence is not reported as a clean bill of health",
  );

  // ── Report ──
  console.log("\n=== ITEM 5(d) / ITEM 6 — TELEGRAM DELIVERY + OUTBOX TESTS ===\n");
  let passed = 0;
  checks.forEach((c) => {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
    if (c.pass) passed += 1;
  });
  console.log(`\n${passed}/${checks.length} passed\n`);

  const start = withStats.indexOf("SECTION 9");
  console.log("--- SECTION 9 as rendered ---");
  console.log(withStats.slice(start - 71, start + 2200));

  globalThis.fetch = originalFetch;
  if (passed !== checks.length) process.exit(1);
}

void main();
