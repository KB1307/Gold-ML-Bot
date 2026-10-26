/**
 * META-LABELING WALK-FORWARD TEST (read-only, anon key, no table writes).
 *
 * Measures BEFORE building: can a classifier trained on the features stored at
 * emission time (rsi, hour, direction, htf alignment, risk$, sl_multiplier)
 * predict P(win) well enough that SKIPPING its lowest-confidence signals raises
 * $/day? Strictly walk-forward: for each test block of 40 signals the model is
 * fit ONLY on signals emitted before the block (expanding window, min 150).
 *
 * Model: L2-regularised logistic regression (gradient descent, standardised
 * features). Deliberately simple — 553 rows cannot support anything heavier
 * without overfitting; a tree ensemble on this n would mostly fit noise.
 *
 * Output: out-of-sample accuracy vs the base rate, AUC, and the $/day of the
 * book when the bottom 20% / 33% / 50% of P(win) is skipped, vs unfiltered.
 *
 * Run: cd expo && bun scripts/measure_metalabel_walkforward.ts
 */
import { createClient } from "@supabase/supabase-js";

type Emit = {
  signal_id: string; emitted_at: string; direction: string; entry: number; sl: number;
  atr: number | null; htf_trend: string | null; rsi: number | null; sl_multiplier: number | null;
};
type Outcome = { signal_id: string; realized_r: number | null };

async function pageAll<T>(q: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw error;
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

type Row = { x: number[]; y: number; usd: number; day: string; t: number };

function featurize(e: Emit): number[] | null {
  // atr is only persisted since 2026-08-13 (165/578 rows) — excluded so the
  // full book is usable; |entry−sl| (risk$) is the ATR proxy (sl scales with ATR).
  if (e.rsi === null) return null;
  const h = new Date(e.emitted_at).getUTCHours() + new Date(e.emitted_at).getUTCMinutes() / 60;
  const dir = e.direction === "BUY" ? 1 : -1;
  const htf = e.htf_trend === "BULLISH" ? 1 : e.htf_trend === "BEARISH" ? -1 : 0;
  return [
    e.rsi,
    (e.rsi - 50) * dir, // side-relative RSI
    Math.sin((2 * Math.PI * h) / 24),
    Math.cos((2 * Math.PI * h) / 24),
    dir,
    htf * dir, // alignment: +1 with-trend, -1 counter, 0 neutral
    Math.abs(e.entry - e.sl),
    e.sl_multiplier ?? 1,
  ];
}

function fitLogistic(X: number[][], y: number[], lambda = 1.0, iters = 1500, lr = 0.05) {
  const d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    mu[j] = X.reduce((a, r) => a + r[j], 0) / X.length;
    sd[j] = Math.sqrt(X.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / X.length) || 1;
  }
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const w = Array(d).fill(0); let b = 0;
  const n = Z.length;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i].reduce((a, v, j) => a + v * w[j], b);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda / n) * w[j]);
    b -= lr * (gb / n);
  }
  return (x: number[]) => {
    const z = x.reduce((a, v, j) => a + ((v - mu[j]) / sd[j]) * w[j], b);
    return 1 / (1 + Math.exp(-z));
  };
}

function auc(scores: number[], labels: number[]) {
  const pos = scores.filter((_, i) => labels[i] === 1), neg = scores.filter((_, i) => labels[i] === 0);
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return pos.length && neg.length ? s / (pos.length * neg.length) : NaN;
}

function perDay(rows: Row[], keep: boolean[]) {
  const m = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) if (keep[i]) m.set(rows[i].day, (m.get(rows[i].day) ?? 0) + rows[i].usd);
  const allDays = new Set(rows.map((r) => r.day));
  const vals = [...allDays].map((d) => m.get(d) ?? 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, vals.length - 1));
  return { days: vals.length, mean, sd, se: sd / Math.sqrt(vals.length), total: vals.reduce((a, b) => a + b, 0) };
}

