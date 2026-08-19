/**
 * ITEMS 159 / 160 / 161 — THE STRATEGIC ROUND, one command.
 *
 * 159(c) LIVE book + 95% CI at current n. 159(d) sample size + calendar date at
 *       which LIVE vs BACKFILL become distinguishable at 95%.
 * 159(e) how many rows (per era) were generated under the CURRENT gate config
 *       (all four suppressive gates introduced 2026-08-18, git -S verified).
 * 159(a) structural field availability per era (ATR, zone snapshot, attention).
 * 160(a) OB-present vs OB-absent re-measured on the CURRENT construct
 *       (marketStructure.computeMarketStructure + findNearbyUnmitigatedOBs over
 *       24h of gold_m1_bars, proximity 3·ATR, min 21 bars) — n/WR/EV/PF/CIs.
 * 161(b,c) attention features vs canonical realised R, HELD-OUT (fit early
 *       window, score late window), display→key map INVERTED FROM THE GENERATOR
 *       (signalEngine.ts:8477/:8489: key.replace(/_/g,' ').toUpperCase()).
 *
 * MEASUREMENT ONLY. DATA: emitted_signals_v1 + trade_outcomes_v1 + gold_m1_bars
 * via anon key, Supabase DIRECT.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { computeMarketStructure, findNearbyUnmitigatedOBs } from '../services/marketStructure';

function loadEnv() {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

/** The generator at signalEngine.ts:8477/:8489 is display = key.replace(/_/g,' ').toUpperCase(). Inverse: */
const displayToKey = (display: string): string => display.toLowerCase().replace(/ /g, '_');

const GATES_LIVE_AT = new Date('2026-08-18T00:00:00Z'); // all four gates introduced this date (git -S)
const RATE_PER_DAY = 7.29;

interface SigRow {
  signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL';
  entry: number; sl: number; atr: number | null; source: string;
  sr_zones_snapshot: unknown; attention_scores: { feature: string; score: number; signedScore: number }[] | null;
  confidence: number | null;
}
interface OutcomeRow { signal_id: string; realized_r: number | null; }
interface BarRow { timestamp: number | string; open: number; high: number; low: number; close: number; }

async function fetchAll<T>(table: string, select: string, orderBy: string, extra?: { column: string; gte?: string; lte?: string }): Promise<T[]> {
  const out: T[] = []; const PAGE = 1000; let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(select).order(orderBy, { ascending: true }).range(offset, offset + PAGE - 1);
    if (extra?.gte) q = q.gte(extra.column, extra.gte);
    if (extra?.lte) q = q.lte(extra.column, extra.lte);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < PAGE) break;
    offset += PAGE; if (offset > 200000) break;
  }
  return out;
}

function stats(rs: number[]) {
  const n = rs.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0, half: NaN, wr: 0, pf: NaN };
  const mean = rs.reduce((s, r) => s + r, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? 1.96 * (sd / Math.sqrt(n)) : NaN;
  const wr = (rs.filter((r) => r > 0).length / n) * 100;
  const wins = rs.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const losses = -rs.filter((r) => r < 0).reduce((s, r) => s + r, 0);
  return { n, mean, sd, half, wr, pf: losses > 0 ? wins / losses : Number.POSITIVE_INFINITY };
}
const fmt = (s: ReturnType<typeof stats>) =>
  `n=${s.n} WR=${s.wr.toFixed(1)}% EV_net=${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(4)}R CI=[${(s.mean - (Number.isFinite(s.half) ? s.half : 0)).toFixed(4)},${(s.mean + (Number.isFinite(s.half) ? s.half : 0)).toFixed(4)}] PF=${Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf'}`;

function welch(a: number[], b: number[]) {
  const sa = stats(a), sb = stats(b);
  if (sa.n < 2 || sb.n < 2) return { t: NaN, p: NaN };
  const se = Math.sqrt(sa.sd ** 2 / sa.n + sb.sd ** 2 / sb.n);
  const t = (sa.mean - sb.mean) / se;
  // normal-approx p (two-sided); n small — reported as guidance only
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { t, p };
}
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x: number): number {
  const s = Math.sign(x); x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return s * y;
}

