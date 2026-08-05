/**
 * FORWARD MONITOR — evaluates the six pre-registered F6 criteria against real
 * forward signals as they land.
 *
 * ── MEASUREMENT POSITION (stated once, up front) ────────────────────────────
 * CANONICAL OUTCOME SET, unchanged from Items B/C/D: signals re-resolved by the
 * REAL `resolveSignalWithBars` (imported, never mirrored) with
 * { fromScratch: true, evalNowMs = last real bar }, win predicate R > 0,
 * denominator = ALL signals in scope (unresolved counted, never excluded).
 * Pre-F canonical reference: n=369  WR 63.1%  PF 1.16  EV +0.0605R  net +$111.2
 *                            BUY n=157 (42.5%)  SELL n=212 (57.5%)
 *
 * DATA-SOURCE RULE: `gold_m1_bars` read DIRECTLY from Supabase via the anon key.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 *
 * POWER RULE (rule 7): every criterion prints its pre-registered refutation
 * threshold, the current value, and an explicit power verdict. A criterion that
 * cannot yet detect the effect size that would matter prints UNDERPOWERED — it
 * is never printed as a pass or a fail.
 *
 * USAGE
 *   bun run scripts/forwardMonitor.ts --forward /tmp/forward_export.txt \
 *        [--reference /tmp/diagnostics_export.txt] [--since 2026-08-03T00:00:00Z]
 *
 * The forward export must come from the POST-Item-F engine. `--since` is the F
 * cutover instant; signals generated before it are excluded and counted.
 */
import { existsSync, readFileSync } from "node:fs";

import { resolveSignalWithBars } from "../services/signalResolver";
import type { OhlcBar } from "../services/barStore";
import { fetchBars, metrics, parseExport, toTradingSignal, type ParsedSignal } from "./preconditions";

// ─── pre-registered constants ───────────────────────────────────────────────

/** Canonical pre-F reference. Every comparison below is against THESE numbers. */
const CANON = {
  n: 369,
  wrPct: 63.1,
  pf: 1.16,
  evR: 0.0605,
  buyN: 157,
  sellN: 212,
  /** BUY share of the pre-F book — the reference for criterion 6. */
  buyShare: 157 / 369,
  /** MFE/MAE over a 24h horizon, in dollars. Item D's stated transfer test. */
  mfe24: { p25: 2.32, p50: 6.45, p75: 11.83 },
  mae24: { p25: 2.41, p50: 5.94, p75: 12.30 },
} as const;

/** Pre-registered minimum samples. Below these a criterion prints UNDERPOWERED. */
const POWER = {
  /** criterion 1 — needs two full weeks of market-open hours to test "two consecutive weeks". */
  emissionHours: 2 * 5 * 23,
  /** criteria 2 and 3 — a distribution over fewer than 30 signals is not a distribution. */
  distributionN: 30,
  /** criterion 4 — a rate threshold of 5% cannot be evaluated on fewer than 100 checks. */
  standAsideChecks: 100,
  /** criterion 5 — F6 itself stated 60 signals, and that it still cannot resolve <±0.15R. */
  economicsN: 60,
  /** criterion 6 — binomial against 42.5% needs ~30 before the normal approximation holds. */
  splitN: 30,
} as const;

const REFUTE = {
  /** 1: emission rate below half of the pre-F baseline for two consecutive weeks. */
  emissionRateFraction: 0.5,
  /** 2: RANGING above 65% of classifications while realised ATR is unchanged. */
  rangingSharePct: 65,
  /** 2: "ATR unchanged" band — realised ATR within ±25% of the pre-F median. */
  atrUnchangedBand: 0.25,
  /** 3: RSI extremes staying near the tick-era rate (within 5 points of it). */
  rsiExtremeNearPts: 5,
  /** 4: stand-aside above 5% of readiness checks. */
  standAsideRatePct: 5,
  /** 5: economic — recorded for accumulation, MUST NOT gate at this sample size. */
  economicMinDetectableR: 0.15,
  /** 6: BUY share differing from the pre-F 42.5% at p < 0.05, two-sided. */
  splitAlpha: 0.05,
} as const;

