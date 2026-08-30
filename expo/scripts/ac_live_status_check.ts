/**
 * AC — LIVE STATUS + AB.2 (read-only, anon key, direct Supabase).
 * AC.1 newest emission annotation state; AC.2 BAND_VETO_SUPPRESSED count (STRICT
 * equality) toward P.3 n=30; AC.3 diagnostics latest.txt funnel + build marker;
 * AC.5 emitted/outcomes counts + B.3 pairs toward 1,041. AB.2 hydration-cap
 * arithmetic against the live count. Market is CLOSED (Sunday) — statuses
 * reflect that.
 */
const { createClient } = await import("@supabase/supabase-js");

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
const db = createClient(url, anon);

// AC.1
{
  const { data, error } = await db.from("emitted_signals_v1").select("signal_id,emitted_at,direction,entry,m15_opposed,m15_endorsed,m15_zone_context,retype_verdict_would_change,chase_position,opposing_zone_fraction,pre_signal_drift,band_veto_would_fire,band_veto_zone_price,regime_at_emission,mapped_sl,mapped_tp").order("emitted_at", { ascending: false }).limit(2);
  if (error) console.log(`AC.1 ERROR: ${error.message}`);
  else {
    console.log("AC.1 — newest 2 emissions, annotation columns:");
    for (const r of data ?? []) console.log(`  ${JSON.stringify(r).slice(0, 420)}`);
    const any = (data ?? []).some((r) => r.m15_opposed !== null || r.retype_verdict_would_change !== null);
    console.log(`  -> annotated row exists: ${any}`);
  }
}

// AC.2
{
  const { count, error } = await db.from("shadow_candidates_v1").select("evaluated_at", { count: "exact", head: true }).eq("candidate_name", "BAND_VETO_SUPPRESSED");
  console.log(`\nAC.2 — BAND_VETO_SUPPRESSED (STRICT equality): ${error ? "ERROR " + error.message : count ?? 0} toward P.3 n=30`);
}

// AC.5 + AB.2
{
  const { count: emitted, error: e1 } = await db.from("emitted_signals_v1").select("signal_id", { count: "exact", head: true });
  const { count: outcomes, error: e2 } = await db.from("trade_outcomes_v1").select("signal_id", { count: "exact", head: true });
  console.log(`\nAC.5 — emitted=${e1 ? "ERR" : emitted} outcomes=${e2 ? "ERR" : outcomes}`);
  if (typeof outcomes === "number") console.log(`  B.3 decided-pair proxy: ${outcomes}/1041 = ${((outcomes / 1041) * 100).toFixed(1)}% (upper bound)`);
  if (typeof outcomes === "number") console.log(`  AB.2 — hydration cap arithmetic: pull limit 300 default (options?.limit ?? 300) / signalEngine passes CORPUS_PULL_LIMIT; local cap MAX_STORED_OUTCOMES=2000; live corpus ${outcomes} -> a default hydrate holds at most 300 of ${outcomes}`);
}

// AC.3 / AC.4 — diagnostics export
{
  const base = url.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/storage/v1/object/public/diagnostics/latest.txt`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    console.log(`\nAC.3/AC.4 — diagnostics/latest.txt fetched (${text.length} bytes)`);
    const gen = text.match(/generated[^\n]*/i)?.[0];
    console.log(`  generated: ${gen ?? "NOT FOUND"}`);
    const sha = text.match(/build[_ ]?sha[^\n]*/i)?.[0] ?? text.match(/[0-9a-f]{7,12}[^\n]*/i)?.[0];
    console.log(`  build-marker line: ${sha ?? "NOT FOUND"}`);
    const funnel = text.match(/\b(generated|emitted|suppressed|attempts)\b[^\n]*/gi)?.slice(0, 6) ?? [];
    for (const f of funnel) console.log(`  funnel: ${f.slice(0, 140)}`);
  } catch (err) {
    console.log(`\nAC.3/AC.4 — diagnostics export UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.exit(0);