async function main() {
  console.log(`ROUND 159/160/161 — ${new Date().toISOString()}`);
  const signals = await fetchAll<SigRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, entry, sl, atr, source, sr_zones_snapshot, attention_scores, confidence', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, realized_r', 'signal_id');
  const byId = new Map(outcomes.map((o) => [o.signal_id, o]));
  console.log(`signals=${signals.length} outcomes=${outcomes.length}`);

  // resolved canonical book
  const book = signals
    .map((s) => ({ s, r: byId.get(s.signal_id)?.realized_r ?? null }))
    .filter((x) => x.r !== null && Number.isFinite(Math.abs(x.s.entry - x.s.sl)) && Math.abs(x.s.entry - x.s.sl) > 0);
  const live = book.filter((x) => x.s.source === 'LIVE');
  const backfill = book.filter((x) => x.s.source !== 'LIVE');
  const rOf = (x: { r: number | null }) => x.r as number;

  // ── 159(c) LIVE book + CI ──
  console.log('\n== 159(c) ERA BOOKS ==');
  console.log(`LIVE     ${fmt(stats(live.map(rOf)))}`);
  console.log(`BACKFILL ${fmt(stats(backfill.map(rOf)))}`);
  console.log(`ALL      ${fmt(stats(book.map(rOf)))}`);

  // ── 159(d) distinguishing n/date ──
  console.log('\n== 159(d) DISTINGUISHING SAMPLE SIZE ==');
  const bStat = stats(backfill.map(rOf));
  const lStat = stats(live.map(rOf));
  // n at which LIVE CI excludes the BACKFILL mean (if LIVE mean stays put)
  const nExcludeBackfillMean = lStat.sd > 0 ? Math.ceil((1.96 * lStat.sd / Math.abs(lStat.mean - bStat.mean)) ** 2) : NaN;
  // n at which the DIFFERENCE (Welch) reaches |t|>=2 assuming current means/sds
  const seN = (n: number) => Math.sqrt(lStat.sd ** 2 / n + bStat.sd ** 2 / bStat.n);
  let nWelch = NaN;
  if (lStat.sd > 0 && bStat.sd > 0) {
    for (let n = Math.max(lStat.n, 2); n <= 100000; n++) {
      if (Math.abs(lStat.mean - bStat.mean) / seN(n) >= 2) { nWelch = n; break; }
    }
  }
  const eta = (n: number) => new Date(Date.now() + ((n - lStat.n) / RATE_PER_DAY) * 86400000).toISOString().slice(0, 10);
  console.log(`LIVE EV_net=${lStat.mean.toFixed(4)}R sd=${lStat.sd.toFixed(4)}R; BACKFILL EV_net=${bStat.mean.toFixed(4)}R (n=${bStat.n})`);
  console.log(`n for LIVE CI to exclude BACKFILL mean: ${nExcludeBackfillMean} (ETA ${Number.isFinite(nExcludeBackfillMean) ? eta(nExcludeBackfillMean) : '?'})`);
  console.log(`n for Welch |t|>=2 at current means/sds: ${nWelch} (ETA ${Number.isFinite(nWelch) ? eta(nWelch) : '?'})`);
  console.log(`rate assumed ${RATE_PER_DAY}/day`);

  // ── 159(e) rows under CURRENT gate config ──
  console.log('\n== 159(e) ROWS UNDER CURRENT GATE CONFIG (all gates live 2026-08-18) ==');
  for (const [label, arr] of [['LIVE', live], ['BACKFILL', backfill]] as const) {
    const cur = arr.filter((x) => new Date(x.s.emitted_at) >= GATES_LIVE_AT);
    console.log(`${label}: total=${arr.length} emitted>=2026-08-18=${cur.length} resolved=${cur.length}`);
  }
  const liveCurrent = live.filter((x) => new Date(x.s.emitted_at) >= GATES_LIVE_AT);
  if (liveCurrent.length > 0) console.log(`LIVE under current gates book: ${fmt(stats(liveCurrent.map(rOf)))}`);

  // ── 159(a) structural availability per era ──
  console.log('\n== 159(a) STRUCTURAL FIELD AVAILABILITY ==');
  for (const [label, arr] of [['LIVE', signals.filter((s) => s.source === 'LIVE')], ['BACKFILL', signals.filter((s) => s.source !== 'LIVE')]] as const) {
    const n = arr.length || 1;
    const pct = (f: (s: SigRow) => boolean) => `${(arr.filter(f).length / n * 100).toFixed(1)}%`;
    console.log(`${label} (emitted n=${arr.length}): atr_present=${pct((s) => s.atr !== null && s.atr !== undefined)} zones_snapshot_present=${pct((s) => !!s.sr_zones_snapshot)} attention_present=${pct((s) => Array.isArray(s.attention_scores) && s.attention_scores.length > 0)}`);
    console.log(`  span: ${arr[0]?.emitted_at} → ${arr[arr.length - 1]?.emitted_at}`);
  }

  // ── 160(a) OB re-measurement ──
  console.log('\n== 160(a) OB PRESENT vs ABSENT — CURRENT CONSTRUCT ==');
  const barStart = Math.floor(new Date(book[0].s.emitted_at).getTime() / 60000) * 60000 - 24 * 3600000;
  const barEnd = new Date(book[book.length - 1].s.emitted_at).getTime();
  console.log(`fetching gold_m1_bars ${new Date(barStart).toISOString()} → ${new Date(barEnd).toISOString()} ...`);
  const bars = await fetchAll<BarRow>('gold_m1_bars', 'timestamp, open, high, low, close', 'timestamp', { column: 'timestamp', gte: new Date(barStart).toISOString(), lte: new Date(barEnd).toISOString() });
  console.log(`bars fetched: ${bars.length} (span ${bars[0] ? new Date(bars[0].timestamp).toISOString() : '-'} → ${bars.length ? new Date(bars[bars.length - 1].timestamp).toISOString() : '-'})`);
  const barsByMin = new Map<number, BarRow>();
  for (const b of bars) barsByMin.set(new Date(b.timestamp).getTime(), b);

  const obPresent: number[] = []; const obAbsent: number[] = []; let obAbstain = 0; let obNoBars = 0;
  for (const x of book) {
    const t = new Date(x.s.emitted_at).getTime();
    const win: BarRow[] = [];
    for (let m = t - 24 * 3600000; m <= t; m += 60000) {
      const b = barsByMin.get(Math.floor(m / 60000) * 60000);
      if (b) win.push(b);
    }
    if (win.length < 21) { obNoBars++; continue; }
    const atr = x.s.atr ?? (win.length >= 15 ? atr14(win) : null);
    if (!atr || atr <= 0) { obAbstain++; continue; }
    const structure = computeMarketStructure(win as never);
    const near = findNearbyUnmitigatedOBs(structure, x.s.entry, atr, 3);
    (near.length > 0 ? obPresent : obAbsent).push(rOf(x));
  }
  console.log(`POWER FIRST: OB-present n=${obPresent.length}, OB-absent n=${obAbsent.length}, abstain(no ATR)=${obAbstain}, no-bars(<21)=${obNoBars}`);
  const sp = stats(obPresent), sa2 = stats(obAbsent);
  console.log(`OB-present ${fmt(sp)}`);
  console.log(`OB-absent  ${fmt(sa2)}`);
  const w = welch(obPresent, obAbsent);
  console.log(`Welch t=${w.t.toFixed(3)} p≈${w.p.toFixed(4)} (normal approx)`);
  const excludesZero = Number.isFinite(w.p) && w.p < 0.05;
  console.log(`PRE-REGISTERED GATE 160(c): split excludes zero at 95%? ${excludesZero ? 'YES — hold filter' : 'NO — RELAX to confidence penalty'}`);

  // ── 161(b,c) attention held-out ──
  console.log('\n== 161(b,c) ATTENTION FEATURES vs REALISED R — HELD-OUT ==');
  const withAtt = book.filter((x) => Array.isArray(x.s.attention_scores) && x.s.attention_scores.length > 0);
  console.log(`resolved rows with attention_scores: ${withAtt.length}/${book.length}`);
  if (withAtt.length >= 20) {
    withAtt.sort((a, b) => new Date(a.s.emitted_at).getTime() - new Date(b.s.emitted_at).getTime());
    const mid = Math.floor(withAtt.length / 2);
    const early = withAtt.slice(0, mid), late = withAtt.slice(mid);
    console.log(`time split: fit n=${early.length} (${early[0].s.emitted_at}→${early[mid-1].s.emitted_at}) | held-out n=${late.length} (${late[0].s.emitted_at}→${late[late.length-1].s.emitted_at})`);
    const keys = new Set<string>();
    for (const x of withAtt) for (const f of x.s.attention_scores!) keys.add(displayToKey(f.feature));
    console.log(`features found (inverted from generator): ${[...keys].join(', ')}`);
    const rows: { key: string; nE: number; rE: number; nL: number; rL: number; ciLo: number; ciHi: number }[] = [];
    for (const key of keys) {
      const pair = (arr: typeof withAtt) => {
        const pts: [number, number][] = [];
        for (const x of arr) {
          const f = x.s.attention_scores!.find((f2) => displayToKey(f2.feature) === key);
          if (f) pts.push([f.signedScore / 100, rOf(x)]);
        }
        return pts;
      };
      const pe = pair(early), pl = pair(late);
      const rE = pearson(pe), rL = pearson(pl);
      const ci = fisherCI(rL, pl.length);
      rows.push({ key, nE: pe.length, rE, nL: pl.length, rL, ciLo: ci[0], ciHi: ci[1] });
    }
    rows.sort((a, b) => a.rL - b.rL);
    console.log('feature                                n_fit  r_fit   n_held  r_held  95%CI(held)      verdict');
    for (const r of rows) {
      const verdict = r.ciLo > 0 ? 'PREDICTIVE' : r.ciHi < 0 ? 'ANTI-PREDICTIVE' : 'INDETERMINATE';
      console.log(`${r.key.padEnd(38)} ${String(r.nE).padStart(5)} ${r.rE.toFixed(3).padStart(7)} ${String(r.nL).padStart(7)} ${r.rL.toFixed(3).padStart(7)}  [${r.ciLo.toFixed(3)},${r.ciHi.toFixed(3)}]  ${verdict}`);
    }
    const anti = rows.filter((r) => r.ciHi < 0);
    console.log(`161(d) flags to ship: ${anti.length === 0 ? 'NONE qualify (no negative held-out r with CI excluding zero)' : anti.map((r) => r.key).join(', ')}`);
  } else {
    console.log('BLOCKER: fewer than 20 resolved rows carry attention_scores — held-out split impossible on the canonical book.');
  }
}

function atr14(bars: BarRow[]): number {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  return trs.reduce((s, x) => s + x, 0) / trs.length;
}
function pearson(pts: [number, number][]): number {
  const n = pts.length; if (n < 3) return NaN;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}
function fisherCI(r: number, n: number): [number, number] {
  if (!Number.isFinite(r) || n < 4) return [NaN, NaN];
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const se = 1 / Math.sqrt(n - 3);
  const inv = (v: number) => (Math.exp(2 * v) - 1) / (Math.exp(2 * v) + 1);
  return [inv(z - 1.96 * se), inv(z + 1.96 * se)];
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
