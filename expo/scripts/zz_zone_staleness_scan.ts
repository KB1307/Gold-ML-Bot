/**
 * ZZ.1/ZZ.2 — ZONE STALENESS SCAN (read-only, anon key, direct Supabase).
 * Reports sr_zones_v1 row count, newest zone timestamp, and its age in minutes.
 * No writes, no deletes.
 */
const { createClient } = await import("@supabase/supabase-js");

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnon) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
const db = createClient(supabaseUrl, supabaseAnon);

const { data: sample, error: eS } = await db.from("sr_zones_v1").select("*").limit(1);
if (eS) {
  console.log(`sr_zones_v1 sample ERROR: ${eS.message}`);
  process.exit(1);
}
const cols = sample && sample[0] ? Object.keys(sample[0]) : [];
console.log(`sr_zones_v1 columns (${cols.length}): ${cols.join(",")}`);

const { count, error: eC } = await db.from("sr_zones_v1").select("*", { count: "exact", head: true });
console.log(`\nZZ.1 row count: ${eC ? "ERROR " + eC.message : count}`);

// find a plausible timestamp column
const tsCol = ["updated_at", "last_confirmed_at", "detected_at", "created_at", "timestamp"].find((c) => cols.includes(c));
console.log(`timestamp column used: ${tsCol ?? "NONE FOUND"}`);

if (tsCol) {
  const { data: newest, error: eN } = await db.from("sr_zones_v1").select("*").order(tsCol, { ascending: false }).limit(3);
  if (eN) console.log(`newest ERROR: ${eN.message}`);
  else {
    const now = Date.now();
    for (const z of newest ?? []) {
      const t = z[tsCol] ? new Date(z[tsCol] as string).getTime() : NaN;
      const ageMin = Number.isNaN(t) ? null : (now - t) / 60_000;
      const brief = JSON.stringify(z);
      console.log(`  ${tsCol}=${z[tsCol]} | age=${ageMin === null ? "?" : ageMin.toFixed(1) + " min"} | ${brief.length > 300 ? brief.slice(0, 300) + "…" : brief}`);
    }
    const first = (newest ?? [])[0];
    if (first && first[tsCol]) {
      const ageMin = (now - new Date(first[tsCol] as string).getTime()) / 60_000;
      console.log(`\nZZ.1 ANSWER: newest zone age = ${ageMin.toFixed(1)} minutes (${(ageMin / 60).toFixed(2)} h) as of scan time.`);
    }
  }
}

// any staleness-ish columns worth reporting
for (const c of ["status", "health", "tier", "zone_type", "type"].filter((c) => cols.includes(c))) {
  const { data: dist } = await db.from("sr_zones_v1").select(c).limit(2000);
  const counts: Record<string, number> = {};
  for (const r of dist ?? []) {
    const k = String((r as Record<string, unknown>)[c]);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  console.log(`distribution of ${c}: ${JSON.stringify(counts)}`);
}

process.exit(0);
