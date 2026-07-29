/**
 * Forensic audit parser for the XAUUSD diagnostics export.
 *
 * Read-only analysis tool: parses a diagnostics export text file (SECTION 1
 * signal history + SECTION 4 metrics) and computes trade-level statistics
 * (session buckets, volatility regimes, confidence calibration, feature-level
 * expectancy, S/R zone evidence quality, streaks, drawdown, duration decay).
 *
 * Usage: bunx tsx expo/scripts/auditDiagnosticsReport.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';

interface ParsedZone {
  type: string;
  price: number;
  touches: number;
  reaction: number;
  confluence: number;
  source: string;
  tier: string;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  entryTime: string;
  confidence: number;
  tp: number[];
  sl: number;
  targetsHit: number;
  exitPrice: number | null;
  exitTime: string | null;
  breakevenReached: boolean;
  slMultiplier: number | null;
  volRegime: string | null;
  atr: number | null;
  features: Record<string, number>;
  zones: ParsedZone[];
}

const path = process.argv[2] ?? '/tmp/diag.txt';
const raw = readFileSync(path, 'utf8');

const section1Start = raw.indexOf('SECTION 1');
const section2Start = raw.indexOf('SECTION 2');
const body = raw.slice(section1Start, section2Start);

const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

const signals: ParsedSignal[] = [];
for (const block of blocks) {
  const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
  if (!head) continue;
  const id = block.match(/id: (\S+)/)?.[1] ?? '';
  const gen = block.match(/generated: (\S+)/)?.[1] ?? '';
  const entryTime = block.match(/entry time: (\S+)/)?.[1] ?? '';
  const conf = num(block.match(/confidence: ([\d.]+)%/)?.[1]) ?? 0;
  const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
  const targetsHit = num(block.match(/targets hit: (\d+)/)?.[1]) ?? 0;
  const exitPrice = num(block.match(/exit price: ([\d.]+)/)?.[1]);
  const exitTime = block.match(/exit time: (\S+)/)?.[1] ?? null;
  const slMult = num(block.match(/SL Multiplier: ([\d.]+)x/)?.[1]);
  const regime = block.match(/\((High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);

  const features: Record<string, number> = {};
  const fullBlock = block.match(/full attention scores \(\d+ total\):\n([\s\S]*?)(?:\n\s{4}\S|\n\n|$)/);
  if (fullBlock) {
    for (const line of fullBlock[1].split('\n')) {
      const m = line.match(/^\s+([A-Z0-9 _/-]+)=(-?[\d.]+)/);
      if (m) features[m[1].trim()] = parseFloat(m[2]);
    }
  }

  const zones: ParsedZone[] = [];
  const zoneRe = /(SUPPORT|RESISTANCE) @ ([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%\s+confluence=(\d+)\s+source=(\S+)\s+tier=(\S+)/g;
  let zm: RegExpExecArray | null;
  while ((zm = zoneRe.exec(block)) !== null) {
    zones.push({
      type: zm[1],
      price: parseFloat(zm[2]),
      touches: parseInt(zm[3], 10),
      reaction: parseInt(zm[4], 10),
      confluence: parseInt(zm[5], 10),
      source: zm[6],
      tier: zm[7],
    });
  }

  signals.push({
    index: parseInt(head[1], 10),
    direction: head[2] as 'BUY' | 'SELL',
    entry: parseFloat(head[3]),
    status: head[4],
    id,
    generatedMs: new Date(gen).getTime(),
    entryTime,
    confidence: conf,
    tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    sl: tpm ? parseFloat(tpm[4]) : 0,
    targetsHit,
    exitPrice,
    exitTime,
    breakevenReached: /breakeven reached: yes/.test(block),
    slMultiplier: slMult,
    volRegime: regime?.[1] ?? null,
    atr: num(regime?.[2]),
    features,
    zones,
  });
}

/** Signed $ move captured (positive = favourable) using exit vs entry. */
function pnlDollars(s: ParsedSignal): number | null {
  if (s.exitPrice === null) return null;
  return s.direction === 'BUY' ? s.exitPrice - s.entry : s.entry - s.exitPrice;
}

/** Initial risk in $ (entry to SL). */
function riskDollars(s: ParsedSignal): number {
  return Math.abs(s.entry - s.sl);
}