// ─── args ───────────────────────────────────────────────────────────────────

interface Args {
  forward: string;
  reference: string;
  sinceMs: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : fallback;
  };
  const sinceRaw = get("--since", "2026-08-03T00:00:00Z");
  const sinceMs = new Date(sinceRaw).getTime();
  if (Number.isNaN(sinceMs)) throw new Error(`--since is not a valid ISO instant: ${sinceRaw}`);
  return {
    forward: get("--forward", "/tmp/forward_export.txt"),
    reference: get("--reference", "/tmp/diagnostics_export.txt"),
    sinceMs,
  };
}

// ─── telemetry parsed out of the export (added for criteria 2, 3, 4) ────────

export interface SignalTelemetry {
  rsi: number | null;
  regime: string | null;
  atr: number | null;
  htf: string | null;
}

/** `    forward telemetry: rsi=..  regime=..  regimeStrength=..  atr=..  htf=..  adx=..` */
export function parseTelemetry(filePath: string): Map<string, SignalTelemetry> {
  const out = new Map<string, SignalTelemetry>();
  if (!existsSync(filePath)) return out;
  const lines = readFileSync(filePath, "utf-8").split("\n");
  let currentId: string | null = null;
  for (const line of lines) {
    const id = line.match(/^\s+id:\s+(\S+)/);
    if (id) {
      currentId = id[1];
      continue;
    }
    const t = line.match(/^\s+forward telemetry:\s+(.+)$/);
    if (t && currentId) {
      const kv = new Map<string, string>();
      for (const part of t[1].trim().split(/\s{2,}/)) {
        const i = part.indexOf("=");
        if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
      }
      const num = (k: string): number | null => {
        const v = kv.get(k);
        if (v === undefined || v === "n/a") return null;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : null;
      };
      const str = (k: string): string | null => {
        const v = kv.get(k);
        return v === undefined || v === "n/a" ? null : v;
      };
      out.set(currentId, { rsi: num("rsi"), regime: str("regime"), atr: num("atr"), htf: str("htf") });
    }
  }
  return out;
}

export interface StandAsideStats {
  checks: number;
  standAsides: number;
}

/** SECTION 8 of the export. Absent => NOT INSTRUMENTED, which is not "zero". */
export function parseStandAside(filePath: string): StandAsideStats | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.includes("SECTION 8 — DIRECTIONAL BAR LAYER")) return null;
  const checks = raw.match(/Readiness checks this process:\s+(\d+)/);
  const stands = raw.match(/Stand-asides \(bar layer unavailable or stale\):\s+(\d+)/);
  if (!checks || !stands) return null;
  return { checks: parseInt(checks[1], 10), standAsides: parseInt(stands[1], 10) };
}

// ─── stats ──────────────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number {
  return quantile([...values].sort((x, y) => x - y), 0.5);
}

/** Two-sided normal-approximation binomial test of `k/n` against `p0`. */
function binomTest(k: number, n: number, p0: number): number {
  if (n === 0) return NaN;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  if (se === 0) return NaN;
  const z = Math.abs(k / n - p0) / se;
  // Abramowitz & Stegun 7.1.26 error-function approximation.
  const erf = (x: number): number => {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-ax * ax);
    return s * y;
  };
  return 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2)));
}

/** Minimum detectable effect on EV at 80% power, 5% two-sided, given observed spread. */
function mdeR(rs: number[]): number {
  if (rs.length < 2) return Number.POSITIVE_INFINITY;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const varr = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1);
  return 2.8 * Math.sqrt(varr / rs.length);
}

// ─── report helpers ─────────────────────────────────────────────────────────

const W = 100;
const out: string[] = [];
function say(line = ""): void {
  out.push(line);
}
function hr(title?: string): void {
  say("=".repeat(W));
  if (title) {
    say(title);
    say("=".repeat(W));
  }
}
function verdict(label: string, state: "UNDERPOWERED" | "NOT REFUTED" | "REFUTED" | "NOT INSTRUMENTED", detail: string): void {
  say(`  VERDICT: ${state.padEnd(16)} ${label}`);
  say(`  ${detail}`);
}

