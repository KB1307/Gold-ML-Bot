/**
 * ITEM 13 — VERIFY THE PROPOSED BACKFILL RULE BEFORE PROPOSING IT.
 *
 * SPEC-SUPPORT ONLY. Nothing is migrated, nothing is written, nothing is deleted.
 *
 * The proposed rule for backfilling `source` on existing `shadow_signals_v1` rows
 * is "id > 16 => SIMULATION". The brief also names the price band as an
 * independent discriminator and requires that the two AGREE before the rule is
 * proposed. This script measures that agreement instead of assuming it, and does
 * the same for `trade_outcomes_v1` (which has no serial id, so it needs its own
 * rule).
 *
 * Usage: bun run scripts/investigateItem13ProvenanceBackfill.ts
 */
import { createClient } from "@supabase/supabase-js";

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

/** The synthetic band the simulation harness generates in (Item 10 measured $3023.7-3054). */
const SIM_BAND_LO = 2900;
const SIM_BAND_HI = 3200;

interface ShadowRow {
  id: number;
  signal_id: string;
  created_at: string;
  entry: number | string;
  atr: number | string | null;
}

async function fetchAllShadow(): Promise<ShadowRow[]> {
  const rows: ShadowRow[] = [];
  for (let page = 0; page < 20; page += 1) {
    const from = page * 500;
    const res = await svc
      .from("shadow_signals_v1")
      .select("id, signal_id, created_at, entry, atr")
      .order("id", { ascending: true })
      .range(from, from + 499);
    if (res.error) throw new Error(res.error.message);
    const batch = (res.data ?? []) as unknown as ShadowRow[];
    rows.push(...batch);
    if (batch.length < 500) break;
  }
  return rows;
}

function classifyById(id: number): "LIVE" | "SIMULATION" {
  return id > 16 ? "SIMULATION" : "LIVE";
}

function classifyByBand(entry: number): "LIVE" | "SIMULATION" {
  return entry >= SIM_BAND_LO && entry <= SIM_BAND_HI ? "SIMULATION" : "LIVE";
}

async function main(): Promise<void> {
  console.log("===================================================================");
  console.log("  ITEM 13 - BACKFILL RULE VERIFICATION (read-only, spec support)");
  console.log(`  ${new Date().toISOString()}`);
  console.log("===================================================================\n");

  const rows = await fetchAllShadow();
  console.log(`shadow_signals_v1 rows fetched: ${rows.length}`);
  console.log(`id range: ${rows[0]?.id} .. ${rows[rows.length - 1]?.id}`);

  let agree = 0;
  const disagreements: string[] = [];
  const byClass = new Map<string, number>();
  for (const r of rows) {
    const entry = Number(r.entry);
    const a = classifyById(r.id);
    const b = classifyByBand(entry);
    byClass.set(a, (byClass.get(a) ?? 0) + 1);
    if (a === b) agree += 1;
    else disagreements.push(`id=${r.id} entry=${entry} byId=${a} byBand=${b} created_at=${r.created_at}`);
  }

  console.log(`\n-- Rule A (id > 16 => SIMULATION) vs Rule B (entry in $${SIM_BAND_LO}-${SIM_BAND_HI} => SIMULATION) --`);
  console.log(`  agreement: ${agree}/${rows.length} (${((agree / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  classification by Rule A: ${[...byClass.entries()].map(([k, v]) => `${k}=${v}`).join("  ")}`);
  if (disagreements.length === 0) {
    console.log("  DISAGREEMENTS: none - the two discriminators are 100% concordant.");
  } else {
    console.log(`  DISAGREEMENTS (${disagreements.length}) - the rule is NOT safe as stated:`);
    disagreements.slice(0, 20).forEach((d) => console.log(`    ${d}`));
  }

  // Third, independent discriminator: gold_m1_bars coverage of the row's own date.
  const live = rows.filter((r) => classifyById(r.id) === "LIVE");
  const sim = rows.filter((r) => classifyById(r.id) === "SIMULATION");
  console.log("\n-- Independent cross-check: does gold_m1_bars cover the row's date at all? --");
  for (const [label, set] of [["LIVE (id<=16)", live], ["SIMULATION (id>16)", sim]] as const) {
    if (set.length === 0) continue;
    const dates = [...new Set(set.map((r) => r.created_at.slice(0, 10)))].sort();
    console.log(`  ${label}: n=${set.length} distinct dates=${dates.length} [${dates.slice(0, 3).join(", ")}${dates.length > 3 ? ", ..." : ""}]`);
    const probeDate = dates[0];
    // NOTE: gold_m1_bars.timestamp is an ISO timestamptz, NOT epoch ms. Filtering
    // it with epoch integers silently returns 0 rows for the WRONG reason, which
    // would have produced a fake corroboration here.
    const { count } = await svc
      .from("gold_m1_bars")
      .select("timestamp", { count: "exact", head: true })
      .gte("timestamp", `${probeDate}T00:00:00Z`)
      .lt("timestamp", `${probeDate}T23:59:59Z`);
    console.log(`    gold_m1_bars rows on ${probeDate}: ${count ?? 0}${(count ?? 0) === 0 ? "  <-- no market data existed; cannot be a live signal" : ""}`);
    const entries = set.map((r) => Number(r.entry)).sort((a, b) => a - b);
    console.log(`    entry range: $${entries[0]} .. $${entries[entries.length - 1]}`);
  }

  // trade_outcomes_v1 has no serial id, so state plainly what a rule there can use.
  console.log("\n-- trade_outcomes_v1: what a backfill rule can key on --");
  const { count: outcomesCount } = await svc
    .from("trade_outcomes_v1")
    .select("signal_id", { count: "exact", head: true });
  const { data: sample } = await svc
    .from("trade_outcomes_v1")
    .select("signal_id, ts, entry_price, created_at")
    .order("ts", { ascending: true })
    .limit(5);
  console.log(`  rows: ${outcomesCount}`);
  (sample ?? []).forEach((r) => {
    const rec = r as unknown as { signal_id: string; ts: string; entry_price: number; created_at?: string };
    console.log(`    ${rec.signal_id}  ts=${rec.ts}  entry=${rec.entry_price}  created_at=${rec.created_at ?? "(column absent)"}`);
  });
  const { data: bandRows } = await svc
    .from("trade_outcomes_v1")
    .select("signal_id, entry_price")
    .gte("entry_price", SIM_BAND_LO)
    .lte("entry_price", SIM_BAND_HI);
  console.log(`  rows inside the simulation price band: ${(bandRows ?? []).length}`);
  console.log("  (no serial id column exists here, so the id>N rule does NOT transfer)");

  console.log("\n===================================================================");
  console.log("  END - read-only. No migration run, nothing written or deleted.");
  console.log("===================================================================");
}

void main();
