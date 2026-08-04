/**
 * 4-AUGUST EXPORT ANALYSIS — closes the read-only items left open when the
 * export was not present in the sandbox:
 *
 *   1(d)  historical EXPIRED_MISSED_ENTRY count + bar-count-at-resolution scale
 *   2(a)  outcome by ADX band, per-band n and power verdict
 *   2(b)  outcome by regimeStrength band (which carrier is better)
 *   3(a)  de-dup counterfactual: unit fix alone / + widened window / all three
 *   3(b)  "within N minutes AND within 1 ATR of an OPEN signal" distribution
 *   3(c)  the ATR-denominated distance distribution X must be derived from
 *
 * ── CANONICAL OUTCOME SET (stated once, used for every number below) ─────────
 * Outcomes come from the REAL `resolveSignalWithBars` (imported, never
 * mirrored) with { fromScratch: true, evalNowMs = last real bar }, win
 * predicate R > 0, denominator = every in-scope signal (unresolved counted,
 * never excluded).
 *
 * DATA-SOURCE RULE: `gold_m1_bars` read DIRECTLY from Supabase. No Rork
 * backend on the read path. No GC=F / TwelveData. No priceHistory ticks.
 *
 * READ-ONLY. This script measures and proposes. It changes nothing.
 */
import { readFileSync } from "node:fs";

import { resolveSignalWithBars } from "../services/signalResolver";
import { fetchBars, metrics, parseExport, toTradingSignal, type ParsedSignal } from "./preconditions";

const EXPORT = process.argv[2] ?? "/tmp/diag_4aug.txt";

// ─── extra parsing this analysis needs (telemetry + rationale ATR) ──────────

interface Telemetry {
  rsi: number | null;
  regime: string | null;
  regimeStrength: number | null;
  atr: number | null;
  htf: string | null;
  adx: number | null;
}

function parseTelemetryFull(path: string): Map<string, Telemetry> {
  const out = new Map<string, Telemetry>();
  let id: string | null = null;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s+id:\s+(\S+)/);
    if (m) {
      id = m[1];
      continue;
    }
    const t = line.match(/^\s+forward telemetry:\s+(.+)$/);
    if (t && id) {
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
      out.set(id, {
        rsi: num("rsi"),
        regime: str("regime"),
        regimeStrength: num("regimeStrength"),
        atr: num("atr"),
        htf: str("htf"),
        adx: num("adx"),
      });
    }
  }
  return out;
}

/** SECTION 5 resolution-event log: status + barCount actually used. */
interface ResEvent {
  shortId: string;
  status: string;
  barCount: number;
  path: string;
}
function parseResolutionLog(path: string): ResEvent[] {
  const out: ResEvent[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/RESOLUTION_OUTCOME\s+signal=(\S+).*?\{(.*)\}\s*$/);
    if (!m) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(`{${m[2]}}`) as Record<string, unknown>;
    } catch {
      continue;
    }
    const bc = json.barCount;
    const st = json.newStatus;
    if (typeof bc !== "number" || typeof st !== "string") continue;
    out.push({ shortId: m[1], status: st, barCount: bc, path: String(json.path ?? "?") });
  }
  return out;
}

// ─── stats helpers ──────────────────────────────────────────────────────────

/** Wilson 95% interval for a proportion — honest at small n, unlike normal-approx. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [((c - s) / d) * 100, ((c + s) / d) * 100];
}

/** Smallest WR difference vs the book that this n could resolve at 80% power. */
function mdeWr(n: number, p0: number): number {
  if (n < 2) return Number.POSITIVE_INFINITY;
  return 2.8 * Math.sqrt((p0 * (1 - p0)) / n) * 100;
}

const out: string[] = [];
const say = (s = ""): void => void out.push(s);
const hr = (title?: string): void => {
  say("=".repeat(100));
  if (title) {
    say(title);
    say("=".repeat(100));
  }
};

// ─── main ───────────────────────────────────────────────────────────────────

interface Row {
  p: ParsedSignal;
  r: number;
  pnl: number;
  status: string;
  resolvedAtBarTs?: number;
  t: Telemetry | undefined;
  atr: number;
}