function rMultiple(s: ParsedSignal): number | null {
  const p = pnlDollars(s);
  const r = riskDollars(s);
  if (p === null || r <= 0) return null;
  return p / r;
}

function minutesInTrade(s: ParsedSignal): number | null {
  if (!s.exitTime || !s.entryTime) return null;
  const [eh, em] = s.entryTime.split(':').map(Number);
  const [xh, xm] = s.exitTime.split(':').map(Number);
  if ([eh, em, xh, xm].some((v) => !Number.isFinite(v))) return null;
  let d = xh * 60 + xm - (eh * 60 + em);
  if (d < 0) d += 24 * 60;
  return d;
}

/** Session bucket from UTC generation hour. */
function session(s: ParsedSignal): 'ASIA' | 'LONDON' | 'NY' | 'NY_PM' {
  const h = new Date(s.generatedMs).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 12) return 'LONDON';
  if (h >= 12 && h < 17) return 'NY';
  return 'NY_PM';
}

const resolved = signals.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED');

function stats(list: ParsedSignal[]) {
  const rs = list.map(rMultiple).filter((v): v is number => v !== null);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) : 0;
  const downside = losses.length > 1 ? Math.sqrt(losses.reduce((a, b) => a + (b - mean) ** 2, 0) / (losses.length - 1)) : 0;
  const dollars = list.map(pnlDollars).filter((v): v is number => v !== null);
  return {
    n: rs.length,
    winRate: rs.length ? (wins.length / rs.length) * 100 : 0,
    avgWinR: wins.length ? gross / wins.length : 0,
    avgLossR: losses.length ? -grossLoss / losses.length : 0,
    pf: grossLoss > 0 ? gross / grossLoss : Infinity,
    expectancyR: mean,
    sharpe: sd > 0 ? mean / sd : 0,
    sortino: downside > 0 ? mean / downside : 0,
    avgDollars: dollars.length ? dollars.reduce((a, b) => a + b, 0) / dollars.length : 0,
    netDollars: dollars.reduce((a, b) => a + b, 0),
  };
}

function fmt(s: ReturnType<typeof stats>): string {
  return `n=${String(s.n).padStart(3)}  WR=${s.winRate.toFixed(1).padStart(5)}%  avgW=${s.avgWinR.toFixed(2)}R  avgL=${s.avgLossR.toFixed(2)}R  PF=${(Number.isFinite(s.pf) ? s.pf.toFixed(2) : 'inf').padStart(5)}  EV=${s.expectancyR.toFixed(3).padStart(6)}R  Sharpe=${s.sharpe.toFixed(2).padStart(5)}  Sortino=${s.sortino.toFixed(2).padStart(5)}  net=$${s.netDollars.toFixed(1)}  avg=$${s.avgDollars.toFixed(2)}`;
}

function group<K extends string | number>(list: ParsedSignal[], key: (s: ParsedSignal) => K): Map<K, ParsedSignal[]> {
  const m = new Map<K, ParsedSignal[]>();
  for (const s of list) {
    const k = key(s);
    const arr = m.get(k) ?? [];
    arr.push(s);
    m.set(k, arr);
  }
  return m;
}

