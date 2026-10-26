/**
 * PNL BASELINE (read-only, anon key, no table writes).
 *
 * Question: what does the LIVE book earn per day today, in price-dollars
 * (1 oz = $1 per $1 move; pip = $0.10), before any new learning layer?
 *
 * Joins emitted_signals_v1 (entry/sl → risk in $) with trade_outcomes_v1
 * (realized_r). $ per trade = realized_r × |entry − sl|. Groups by UTC day and
 * by calendar month. Also prints the realized distribution by result label so
 * the win-rate / payoff asymmetry is visible, and a per-feature split
 * (htf_trend alignment, rsi bucket, hour bucket, sl size) so any proposed
 * learning lever is measured BEFORE it is built.
 *
 * Run: cd expo && bun scripts/measure_pnl_baseline.ts
 */
import { createClient } from "@supabase/supabase-js";

type Emit = {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number | null;
  atr: number | null;
  htf_trend: string | null;
  rsi: number | null;
};
type Outcome = { signal_id: string; result: string | null; realized_r: number | null };

async function pageAll<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

function stats(rows: { usd: number; r: number }[]) {
  const n = rows.length;
  if (n === 0) return { n, wr: 0, ev: 0, evr: 0, sum: 0 };
  const wins = rows.filter((x) => x.r > 0).length;
  const sum = rows.reduce((a, x) => a + x.usd, 0);
  const sumR = rows.reduce((a, x) => a + x.r, 0);
  return { n, wr: wins / n, ev: sum / n, evr: sumR / n, sum };
}
const f = (s: ReturnType<typeof stats>) =>
  `n=${s.n} WR=${(s.wr * 100).toFixed(1)}% EV=$${s.ev.toFixed(2)}/trade (${s.evr.toFixed(3)}R) total=$${s.sum.toFixed(0)}`;

async function main() {
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
  const emits = await pageAll<Emit>((a, b) =>
    client
      .from("emitted_signals_v1")
      .select("signal_id,emitted_at,direction,entry,sl,tp1,atr,htf_trend,rsi")
      .order("emitted_at", { ascending: true })
      .range(a, b),
  );
  const outs = await pageAll<Outcome>((a, b) =>
    client.from("trade_outcomes_v1").select("signal_id,result,realized_r").range(a, b),
  );
  const byId = new Map(outs.map((o) => [o.signal_id, o]));

  const rows = emits
    .map((e) => {
      const o = byId.get(e.signal_id);
      if (!o || o.realized_r === null || !Number.isFinite(o.realized_r)) return null;
      const risk = Math.abs(e.entry - e.sl);
      return { e, r: o.realized_r, result: o.result ?? "?", usd: o.realized_r * risk, risk };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  console.log(`emitted=${emits.length} outcomes=${outs.length} decided-with-R=${rows.length}`);
  console.log(`window: ${rows[0]?.e.emitted_at} → ${rows[rows.length - 1]?.e.emitted_at}`);
  console.log(`\nOVERALL: ${f(stats(rows))}`);

  // by result label
  const byResult = new Map<string, typeof rows>();
  for (const r of rows) byResult.set(r.result, [...(byResult.get(r.result) ?? []), r]);
  console.log("\nBY RESULT LABEL:");
  for (const [k, v] of [...byResult].sort((a, b) => b[1].length - a[1].length))
    console.log(`  ${k.padEnd(22)} ${f(stats(v))}`);

  // per day
  const byDay = new Map<string, typeof rows>();
  for (const r of rows) {
    const d = r.e.emitted_at.slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), r]);
  }
  const days = [...byDay].sort();
  const dayTotals = days.map(([, v]) => v.reduce((a, x) => a + x.usd, 0));
  const dayN = days.map(([, v]) => v.length);
  const mean = dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length;
  const sd = Math.sqrt(dayTotals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, dayTotals.length - 1));
  const sorted = [...dayTotals].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`\nPER TRADING DAY (${days.length} days): mean=$${mean.toFixed(2)} median=$${med.toFixed(2)} sd=$${sd.toFixed(2)} ` +
    `trades/day=${(dayN.reduce((a, b) => a + b, 0) / days.length).toFixed(1)} ` +
    `days≥$3: ${dayTotals.filter((x) => x >= 3).length} days<0: ${dayTotals.filter((x) => x < 0).length}`);
  console.log("  last 15 days:");
  for (const [d, v] of days.slice(-15))
    console.log(`   ${d}  n=${v.length}  $${v.reduce((a, x) => a + x.usd, 0).toFixed(2)}`);

  // per month
  const byMonth = new Map<string, typeof rows>();
  for (const r of rows) {
    const m = r.e.emitted_at.slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
  }
  console.log("\nPER MONTH:");
  for (const [m, v] of [...byMonth].sort()) console.log(`  ${m}  ${f(stats(v))}`);

  // candidate levers — measured, not assumed
  console.log("\nLEVER SPLITS (same rows):");
  const aligned = rows.filter((r) => (r.e.htf_trend === "BULLISH" && r.e.direction === "BUY") || (r.e.htf_trend === "BEARISH" && r.e.direction === "SELL"));
  const counter = rows.filter((r) => (r.e.htf_trend === "BULLISH" && r.e.direction === "SELL") || (r.e.htf_trend === "BEARISH" && r.e.direction === "BUY"));
  const neutral = rows.filter((r) => !aligned.includes(r) && !counter.includes(r));
  console.log(`  HTF aligned : ${f(stats(aligned))}`);
  console.log(`  HTF counter : ${f(stats(counter))}`);
  console.log(`  HTF neutral : ${f(stats(neutral))}`);
  for (const [lab, lo, hi] of [["rsi<35", 0, 35], ["rsi35-50", 35, 50], ["rsi50-65", 50, 65], ["rsi>=65", 65, 101]] as const)
    console.log(`  ${String(lab).padEnd(12)}: ${f(stats(rows.filter((r) => r.e.rsi !== null && r.e.rsi >= lo && r.e.rsi < hi)))}`);
  for (const [lab, lo, hi] of [["00-07 UTC", 0, 7], ["07-12 UTC", 7, 12], ["12-17 UTC", 12, 17], ["17-24 UTC", 17, 24]] as const)
    console.log(`  ${String(lab).padEnd(12)}: ${f(stats(rows.filter((r) => { const h = new Date(r.e.emitted_at).getUTCHours(); return h >= lo && h < hi; })))}`);
  for (const [lab, lo, hi] of [["risk<$6", 0, 6], ["risk$6-9", 6, 9], ["risk$9-12", 9, 12], ["risk≥$12", 12, 1e9]] as const)
    console.log(`  ${String(lab).padEnd(12)}: ${f(stats(rows.filter((r) => r.risk >= lo && r.risk < hi)))}`);
  for (const [lab, lo, hi] of [["atr<4", 0, 4], ["atr4-6", 4, 6], ["atr6-9", 6, 9], ["atr≥9", 9, 1e9]] as const)
    console.log(`  ${String(lab).padEnd(12)}: ${f(stats(rows.filter((r) => r.e.atr !== null && r.e.atr >= lo && r.e.atr < hi)))}`);
  console.log(`  BUY         : ${f(stats(rows.filter((r) => r.e.direction === "BUY")))}`);
  console.log(`  SELL        : ${f(stats(rows.filter((r) => r.e.direction === "SELL")))}`);
}

main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