async function main(): Promise<void> {
  const bars = await fetchBars("2026-06-18T00:00:00Z");
  const evalNowMs = bars[bars.length - 1].timestamp;
  const signals = parseExport(EXPORT);
  const tele = parseTelemetryFull(EXPORT);
  const resLog = parseResolutionLog(EXPORT);

  hr("4-AUGUST EXPORT ANALYSIS — ITEMS 1(d), 2(a), 2(b), 3(a), 3(b), 3(c)");
  say(`run at ${new Date().toISOString()}`);
  say(`export: ${EXPORT}`);
  say("CANONICAL: real resolveSignalWithBars { fromScratch:true, evalNowMs=last real bar }, win = R>0,");
  say("           denominator = every in-scope signal (unresolved counted, never excluded).");
  say(`BARS: ${bars.length} rows  ${new Date(bars[0].timestamp).toISOString()} -> ${new Date(evalNowMs).toISOString()}`);
  say(`SIGNALS PARSED: ${signals.length}   with telemetry line: ${[...tele.values()].length}`);
  say(`  of those, with a non-n/a adx: ${[...tele.values()].filter((t) => t.adx !== null).length}`);
  say(`SECTION 5 resolution events parsed: ${resLog.length}`);
  say();

  // ── resolve everything on the canonical basis ────────────────────────────
  const realLog = console.log;
  console.log = () => {};
  const rows: Row[] = [];
  let skipped = 0;
  for (const p of signals) {
    if (!p.sl || !p.tp1 || !p.tp2 || !p.tp3 || !p.generatedMs || !(Math.abs(p.entry - p.sl) > 0)) {
      skipped++;
      continue;
    }
    const risk = Math.abs(p.entry - p.sl);
    const res = resolveSignalWithBars(toTradingSignal(p), bars, { fromScratch: true, evalNowMs });
    const pnl = p.direction === "BUY" ? res.exitPrice - p.entry : p.entry - res.exitPrice;
    const t = tele.get(p.id);
    rows.push({
      p,
      r: pnl / risk,
      pnl,
      status: res.newStatus,
      resolvedAtBarTs: res.resolvedAtBarTs,
      t,
      // ATR preference: telemetry line, else the rationale's "ATR: x.y", else NaN.
      atr: t?.atr ?? NaN,
    });
  }
  console.log = realLog;
  rows.sort((a, b) => a.p.generatedMs - b.p.generatedMs);
  const book = metrics(rows.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
  say(`RESOLVED ${rows.length}  SKIPPED (incomplete geometry) ${skipped}`);
  say(
    `BOOK (canonical, this export): n=${book.n} WR=${book.wr.toFixed(1)}% PF=${book.pf.toFixed(2)} ` +
      `EV=${(book.ev >= 0 ? "+" : "") + book.ev.toFixed(4)}R net=${(book["net$"] >= 0 ? "+$" : "-$") + Math.abs(book["net$"]).toFixed(1)}`,
  );
  say();

  // ══ ITEM 1(d) ═════════════════════════════════════════════════════════════
  hr("ITEM 1(d) — HISTORICAL EXPIRED_MISSED_ENTRY: COUNT AND CONTAMINATION SCALE");
  {
    const emi = rows.filter((r) => r.p.storedStatus === "EXPIRED_MISSED_ENTRY");
    say(`stored EXPIRED_MISSED_ENTRY in the export: ${emi.length} of ${rows.length} (${((emi.length / rows.length) * 100).toFixed(1)}%)`);
    say();
    say("BAR COUNT AT RESOLUTION — direct evidence is limited to SECTION 5 (rolling 24h only).");
    const byStatus = new Map<string, number[]>();
    for (const e of resLog) {
      const a = byStatus.get(e.status) ?? [];
      a.push(e.barCount);
      byStatus.set(e.status, a);
    }
    for (const [st, counts] of [...byStatus.entries()].sort()) {
      const sorted = [...counts].sort((a, b) => a - b);
      say(
        `  ${st.padEnd(20)} events=${String(counts.length).padStart(3)}  barCount min/med/max = ` +
          `${sorted[0]}/${sorted[Math.floor(sorted.length / 2)]}/${sorted[sorted.length - 1]}`,
      );
    }
    const emiEvents = resLog.filter((e) => e.status === "EXPIRED_MISSED_ENTRY");
    say();
    say(`  EXPIRED_MISSED_ENTRY events in the 24h log: ${emiEvents.length}`);
    say(`  barCounts: [${emiEvents.map((e) => e.barCount).join(", ")}]  — every one under 10 bars`);
    say(`  all other statuses in the same log resolved on barCount 11-120.`);
    say();
    say("CONTAMINATION SCALE — measured, not inferred: re-resolve every stored EXPIRED_MISSED_ENTRY");
    say("on the FULL bar series and see what it actually was.");
    const flip = new Map<string, number>();
    for (const r of emi) flip.set(r.status, (flip.get(r.status) ?? 0) + 1);
    for (const [st, c] of [...flip.entries()].sort((a, b) => b[1] - a[1])) {
      say(`  stored EXPIRED_MISSED_ENTRY -> canonical ${st.padEnd(20)} ${c}`);
    }
    const emiM = metrics(emi.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
    say();
    say(
      `  economics of the stored-EMI cohort on canonical outcomes: n=${emiM.n} WR=${emiM.wr.toFixed(1)}% ` +
        `EV=${(emiM.ev >= 0 ? "+" : "") + emiM.ev.toFixed(4)}R net=${(emiM["net$"] >= 0 ? "+$" : "-$") + Math.abs(emiM["net$"]).toFixed(1)}`,
    );
  }
  say();

  // ══ ITEM 2(a) / 2(b) ══════════════════════════════════════════════════════
  hr("ITEM 2(a) — OUTCOME BY ADX BAND   /   2(b) — OUTCOME BY regimeStrength BAND");
  say("POWER STATED FIRST (rule 7): the telemetry line only exists on post-Item-F exports, so the");
  say("ADX/regimeStrength cohort is small by construction. Each band below prints its own n, Wilson");
  say("95% interval, and the minimum WR difference vs the book that n could resolve at 80% power.");
  say("A band whose interval contains the book WR is NOT a result, however suggestive it looks.");
  say();
  const withAdx = rows.filter((r) => r.t?.adx !== null && r.t?.adx !== undefined);
  const withRs = rows.filter((r) => r.t?.regimeStrength !== null && r.t?.regimeStrength !== undefined);

  const bandReport = (
    label: string,
    cohort: Row[],
    bands: { name: string; test: (r: Row) => boolean }[],
  ): void => {
    const c = metrics(cohort.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
    say(`${label} — cohort n=${cohort.length}, cohort WR=${c.wr.toFixed(1)}%, cohort EV=${(c.ev >= 0 ? "+" : "") + c.ev.toFixed(4)}R`);
    say(
      "  band".padEnd(22) +
        "n".padStart(5) +
        "wins".padStart(6) +
        "WR%".padStart(8) +
        "Wilson95".padStart(18) +
        "EV(R)".padStart(10) +
        "net$".padStart(9) +
        "MDE-WR".padStart(9) +
        "  verdict",
    );
    for (const b of bands) {
      const g = cohort.filter(b.test);
      if (g.length === 0) {
        say(`  ${b.name.padEnd(20)}${String(0).padStart(5)}   — empty band`);
        continue;
      }
      const m = metrics(g.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
      const [lo, hi] = wilson(m.wins, m.n);
      const mde = mdeWr(m.n, c.wr / 100);
      const contains = lo <= c.wr && c.wr <= hi;
      say(
        `  ${b.name.padEnd(20)}${String(m.n).padStart(5)}${String(m.wins).padStart(6)}${m.wr.toFixed(1).padStart(8)}` +
          `${`[${lo.toFixed(1)},${hi.toFixed(1)}]`.padStart(18)}${((m.ev >= 0 ? "+" : "") + m.ev.toFixed(3)).padStart(10)}` +
          `${((m["net$"] >= 0 ? "+" : "-") + Math.abs(m["net$"]).toFixed(1)).padStart(9)}${("±" + (Number.isFinite(mde) ? mde.toFixed(1) : "inf")).padStart(9)}` +
          `  ${contains ? "UNDERPOWERED (CI contains cohort WR)" : "CI EXCLUDES cohort WR"}`,
      );
    }
    say();
  };

  bandReport("2(a) ADX", withAdx, [
    { name: "ADX < 15", test: (r) => (r.t!.adx as number) < 15 },
    { name: "15 <= ADX < 20", test: (r) => (r.t!.adx as number) >= 15 && (r.t!.adx as number) < 20 },
    { name: "20 <= ADX < 25", test: (r) => (r.t!.adx as number) >= 20 && (r.t!.adx as number) < 25 },
    { name: "25 <= ADX < 30", test: (r) => (r.t!.adx as number) >= 25 && (r.t!.adx as number) < 30 },
    { name: "ADX >= 30", test: (r) => (r.t!.adx as number) >= 30 },
  ]);
  bandReport("2(a) ADX — the binary the proposal would use", withAdx, [
    { name: "ADX < 20 (chop)", test: (r) => (r.t!.adx as number) < 20 },
    { name: "ADX >= 20", test: (r) => (r.t!.adx as number) >= 20 },
  ]);
  bandReport("2(b) regimeStrength", withRs, [
    { name: "rs < 0.55", test: (r) => (r.t!.regimeStrength as number) < 0.55 },
    { name: "0.55 <= rs < 0.70", test: (r) => (r.t!.regimeStrength as number) >= 0.55 && (r.t!.regimeStrength as number) < 0.7 },
    { name: "0.70 <= rs < 0.80", test: (r) => (r.t!.regimeStrength as number) >= 0.7 && (r.t!.regimeStrength as number) < 0.8 },
    { name: "rs >= 0.80", test: (r) => (r.t!.regimeStrength as number) >= 0.8 },
  ]);
  say("REGIME LABEL cross-tab (telemetry cohort):");
  {
    const byRegime = new Map<string, Row[]>();
    for (const r of rows) {
      const g = r.t?.regime;
      if (!g) continue;
      byRegime.set(g, [...(byRegime.get(g) ?? []), r]);
    }
    for (const [g, arr] of [...byRegime.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const m = metrics(arr.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
      const [lo, hi] = wilson(m.wins, m.n);
      const adxs = arr.map((r) => r.t?.adx).filter((v): v is number => v !== null && v !== undefined).sort((a, b) => a - b);
      say(
        `  ${g.padEnd(12)} n=${String(m.n).padStart(3)} WR=${m.wr.toFixed(1)}% [${lo.toFixed(1)},${hi.toFixed(1)}] ` +
          `EV=${(m.ev >= 0 ? "+" : "") + m.ev.toFixed(3)}R  median ADX=${adxs.length ? adxs[Math.floor(adxs.length / 2)].toFixed(1) : "n/a"}`,
      );
    }
  }
  say();

  // ══ ITEM 3 — DE-DUP ═══════════════════════════════════════════════════════
  hr("ITEM 3(b) — CONCURRENCY / PROXIMITY DISTRIBUTION, AND 3(a) COUNTERFACTUALS");
  {
    /** A prior signal is OPEN at time t on the canonical basis. */
    const openAt = (prior: Row, t: number): boolean =>
      prior.p.generatedMs <= t && (prior.resolvedAtBarTs === undefined || prior.resolvedAtBarTs > t);

    /** ATR used for the ATR-denominated distance; falls back to the book median. */
    const atrs = rows.map((r) => r.atr).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const medAtr = atrs[Math.floor(atrs.length / 2)];
    const atrOf = (r: Row): number => (Number.isFinite(r.atr) && r.atr > 0 ? r.atr : medAtr);
    say(`median telemetry ATR = ${medAtr.toFixed(2)} (used only where a signal has no ATR of its own; n with ATR=${atrs.length})`);
    say();

    // 3(b) — the distribution the proposal must be derived from.
    say("3(b) — signals emitted within N minutes AND within K x ATR of an OPEN same-direction signal");
    say("  N (min)".padEnd(10) + ["0.25", "0.5", "1.0", "1.5", "2.0"].map((k) => `<=${k}ATR`.padStart(10)).join("") + "   any-distance");
    for (const n of [4, 15, 30, 45, 60, 120]) {
      const counts: number[] = [];
      let anyDist = 0;
      for (const k of [0.25, 0.5, 1.0, 1.5, 2.0]) {
        let c = 0;
        for (let i = 0; i < rows.length; i++) {
          const cand = rows[i];
          const t = cand.p.generatedMs;
          const hit = rows.slice(0, i).some(
            (prior) =>
              prior.p.direction === cand.p.direction &&
              t - prior.p.generatedMs <= n * 60_000 &&
              openAt(prior, t) &&
              Math.abs(cand.p.entry - prior.p.entry) <= k * atrOf(cand),
          );
          if (hit) c++;
        }
        counts.push(c);
      }
      for (let i = 0; i < rows.length; i++) {
        const cand = rows[i];
        const t = cand.p.generatedMs;
        if (
          rows.slice(0, i).some(
            (prior) => prior.p.direction === cand.p.direction && t - prior.p.generatedMs <= n * 60_000 && openAt(prior, t),
          )
        )
          anyDist++;
      }
      say(String(n).padEnd(10) + counts.map((c) => String(c).padStart(10)).join("") + String(anyDist).padStart(15));
    }
    say(`  (denominator = ${rows.length} signals)`);
    say();

    // The raw distance distribution — this is what X must be derived from.
    const nearest: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cand = rows[i];
      const t = cand.p.generatedMs;
      let best = Number.POSITIVE_INFINITY;
      for (const prior of rows.slice(0, i)) {
        if (prior.p.direction !== cand.p.direction) continue;
        if (!openAt(prior, t)) continue;
        best = Math.min(best, Math.abs(cand.p.entry - prior.p.entry) / atrOf(cand));
      }
      if (Number.isFinite(best)) nearest.push(best);
    }
    nearest.sort((a, b) => a - b);
    const q = (p: number): number => nearest[Math.min(nearest.length - 1, Math.floor((nearest.length - 1) * p))];
    say(`3(c) INPUT — distance to the NEAREST open same-direction signal, in ATR units (n=${nearest.length} of ${rows.length}`);
    say(`  had any open same-direction signal at all):`);
    say(`  p05=${q(0.05).toFixed(2)}  p10=${q(0.1).toFixed(2)}  p25=${q(0.25).toFixed(2)}  p50=${q(0.5).toFixed(2)}  p75=${q(0.75).toFixed(2)}  p90=${q(0.9).toFixed(2)}`);
    const under = (k: number): string => `${nearest.filter((v) => v <= k).length} (${((nearest.filter((v) => v <= k).length / rows.length) * 100).toFixed(1)}% of the book)`;
    say(`  <=0.25 ATR: ${under(0.25)}    <=0.5 ATR: ${under(0.5)}    <=1.0 ATR: ${under(1.0)}    <=1.5 ATR: ${under(1.5)}`);
    say();

    // 3(a) — the three counterfactuals, each with volume cost and outcome mix.
    say("3(a) — WHAT EACH FIX WOULD ACTUALLY HAVE BLOCKED (chronological replay of the export)");
    say("  Live rule for reference: same-direction only, comparison window 4 min, distance");
    say("  |Δprice| * 1000 < 12  (the unit bug — a $1.40 gap computes as 1400 vs a threshold of 12).");
    say();

    interface Variant {
      name: string;
      windowMin: number;
      /** true => prior counts only while canonically open (no 5-min timer release). */
      statusLock: boolean;
      /** pip-denominated threshold with the *10 unit fix, or null when ATR-denominated. */
      pipThreshold: number | null;
      atrThreshold: number | null;
      lockReleaseMin: number | null;
    }
    const variants: Variant[] = [
      { name: "LIVE (as shipped, *1000)", windowMin: 4, statusLock: false, pipThreshold: null, atrThreshold: null, lockReleaseMin: 5 },
      { name: "(i) unit fix only (*10)", windowMin: 4, statusLock: false, pipThreshold: 12, atrThreshold: null, lockReleaseMin: 5 },
      { name: "(ii) unit fix + 30min win", windowMin: 30, statusLock: false, pipThreshold: 12, atrThreshold: null, lockReleaseMin: 5 },
      { name: "(ii) unit fix + 60min win", windowMin: 60, statusLock: false, pipThreshold: 12, atrThreshold: null, lockReleaseMin: 5 },
      { name: "(iii) all three, 0.5 ATR", windowMin: 1440, statusLock: true, pipThreshold: null, atrThreshold: 0.5, lockReleaseMin: null },
      { name: "(iii) all three, 1.0 ATR", windowMin: 1440, statusLock: true, pipThreshold: null, atrThreshold: 1.0, lockReleaseMin: null },
      { name: "(iii) all three, 1.5 ATR", windowMin: 1440, statusLock: true, pipThreshold: null, atrThreshold: 1.5, lockReleaseMin: null },
    ];

    say(
      "  variant".padEnd(28) +
        "blocked".padStart(9) +
        "kept".padStart(6) +
        "keptWR".padStart(8) +
        "keptEV(R)".padStart(11) +
        "keptNet$".padStart(10) +
        "blockedWR".padStart(11) +
        "blockedEV".padStart(11) +
        "blockedNet$".padStart(12),
    );
    for (const v of variants) {
      const kept: Row[] = [];
      const blocked: Row[] = [];
      for (let i = 0; i < rows.length; i++) {
        const cand = rows[i];
        const t = cand.p.generatedMs;
        // Only signals that were themselves KEPT can block a later one — a
        // suppressed signal never existed, so it holds no lock.
        const isBlocked = kept.some((prior) => {
          if (prior.p.direction !== cand.p.direction) return false;
          if (t - prior.p.generatedMs > v.windowMin * 60_000) return false;
          if (v.statusLock && !openAt(prior, t)) return false;
          if (v.lockReleaseMin !== null && t - prior.p.generatedMs > v.lockReleaseMin * 60_000 && !v.statusLock) {
            // the unconditional timer releases the lock regardless of state
            if (!openAt(prior, t)) return false;
          }
          const d = Math.abs(cand.p.entry - prior.p.entry);
          if (v.pipThreshold !== null) return d * 10 < v.pipThreshold;
          if (v.atrThreshold !== null) return d <= v.atrThreshold * atrOf(cand);
          // LIVE: the shipped *1000 conversion
          return d * 1000 < 12;
        });
        if (isBlocked) blocked.push(cand);
        else kept.push(cand);
      }
      const k = metrics(kept.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
      const b = metrics(blocked.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
      say(
        `  ${v.name.padEnd(26)}${String(blocked.length).padStart(9)}${String(kept.length).padStart(6)}` +
          `${k.wr.toFixed(1).padStart(8)}${((k.ev >= 0 ? "+" : "") + k.ev.toFixed(4)).padStart(11)}` +
          `${((k["net$"] >= 0 ? "+" : "-") + Math.abs(k["net$"]).toFixed(1)).padStart(10)}` +
          `${(blocked.length ? b.wr.toFixed(1) : "—").padStart(11)}` +
          `${(blocked.length ? (b.ev >= 0 ? "+" : "") + b.ev.toFixed(4) : "—").padStart(11)}` +
          `${(blocked.length ? (b["net$"] >= 0 ? "+" : "-") + Math.abs(b["net$"]).toFixed(1) : "—").padStart(12)}`,
      );
    }
    say();

    // The 3-Aug cluster, named explicitly, so the proposal can be checked against it.
    const clusterFrom = new Date("2026-08-03T16:00:00Z").getTime();
    const clusterTo = new Date("2026-08-03T17:30:00Z").getTime();
    const cluster = rows.filter((r) => r.p.generatedMs >= clusterFrom && r.p.generatedMs <= clusterTo);
    say(`THE 3-AUG 16:17-17:00 CLUSTER (${cluster.length} signals in 16:00-17:30Z):`);
    for (const r of cluster) {
      say(
        `  ${new Date(r.p.generatedMs).toISOString().slice(11, 19)}  ${r.p.direction} @ ${r.p.entry.toFixed(1)}  ` +
          `atr=${Number.isFinite(r.atr) ? r.atr.toFixed(2) : "n/a"}  adx=${r.t?.adx ?? "n/a"}  regime=${r.t?.regime ?? "n/a"}(${r.t?.regimeStrength ?? "n/a"})  ` +
          `canonical=${r.status.padEnd(18)} R=${(r.r >= 0 ? "+" : "") + r.r.toFixed(3)}`,
      );
    }
    const cm = metrics(cluster.map((r) => ({ r: r.r, pnlDollars: r.pnl })));
    say(
      `  cluster totals: n=${cm.n} WR=${cm.wr.toFixed(1)}% EV=${(cm.ev >= 0 ? "+" : "") + cm.ev.toFixed(4)}R ` +
        `net=${(cm["net$"] >= 0 ? "+$" : "-$") + Math.abs(cm["net$"]).toFixed(1)}`,
    );
    const cEntries = cluster.map((r) => r.p.entry);
    if (cEntries.length > 1) {
      say(`  entry spread: $${(Math.max(...cEntries) - Math.min(...cEntries)).toFixed(2)} across ${cEntries.length} signals`);
    }
  }
  say();
  hr("END — read-only. No file outside scripts/ was touched by this run.");
  console.log(out.join("\n"));
}

main().catch((e: unknown) => {
  console.error("analyze4Aug failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