function report(title: string, m: Map<string | number, ParsedSignal[]>): void {
  console.log(`\n=== ${title} ===`);
  const keys = [...m.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  for (const k of keys) {
    console.log(`${String(k).padEnd(22)} ${fmt(stats(m.get(k)!))}`);
  }
}

console.log(`Parsed ${signals.length} signals; ${resolved.length} resolved with exits.`);
console.log(`\n=== OVERALL (resolved) ===\n${fmt(stats(resolved))}`);

// Status distribution
console.log('\n=== STATUS DISTRIBUTION ===');
for (const [k, v] of [...group(signals, (s) => s.status)].sort((a, b) => b[1].length - a[1].length)) {
  const st = stats(v);
  console.log(`${k.padEnd(22)} count=${String(v.length).padStart(3)}  avgR=${st.expectancyR.toFixed(3)}  avg$=${st.avgDollars.toFixed(2)}`);
}

report('SESSION', group(resolved, (s) => session(s)));
report('DIRECTION', group(resolved, (s) => s.direction));
report('VOL REGIME', group(resolved, (s) => s.volRegime ?? 'unknown'));
report('CONFIDENCE BUCKET', group(resolved, (s) => {
  const c = s.confidence;
  if (c < 80) return 'A <80';
  if (c < 85) return 'B 80-85';
  if (c < 90) return 'C 85-90';
  if (c < 93) return 'D 90-93';
  return 'E 93+';
}));
report('HOUR (UTC)', group(resolved, (s) => `h${String(new Date(s.generatedMs).getUTCHours()).padStart(2, '0')}`));
report('RISK ($ to SL)', group(resolved, (s) => {
  const r = riskDollars(s);
  if (r < 2) return 'A <2.0';
  if (r < 3) return 'B 2-3';
  if (r < 4) return 'C 3-4';
  if (r < 6) return 'D 4-6';
  return 'E 6+';
}));
report('TP1 DISTANCE ($)', group(resolved, (s) => {
  const d = Math.abs(s.tp[0] - s.entry);
  if (d < 2) return 'A <2';
  if (d < 3) return 'B 2-3';
  if (d < 5) return 'C 3-5';
  return 'D 5+';
}));
report('TIME IN TRADE (min)', group(resolved, (s) => {
  const m = minutesInTrade(s);
  if (m === null) return 'unknown';
  if (m <= 2) return 'A 0-2';
  if (m <= 5) return 'B 3-5';
  if (m <= 15) return 'C 6-15';
  if (m <= 60) return 'D 16-60';
  return 'E 60+';
}));
report('BREAKEVEN REACHED', group(resolved, (s) => (s.breakevenReached ? 'yes' : 'no')));
report('ZONE TIER', group(resolved, (s) => (s.zones.length ? s.zones[0].tier : 'none')));

// Duration: winners vs losers
const winsD = resolved.filter((s) => (rMultiple(s) ?? 0) > 0).map(minutesInTrade).filter((v): v is number => v !== null);
const lossD = resolved.filter((s) => (rMultiple(s) ?? 0) <= 0).map(minutesInTrade).filter((v): v is number => v !== null);
const med = (a: number[]): number => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
console.log('\n=== TIME-IN-TRADE DECAY ===');
console.log(`winners: n=${winsD.length} mean=${(winsD.reduce((a, b) => a + b, 0) / winsD.length).toFixed(1)}min median=${med(winsD)}min max=${Math.max(...winsD)}`);
console.log(`losers : n=${lossD.length} mean=${(lossD.reduce((a, b) => a + b, 0) / lossD.length).toFixed(1)}min median=${med(lossD)}min max=${Math.max(...lossD)}`);

// Feature-conditional expectancy
console.log('\n=== FEATURE-CONDITIONAL EXPECTANCY (present vs absent, min 15 obs) ===');
const featureNames = new Set<string>();
for (const s of resolved) for (const f of Object.keys(s.features)) featureNames.add(f);
const rows: { name: string; nP: number; wrP: number; evP: number; nA: number; wrA: number; evA: number; delta: number }[] = [];
for (const f of featureNames) {
  const present = resolved.filter((s) => s.features[f] !== undefined);
  const absent = resolved.filter((s) => s.features[f] === undefined);
  if (present.length < 15 || absent.length < 15) continue;
  const p = stats(present);
  const a = stats(absent);
  rows.push({ name: f, nP: p.n, wrP: p.winRate, evP: p.expectancyR, nA: a.n, wrA: a.winRate, evA: a.expectancyR, delta: p.expectancyR - a.expectancyR });
}
rows.sort((x, y) => y.delta - x.delta);
for (const r of rows) {
  console.log(`${r.name.padEnd(34)} present n=${String(r.nP).padStart(3)} WR=${r.wrP.toFixed(1).padStart(5)}% EV=${r.evP.toFixed(3).padStart(6)}R | absent n=${String(r.nA).padStart(3)} WR=${r.wrA.toFixed(1).padStart(5)}% EV=${r.evA.toFixed(3).padStart(6)}R | delta=${r.delta.toFixed(3)}R`);
}

// RSI LEARNED MODULATION magnitude buckets (dominant feature)
console.log('\n=== RSI LEARNED MODULATION magnitude ===');
report('RSI MOD BUCKET', group(resolved.filter((s) => s.features['RSI LEARNED MODULATION'] !== undefined), (s) => {
  const v = s.features['RSI LEARNED MODULATION'];
  if (v < 50) return 'A <50';
  if (v < 100) return 'B 50-100';
  if (v < 150) return 'C 100-150';
  return 'D 150+';
}));

// Zone evidence quality
console.log('\n=== ZONE EVIDENCE (nearest zone to entry) ===');
function nearestZone(s: ParsedSignal): ParsedZone | null {
  if (!s.zones.length) return null;
  return [...s.zones].sort((a, b) => Math.abs(a.price - s.entry) - Math.abs(b.price - s.entry))[0];
}
report('NEAREST ZONE TOUCHES', group(resolved, (s) => {
  const z = nearestZone(s);
  if (!z) return 'none';
  if (z.touches === 0) return 'A 0 touches';
  if (z.touches < 20) return 'B 1-19';
  if (z.touches < 60) return 'C 20-59';
  return 'D 60+';
}));
report('NEAREST ZONE SOURCE', group(resolved, (s) => nearestZone(s)?.source ?? 'none'));
report('NEAREST ZONE CONFLUENCE', group(resolved, (s) => `conf=${nearestZone(s)?.confluence ?? 'none'}`));

// Zone touch saturation diagnostics
const allZones = resolved.flatMap((s) => s.zones);
const touchCounts = allZones.map((z) => z.touches);
const at100 = touchCounts.filter((t) => t >= 100).length;
const at0 = touchCounts.filter((t) => t === 0).length;
console.log(`\nzone rows=${allZones.length} touches==0: ${at0} (${((at0 / allZones.length) * 100).toFixed(1)}%)  touches>=100: ${at100} (${((at100 / allZones.length) * 100).toFixed(1)}%)`);
const react100 = allZones.filter((z) => z.reaction >= 100).length;
console.log(`reaction==100%: ${react100} (${((react100 / allZones.length) * 100).toFixed(1)}%)  reaction==0%: ${allZones.filter((z) => z.reaction === 0).length}`);

// Streaks + drawdown in R, chronological (oldest first)
const chrono = [...resolved].sort((a, b) => a.generatedMs - b.generatedMs);
let equity = 0;
let peak = 0;
let maxDD = 0;
let curWin = 0;
let curLoss = 0;
let maxWinStreak = 0;
let maxLossStreak = 0;
const equityCurve: number[] = [];
for (const s of chrono) {
  const r = rMultiple(s);
  if (r === null) continue;
  equity += r;
  equityCurve.push(equity);
  peak = Math.max(peak, equity);
  maxDD = Math.max(maxDD, peak - equity);
  if (r > 0) {
    curWin += 1;
    curLoss = 0;
    maxWinStreak = Math.max(maxWinStreak, curWin);
  } else {
    curLoss += 1;
    curWin = 0;
    maxLossStreak = Math.max(maxLossStreak, curLoss);
  }
}
console.log('\n=== EQUITY / STREAKS (R units, chronological) ===');
console.log(`final equity=${equity.toFixed(2)}R  maxDD=${maxDD.toFixed(2)}R  maxWinStreak=${maxWinStreak}  maxLossStreak=${maxLossStreak}`);

// Loss clustering: are losses autocorrelated?
const seq = chrono.map((s) => ((rMultiple(s) ?? 0) > 0 ? 1 : 0));
let lossAfterLoss = 0;
let lossTotalPrev = 0;
let lossAfterWin = 0;
let winTotalPrev = 0;
for (let i = 1; i < seq.length; i += 1) {
  if (seq[i - 1] === 0) {
    lossTotalPrev += 1;
    if (seq[i] === 0) lossAfterLoss += 1;
  } else {
    winTotalPrev += 1;
    if (seq[i] === 0) lossAfterWin += 1;
  }
}
console.log(`P(loss | prev loss)=${((lossAfterLoss / lossTotalPrev) * 100).toFixed(1)}%  P(loss | prev win)=${((lossAfterWin / winTotalPrev) * 100).toFixed(1)}%  baseline P(loss)=${((seq.filter((v) => v === 0).length / seq.length) * 100).toFixed(1)}%`);

// Signals per day + clustering
const perDay = group(chrono, (s) => new Date(s.generatedMs).toISOString().slice(0, 10));
console.log('\n=== SIGNALS PER DAY ===');
for (const [d, list] of [...perDay].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  console.log(`${d}  count=${String(list.length).padStart(3)}  ${fmt(stats(list))}`);
}

// Inter-signal spacing
const gaps: number[] = [];
for (let i = 1; i < chrono.length; i += 1) gaps.push((chrono[i].generatedMs - chrono[i - 1].generatedMs) / 60000);
gaps.sort((a, b) => a - b);
console.log(`\ninter-signal gap min: median=${med(gaps).toFixed(1)} p10=${gaps[Math.floor(gaps.length * 0.1)].toFixed(1)} p90=${gaps[Math.floor(gaps.length * 0.9)].toFixed(1)}  gaps<=2min: ${gaps.filter((g) => g <= 2).length}`);

// Target realism: how often is TP3 (max target) reached vs the stated 100-pip ambition
const tpDistances = resolved.map((s) => Math.abs(s.tp[2] - s.entry));
console.log(`\nTP3 distance $: mean=${(tpDistances.reduce((a, b) => a + b, 0) / tpDistances.length).toFixed(2)} median=${med(tpDistances).toFixed(2)} max=${Math.max(...tpDistances).toFixed(2)}  (100 pip target = $10.00)`);
const rrr = resolved.map((s) => Math.abs(s.tp[2] - s.entry) / riskDollars(s));
console.log(`TP3 RRR: mean=${(rrr.reduce((a, b) => a + b, 0) / rrr.length).toFixed(2)} median=${med(rrr).toFixed(2)}`);
const rrr1 = resolved.map((s) => Math.abs(s.tp[0] - s.entry) / riskDollars(s));
console.log(`TP1 RRR: mean=${(rrr1.reduce((a, b) => a + b, 0) / rrr1.length).toFixed(2)} median=${med(rrr1).toFixed(2)}`);

// Spread/slippage sensitivity: what happens to EV with a 0.20/0.35/0.50 spread charge
console.log('\n=== SPREAD SENSITIVITY (charge applied per trade, $) ===');
for (const spread of [0, 0.15, 0.25, 0.35, 0.5]) {
  const adj = resolved.map((s) => {
    const p = pnlDollars(s);
    return p === null ? null : (p - spread) / riskDollars(s);
  }).filter((v): v is number => v !== null);
  const mean = adj.reduce((a, b) => a + b, 0) / adj.length;
  const wins = adj.filter((r) => r > 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(adj.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
  console.log(`spread=$${spread.toFixed(2)}  EV=${mean.toFixed(3)}R  PF=${(gross / grossLoss).toFixed(2)}  WR=${((wins.length / adj.length) * 100).toFixed(1)}%  net$=${(resolved.reduce((a, s) => a + ((pnlDollars(s) ?? 0) - spread), 0)).toFixed(1)}`);
}

// SL_AFTER_BE forensic: how much was left on the table
const beTrades = resolved.filter((s) => s.status === 'SL_AFTER_BE');
console.log(`\n=== SL_AFTER_BE (${beTrades.length} trades) ===`);
const beR = beTrades.map(rMultiple).filter((v): v is number => v !== null);
console.log(`mean R=${(beR.reduce((a, b) => a + b, 0) / beR.length).toFixed(3)}  mean $=${(beTrades.reduce((a, s) => a + (pnlDollars(s) ?? 0), 0) / beTrades.length).toFixed(2)}  positive=${beR.filter((r) => r > 0).length}/${beR.length}`);

const partial = resolved.filter((s) => s.status === 'PARTIAL_WIN_SL_HIT');
const pR = partial.map(rMultiple).filter((v): v is number => v !== null);
console.log(`PARTIAL_WIN_SL_HIT (${partial.length}): mean R=${(pR.reduce((a, b) => a + b, 0) / pR.length).toFixed(3)} positive=${pR.filter((r) => r > 0).length}/${pR.length}`);
const allT = resolved.filter((s) => s.status === 'ALL_TARGETS_HIT');
const aR = allT.map(rMultiple).filter((v): v is number => v !== null);
console.log(`ALL_TARGETS_HIT   (${allT.length}): mean R=${(aR.reduce((a, b) => a + b, 0) / aR.length).toFixed(3)} min=${Math.min(...aR).toFixed(2)} max=${Math.max(...aR).toFixed(2)}`);
const slH = resolved.filter((s) => s.status === 'SL_HIT');
const sR = slH.map(rMultiple).filter((v): v is number => v !== null);
console.log(`SL_HIT            (${slH.length}): mean R=${(sR.reduce((a, b) => a + b, 0) / sR.length).toFixed(3)} worst=${Math.min(...sR).toFixed(2)}  |R|>1.05: ${sR.filter((r) => r < -1.05).length}`);
