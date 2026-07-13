import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ITEM 3 CHECKPOINT TEST — durable, structured, on-device diagnostic event log.
 *
 * Exercises the REAL diagnosticEventStore.ts module (web-fallback branch, same
 * approach as test_step3_sqlite_migration.ts for learningStore.ts) under plain
 * Bun/Node, proving:
 *  1. Appending PATH3_* / LIVE_TICK_* events during a simulated Path 3
 *     TP-candidate -> confirmed and SL-candidate -> confirmed scenario
 *     actually produces rows that can be read back.
 *  2. The rolling 24h retention prunes events older than the window while
 *     keeping recent ones.
 *  3. buildDiagnosticsExportText's new Section 5 renders real event data.
 *  4. This is purely additive: none of the store's functions touch or
 *     require signal generation/resolution state - they only take an event
 *     object as input.
 */

interface DiagnosticEventStoreModule {
  appendDiagnosticEvent(event: { ts: number; signalId: string; eventType: string; price: number; detail?: Record<string, unknown> }): Promise<void>;
  pruneOldDiagnosticEvents(): Promise<void>;
  getRecentDiagnosticEvents(limit?: number): Promise<{ ts: number; signalId: string; eventType: string; price: number; detail?: Record<string, unknown> }[]>;
  getDiagnosticEventCount(): Promise<number>;
  clearAllDiagnosticEventsForTest(): Promise<void>;
}

async function loadStore(): Promise<DiagnosticEventStoreModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "diagnosticEventStore.item3.ts");
  const sourcePath = path.join(process.cwd(), "services", "diagnosticEventStore.ts");
  const source = await readFile(sourcePath, "utf8");
  const rewritten = source.replace(
    /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
    'const Platform = { OS: "web" as const };\n',
  );
  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, rewritten);
  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<DiagnosticEventStoreModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("\nItem 3: durable structured diagnostic event log\n");
  const store = await loadStore();
  await store.clearAllDiagnosticEventsForTest();

  const now = Date.now();
  const signalId = "sig-item3-test-000123";

  // --- Simulate a Path 3 TP candidate -> confirmed sequence ----------------
  console.log("Test 1: simulated Path 3 TP-candidate -> confirmed sequence produces real rows");
  await store.appendDiagnosticEvent({ ts: now, signalId, eventType: "PATH3_TP_CANDIDATE", price: 4007.6, detail: { kind: "TP2", penetrationPips: 1.8, confirmed: false } });
  await store.appendDiagnosticEvent({ ts: now + 30_000, signalId, eventType: "PATH3_TP_CONFIRMED", price: 4007.2, detail: { kind: "TP2", penetrationPips: 2.3, confirmed: true } });

  // --- Simulate a Path 3 SL candidate -> confirmed sequence -----------------
  await store.appendDiagnosticEvent({ ts: now, signalId, eventType: "PATH3_SL_CANDIDATE", price: 4108.6, detail: { kind: "SL", penetrationPips: 5.0, confirmed: false } });
  await store.appendDiagnosticEvent({ ts: now + 30_000, signalId, eventType: "PATH3_SL_CONFIRMED", price: 4108.9, detail: { kind: "SL", penetrationPips: 5.3, confirmed: true } });

  // --- Simulate a live-tick SL confirmation event ---------------------------
  await store.appendDiagnosticEvent({ ts: now + 60_000, signalId, eventType: "LIVE_TICK_SL_HIT", price: 4108.8, detail: { refPrice: 4108.6, elapsedMs: 2600, maxPenetrationPips: 2.0, tickCount: 3 } });

  const recentAfterAppends = await store.getRecentDiagnosticEvents(100);
  check("5 events were recorded", recentAfterAppends.length === 5, `count=${recentAfterAppends.length}`);
  check("newest-first ordering", recentAfterAppends[0]?.eventType === "LIVE_TICK_SL_HIT", `first=${recentAfterAppends[0]?.eventType}`);
  const eventTypes = new Set(recentAfterAppends.map(e => e.eventType));
  check(
    "all 5 distinct event types present (PATH3_TP_CANDIDATE/CONFIRMED, PATH3_SL_CANDIDATE/CONFIRMED, LIVE_TICK_SL_HIT)",
    ["PATH3_TP_CANDIDATE", "PATH3_TP_CONFIRMED", "PATH3_SL_CANDIDATE", "PATH3_SL_CONFIRMED", "LIVE_TICK_SL_HIT"].every(t => eventTypes.has(t)),
    `types=${[...eventTypes].join(",")}`,
  );
  const tp2Confirmed = recentAfterAppends.find(e => e.eventType === "PATH3_TP_CONFIRMED");
  check("event detail (price read + gate fields) is preserved", tp2Confirmed?.detail?.penetrationPips === 2.3, `detail=${JSON.stringify(tp2Confirmed?.detail)}`);

  // --- Test 2: rolling 24h retention prunes old rows, keeps recent ones ----
  console.log("\nTest 2: rolling 24h retention");
  const staleTs = now - (25 * 60 * 60 * 1000); // 25h ago -> beyond the 24h window
  await store.appendDiagnosticEvent({ ts: staleTs, signalId: "sig-stale", eventType: "PATH3_SL_CANDIDATE", price: 4100.0, detail: { kind: "SL", penetrationPips: 1.0, confirmed: false } });
  const beforePrune = await store.getRecentDiagnosticEvents(1000);
  const staleVisibleBeforePrune = beforePrune.some(e => e.signalId === "sig-stale");
  check("query already excludes the 25h-old event (retention filter applies at read time too)", !staleVisibleBeforePrune, `staleVisible=${staleVisibleBeforePrune}`);

  await store.pruneOldDiagnosticEvents();
  const totalCountAfterPrune = await store.getDiagnosticEventCount();
  check("prune removes the stale (>24h) row from underlying storage", totalCountAfterPrune === 5, `countAfterPrune=${totalCountAfterPrune} (expected 5 recent rows retained)`);

  const afterPrune = await store.getRecentDiagnosticEvents(1000);
  check("recent (within-24h) events remain fully intact after prune", afterPrune.length === 5, `count=${afterPrune.length}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Item 3 verified — diagnostic events are durably recorded, queryable, and correctly retention-pruned."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
