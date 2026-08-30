/**
 * WW — QUARANTINE SCAN. Identifies every emitted_signals_v1 row whose
 * emitted_at falls inside a CLOSED gold-market window, evaluated with the REAL
 * getGoldMarketClock from services/signalEngine.ts (the UU.2 shared predicate —
 * no second implementation). Read-only; never deletes or updates anything.
 *
 * Also answers WW.4: whether flagged signals reached trade_outcomes_v1,
 * shadow_candidates_v1, or telegram_outbox_v1.
 *
 * Runtime: bun cannot parse react-native's Flow-typed entry, so the RN boundary
 * is stubbed with a Bun runtime plugin and the engine module is imported
 * UNMODIFIED (same pattern as uu_forced_clock_test.ts).
 */
interface BunModuleResult {
  exports?: unknown;
  loader?: string;
}
interface BunPluginBuild {
  module(specifier: string, init: () => BunModuleResult): void;
}
interface BunGlobal {
  plugin(plugin: { name: string; setup(build: BunPluginBuild): void }): void;
}
const Bun_ = (globalThis as unknown as { Bun?: BunGlobal }).Bun;
if (!Bun_) throw new Error("Bun runtime required");

const noopAsync = async (): Promise<null> => null;
const asyncStorageStub = {
  getItem: noopAsync,
  setItem: async (): Promise<null> => null,
  removeItem: noopAsync,
  mergeItem: noopAsync,
  multiGet: async (): Promise<[][]> => [],
  multiSet: async (): Promise<null> => null,
  multiRemove: async (): Promise<null> => null,
  getAllKeys: async (): Promise<string[]> => [],
};
const reactNativeStub = {
  Platform: { OS: "web", select: <T,>(s: { default?: T; web?: T }): T | undefined => s.web ?? s.default },
  NativeModules: {},
};
Bun_.plugin({
  name: "ww-scan-rn-boundary-stub",
  setup(build: BunPluginBuild) {
    build.module("react-native", () => ({ exports: { ...reactNativeStub, default: reactNativeStub }, loader: "object" }));
    build.module("@react-native-async-storage/async-storage", () => ({ exports: { ...asyncStorageStub, default: asyncStorageStub }, loader: "object" }));
  },
});

const { createClient } = await import("@supabase/supabase-js");
const { getGoldMarketClock } = await import("../services/signalEngine");

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnon) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
const db = createClient(supabaseUrl, supabaseAnon);

interface EmissionRow {
  signal_id: string;
  emitted_at: string | null;
  direction: string | null;
  entry: number | null;
  source: string | null;
}

async function fetchAllEmissions(): Promise<EmissionRow[]> {
  const out: EmissionRow[] = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const { data, error } = await db
      .from("emitted_signals_v1")
      .select("signal_id,emitted_at,direction,entry,source")
      .order("emitted_at", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`emitted_signals_v1 fetch failed: ${error.message}`);
    const rows = (data ?? []) as EmissionRow[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log("WW — CLOSED-MARKET EMISSION SCAN (predicate: getGoldMarketClock, the UU.2 shared predicate)");
  const rows = await fetchAllEmissions();
  console.log(`total emitted_signals_v1 rows scanned: ${rows.length}`);

  const flagged: Array<EmissionRow & { closedAs: string }> = [];
  for (const r of rows) {
    if (!r.emitted_at) continue;
    const t = new Date(r.emitted_at);
    if (Number.isNaN(t.getTime())) continue;
    const clock = getGoldMarketClock(t);
    if (!clock.isMarketOpen) {
      const closedAs = clock.isSaturday ? "SATURDAY" : clock.isFridayClose ? "FRIDAY_CLOSE" : clock.isSundayBeforeOpen ? "SUNDAY_BEFORE_OPEN" : "DAILY_BREAK";
      flagged.push({ ...r, closedAs });
    }
  }

  console.log(`\nWW.1 — closed-market emissions: ${flagged.length}`);
  for (const f of flagged) {
    console.log(`  ${f.signal_id} | ${f.emitted_at} | ${f.direction ?? "?"} | entry=${f.entry ?? "?"} | source=${f.source ?? "?"} | closedAs=${f.closedAs}`);
  }

  const ids = flagged.map((f) => f.signal_id);
  console.log(`\nWW.4 — downstream reach of flagged signals (n=${ids.length})`);

  const { data: outcomes, error: eOut } = await db.from("trade_outcomes_v1").select("signal_id,resolved_at,realized_r").in("signal_id", ids.length ? ids : ["__none__"]);
  if (eOut) console.log(`  trade_outcomes_v1: ERROR ${eOut.message}`);
  else console.log(`  trade_outcomes_v1 rows for flagged signals: ${(outcomes ?? []).length}${(outcomes ?? []).length ? " " + JSON.stringify(outcomes) : ""}`);

  const { data: shadows, error: eSh } = await db.from("shadow_candidates_v1").select("id,candidate_name,evaluated_at,signal_id").in("signal_id", ids.length ? ids : ["__none__"]);
  if (eSh) console.log(`  shadow_candidates_v1 (by signal_id): ERROR ${eSh.message} — trying time-window fallback`);
  else console.log(`  shadow_candidates_v1 rows for flagged signals: ${(shadows ?? []).length}${(shadows ?? []).length ? " " + JSON.stringify(shadows) : ""}`);

  const { data: outbox, error: eOb } = await db.from("telegram_outbox_v1").select("id,created_at,payload").order("created_at", { ascending: false }).limit(500);
  if (eOb) console.log(`  telegram_outbox_v1: ERROR ${eOb.message}`);
  else {
    const text = JSON.stringify(outbox ?? []);
    const hits = ids.filter((id) => text.includes(id));
    console.log(`  telegram_outbox_v1: scanned newest ${(outbox ?? []).length} rows; flagged-signal references found: ${hits.length}${hits.length ? " ids=" + hits.join(",") : ""}`);
  }

  console.log("\nWW scan COMPLETE (read-only; nothing was deleted or updated)");
  process.exit(0);
}

try {
  await main();
} catch (err) {
  console.error(`WW scan FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
