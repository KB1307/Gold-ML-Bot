/**
 * WW follow-up — column discovery + every row emitted since Friday 2026-08-28
 * 20:00 UTC across emitted_signals_v1 / trade_outcomes_v1 / shadow_candidates_v1
 * / telegram_outbox_v1. Read-only. Decides where the user's weekend BUY lives.
 */
const { createClient } = await import("@supabase/supabase-js");

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnon) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
const db = createClient(supabaseUrl, supabaseAnon);

async function sampleColumns(table: string): Promise<string[]> {
  const { data, error } = await db.from(table).select("*").limit(1);
  if (error) {
    console.log(`${table}: sample ERROR ${error.message}`);
    return [];
  }
  const keys = data && data[0] ? Object.keys(data[0]) : [];
  console.log(`${table} columns (${keys.length}): ${keys.join(",")}`);
  return keys;
}

async function rowsSince(table: string, sinceIso: string, orderCol: string, max = 12): Promise<void> {
  const { data, error } = await db
    .from(table)
    .select("*")
    .gte(orderCol, sinceIso)
    .order(orderCol, { ascending: true })
    .limit(max);
  if (error) {
    console.log(`${table}: since-query ERROR ${error.message}`);
    return;
  }
  console.log(`\n${table}: ${(data ?? []).length} row(s) with ${orderCol} >= ${sinceIso}`);
  for (const r of data ?? []) {
    const s = JSON.stringify(r);
    console.log(`  ${s.length > 480 ? s.slice(0, 480) + "…" : s}`);
  }
}

async function newest(table: string, orderCol: string, n = 5): Promise<void> {
  const { data, error } = await db.from(table).select("*").order(orderCol, { ascending: false }).limit(n);
  if (error) {
    console.log(`${table}: newest ERROR ${error.message}`);
    return;
  }
  console.log(`\n${table}: newest ${n} by ${orderCol}`);
  for (const r of data ?? []) {
    const s = JSON.stringify(r);
    console.log(`  ${s.length > 480 ? s.slice(0, 480) + "…" : s}`);
  }
}

console.log("=== COLUMN DISCOVERY ===");
await sampleColumns("emitted_signals_v1");
await sampleColumns("trade_outcomes_v1");
await sampleColumns("shadow_candidates_v1");
await sampleColumns("telegram_outbox_v1");

const since = "2026-08-28T20:00:00Z";
console.log(`\n=== EVERY ROW SINCE ${since} (Friday 20:00 UTC = 1h before close) ===`);
await rowsSince("emitted_signals_v1", since, "emitted_at", 20);
await rowsSince("telegram_outbox_v1", since, "created_at", 20);
await rowsSince("trade_outcomes_v1", since, "created_at", 20);
await rowsSince("shadow_candidates_v1", since, "evaluated_at", 20);

console.log("\n=== NEWEST 5 PER TABLE (raw emitted_at strings for timezone audit) ===");
await newest("emitted_signals_v1", "emitted_at", 5);
await newest("telegram_outbox_v1", "created_at", 5);

process.exit(0);