// ─── main ───────────────────────────────────────────────────────────────────

interface ForwardRow {
  p: ParsedSignal;
  r: number;
  pnlDollars: number;
  status: string;
  resolvedAtBarTs?: number;
  mfe24: number;
  mae24: number;
  matured: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs();

  hr("FORWARD MONITOR — F6 PRE-REGISTERED CRITERIA");
  say(`run at ${new Date().toISOString()}`);
  say(`forward export : ${args.forward}`);
  say(`reference export: ${args.reference}`);
  say(`F cutover (--since): ${new Date(args.sinceMs).toISOString()}`);
  say();
  say("CANONICAL OUTCOME SET (used for every number below, stated once):");
  say("  real resolveSignalWithBars, { fromScratch: true, evalNowMs = last real bar },");
  say("  win predicate R > 0, denominator = all in-scope signals (unresolved counted, not excluded).");
  say(`  Pre-F canonical: n=${CANON.n}  WR ${CANON.wrPct}%  PF ${CANON.pf}  EV +${CANON.evR}R`);
  say(`  Pre-F split    : BUY ${CANON.buyN} (${(CANON.buyShare * 100).toFixed(1)}%) / SELL ${CANON.sellN}`);
  say();

  if (!existsSync(args.forward)) {
    hr("NO FORWARD DATA");
    say(`The forward export does not exist at ${args.forward}.`);
    say("Every criterion below is therefore UNEVALUABLE, not passing. Export diagnostics from the");
    say("app (Settings -> Export diagnostics), save the file to that path, and re-run.");
    hr();
    console.log(out.join("\n"));
    return;
  }

  // ── load ──────────────────────────────────────────────────────────────────
  const bars = await fetchBars("2026-06-18T00:00:00Z");
  const evalNowMs = bars[bars.length - 1].timestamp;
  const allForward = parseExport(args.forward);
  const forwardSignals = allForward.filter((s) => s.generatedMs >= args.sinceMs);
  const preCutover = allForward.length - forwardSignals.length;
  const telemetry = parseTelemetry(args.forward);
  const refTelemetry = existsSync(args.reference) ? parseTelemetry(args.reference) : new Map<string, SignalTelemetry>();
  const standAside = parseStandAside(args.forward);

  say(`BARS: ${bars.length} rows, ${new Date(bars[0].timestamp).toISOString()} -> ${new Date(evalNowMs).toISOString()}`);
  say(`FORWARD EXPORT: ${allForward.length} signals parsed, ${preCutover} excluded as pre-cutover, ${forwardSignals.length} in scope`);
  say();

  if (forwardSignals.length === 0) {
    hr("NO POST-CUTOVER SIGNALS YET");
    say("The export parsed cleanly but contains no signal generated at or after the cutover.");
    say("All six criteria are UNEVALUABLE. This is not evidence for or against the change.");
    hr();
    console.log(out.join("\n"));
    return;
  }

  // ── resolve on the canonical basis ────────────────────────────────────────
  const rows: ForwardRow[] = [];
  let skipped = 0;
  const realLog = console.log;
  console.log = () => {};
  for (const p of forwardSignals) {
    if (!p.sl || !p.tp1 || !p.tp2 || !p.tp3 || !p.generatedMs) {
      skipped++;
      continue;
    }
    const risk = Math.abs(p.entry - p.sl);
    if (!(risk > 0)) {
      skipped++;
      continue;
    }
    const res = resolveSignalWithBars(toTradingSignal(p), bars, { fromScratch: true, evalNowMs });
    const pnl = p.direction === "BUY" ? res.exitPrice - p.entry : p.entry - res.exitPrice;
    const isBuy = p.direction === "BUY";
    const horizon = p.generatedMs + 24 * 60 * 60 * 1000;
    let mfe24 = 0;
    let mae24 = 0;
    for (const b of bars) {
      if (b.timestamp < p.generatedMs) continue;
      if (b.timestamp > horizon) break;
      const fav = isBuy ? b.high - p.entry : p.entry - b.low;
      const adv = isBuy ? p.entry - b.low : b.high - p.entry;
      if (fav > mfe24) mfe24 = fav;
      if (adv > mae24) mae24 = adv;
    }
    rows.push({
      p,
      r: pnl / risk,
      pnlDollars: pnl,
      status: res.newStatus,
      resolvedAtBarTs: res.resolvedAtBarTs,
      mfe24,
      mae24,
      // "matured" = the bar series has run at least 24h past generation, so the
      // outcome is not still open purely because the data ends.
      matured: evalNowMs >= horizon || res.resolvedAtBarTs !== undefined,
    });
  }
  console.log = realLog;
  say(`RESOLVED: ${rows.length}   SKIPPED (incomplete geometry): ${skipped}`);
  say(`MATURED (24h elapsed or terminal event reached): ${rows.filter((r) => r.matured).length}`);
  say();

