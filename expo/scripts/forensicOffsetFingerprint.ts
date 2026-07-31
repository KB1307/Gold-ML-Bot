/**
 * FORENSIC: per-week intraday volatility fingerprint of gold_m1_bars.
 *
 * WHY: the Friday-boundary forensic found the last bar of Fri 17 Jul and
 * Fri 24 Jul is stamped 22:41Z (broker 01:41 under +3.00h), whereas Fri 31 Jul
 * closes cleanly at 21:00Z (broker 00:00). The 101-minute excess is exactly the
 * signature of a writer using +1.32h instead of +3.00h.
 *
 * That leaves ONE question that decides whether the B1 counterfactual may use
 * the full 21,258-bar history or only the clean tail:
 *   Are the earlier weeks shifted WHOLESALE, or is only the Friday tail bad?
 *
 * DECISIVE TEST: gold's intraday volatility profile is a stable, venue-
 * independent fingerprint — a pronounced trough in the Asian session and sharp
 * peaks at the London open (~07:00Z) and the NY/COMEX open (~13:30Z). If a week
 * was written under a wrong offset, its ENTIRE profile shifts by the offset
 * error. We compute mean |high-low| per UTC hour per week, then cross-correlate
 * each week against the known-clean week to recover the shift in hours.
 *
 * A shift of 0h  => that week is correctly stamped (tail-only defect).
 * A shift of ~1.7h => that week is wholesale mis-stamped and MUST be excluded.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via the anon key.
 * No Rork backend. No GC=F/TwelveData. Nothing else feeds this.
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

/** Mean bar range per UTC hour, using only Mon-Thu full sessions (avoids the
 *  Friday-tail defect and the thin Sunday open contaminating the profile). */
function hourlyProfile(bars: Bar[]): { profile: number[]; counts: number[] } {
  const sum = new Array<number>(24).fill(0);
  const counts = new Array<number>(24).fill(0);
  for (const b of bars) {
    const d = new Date(b.timestamp);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 5 || dow === 6) continue; // Mon-Thu only
    const h = d.getUTCHours();
    sum[h] += b.high - b.low;
    counts[h] += 1;
  }
  const profile = sum.map((s, i) => (counts[i] > 0 ? s / counts[i] : 0));
  return { profile, counts };
}

/** Circular cross-correlation: find the integer hour shift maximising similarity. */
function bestShift(ref: number[], test: number[]): { shift: number; corr: number; all: number[] } {
  const norm = (a: number[]): number[] => {
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    return sd > 0 ? a.map((v) => (v - m) / sd) : a.map(() => 0);
  };
  const r = norm(ref);
  const t = norm(test);
  const all: number[] = [];
  let bestS = 0;
  let bestC = -Infinity;
  for (let s = 0; s < 24; s++) {
    let c = 0;
    for (let i = 0; i < 24; i++) c += r[i] * t[(i + s) % 24];
    c /= 24;
    all.push(c);
    if (c > bestC) {
      bestC = c;
      bestS = s;
    }
  }
  // express shift in [-12, +12]
  const signed = bestS > 12 ? bestS - 24 : bestS;
  return { shift: signed, corr: bestC, all };
}

function bar(v: number, max: number): string {
  return "#".repeat(Math.max(0, Math.round((v / max) * 50)));
}

