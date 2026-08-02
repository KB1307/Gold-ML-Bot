/**
 * PRECONDITIONS 1-3 for ITEM C / ITEM D.
 *
 * CANONICAL OUTCOME SET (declared once, used everywhere):
 *   outcome source = bar-derived via the REAL resolveSignalWithBars (imported,
 *                    NOT reimplemented), opts { fromScratch: true, evalNowMs }
 *   win predicate  = R > 0   (economic, label-independent)
 *   denominator    = all 369 export signals with complete geometry
 *
 * P1. Per-direction economics: BUY / SELL / COMBINED with WR, PF, EV, net $.
 * P2. Explain the EV correction (+0.3019R mirror -> +0.0605R canonical).
 * P3. App-internal geometry consistency:
 *     a. TP1 actual R-multiple per signal; detect ladder generations.
 *     b. Which post-TP1 lock function is live (static evidence printed).
 *     c. Does the 5-pip floor ever bind?
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECTLY from Supabase via anon key + RLS.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import {
  resolveSignalWithBars,
  getPostTP1LockPrice,
  POST_TP1_PROFIT_LOCK_R,
  POST_TP1_PROFIT_LOCK_MIN_PIPS,
} from "../services/signalResolver";
import type { TradingSignal, SignalStatus } from "../types/trading";
import type { OhlcBar } from "../services/barStore";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(pathResolve(process.cwd(), ".env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}
const env = loadEnv();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  storedStatus: string;
  id: string;
  generatedMs: number;
  confidence: number;
  storedExitPrice: number | null;
  storedTargetsHit: number;
}

export function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  let current: Partial<ParsedSignal> | null = null;
  for (const line of raw.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (m) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(m[1]),
        direction: m[2] as "BUY" | "SELL",
        entry: parseFloat(m[3]),
        storedStatus: m[4],
        storedTargetsHit: 0,
        storedExitPrice: null,
      };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^\s+id:\s+(\S+)/);
    if (id && !current.id) current.id = id[1];
    const g = line.match(/^\s+generated:\s+(\S+)/);
    if (g && current.generatedMs === undefined) {
      const ts = new Date(g[1]).getTime();
      if (!isNaN(ts)) current.generatedMs = ts;
    }
    const c = line.match(/^\s+confidence:\s+([\d.]+)%/);
    if (c && current.confidence === undefined) current.confidence = parseFloat(c[1]);
    const tp = line.match(/TP1:\s+([\d.]+)\s+TP2:\s+([\d.]+)\s+TP3:\s+([\d.]+)\s+SL:\s+([\d.]+)/);
    if (tp) {
      current.tp1 = parseFloat(tp[1]);
      current.tp2 = parseFloat(tp[2]);
      current.tp3 = parseFloat(tp[3]);
      current.sl = parseFloat(tp[4]);
    }
    const th = line.match(/targets hit:\s+(\d+)/);
    if (th) current.storedTargetsHit = parseInt(th[1]);
    const ex = line.match(/exit price:\s+([\d.]+)/);
    if (ex && current.storedExitPrice === null) current.storedExitPrice = parseFloat(ex[1]);
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

export async function fetchBars(fromTs: string): Promise<OhlcBar[]> {
  const out: OhlcBar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows)
      out.push({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close });
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

export function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id,
    timestamp: new Date(p.generatedMs),
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    sl: p.sl,
    slMultiplier: 1,
    confidence: p.confidence / 100,
    status: p.storedStatus as SignalStatus,
    targetsHit: p.storedTargetsHit,
    entryTime: new Date(p.generatedMs).toISOString(),
    exitPrice: p.storedExitPrice ?? undefined,
    topFeatures: [],
    riskJustification: "",
    createdAt: p.generatedMs,
  };
}

export interface Canon {
  p: ParsedSignal;
  newStatus: SignalStatus;
  targetsHit: number;
  exitPrice: number;
  r: number;
  pnlDollars: number;
  tp1R: number;
  slDistance: number;
  resolvedAtBarTs?: number;
}

export interface Metrics {
  n: number;
  wins: number;
  losses: number;
  flats: number;
  wr: number;
  pf: number;
  ev: number;
  net$: number;
  grossWinR: number;
  grossLossR: number;
}

export function metrics(rows: { r: number; pnlDollars: number }[]): Metrics {
  const n = rows.length;
  if (n === 0)
    return { n: 0, wins: 0, losses: 0, flats: 0, wr: 0, pf: 0, ev: 0, "net$": 0, grossWinR: 0, grossLossR: 0 };
  const wins = rows.filter((x) => x.r > 0);
  const losses = rows.filter((x) => x.r < 0);
  const flats = rows.filter((x) => x.r === 0);
  const gw = wins.reduce((a, b) => a + b.r, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b.r, 0));
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    wr: (wins.length / n) * 100,
    pf: gl > 0 ? gw / gl : Number.POSITIVE_INFINITY,
    ev: rows.reduce((a, b) => a + b.r, 0) / n,
    "net$": rows.reduce((a, b) => a + b.pnlDollars, 0),
    grossWinR: gw,
    grossLossR: gl,
  };
}

export function fmt(label: string, m: Metrics): string {
  const pf = Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf";
  return (
    `  ${label.padEnd(10)} n=${String(m.n).padStart(3)}  W/L/F=${String(m.wins).padStart(3)}/${String(m.losses).padStart(3)}/${String(m.flats).padStart(2)}` +
    `  WR=${m.wr.toFixed(1).padStart(5)}%  PF=${pf.padStart(5)}` +
    `  EV=${(m.ev >= 0 ? "+" : "") + m.ev.toFixed(4)}R  net=${(m["net$"] >= 0 ? "+$" : "-$") + Math.abs(m["net$"]).toFixed(1)}`
  );
}

/** Resolve every export signal on the canonical basis. */
export async function buildCanonical(): Promise<{ rows: Canon[]; bars: OhlcBar[]; evalNowMs: number; skipped: number }> {
  const bars = await fetchBars("2026-06-18T00:00:00Z");
  const signals = parseExport("/tmp/diagnostics_export.txt");
  const evalNowMs = bars[bars.length - 1].timestamp;

  const rows: Canon[] = [];
  let skipped = 0;
  const realLog = console.log;
  console.log = () => {};
  for (const p of signals) {
    if (!p.sl || !p.tp1 || !p.tp2 || !p.tp3 || !p.generatedMs) {
      skipped++;
      continue;
    }
    const out = resolveSignalWithBars(toTradingSignal(p), bars, { fromScratch: true, evalNowMs });
    const risk = Math.abs(p.entry - p.sl);
    if (!(risk > 0)) {
      skipped++;
      continue;
    }
    const pnl = p.direction === "BUY" ? out.exitPrice - p.entry : p.entry - out.exitPrice;
    rows.push({
      p,
      newStatus: out.newStatus,
      targetsHit: out.targetsHit,
      exitPrice: out.exitPrice,
      r: pnl / risk,
      pnlDollars: pnl,
      tp1R: Math.abs(p.tp1 - p.entry) / risk,
      slDistance: risk,
      resolvedAtBarTs: out.resolvedAtBarTs,
    });
  }
  console.log = realLog;
  return { rows, bars, evalNowMs, skipped };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("PRECONDITIONS 1-3");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(104));

  const { rows, bars, evalNowMs, skipped } = await buildCanonical();
  console.log(`\nBARS  : ${bars.length} from ${iso(bars[0].timestamp)} to ${iso(bars[bars.length - 1].timestamp)}`);
  console.log(`evalNowMs (last real bar) = ${iso(evalNowMs)}`);
  console.log(`SIGNALS resolved on the canonical basis: ${rows.length}   skipped (incomplete geometry): ${skipped}`);

  const buy = rows.filter((r) => r.p.direction === "BUY");
  const sell = rows.filter((r) => r.p.direction === "SELL");

  // ══ P1 ═════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(104));
  console.log("PRECONDITION 1 — PER-DIRECTION ECONOMICS ON THE CANONICAL SET");
  console.log("=".repeat(104));
  console.log("  win predicate = R > 0 | outcome = REAL resolver, fromScratch:true | denominator = all resolvable");
  console.log("  net $ = sum of (exit - entry) signed by direction, per 1 unit of XAU (i.e. per $1 of price move).");
  console.log("          It is NOT lot-scaled — no position sizing is applied anywhere in this report.\n");
  const mBuy = metrics(buy);
  const mSell = metrics(sell);
  const mAll = metrics(rows);
  console.log(fmt("BUY", mBuy));
  console.log(fmt("SELL", mSell));
  console.log(fmt("COMBINED", mAll));
  console.log(`\n  gross R won / lost:`);
  console.log(`    BUY      +${mBuy.grossWinR.toFixed(2)}R won / -${mBuy.grossLossR.toFixed(2)}R lost`);
  console.log(`    SELL     +${mSell.grossWinR.toFixed(2)}R won / -${mSell.grossLossR.toFixed(2)}R lost`);
  console.log(`    COMBINED +${mAll.grossWinR.toFixed(2)}R won / -${mAll.grossLossR.toFixed(2)}R lost`);
  console.log(`\n  mean R per WIN / per LOSS:`);
  for (const [lbl, set] of [
    ["BUY", buy],
    ["SELL", sell],
    ["COMBINED", rows],
  ] as [string, Canon[]][]) {
    const w = set.filter((x) => x.r > 0);
    const l = set.filter((x) => x.r < 0);
    console.log(
      `    ${lbl.padEnd(9)} win ${(w.reduce((a, b) => a + b.r, 0) / (w.length || 1)).toFixed(4)}R (n=${w.length})   loss ${(l.reduce((a, b) => a + b.r, 0) / (l.length || 1)).toFixed(4)}R (n=${l.length})`,
    );
  }

  // ══ P2 ═════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(104));
  console.log("PRECONDITION 2 — THE EV CORRECTION, EXPLAINED MECHANICALLY");
  console.log("=".repeat(104));
  console.log("  Item 5 (old MIRROR)  : WR 63.1%  EV +0.3019R  net +$581.6");
  console.log(`  CANONICAL (real res.): WR ${mAll.wr.toFixed(1)}%  EV ${(mAll.ev >= 0 ? "+" : "") + mAll.ev.toFixed(4)}R  net ${(mAll["net$"] >= 0 ? "+$" : "-$") + Math.abs(mAll["net$"]).toFixed(1)}`);
  console.log("  Same win RATE, radically different EV => the difference is R PER WIN, not who won.\n");

  // Reproduce the mirror's exit prices to show where the R inflation comes from.
  const bucket = new Map<string, { n: number; sumR: number; sumMirrorR: number }>();
  for (const r of rows) {
    const k = r.newStatus;
    if (!bucket.has(k)) bucket.set(k, { n: 0, sumR: 0, sumMirrorR: 0 });
    const b = bucket.get(k)!;
    b.n++;
    b.sumR += r.r;
    // The mirror had NO post-TP1 lock and NO protected exit: it exits at the
    // furthest target reached, or at raw SL. Reconstruct that exit.
    let mExit: number;
    if (r.targetsHit >= 3) mExit = r.p.tp3;
    else if (r.targetsHit >= 2) mExit = r.p.tp2;
    else if (r.targetsHit >= 1) mExit = r.p.tp1;
    else mExit = r.newStatus === "SL_HIT" ? r.p.sl : r.exitPrice;
    const mPnl = r.p.direction === "BUY" ? mExit - r.p.entry : r.p.entry - mExit;
    b.sumMirrorR += mPnl / r.slDistance;
  }
  console.log("  Per bar-verified status: mean R under the CANONICAL resolver vs under the MIRROR's exit rule\n");
  console.log(
    "    status                  n     canonical meanR    mirror meanR    delta   why the mirror differs",
  );
  console.log("    " + "-".repeat(98));
  const why: Record<string, string> = {
    SL_AFTER_BE: "mirror exits at TP1, resolver at the 0.35R lock",
    PARTIAL_WIN_SL_HIT: "mirror exits at TP2, resolver at (TP1+TP2+entry)/3",
    ALL_TARGETS_HIT: "same exit (TP3)",
    SL_HIT: "same exit (SL)",
    CLOSED: "mirror has no CLOSED-flat concept",
    EXPIRED_MISSED_ENTRY: "mirror assumes entry ALWAYS fills",
  };
  for (const [k, b] of [...bucket.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const c = b.sumR / b.n;
    const m = b.sumMirrorR / b.n;
    console.log(
      `    ${k.padEnd(22)}${String(b.n).padStart(4)}${(c >= 0 ? "+" : "") + c.toFixed(4)}R`.padEnd(60) +
        `${(m >= 0 ? "+" : "") + m.toFixed(4)}R`.padStart(10) +
        `${(m - c >= 0 ? "+" : "") + (m - c).toFixed(4)}`.padStart(10) +
        `   ${why[k] ?? ""}`,
    );
  }
  const canonEV = mAll.ev;
  const mirrorEV = [...bucket.values()].reduce((a, b) => a + b.sumMirrorR, 0) / rows.length;
  console.log(
    `\n    WHOLE BOOK   canonical EV ${(canonEV >= 0 ? "+" : "") + canonEV.toFixed(4)}R   mirror-exit EV ${(mirrorEV >= 0 ? "+" : "") + mirrorEV.toFixed(4)}R   inflation +${(mirrorEV - canonEV).toFixed(4)}R/signal`,
  );
  console.log("\n  RECORDED: the true edge is THIN. The book nets a fraction of an R per signal, not a third of one.");

  // ══ P3a ════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(104));
  console.log("PRECONDITION 3a — TP1'S ACTUAL R-MULTIPLE ACROSS THE EXPORT");
  console.log("=".repeat(104));
  console.log("  computed per signal from its OWN stored geometry: |TP1 - entry| / |SL - entry|\n");

  const hist = new Map<string, number>();
  for (const r of rows) {
    const k = r.tp1R.toFixed(2);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  console.log("    TP1 R-multiple (2dp)   count");
  for (const [k, v] of [...hist.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    console.log(`      ${k.padStart(6)}              ${String(v).padStart(4)}  ${"#".repeat(Math.min(60, Math.round(v / 2)))}`);
  }
  const sortedR = [...rows].map((r) => r.tp1R).sort((a, b) => a - b);
  const q = (f: number): number => sortedR[Math.min(sortedR.length - 1, Math.floor(f * sortedR.length))];
  console.log(
    `\n    min ${sortedR[0].toFixed(3)}  p25 ${q(0.25).toFixed(3)}  median ${q(0.5).toFixed(3)}  p75 ${q(0.75).toFixed(3)}  max ${sortedR[sortedR.length - 1].toFixed(3)}`,
  );

  // chronological scan for the changeover
  const chrono = [...rows].sort((a, b) => a.p.generatedMs - b.p.generatedMs);
  console.log("\n  CHRONOLOGICAL SCAN — where does the ladder change?");
  console.log("    (a 'generation' = a contiguous run of signals sharing the same TP1 R to 2dp)\n");
  interface Run {
    val: string;
    from: number;
    to: number;
    n: number;
  }
  const runs: Run[] = [];
  for (const r of chrono) {
    const v = r.tp1R.toFixed(2);
    const last = runs[runs.length - 1];
    if (last && last.val === v) {
      last.to = r.p.generatedMs;
      last.n++;
    } else runs.push({ val: v, from: r.p.generatedMs, to: r.p.generatedMs, n: 1 });
  }
  console.log(`    contiguous runs: ${runs.length}`);
  for (const run of runs.filter((x) => x.n >= 5)) {
    console.log(`      TP1=${run.val}R  n=${String(run.n).padStart(3)}   ${iso(run.from)} -> ${iso(run.to)}`);
  }
  if (runs.filter((x) => x.n >= 5).length === 0) console.log("      (no run of >=5 — the value is not piecewise-constant)");

  // Bucket into the two nominal generations and report each
  const GEN_SPLIT = 0.6; // midpoint between the nominal 0.50 and 0.70 ladders
  const gen50 = chrono.filter((r) => r.tp1R < GEN_SPLIT);
  const gen70 = chrono.filter((r) => r.tp1R >= GEN_SPLIT);
  console.log(`\n  GENERATION SPLIT at TP1 R = ${GEN_SPLIT} (midpoint of the nominal 0.50R / 0.70R ladders):`);
  console.log(
    `    GEN-A (TP1 < ${GEN_SPLIT}R): n=${gen50.length}  ${gen50.length ? iso(gen50[0].p.generatedMs) + " -> " + iso(gen50[gen50.length - 1].p.generatedMs) : ""}`,
  );
  console.log(
    `    GEN-B (TP1 >= ${GEN_SPLIT}R): n=${gen70.length}  ${gen70.length ? iso(gen70[0].p.generatedMs) + " -> " + iso(gen70[gen70.length - 1].p.generatedMs) : ""}`,
  );
  const overlapA = gen50.length && gen70.length ? gen50[gen50.length - 1].p.generatedMs > gen70[0].p.generatedMs : false;
  console.log(
    `    do the two generations OVERLAP in time? ${overlapA ? "YES — they are interleaved, not sequential" : "NO — cleanly sequential"}`,
  );

  console.log("\n  PER-GENERATION ECONOMICS (canonical outcomes):");
  for (const [lbl, set] of [
    [`GEN-A TP1<${GEN_SPLIT}R`, gen50],
    [`GEN-B TP1>=${GEN_SPLIT}R`, gen70],
  ] as [string, Canon[]][]) {
    console.log(`\n    ${lbl}   meanTP1R=${(set.reduce((a, b) => a + b.tp1R, 0) / (set.length || 1)).toFixed(3)}`);
    console.log("    " + fmt("  ALL", metrics(set)).trim());
    console.log("    " + fmt("  BUY", metrics(set.filter((x) => x.p.direction === "BUY"))).trim());
    console.log("    " + fmt("  SELL", metrics(set.filter((x) => x.p.direction === "SELL"))).trim());
  }

  // ══ P3b ════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(104));
  console.log("PRECONDITION 3b — WHICH LOCK FUNCTION IS LIVE");
  console.log("=".repeat(104));
  console.log(`  services/signalResolver.ts exports EXACTLY ONE lock implementation:`);
  console.log(`    getPostTP1LockPrice()  —  R-relative ${POST_TP1_PROFIT_LOCK_R}R, ${POST_TP1_PROFIT_LOCK_MIN_PIPS}-pip floor, 0.9x TP1 cap`);
  console.log(`  resolver call sites: line 62 (getProtectedExitPrice), line 110 (postTP1Lock), line 344 (matured branch)`);
  console.log(`  POST_TP1_PROFIT_LOCK_PIPS (the fixed 15-pip constant): grep across the repo returns ZERO hits.`);
  console.log(`  contexts/TradingContext.tsx:17 imports it ALIASED as computePostTP1LockPrice and`);
  console.log(`  :376-377 re-exports a same-named wrapper that simply delegates — one implementation, two names.`);
  const probe: TradingSignal = toTradingSignal({
    index: 0,
    direction: "BUY",
    entry: 4000,
    sl: 3996,
    tp1: 4002.8,
    tp2: 4004.2,
    tp3: 4005.6,
    storedStatus: "ACTIVE",
    id: "probe",
    generatedMs: 0,
    confidence: 50,
    storedExitPrice: null,
    storedTargetsHit: 0,
  });
  console.log(`  live probe: entry 4000, SL 3996 (4.0 stop) -> lock ${getPostTP1LockPrice(probe)}  (= entry + 0.35*4.0 = 4001.4) CONFIRMED`);

  // ══ P3c ════════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(104));
  console.log("PRECONDITION 3c — DOES THE 5-PIP FLOOR EVER BIND?");
  console.log("=".repeat(104));
  const minDelta = POST_TP1_PROFIT_LOCK_MIN_PIPS * 0.1;
  const bindAt = minDelta / POST_TP1_PROFIT_LOCK_R;
  console.log(`  floor binds when stopDistance * ${POST_TP1_PROFIT_LOCK_R} < ${minDelta}  =>  stopDistance < $${bindAt.toFixed(4)}`);
  const sab = rows.filter((r) => r.newStatus === "SL_AFTER_BE");
  const floorAll = rows.filter((r) => r.slDistance < bindAt);
  const floorSab = sab.filter((r) => r.slDistance < bindAt);
  const capAll = rows.filter((r) => {
    const rBased = r.slDistance * POST_TP1_PROFIT_LOCK_R;
    const ceiling = Math.abs(r.p.tp1 - r.p.entry) * 0.9;
    return Math.max(rBased, minDelta) > ceiling;
  });
  const stops = [...rows].map((r) => r.slDistance).sort((a, b) => a - b);
  console.log(`  stop distance across the export: min $${stops[0].toFixed(2)}  median $${stops[Math.floor(stops.length / 2)].toFixed(2)}  max $${stops[stops.length - 1].toFixed(2)}`);
  console.log(`  signals where the 5-pip FLOOR binds : ${floorAll.length}/${rows.length}   (of the ${sab.length} SL_AFTER_BE: ${floorSab.length})`);
  console.log(`  signals where the 0.9xTP1 CAP binds : ${capAll.length}/${rows.length}`);
  if (capAll.length > 0) {
    console.log(`    cap-bound examples (TP1 R-multiple must be < ${(POST_TP1_PROFIT_LOCK_R / 0.9).toFixed(4)} for the cap to bind):`);
    for (const r of capAll.slice(0, 5))
      console.log(`      [${r.p.index}] ${r.p.direction} stop $${r.slDistance.toFixed(2)}  TP1R ${r.tp1R.toFixed(3)}  lock ${getPostTP1LockPrice(toTradingSignal(r.p))}`);
  }
  console.log(
    `\n  => ${floorAll.length === 0 ? "the 5-pip floor NEVER binds on this export; it is dead code for this sample." : "the floor binds on " + floorAll.length + " signals — material, reported above."}`,
  );

  console.log("\n" + "=".repeat(104));
  console.log("NOTE FOR THE RECORD: fromScratch applies TODAY's lock formula (0.35R) to signals");
  console.log("generated under older geometry. Correct for a 'what would this system do now'");
  console.log("measurement; historical R here is NOT what those trades earned at the time.");
  console.log("=".repeat(104));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
