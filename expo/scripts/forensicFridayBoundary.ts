/**
 * FORENSIC: Friday-close / Sunday-open boundary integrity in gold_m1_bars.
 *
 * Triggered by the cleanup-verification run, which found the sole >1min gap in
 * the last 10 days runs 2026-07-24T22:41:00Z -> 2026-07-26T22:00:00Z.
 * 22:41 is the EXACT fingerprint attributed to the corrupt +1.25h writer
 * (frozen broker bar 23:56 minus 1.25h = 22:41). A bar carrying that signature
 * on 24 Jul must be explained, not assumed clean.
 *
 * Applies the agreed forensic technique: back-calculate the writer's offset
 * from the mis-stamped timestamp, assuming the broker's true offset is +3.00h.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via the anon key.
 * No Rork backend. No GC=F/TwelveData.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
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
const anon: SupabaseClient = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL as string,
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

const TRUE_OFFSET_H = 3.0;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function fetchRange(fromIso: string, toIso: string): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const res = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (res.error) throw new Error(res.error.message);
    const rows = (res.data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

function fmt(b: Bar): string {
  const d = new Date(b.timestamp);
  const range = (b.high - b.low).toFixed(2);
  const brokerH = new Date(d.getTime() + TRUE_OFFSET_H * 3_600_000);
  return `    ${b.timestamp}  (${DOW[d.getUTCDay()]})  broker=${brokerH.toISOString().slice(11, 16)}  O=${String(b.open).padEnd(8)} H=${String(b.high).padEnd(8)} L=${String(b.low).padEnd(8)} C=${String(b.close).padEnd(8)} range=${range.padStart(5)}`;
}

/** Back-calculate what offset a writer used, given the broker's frozen last bar. */
function backCalcOffset(stampedIso: string, assumedBrokerHHMM: string): number {
  const d = new Date(stampedIso);
  const [bh, bm] = assumedBrokerHHMM.split(":").map(Number);
  const stampedMinOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const brokerMinOfDay = bh * 60 + bm;
  let diff = brokerMinOfDay - stampedMinOfDay;
  if (diff < -720) diff += 1440;
  if (diff > 720) diff -= 1440;
  return diff / 60;
}