  // ══ CRITERION 1 — emission rate per market-open hour ═══════════════════════
  hr("CRITERION 1 (PRIMARY) — DOES THE BAR LAYER REACH CONVICTION?");
  say("  Metric   : emitted signals per MARKET-OPEN hour.");
  say("  Market-open hours are counted from gold_m1_bars itself (an hour with >=1 real bar),");
  say("  so the denominator is the venue's own record of when it was trading, not an assumption.");
  say(`  Threshold: REFUTED if the rate stays below ${REFUTE.emissionRateFraction * 100}% of the pre-F baseline for two consecutive weeks.`);
  {
    const openHours = (fromMs: number, toMs: number): number => {
      const set = new Set<number>();
      for (const b of bars) {
        if (b.timestamp < fromMs || b.timestamp > toMs) continue;
        set.add(Math.floor(b.timestamp / 3_600_000));
      }
      return set.size;
    };
    const refSignals = existsSync(args.reference) ? parseExport(args.reference).filter((s) => s.generatedMs < args.sinceMs) : [];
    const refFrom = refSignals.length ? Math.min(...refSignals.map((s) => s.generatedMs)) : 0;
    const refTo = refSignals.length ? Math.max(...refSignals.map((s) => s.generatedMs)) : 0;
    const refHours = refSignals.length ? openHours(refFrom, refTo) : 0;
    const refRate = refHours > 0 ? refSignals.length / refHours : NaN;

    const fwdFrom = Math.min(...rows.map((r) => r.p.generatedMs));
    const fwdHours = openHours(fwdFrom, evalNowMs);
    const fwdRate = fwdHours > 0 ? rows.length / fwdHours : NaN;

    say();
    say(`  pre-F baseline : ${refSignals.length} signals over ${refHours} market-open hours = ${Number.isFinite(refRate) ? refRate.toFixed(4) : "n/a"} /h`);
    say(`  forward        : ${rows.length} signals over ${fwdHours} market-open hours = ${Number.isFinite(fwdRate) ? fwdRate.toFixed(4) : "n/a"} /h`);
    if (Number.isFinite(refRate) && Number.isFinite(fwdRate) && refRate > 0) {
      say(`  ratio          : ${(fwdRate / refRate).toFixed(2)}x baseline (refutation line = ${REFUTE.emissionRateFraction.toFixed(2)}x)`);
    }
    say(`  power          : ${fwdHours} of ${POWER.emissionHours} market-open hours required for the two-week test`);
    if (!Number.isFinite(refRate)) {
      verdict("no pre-F baseline in the reference export", "UNDERPOWERED", "Supply --reference pointing at the pre-F export; the ratio cannot be formed without it.");
    } else if (fwdHours < POWER.emissionHours) {
      verdict("two consecutive weeks not yet observed", "UNDERPOWERED", `Need ${POWER.emissionHours} market-open hours; have ${fwdHours}. The ratio above is descriptive only and must not be read as a pass or a fail.`);
    } else if (fwdRate / refRate < REFUTE.emissionRateFraction) {
      verdict("emission rate below half of baseline", "REFUTED", "The bar layer is not reaching conviction; the thresholds were calibrated for tick-scale feature magnitudes.");
    } else {
      verdict("emission rate holds", "NOT REFUTED", "The bar-sourced layer reaches conviction at a rate consistent with the pre-F engine.");
    }
  }
  say();