async function main(): Promise<void> {
  console.log("=".repeat(92));
  console.log("FORENSIC — per-week intraday volatility fingerprint (offset-shift detector)");
  console.log(`run at: ${new Date().toISOString()}`);
  console.log("source: Supabase gold_m1_bars, anon key, direct. No backend. No GC=F/TwelveData.");
  console.log("=".repeat(92));

  const weeks = [
    { label: "W1 13-17 Jul", from: "2026-07-13T00:00:00Z", to: "2026-07-17T23:59:59Z" },
    { label: "W2 20-24 Jul", from: "2026-07-20T00:00:00Z", to: "2026-07-24T23:59:59Z" },
    { label: "W3 27-31 Jul", from: "2026-07-27T00:00:00Z", to: "2026-07-31T23:59:59Z" },
  ];

  const profiles: { label: string; profile: number[]; counts: number[]; n: number }[] = [];

  for (const w of weeks) {
    const bars = await fetchRange(w.from, w.to);
    const { profile, counts } = hourlyProfile(bars);
    profiles.push({ label: w.label, profile, counts, n: bars.length });
    console.log(`\n${w.label}: ${bars.length} bars total, ${counts.reduce((a, b) => a + b, 0)} Mon-Thu bars used`);
  }

  const gmax = Math.max(...profiles.flatMap((p) => p.profile));

  for (const p of profiles) {
    console.log(`\n${"-".repeat(92)}`);
    console.log(`${p.label} — mean bar range (high-low) by UTC hour, Mon-Thu only`);
    console.log(`${"-".repeat(92)}`);
    const peak = p.profile.indexOf(Math.max(...p.profile));
    for (let h = 0; h < 24; h++) {
      const marker = h === peak ? "  <== PEAK" : "";
      console.log(
        `  ${String(h).padStart(2, "0")}:00Z  ${p.profile[h].toFixed(3).padStart(7)}  n=${String(p.counts[h]).padStart(4)}  ${bar(p.profile[h], gmax)}${marker}`,
      );
    }
    // top 3 hours
    const ranked = p.profile
      .map((v, h) => ({ v, h }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    console.log(`  top-3 volatility hours: ${ranked.map((r) => `${String(r.h).padStart(2, "0")}:00Z(${r.v.toFixed(2)})`).join(", ")}`);
    const quiet = p.profile
      .map((v, h) => ({ v, h }))
      .sort((a, b) => a.v - b.v)
      .slice(0, 3);
    console.log(`  quietest 3 hours:       ${quiet.map((r) => `${String(r.h).padStart(2, "0")}:00Z(${r.v.toFixed(2)})`).join(", ")}`);
  }

  // ── cross-correlate every week against W3 (the known-clean week) ──────────
  console.log(`\n${"=".repeat(92)}`);
  console.log("CROSS-CORRELATION vs W3 27-31 Jul (the week whose Friday close is verifiably +3.00h clean)");
  console.log("=".repeat(92));
  const ref = profiles[profiles.length - 1];
  for (const p of profiles) {
    const { shift, corr, all } = bestShift(ref.profile, p.profile);
    console.log(`\n  ${p.label} vs ${ref.label}:`);
    console.log(`    best-fit shift = ${shift >= 0 ? "+" : ""}${shift}h   correlation = ${corr.toFixed(4)}`);
    console.log(`    correlation by candidate shift (0..23h):`);
    const line = all
      .map((c, i) => `${String(i).padStart(2)}h:${c.toFixed(2)}`)
      .reduce<string[]>((acc, s, i) => {
        const row = Math.floor(i / 6);
        acc[row] = (acc[row] ?? "") + s.padEnd(11);
        return acc;
      }, []);
    for (const l of line) console.log(`      ${l}`);
    if (p.label === ref.label) {
      console.log(`    (self-comparison — must be shift 0, corr 1.00; sanity check on the method)`);
    } else if (shift === 0) {
      console.log(`    -> VERDICT: NO wholesale offset shift. This week's body is correctly stamped.`);
    } else {
      console.log(`    -> VERDICT: WHOLESALE SHIFT of ${shift}h detected. This week must be EXCLUDED.`);
    }
  }

  // ── absolute anchor: NY/COMEX open should be the daily volatility peak ────
  console.log(`\n${"=".repeat(92)}`);
  console.log("ABSOLUTE ANCHOR — gold's volatility peak should sit at the London (07-08Z)");
  console.log("and NY/COMEX (13-14Z) opens. A correctly stamped week peaks there.");
  console.log("=".repeat(92));
  for (const p of profiles) {
    const peak = p.profile.indexOf(Math.max(...p.profile));
    const okWindow = (peak >= 7 && peak <= 8) || (peak >= 13 && peak <= 15);
    console.log(
      `  ${p.label.padEnd(14)} peak hour = ${String(peak).padStart(2, "0")}:00Z  -> ${okWindow ? "CONSISTENT with a correct +3.00h stamp" : "OFF-ANCHOR — investigate"}`,
    );
  }

  console.log(`\n${"=".repeat(92)}`);
  console.log("FINGERPRINT COMPLETE");
  console.log("=".repeat(92));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