async function main(): Promise<void> {
  console.log("=".repeat(84));
  console.log("FORENSIC — Friday-close / Sunday-open boundary integrity");
  console.log(`run at: ${new Date().toISOString()}   assumed true broker offset: +${TRUE_OFFSET_H.toFixed(2)}h`);
  console.log("=".repeat(84));

  const weeks = [
    { label: "Fri 2026-07-17 close", from: "2026-07-17T19:00:00Z", to: "2026-07-17T23:59:59Z" },
    { label: "Sun 2026-07-19 open", from: "2026-07-19T18:00:00Z", to: "2026-07-19T23:59:59Z" },
    { label: "Fri 2026-07-24 close", from: "2026-07-24T19:00:00Z", to: "2026-07-24T23:59:59Z" },
    { label: "Sun 2026-07-26 open", from: "2026-07-26T18:00:00Z", to: "2026-07-26T23:59:59Z" },
    { label: "Fri 2026-07-31 close", from: "2026-07-31T19:00:00Z", to: "2026-07-31T23:59:59Z" },
  ];

  const lastBars: Record<string, string> = {};

  for (const w of weeks) {
    const bars = await fetchRange(w.from, w.to);
    console.log(`\n${"-".repeat(84)}`);
    console.log(`${w.label}   window ${w.from} -> ${w.to}   bars=${bars.length}`);
    console.log(`${"-".repeat(84)}`);
    if (bars.length === 0) {
      console.log("    (no bars)");
      continue;
    }
    console.log(`  FIRST bar in window:`);
    console.log(fmt(bars[0]));
    console.log(`  LAST 8 bars in window:`);
    for (const b of bars.slice(-8)) console.log(fmt(b));
    lastBars[w.label] = bars[bars.length - 1].timestamp;

    // frozen-tick detector: consecutive identical OHLC
    let frozen = 0;
    for (let i = 1; i < bars.length; i++) {
      const p = bars[i - 1];
      const c = bars[i];
      if (p.open === c.open && p.high === c.high && p.low === c.low && p.close === c.close) frozen++;
    }
    console.log(`  consecutive-identical-OHLC (frozen-tick) bars in window: ${frozen}`);

    // zero-range detector
    const zeroRange = bars.filter((b) => b.high === b.low).length;
    console.log(`  zero-range (H==L) bars in window: ${zeroRange}`);
  }

  // ── the 22:41 signature ───────────────────────────────────────────────────
  console.log(`\n${"=".repeat(84)}`);
  console.log("THE 22:41 SIGNATURE — back-calculating the writer offset");
  console.log("=".repeat(84));
  console.log(`  Known-bad reference: a bar stamped 2026-07-31T22:41Z was traced to a writer`);
  console.log(`  using +1.25h against a frozen broker bar of 23:56.`);
  console.log(`    check: broker 23:56 - 1.25h = ${backCalcOffset("2026-07-31T22:41:00Z", "23:56").toFixed(2)}h implied -> ${Math.abs(backCalcOffset("2026-07-31T22:41:00Z", "23:56") - 1.25) < 0.01 ? "MATCHES the +1.25h writer" : "does not match"}`);

  const suspect = await fetchRange("2026-07-24T22:30:00Z", "2026-07-24T23:59:59Z");
  console.log(`\n  Bars on 2026-07-24 at/after 22:30Z: ${suspect.length}`);
  for (const b of suspect) console.log(fmt(b));

  if (suspect.length > 0) {
    const last = suspect[suspect.length - 1];
    console.log(`\n  Back-calc for the 24 Jul tail bar ${last.timestamp}:`);
    for (const brokerClose of ["23:56", "23:59", "00:00", "01:41"]) {
      console.log(
        `    if broker's true last bar was ${brokerClose} -> writer offset implied = ${backCalcOffset(last.timestamp, brokerClose).toFixed(2)}h`,
      );
    }
  }

  // ── weekly close-time consistency table ───────────────────────────────────
  console.log(`\n${"=".repeat(84)}`);
  console.log("WEEKLY BOUNDARY CONSISTENCY (a clean +3.00h writer should be identical each week)");
  console.log("=".repeat(84));
  for (const [k, v] of Object.entries(lastBars)) {
    const d = new Date(v);
    const broker = new Date(d.getTime() + TRUE_OFFSET_H * 3_600_000);
    console.log(
      `  ${k.padEnd(24)} last bar = ${v}  -> broker time ${broker.toISOString().slice(11, 16)}  (implied offset if broker close is 00:00: ${backCalcOffset(v, "00:00").toFixed(2)}h)`,
    );
  }

  // ── whole-table sweep for any bar with a suspicious post-close stamp ──────
  console.log(`\n${"=".repeat(84)}`);
  console.log("WHOLE-TABLE SWEEP — every bar stamped Fri >21:05Z or Sat (post-close territory)");
  console.log("=".repeat(84));
  const all = await fetchRange("2026-07-13T00:00:00Z", "2026-08-01T00:00:00Z");
  console.log(`  total bars swept: ${all.length}`);
  const postClose = all.filter((b) => {
    const d = new Date(b.timestamp);
    const dow = d.getUTCDay();
    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (dow === 6) return true; // any Saturday bar
    if (dow === 5 && minOfDay > 21 * 60 + 5) return true; // Friday after 21:05Z
    return false;
  });
  console.log(`  bars in post-close territory: ${postClose.length}`);
  for (const b of postClose) {
    console.log(fmt(b));
    console.log(
      `        -> implied writer offset if broker close was 00:00: ${backCalcOffset(b.timestamp, "00:00").toFixed(2)}h   (true is +3.00h)`,
    );
  }

  // ── duplicate timestamp check across whole table ─────────────────────────
  console.log(`\n${"=".repeat(84)}`);
  console.log("DUPLICATE / NON-MONOTONIC TIMESTAMP CHECK (whole table)");
  console.log("=".repeat(84));
  const seen = new Set<string>();
  let dupes = 0;
  let nonMono = 0;
  let prevMs = -1;
  for (const b of all) {
    if (seen.has(b.timestamp)) {
      dupes++;
      if (dupes <= 10) console.log(`  DUPLICATE: ${b.timestamp}`);
    }
    seen.add(b.timestamp);
    const ms = new Date(b.timestamp).getTime();
    if (ms <= prevMs) nonMono++;
    prevMs = ms;
  }
  console.log(`  duplicates: ${dupes}   non-monotonic: ${nonMono}`);

  // ── global frozen-tick sweep ─────────────────────────────────────────────
  let globalFrozen = 0;
  const frozenRuns: { start: string; len: number }[] = [];
  let runStart: string | null = null;
  let runLen = 0;
  for (let i = 1; i < all.length; i++) {
    const p = all[i - 1];
    const c = all[i];
    const same = p.open === c.open && p.high === c.high && p.low === c.low && p.close === c.close;
    if (same) {
      globalFrozen++;
      if (runStart === null) {
        runStart = p.timestamp;
        runLen = 2;
      } else runLen++;
    } else if (runStart !== null) {
      frozenRuns.push({ start: runStart, len: runLen });
      runStart = null;
      runLen = 0;
    }
  }
  if (runStart !== null) frozenRuns.push({ start: runStart, len: runLen });
  console.log(`\n  whole-table consecutive-identical-OHLC bars: ${globalFrozen}`);
  frozenRuns.sort((a, b) => b.len - a.len);
  console.log(`  longest frozen runs:`);
  for (const r of frozenRuns.slice(0, 10)) console.log(`    ${r.start}  run length ${r.len}`);
  if (frozenRuns.length === 0) console.log(`    none — no frozen-tick residue in the table`);

  console.log(`\n${"=".repeat(84)}`);
  console.log("FORENSIC COMPLETE");
  console.log("=".repeat(84));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