  // ══ CRITERION 2 — regime distribution ══════════════════════════════════════
  hr("CRITERION 2 (PRIMARY) — IS THE RANGING SHIFT REAL?");
  say("  Metric   : regime distribution of emitted signals, plus realised ATR as the control.");
  say(`  Threshold: REFUTED if RANGING exceeds ${REFUTE.rangingSharePct}% of classifications WHILE realised ATR is unchanged`);
  say(`             (within +/-${REFUTE.atrUnchangedBand * 100}% of the pre-F median ATR). Both limbs must hold — a RANGING`);
  say("             share driven by genuinely lower volatility is a market fact, not a mis-calibration.");
  {
    const withRegime = rows.filter((r) => telemetry.get(r.p.id)?.regime);
    say();
    if (withRegime.length === 0) {
      verdict("regime not present in this export", "NOT INSTRUMENTED", "Per-signal regime is emitted on the `forward telemetry:` line. An export predating that line cannot evaluate this criterion. Re-export from the current build.");
    } else {
      const counts = new Map<string, number>();
      for (const r of withRegime) {
        const g = telemetry.get(r.p.id)!.regime!;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      for (const [g, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        say(`    ${g.padEnd(12)} ${String(c).padStart(4)}  (${((c / withRegime.length) * 100).toFixed(1)}%)`);
      }
      const rangingPct = ((counts.get("RANGING") ?? 0) / withRegime.length) * 100;
      const fwdAtr = withRegime.map((r) => telemetry.get(r.p.id)!.atr).filter((v): v is number => v !== null);
      const refAtr = [...refTelemetry.values()].map((t) => t.atr).filter((v): v is number => v !== null);
      const fwdMedAtr = fwdAtr.length ? median(fwdAtr) : NaN;
      const refMedAtr = refAtr.length ? median(refAtr) : NaN;
      say();
      say(`  RANGING share  : ${rangingPct.toFixed(1)}%   (refutation line ${REFUTE.rangingSharePct}%)`);
      say(`  median ATR fwd : ${Number.isFinite(fwdMedAtr) ? fwdMedAtr.toFixed(3) : "n/a"}   pre-F: ${Number.isFinite(refMedAtr) ? refMedAtr.toFixed(3) : "n/a (reference export has no telemetry line)"}`);
      say(`  power          : n=${withRegime.length} of ${POWER.distributionN} required`);
      const atrComparable = Number.isFinite(fwdMedAtr) && Number.isFinite(refMedAtr);
      const atrUnchanged = atrComparable && Math.abs(fwdMedAtr - refMedAtr) / refMedAtr <= REFUTE.atrUnchangedBand;
      if (withRegime.length < POWER.distributionN) {
        verdict("distribution too small", "UNDERPOWERED", `Need ${POWER.distributionN} classified signals; have ${withRegime.length}.`);
      } else if (!atrComparable) {
        verdict("ATR control unavailable", "UNDERPOWERED", "The second limb needs a pre-F median ATR. Without it a high RANGING share cannot be separated from a genuinely quieter market.");
      } else if (rangingPct > REFUTE.rangingSharePct && atrUnchanged) {
        verdict("RANGING dominant at unchanged ATR", "REFUTED", "This is a mis-calibrated ATR-relative threshold, not a market regime.");
      } else {
        verdict("RANGING share within bounds or explained by ATR", "NOT REFUTED", atrUnchanged ? "RANGING share is below the line." : "RANGING share is elevated but realised ATR moved with it — consistent with a genuinely quieter market.");
      }
    }
  }
  say();

  // ══ CRITERION 3 — RSI extremes ═════════════════════════════════════════════
  hr("CRITERION 3 (SECONDARY) — DOES THE BAR-BASED RSI BEHAVE?");
  say("  Metric   : fraction of emitted signals with RSI > 70 or < 30.");
  say("  Expectation: a LARGE drop from the tick-era rate. A 15-tick window has no fixed time base,");
  say("               so tick-era RSI saturated far more often than a real RSI(14) on M5 bars should.");
  say(`  Threshold: CONCERNING if it stays within ${REFUTE.rsiExtremeNearPts} points of the tick-era rate — the bar series would`);
  say("             then be inheriting tick-like noise, meaning the aggregation is wrong.");
  {
    const fwdRsi = rows.map((r) => telemetry.get(r.p.id)?.rsi).filter((v): v is number => v !== null && v !== undefined);
    const refRsi = [...refTelemetry.values()].map((t) => t.rsi).filter((v): v is number => v !== null);
    say();
    if (fwdRsi.length === 0) {
      verdict("RSI not present in this export", "NOT INSTRUMENTED", "Per-signal RSI is emitted on the `forward telemetry:` line. Re-export from the current build.");
    } else {
      const ext = (xs: number[]): number => (xs.filter((v) => v > 70 || v < 30).length / xs.length) * 100;
      const fwdExt = ext(fwdRsi);
      say(`  forward extreme fraction : ${fwdExt.toFixed(1)}%  (n=${fwdRsi.length})`);
      say(`  tick-era comparator      : ${refRsi.length ? ext(refRsi).toFixed(1) + "%  (n=" + refRsi.length + ")" : "UNAVAILABLE — the pre-F export predates the telemetry line"}`);
      say(`  power                    : n=${fwdRsi.length} of ${POWER.distributionN} required`);
      if (fwdRsi.length < POWER.distributionN) {
        verdict("too few signals", "UNDERPOWERED", `Need ${POWER.distributionN}; have ${fwdRsi.length}.`);
      } else if (refRsi.length === 0) {
        verdict("no tick-era comparator", "UNDERPOWERED", "The forward fraction is reported for accumulation. Without the pre-F rate the 'stayed near it' test cannot be run, and no substitute number will be invented for it.");
      } else if (Math.abs(fwdExt - ext(refRsi)) <= REFUTE.rsiExtremeNearPts) {
        verdict("extremes unchanged from the tick era", "REFUTED", "The bar series is inheriting tick-like noise — the aggregation is wrong.");
      } else {
        verdict("extremes dropped as expected", "NOT REFUTED", "Consistent with a real RSI(14) on a fixed time base.");
      }
    }
  }
  say();

  // ══ CRITERION 4 — stand-aside gate ═════════════════════════════════════════
  hr("CRITERION 4 (SECONDARY) — DOES THE STAND-ASIDE GATE OVER-FIRE?");
  say("  Metric   : bar-layer stand-asides as a share of readiness checks (SECTION 8 of the export).");
  say(`  Threshold: REFUTED above ${REFUTE.standAsideRatePct}% — that is a bar-freshness/ingest problem, not a directional one,`);
  say("             and it would silently suppress the whole book.");
  say("  DENOMINATOR is market-open ONLY: isDirectionalLayerReady() is reached only from");
  say("        generateSignal(), and TradingContext returns before that call when the market is");
  say("        closed, so closed-market minutes enter NEITHER the numerator nor the denominator.");
  say("  ITEM 14 CORRECTION: these counters are DURABLE and CUMULATIVE across the install");
  say("        lifetime (AsyncStorage, ITEM 4). They do NOT reset on reload, as this script used");
  say("        to claim. The rate below therefore spans EVERY code state since install; to judge");
  say("        one code state, subtract the pre-week baseline from BOTH numbers first.");
  {
    say();
    if (!standAside) {
      verdict("SECTION 8 absent", "NOT INSTRUMENTED", "This export predates the directional-layer counters. NOT the same as zero stand-asides — the criterion simply cannot be evaluated. Re-export from the current build.");
    } else {
      const rate = standAside.checks > 0 ? (standAside.standAsides / standAside.checks) * 100 : NaN;
      say(`  readiness checks : ${standAside.checks}`);
      say(`  stand-asides     : ${standAside.standAsides}`);
      say(`  rate             : ${Number.isFinite(rate) ? rate.toFixed(2) + "%" : "n/a"}   (refutation line ${REFUTE.standAsideRatePct}%)`);
      say(`  power            : ${standAside.checks} of ${POWER.standAsideChecks} checks required`);
      if (standAside.checks < POWER.standAsideChecks) {
        verdict("too few readiness checks", "UNDERPOWERED", `A 5% line cannot be resolved on ${standAside.checks} checks.`);
      } else if (rate > REFUTE.standAsideRatePct) {
        verdict("stand-aside gate over-firing", "REFUTED", "Bar freshness/ingest is the problem to fix, not the directional layer.");
      } else {
        verdict("stand-aside within bounds", "NOT REFUTED", "The gate is firing at a rate consistent with normal bar availability.");
      }
    }
  }
  say();

  // ══ CRITERION 5 — economics ════════════════════════════════════════════════
  hr("CRITERION 5 (ECONOMIC) — BAR-VERIFIED EV vs THE CANONICAL +0.0605R");
  say("  STATED UNDERPOWERED IN ADVANCE. At ~60 signals and PF 1.16 this cannot distinguish");
  say(`  anything smaller than roughly +/-${REFUTE.economicMinDetectableR}R. It is recorded for accumulation and MUST NOT`);
  say("  gate any decision at this sample size.");
  {
    const matured = rows.filter((r) => r.matured);
    const all = metrics(rows.map((r) => ({ r: r.r, pnlDollars: r.pnlDollars })));
    const mat = metrics(matured.map((r) => ({ r: r.r, pnlDollars: r.pnlDollars })));
    const buy = metrics(rows.filter((r) => r.p.direction === "BUY").map((r) => ({ r: r.r, pnlDollars: r.pnlDollars })));
    const sell = metrics(rows.filter((r) => r.p.direction === "SELL").map((r) => ({ r: r.r, pnlDollars: r.pnlDollars })));
    const line = (label: string, m: ReturnType<typeof metrics>): void => {
      const pf = Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf";
      say(
        `    ${label.padEnd(16)} n=${String(m.n).padStart(4)}  WR=${m.wr.toFixed(1).padStart(5)}%  PF=${pf.padStart(5)}` +
          `  EV=${(m.ev >= 0 ? "+" : "") + m.ev.toFixed(4)}R  net=${(m["net$"] >= 0 ? "+$" : "-$") + Math.abs(m["net$"]).toFixed(1)}`,
      );
    };
    say();
    line("ALL (in scope)", all);
    line("MATURED only", mat);
    line("BUY", buy);
    line("SELL", sell);
    const mde = mdeR(rows.map((r) => r.r));
    say();
    say(`  observed delta vs canonical : ${(all.ev - CANON.evR >= 0 ? "+" : "") + (all.ev - CANON.evR).toFixed(4)}R`);
    say(`  minimum detectable effect   : +/-${Number.isFinite(mde) ? mde.toFixed(4) : "inf"}R at 80% power, 5% two-sided, on n=${rows.length}`);
    say(`  power                       : n=${rows.length} of ${POWER.economicsN} required, and even then <${REFUTE.economicMinDetectableR}R stays unresolvable`);
    if (rows.length < POWER.economicsN || Math.abs(all.ev - CANON.evR) < mde) {
      verdict("EV difference not distinguishable from noise", "UNDERPOWERED", "Recorded for accumulation only. This number must not be cited as evidence in either direction.");
    } else {
      verdict("EV difference exceeds the minimum detectable effect", "NOT REFUTED", "Large enough to be visible, but note this is an observational forward sample, not a controlled comparison.");
    }
  }
  say();

  // ══ CRITERION 6 — BUY/SELL split ═══════════════════════════════════════════
  hr("CRITERION 6 — BUY/SELL EMISSION SPLIT vs THE 157/212 REFERENCE");
  say(`  Metric   : BUY share of emitted signals, against the pre-F ${CANON.buyN}/${CANON.sellN} (BUY ${(CANON.buyShare * 100).toFixed(1)}%).`);
  say(`  Threshold: a materially different rate at p < ${REFUTE.splitAlpha} two-sided is a FINDING about the new`);
  say("             directional layer — not automatically a fault, but it must be reported either way.");
  {
    const nBuy = rows.filter((r) => r.p.direction === "BUY").length;
    const n = rows.length;
    const p = binomTest(nBuy, n, CANON.buyShare);
    say();
    say(`  forward  : BUY ${nBuy} / SELL ${n - nBuy}  = BUY ${((nBuy / n) * 100).toFixed(1)}%`);
    say(`  pre-F    : BUY ${CANON.buyN} / SELL ${CANON.sellN} = BUY ${(CANON.buyShare * 100).toFixed(1)}%`);
    say(`  binomial : p = ${Number.isFinite(p) ? p.toFixed(4) : "n/a"} (two-sided, normal approximation)`);
    say(`  power    : n=${n} of ${POWER.splitN} required`);
    if (n < POWER.splitN) {
      verdict("sample too small for the normal approximation", "UNDERPOWERED", `Need ${POWER.splitN}; have ${n}.`);
    } else if (p < REFUTE.splitAlpha) {
      verdict("split differs materially from the pre-F reference", "REFUTED", "The new directional layer is picking direction differently. Report it; do not act on it without a reason.");
    } else {
      verdict("split consistent with the pre-F reference", "NOT REFUTED", "No detectable change in the BUY/SELL balance.");
    }
  }
  say();

  // ══ MFE / MAE — Item D's stated transfer test ══════════════════════════════
  hr("MFE / MAE — ITEM D's STATED TRANSFER TEST");
  say("  Item D's conclusion (no ladder adoptable; the sweep expressed a monotone preference for");
  say("  wider targets on a trending sample) was drawn on PRE-F signals. The property that carries");
  say("  transfer is the excursion profile: if forward MFE/MAE match the pre-F reference, the");
  say("  conclusion transfers; if forward trades have materially more or less room, it does not.");
  {
    const mfe = rows.map((r) => r.mfe24).sort((a, b) => a - b);
    const mae = rows.map((r) => r.mae24).sort((a, b) => a - b);
    say();
    say(`  reference (pre-F, n=369)  MFE24 p25/50/75 = ${CANON.mfe24.p25.toFixed(2)}/${CANON.mfe24.p50.toFixed(2)}/${CANON.mfe24.p75.toFixed(2)}   MAE24 = ${CANON.mae24.p25.toFixed(2)}/${CANON.mae24.p50.toFixed(2)}/${CANON.mae24.p75.toFixed(2)}`);
    say(`  forward   (n=${rows.length})        MFE24 p25/50/75 = ${quantile(mfe, 0.25).toFixed(2)}/${quantile(mfe, 0.5).toFixed(2)}/${quantile(mfe, 0.75).toFixed(2)}   MAE24 = ${quantile(mae, 0.25).toFixed(2)}/${quantile(mae, 0.5).toFixed(2)}/${quantile(mae, 0.75).toFixed(2)}`);
    const medRatioF = quantile(mfe, 0.5) / CANON.mfe24.p50;
    const medRatioA = quantile(mae, 0.5) / CANON.mae24.p50;
    say(`  median ratio forward/pre-F: MFE ${medRatioF.toFixed(2)}x   MAE ${medRatioA.toFixed(2)}x`);
    say(`  power: n=${rows.length}; quantiles on fewer than ${POWER.distributionN} observations are indicative only.`);
    if (rows.length < POWER.distributionN) {
      say("  READ AS: indicative only. Not enough observations to claim the profile has or has not shifted.");
    } else if (Math.abs(medRatioF - 1) <= 0.25 && Math.abs(medRatioA - 1) <= 0.25) {
      say("  READ AS: excursion profile is comparable — Item D's conclusion transfers to the post-F population.");
    } else {
      say("  READ AS: excursion profile has SHIFTED — Item D's sweep should be re-run on post-F signals");
      say("           before any of its conclusions are carried forward.");
    }
  }
  say();

  hr("END — every criterion above prints its own threshold, value and power verdict.");
  console.log(out.join("\n"));
}

// Only run the report when executed directly, so the parsers above can be
// imported by the writer/parser contract test without triggering a full run.
if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error("forwardMonitor failed:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