async function main() {
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
  const emits = await pageAll<Emit>((a, b) =>
    client.from("emitted_signals_v1").select("signal_id,emitted_at,direction,entry,sl,atr,htf_trend,rsi,sl_multiplier").order("emitted_at", { ascending: true }).range(a, b));
  const outs = await pageAll<Outcome>((a, b) => client.from("trade_outcomes_v1").select("signal_id,realized_r").range(a, b));
  const byId = new Map(outs.map((o) => [o.signal_id, o.realized_r]));

  const rows: Row[] = [];
  for (const e of emits) {
    const r = byId.get(e.signal_id);
    const x = featurize(e);
    if (r === undefined || r === null || !Number.isFinite(r) || !x) continue;
    rows.push({ x, y: r > 0 ? 1 : 0, usd: r * Math.abs(e.entry - e.sl), day: e.emitted_at.slice(0, 10), t: Date.parse(e.emitted_at) });
  }
  console.log(`rows with features+outcome: ${rows.length} (base win rate ${(rows.reduce((a, r) => a + r.y, 0) / rows.length * 100).toFixed(1)}%)`);

  const MIN_TRAIN = 150, BLOCK = 40;
  const pred = new Array<number>(rows.length).fill(NaN);
  for (let start = MIN_TRAIN; start < rows.length; start += BLOCK) {
    const tr = rows.slice(0, start);
    const model = fitLogistic(tr.map((r) => r.x), tr.map((r) => r.y));
    for (let i = start; i < Math.min(rows.length, start + BLOCK); i++) pred[i] = model(rows[i].x);
  }
  const oos = rows.map((r, i) => ({ r, p: pred[i] })).filter((z) => Number.isFinite(z.p));
  const labels = oos.map((z) => z.r.y), scores = oos.map((z) => z.p);
  const base = labels.reduce((a, b) => a + b, 0) / labels.length;
  const acc = oos.filter((z) => (z.p >= 0.5 ? 1 : 0) === z.r.y).length / oos.length;
  const majority = Math.max(base, 1 - base);
  // binomial SE for accuracy
  const se = Math.sqrt(majority * (1 - majority) / oos.length);
  console.log(`\nOUT-OF-SAMPLE (${oos.length} signals, walk-forward blocks of ${BLOCK}, min train ${MIN_TRAIN}):`);
  console.log(`  accuracy @0.5 = ${(acc * 100).toFixed(1)}%  vs majority-class ${(majority * 100).toFixed(1)}%  (SE ±${(se * 100).toFixed(1)}pp)  → z=${((acc - majority) / se).toFixed(2)}`);
  console.log(`  AUC = ${auc(scores, labels).toFixed(3)}  (0.500 = no ranking power)`);

  // calibration deciles
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  console.log("  P(win) quintiles (predicted → realised WR, EV$/trade):");
  for (let q = 0; q < 5; q++) {
    const sl = idx.slice(Math.floor((q * idx.length) / 5), Math.floor(((q + 1) * idx.length) / 5));
    const wr = sl.reduce((a, i) => a + labels[i], 0) / sl.length;
    const ev = sl.reduce((a, i) => a + oos[i].r.usd, 0) / sl.length;
    const pm = sl.reduce((a, i) => a + scores[i], 0) / sl.length;
    console.log(`    Q${q + 1} pred=${(pm * 100).toFixed(1)}% → WR=${(wr * 100).toFixed(1)}%  EV=$${ev.toFixed(2)}  n=${sl.length}`);
  }

  const oosRows = oos.map((z) => z.r);
  const all = perDay(oosRows, oosRows.map(() => true));
  console.log(`\n$/DAY ON THE OOS WINDOW (${all.days} days):`);
  console.log(`  unfiltered       : mean $${all.mean.toFixed(2)}/day ±$${all.se.toFixed(2)} (se)  total $${all.total.toFixed(0)}`);
  for (const skip of [0.2, 0.33, 0.5]) {
    const cut = scores.slice().sort((a, b) => a - b)[Math.floor(scores.length * skip)];
    const keep = scores.map((s) => s >= cut);
    const st = perDay(oosRows, keep);
    const kept = keep.filter(Boolean).length;
    console.log(`  skip bottom ${(skip * 100).toFixed(0).padStart(2)}%  : mean $${st.mean.toFixed(2)}/day ±$${st.se.toFixed(2)}  total $${st.total.toFixed(0)}  (kept ${kept}/${scores.length}, Δ vs unfiltered $${(st.mean - all.mean).toFixed(2)}/day)`);
  }

  // power statement for the $/day target
  const need = (delta: number) => Math.ceil(2 * ((1.96 + 0.84) * all.sd / delta) ** 2);
  console.log(`\nPOWER: daily sd ≈ $${all.sd.toFixed(1)}. Detecting a +$3.3/day shift ($1.7 → $5) at 80% power / α 0.05 needs ≈ ${need(3.3)} trading days per arm; +$8 needs ≈ ${need(8)}.`);
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
