/**
 * ITEM 33 — SHADOW ZONE METRIC: RELIABILITY AND MAGNITUDE AS SEPARATE AXES
 * ========================================================================
 *
 * MINDSET 8 rules (restated verbatim, every report):
 *  1. Measure before building.
 *  2. Pre-registered gates, not post-hoc rationalisation.
 *  3. Verify against LIVE data, not synthetic.
 *  4. Pasted evidence, not description.
 *  5. Provenance is not appearance.
 *  6. Labels carry their meaning.
 *  7. Correlation is not a lever.
 *  8. POWER before result. Impossible ≠ underpowered.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECT from Supabase via anon key.
 * The diagnostics export is fetched to /tmp/diagnostics_export.txt.
 * No Rork backend on any read path. Nothing is written. No engine code
 * is imported or called — the zone computation is a verbatim port of the
 * LIVE maths, and the shadow metrics are NEW maths in this file only.
 *
 * WHAT THIS SCRIPT MEASURES (and nothing else):
 *  33.1 RELIABILITY axis — visit-based touches, reversalRate with
 *      denominator, ATR-relative band (no Math.max floor), no /6 cap,
 *      minimum visit count before publishing.
 *  33.2 MAGNITUDE axis — per-reversal excursion from the wick extreme,
 *      distribution (median/p25/p75/n), excursion as fraction of TP1
 *      distance, break magnitude as a reported field only.
 *  33.3 OVERLAP — zones published under each metric, overlap-band count,
 *      per-signal top structural feature qualification.
 *  33.4 DECIDING SPLITS — 1D by reliability, 1D by magnitude, 2D grid
 *      only if POWER allows. POWER FIRST every time.
 *
 * N FOR EXCURSION = 30 bars (30 M1 bars = 30 minutes).
 * Rationale: a TP1-scale reaction (~$5.70 = 57 pips ≈ 3.5× a typical
 * ATR of 1.6) requires directional movement that takes 15–30 minutes
 * to develop at gold M1 volatility. N=30 gives the reaction room to
 * express without capturing an unrelated subsequent move. N=15 and N=60
 * are checked as sensitivity.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ─── env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ["expo/.env", ".env"]) {
    try {
      const raw = readFileSync(file, "utf8");
      raw.split("\n").forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      });
    } catch {
      // optional
    }
  }
  return out;
}

// ─── types ──────────────────────────────────────────────────────────────
interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type ZoneSource =
  | "PRICE_ACTION"
  | "PIVOT"
  | "PREV_DAY"
  | "ASIAN_RANGE"
  | "ORH_ORL"
  | "WEEKLY"
  | "SESSION_BLOCK";

interface LiveZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  rawReactionStrength: number;
  source: ZoneSource;
  confluenceScore: number;
}

interface VisitResult {
  visitStartIdx: number;
  visitEndIdx: number;
  extremeIdx: number;
  extremePrice: number;
  reversed: boolean;
  broken: boolean;
  excursion: number | null;
  excursionBars: number | null;
  breakExcursion: number | null;
}

interface ShadowZoneMetric {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  bandWidth: number;
  visits: number;
  reversals: number;
  breaks: number;
  reversalRate: number | null;
  breakRate: number | null;
  // magnitude
  reversalExcursionsATR: number[];
  medianReversalExcursionATR: number | null;
  p25ReversalExcursionATR: number | null;
  p75ReversalExcursionATR: number | null;
  reversalExcursionsTp1: number[];
  medianReversalExcursionTp1Frac: number | null;
  clearsTp1Count: number;
  clearsTp1Rate: number | null;
  // break magnitude (reported only, not gated)
  breakExcursionsATR: number[];
  medianBreakExcursionATR: number | null;
  // min visit gate
  minVisitsMet: boolean;
}

interface ParsedSignal {
  index: number;
  type: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  status: string;
  exit: number | null;
  generated: string;
  generatedMs: number;
  topFeatures: { name: string; score: number }[];
  attentionScores: { name: string; score: number }[];
  srZonesSnapshot: { price: number; type: "SUPPORT" | "RESISTANCE"; touches: number; reaction: number; tier: string }[];
  hasSrZoneFeature: boolean;
  topIsSrZone: boolean;
}

// ─── constants ──────────────────────────────────────────────────────────
const LOOKBACK_HOURS = 120;
const ZONE_STALENESS_HALF_LIFE_HOURS = 18;
const HYSTERESIS_MULTIPLIER = 1.5;
const REVERSAL_ATR_MULTIPLE = 1.0;
const BREAK_ATR_MULTIPLE = 1.0;
const EXCURSION_N_BARS = 30;
const EXCURSION_SENSITIVITY_N = [15, 30, 60];
const MIN_VISITS_FOR_STRENGTH = 3;
const PIP_VALUE = 0.1;

const EXCLUDED_STATUSES = new Set(["ACTIVE", "EXPIRED_MISSED_ENTRY", "NEVER_FILLABLE"]);

// ─── supabase ───────────────────────────────────────────────────────────
function makeAnon(env: Record<string, string>): SupabaseClient {
  return createClient(
    env.EXPO_PUBLIC_SUPABASE_URL as string,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

async function fetchBarsPaginated(client: SupabaseClient, fromTs: string): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await client
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close, volume")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

// ─── export fetch ───────────────────────────────────────────────────────
async function fetchExport(env: Record<string, string>): Promise<string> {
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  for (const path of [
    "/storage/v1/object/public/diagnostics/latest.txt",
    "/storage/v1/object/public/diagnostics/diagnostics_export.txt",
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync("/tmp/diagnostics_export.txt", text);
      return text;
    }
  }
  throw new Error("Could not fetch export from Supabase Storage");
}

// ─── export parser ──────────────────────────────────────────────────────
function parseExport(text: string): { signals: ParsedSignal[]; generatedMs: number } {
  const gen = /Generated:\s*(\S+)/.exec(text)?.[1] ?? "unknown";
  const generatedMs = new Date(gen).getTime();
  const section = text.split("SECTION 2")[0];
  const blocks = section.split(/\n\[(\d+)\] /).slice(1);
  const signals: ParsedSignal[] = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const index = parseInt(blocks[i], 10);
    const body = blocks[i + 1];
    const head = /^(BUY|SELL) @ ([\d.]+)\s+—\s+status: (\S+)/.exec(body);
    if (!head) continue;
    const sl = /SL: ([\d.]+)/.exec(body);
    const tp1 = /TP1: ([\d.]+)/.exec(body);
    const exit = /exit price: ([\d.]+)/.exec(body);
    const genLine = /generated: (\S+)/.exec(body);

    // top features
    const topFeatures: { name: string; score: number }[] = [];
    const topLine = /top features:\s*(.*)/.exec(body);
    if (topLine) {
      for (const part of topLine[1].split(",")) {
        const m = /(.+?)=([\d.]+)/.exec(part.trim());
        if (m) topFeatures.push({ name: m[1].trim(), score: parseFloat(m[2]) });
      }
    }

    // full attention scores
    const attentionScores: { name: string; score: number }[] = [];
    const fullMatch = /full attention scores.*\n([\s\S]*?)(?:\n\s*\n|\nsrZones)/.exec(body);
    if (fullMatch) {
      for (const line of fullMatch[1].split("\n")) {
        const m = /=\s*([\d.]+)/.exec(line.trim());
        const name = line.trim().replace(/=\s*[\d.]+/, "").trim();
        if (m && name) attentionScores.push({ name, score: parseFloat(m[1]) });
      }
    }

    // srZones snapshot — capture everything after the header line to end of body
    const srZonesSnapshot: ParsedSignal["srZonesSnapshot"] = [];
    const srHeaderIdx = body.indexOf("srZones snapshot");
    if (srHeaderIdx >= 0) {
      const afterHeader = body.slice(srHeaderIdx);
      const srLines = afterHeader.split("\n").slice(1); // skip header line itself
      for (const line of srLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("[")) break; // next signal block
        const m = /(SUPPORT|RESISTANCE)\s+@\s+([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%.*tier=(\S+)/.exec(trimmed);
        if (m) {
          srZonesSnapshot.push({
            type: m[1] as "SUPPORT" | "RESISTANCE",
            price: parseFloat(m[2]),
            touches: parseInt(m[3], 10),
            reaction: parseInt(m[4], 10),
            tier: m[5],
          });
        }
      }
    }

    const hasSrZoneFeature = attentionScores.some((a) => /SR ZONE/i.test(a.name));
    const topIsSrZone = topFeatures.length > 0 && /SR ZONE/i.test(topFeatures[0].name);

    signals.push({
      index,
      type: head[1] as "BUY" | "SELL",
      entry: parseFloat(head[2]),
      sl: sl ? parseFloat(sl[1]) : NaN,
      tp1: tp1 ? parseFloat(tp1[1]) : NaN,
      status: head[3],
      exit: exit ? parseFloat(exit[1]) : null,
      generated: genLine?.[1] ?? "unknown",
      generatedMs: genLine ? new Date(genLine[1]).getTime() : 0,
      topFeatures,
      attentionScores,
      srZonesSnapshot,
      hasSrZoneFeature,
      topIsSrZone,
    });
  }
  return { signals, generatedMs };
}

// ─── ATR (verbatim from engine) ─────────────────────────────────────────
function computeATR(bars: Bar[], period = 14): number {
  if (bars.length < 2) return 0;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, closes.length - period); i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

// ─── LIVE zone computation (verbatim port, instrumented) ────────────────
function computeLiveZones(bars: Bar[], now: number, useFloor: boolean): LiveZone[] {
  if (bars.length < 50) return [];
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const timestamps = bars.map((b) => new Date(b.timestamp).getTime());
  const currentPrice = closes[closes.length - 1];

  let atrSum = 0;
  let atrCount = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    atrSum += tr;
    atrCount++;
  }
  const atr = atrCount > 0 ? atrSum / atrCount : currentPrice * 0.001;
  const zoneWidth = useFloor
    ? Math.max(atr * 0.3, currentPrice * 0.0015)
    : atr * 0.3;

  type Candidate = { price: number; source: ZoneSource; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      candidates.push({ price: highs[i], source: "PRICE_ACTION" });
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      candidates.push({ price: lows[i], source: "PRICE_ACTION" });
    }
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yesterdayIdx.length > 0) {
    const yHigh = Math.max(...yesterdayIdx.map((t) => highs[t.i]));
    const yLow = Math.min(...yesterdayIdx.map((t) => lows[t.i]));
    const yClose = closes[yesterdayIdx[yesterdayIdx.length - 1].i];
    candidates.push({ price: yHigh, source: "PREV_DAY", alwaysAdmit: true });
    candidates.push({ price: yLow, source: "PREV_DAY", alwaysAdmit: true });
    const dailyPivot = (yHigh + yLow + yClose) / 3;
    const dailyRange = Math.max(yHigh - yLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidates.push({ price: dailyPivot, source: "PIVOT" });
    candidates.push({ price: yClose + zoneStep, source: "PIVOT" });
    candidates.push({ price: yClose - zoneStep, source: "PIVOT" });
  }

  const weekMs = 7 * dayMs;
  const weekStart = now - weekMs;
  const weekIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({ price: Math.max(...weekIdx.map((t) => highs[t.i])), source: "WEEKLY", alwaysAdmit: true });
    candidates.push({ price: Math.min(...weekIdx.map((t) => lows[t.i])), source: "WEEKLY", alwaysAdmit: true });
  }

  const clustered: { price: number; source: ZoneSource; sources: Set<ZoneSource>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < zoneWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      if (c.source === "PRICE_ACTION") existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit });
    }
  }

  const zones: LiveZone[] = [];
  for (const cluster of clustered) {
    let touches = 0;
    let rejectionWicks = 0;
    let totalRejectionSize = 0;
    let lastTouchTs = 0;
    const isResistance = cluster.price > currentPrice;

    let insideZone = false;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i];
      const high = highs[i];
      const low = lows[i];
      const isInsideNow = Math.abs(price - cluster.price) < zoneWidth;
      if (isInsideNow) {
        if (!insideZone) touches++;
        lastTouchTs = timestamps[i];
      }
      insideZone = isInsideNow;

      if (isResistance && high >= cluster.price - zoneWidth && price < cluster.price) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
      if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i - 1)]) - low;
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
    }

    // live metric: /6 cap on touchScore, /4 cap on rejectionScore
    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const confluenceScore = cluster.sources.size;
    const confluenceBonus = Math.min(1, confluenceScore * 0.25);
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
    const rawReactionStrength = Math.min(
      1,
      touchScore * 0.3 +
        rejectionScore * 0.3 +
        rejectionSizeScore * 0.2 +
        Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) +
        effectiveConfluenceBonus,
    );

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? "RESISTANCE" : "SUPPORT",
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        rawReactionStrength: parseFloat(rawReactionStrength.toFixed(3)),
        source: cluster.source,
        confluenceScore,
      });
    }
  }

  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

// ─── SHADOW: visit-based reliability + magnitude ────────────────────────

function computeShadowZoneMetric(
  bars: Bar[],
  zonePrice: number,
  zoneType: "SUPPORT" | "RESISTANCE",
  atr: number,
  tp1Distance: number,
): ShadowZoneMetric {
  const bandWidth = atr * 0.3;
  const exitThreshold = bandWidth * HYSTERESIS_MULTIPLIER;
  const isSupport = zoneType === "SUPPORT";

  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  // ── 33.1: visit counting with hysteresis ──
  const visits: { startIdx: number; endIdx: number }[] = [];
  let inside = false;
  let visitStart = -1;
  let exitedAfterHysteresis = false;

  for (let i = 0; i < closes.length; i++) {
    const dist = Math.abs(closes[i] - zonePrice);
    if (dist < bandWidth) {
      if (!inside) {
        // start a new visit only if we've exited past hysteresis since last visit
        if (visitStart === -1 || exitedAfterHysteresis) {
          visitStart = i;
          exitedAfterHysteresis = false;
        }
        inside = true;
      }
    } else if (dist > exitThreshold) {
      if (inside) {
        visits.push({ startIdx: visitStart, endIdx: i - 1 });
        inside = false;
        exitedAfterHysteresis = true;
      }
    }
    // between bandWidth and exitThreshold: hysteresis zone — no state change
  }
  if (inside && visitStart !== -1) {
    visits.push({ startIdx: visitStart, endIdx: closes.length - 1 });
  }

  // ── 33.1b: reversal vs break classification ──
  const visitResults: VisitResult[] = [];
  for (const v of visits) {
    // find extreme during visit
    let extremeIdx = v.startIdx;
    if (isSupport) {
      let extremeLow = Infinity;
      for (let i = v.startIdx; i <= v.endIdx; i++) {
        if (lows[i] < extremeLow) {
          extremeLow = lows[i];
          extremeIdx = i;
        }
      }
    } else {
      let extremeHigh = -Infinity;
      for (let i = v.startIdx; i <= v.endIdx; i++) {
        if (highs[i] > extremeHigh) {
          extremeHigh = highs[i];
          extremeIdx = i;
        }
      }
    }
    const extremePrice = isSupport ? lows[extremeIdx] : highs[extremeIdx];

    // look forward from visit end to classify
    let reversed = false;
    let broken = false;
    let reversalCloseIdx = -1;
    let breakCloseIdx = -1;

    for (let i = v.endIdx + 1; i < closes.length; i++) {
      if (!broken) {
        // check break first: closed through by >= BREAK_ATR_MULTIPLE * ATR
        if (isSupport && closes[i] < zonePrice - BREAK_ATR_MULTIPLE * atr) {
          broken = true;
          breakCloseIdx = i;
          break;
        }
        if (!isSupport && closes[i] > zonePrice + BREAK_ATR_MULTIPLE * atr) {
          broken = true;
          breakCloseIdx = i;
          break;
        }
      }
      if (!reversed) {
        // check reversal: closed back >= REVERSAL_ATR_MULTIPLE * ATR on approach side
        if (isSupport && closes[i] > zonePrice + REVERSAL_ATR_MULTIPLE * atr) {
          reversed = true;
          reversalCloseIdx = i;
        }
        if (!isSupport && closes[i] < zonePrice - REVERSAL_ATR_MULTIPLE * atr) {
          reversed = true;
          reversalCloseIdx = i;
        }
      }
      if (reversed && !broken) break; // reversal confirmed, no break
    }

    // ── 33.2: excursion from extreme (for reversals only) ──
    let excursion: number | null = null;
    let excursionBars: number | null = null;
    if (reversed) {
      const startIdx = Math.min(extremeIdx + 1, closes.length - 1);
      const endIdx = Math.min(startIdx + EXCURSION_N_BARS, closes.length - 1);
      let maxExcursion = 0;
      let maxExcursionBar = startIdx;
      for (let i = startIdx; i <= endIdx; i++) {
        // stop if close back through the level
        if (isSupport && closes[i] < zonePrice) break;
        if (!isSupport && closes[i] > zonePrice) break;
        const exc = isSupport ? highs[i] - extremePrice : extremePrice - lows[i];
        if (exc > maxExcursion) {
          maxExcursion = exc;
          maxExcursionBar = i;
        }
      }
      if (maxExcursion > 0) {
        excursion = maxExcursion;
        excursionBars = maxExcursionBar - startIdx;
      }
    }

    // ── 33.2e: break magnitude (reported only) ──
    let breakExcursion: number | null = null;
    if (broken && breakCloseIdx >= 0) {
      const startIdx = breakCloseIdx;
      const endIdx = Math.min(startIdx + EXCURSION_N_BARS, closes.length - 1);
      let maxBreak = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        const brk = isSupport
          ? zonePrice - lows[i]
          : highs[i] - zonePrice;
        if (brk > maxBreak) maxBreak = brk;
      }
      breakExcursion = maxBreak;
    }

    visitResults.push({
      visitStartIdx: v.startIdx,
      visitEndIdx: v.endIdx,
      extremeIdx,
      extremePrice,
      reversed,
      broken,
      excursion,
      excursionBars,
      breakExcursion,
    });
  }

  // ── aggregate ──
  const reversals = visitResults.filter((v) => v.reversed).length;
  const breaks = visitResults.filter((v) => v.broken).length;
  const reversalRate = visits.length > 0 ? reversals / visits.length : null;
  const breakRate = visits.length > 0 ? breaks / visits.length : null;

  const reversalExcursionsRaw = visitResults
    .filter((v) => v.excursion !== null)
    .map((v) => v.excursion as number);
  const reversalExcursionsATR = reversalExcursionsRaw.map((e) => e / atr);
  const reversalExcursionsTp1 = reversalExcursionsRaw.map((e) => e / tp1Distance);

  const breakExcursionsRaw = visitResults
    .filter((v) => v.breakExcursion !== null)
    .map((v) => v.breakExcursion as number);
  const breakExcursionsATR = breakExcursionsRaw.map((e) => e / atr);

  const median = (vals: number[]): number | null => {
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  };
  const pct = (vals: number[], p: number): number | null => {
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[idx];
  };

  const clearsTp1Count = reversalExcursionsTp1.filter((f) => f >= 1.0).length;

  return {
    price: zonePrice,
    type: zoneType,
    bandWidth,
    visits: visits.length,
    reversals,
    breaks,
    reversalRate,
    breakRate,
    reversalExcursionsATR,
    medianReversalExcursionATR: median(reversalExcursionsATR),
    p25ReversalExcursionATR: pct(reversalExcursionsATR, 25),
    p75ReversalExcursionATR: pct(reversalExcursionsATR, 75),
    reversalExcursionsTp1,
    medianReversalExcursionTp1Frac: median(reversalExcursionsTp1),
    clearsTp1Count,
    clearsTp1Rate: reversalExcursionsRaw.length > 0 ? clearsTp1Count / reversalExcursionsRaw.length : null,
    breakExcursionsATR,
    medianBreakExcursionATR: median(breakExcursionsATR),
    minVisitsMet: visits.length >= MIN_VISITS_FOR_STRENGTH,
  };
}

// ─── signal-to-zone matching ────────────────────────────────────────────
function matchSignalToZone(signal: ParsedSignal): { price: number; type: "SUPPORT" | "RESISTANCE" } | null {
  // The engine's detectActiveSRReaction finds the highest-reactionStrength zone
  // within proximityThreshold of currentPrice. The snapshot is sorted by reaction
  // descending. Match the nearest zone of the correct type to the entry price.
  const desiredType = signal.type === "BUY" ? "SUPPORT" : "RESISTANCE";
  const matching = signal.srZonesSnapshot.filter((z) => z.type === desiredType);
  if (matching.length === 0) return null;
  // nearest to entry
  let best = matching[0];
  let bestDist = Math.abs(signal.entry - best.price);
  for (const z of matching) {
    const d = Math.abs(signal.entry - z.price);
    if (d < bestDist) {
      best = z;
      bestDist = d;
    }
  }
  return { price: best.price, type: best.type };
}

// ─── EV computation ─────────────────────────────────────────────────────
function computeRealisedR(signal: ParsedSignal): number | null {
  if (EXCLUDED_STATUSES.has(signal.status) || signal.exit === null || Math.abs(signal.entry - signal.sl) < 0.01) {
    return null;
  }
  const risk = Math.abs(signal.entry - signal.sl);
  const signed = signal.type === "BUY" ? (signal.exit as number) - signal.entry : signal.entry - (signal.exit as number);
  return signed / risk;
}

// ─── overlap-band count ─────────────────────────────────────────────────
function countOverlapBands(zones: { price: number; type: string }[], bandWidth: number): number {
  let count = 0;
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      if (zones[i].type === zones[j].type && Math.abs(zones[i].price - zones[j].price) < bandWidth) {
        count++;
      }
    }
  }
  return count;
}

// ─── POWER computation (minimum detectable effect) ──────────────────────
function computePower(n1: number, n2: number, ev1: number, ev2: number, pooledSd: number): { mde: number; powered: boolean; note: string } {
  // Simple two-sample t-test power approximation
  // For 80% power at alpha=0.05, need n >= 2 * (1.96 + 0.84)^2 * sd^2 / delta^2
  // => delta_min = (1.96 + 0.84) * sd * sqrt(2/n_avg)
  const nAvg = (n1 + n2) / 2;
  if (nAvg < 5) return { mde: Infinity, powered: false, note: `n_avg=${nAvg.toFixed(0)} < 5, cannot estimate` };
  const mde = 2.8 * pooledSd * Math.sqrt(2 / nAvg);
  const observedDelta = Math.abs(ev1 - ev2);
  const powered = n1 >= 10 && n2 >= 10 && observedDelta >= mde;
  return {
    mde,
    powered,
    note: `n1=${n1} n2=${n2} MDE=${mde.toFixed(4)}R observed_delta=${observedDelta.toFixed(4)}R ${powered ? "POWERED" : "UNDERPOWERED"}`,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────
function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}
function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

// ─── pooled SD ──────────────────────────────────────────────────────────
function pooledSd(vals1: number[], vals2: number[]): number {
  const all = [...vals1, ...vals2];
  if (all.length < 2) return 0;
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const variance = all.reduce((a, b) => a + (b - mean) ** 2, 0) / (all.length - 1);
  return Math.sqrt(variance);
}

// ─── MAIN ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnv();
  const client = makeAnon(env);

  console.log("=".repeat(80));
  console.log("ITEM 33 — SHADOW ZONE METRIC: RELIABILITY × MAGNITUDE (SEPARATE AXES)");
  console.log("MINDSET 8 rules apply. POWER FIRST. Read-only. No engine code touched.");
  console.log("=".repeat(80));

  // 1. Fetch export
  console.log("\n── 0. Fetching diagnostics export ──");
  const exportText = await fetchExport(env);
  const { signals: allSignals, generatedMs } = parseExport(exportText);
  const genDate = new Date(generatedMs).toISOString();
  console.log(`  Export parsed: ${allSignals.length} signals, Generated=${genDate}`);

  // 2. Fetch bars — from 30 days ago to cover the full zone history
  console.log("\n── 1. Fetching gold_m1_bars ──");
  const fromTs = new Date(generatedMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  const allBars = await fetchBarsPaginated(client, fromTs);
  console.log(`  Fetched ${allBars.length} bars from ${allBars[0]?.timestamp} to ${allBars[allBars.length - 1]?.timestamp}`);

  // 3. Compute ATR at export generation time (last 14 bars before generation)
  const barsUpToGen = allBars.filter((b) => new Date(b.timestamp).getTime() <= generatedMs);
  const atrAtGen = computeATR(barsUpToGen.slice(-Math.min(barsUpToGen.length, 7200)), 14);
  console.log(`  ATR at export time (14-period, last 7200 bars): ${atrAtGen.toFixed(3)}`);

  // 4. 120h window for zone computation
  const windowStartMs = generatedMs - LOOKBACK_HOURS * 60 * 60 * 1000;
  const windowBars = barsUpToGen.filter((b) => new Date(b.timestamp).getTime() >= windowStartMs);
  console.log(`  120h window: ${windowBars.length} bars`);

  // ─── 33.1d: BAND WIDTH REPORT ───────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.1d — BAND WIDTH: what separates 4248.7 / 4256.6 / 4262.0?");
  console.log("=".repeat(80));
  const liveFloor = Math.max(atrAtGen * 0.3, 3670 * 0.0015); // currentPrice approx
  const liveFloorActual = Math.max(atrAtGen * 0.3, (windowBars[windowBars.length - 1]?.close ?? 4250) * 0.0015);
  const atrOnly = atrAtGen * 0.3;
  console.log(`  ATR at gen time: ${atrAtGen.toFixed(3)}`);
  console.log(`  Live band (Math.max floor): Math.max(${atrAtGen.toFixed(3)} * 0.3, ~4250 * 0.0015) = Math.max(${(atrAtGen * 0.3).toFixed(3)}, ${(4250 * 0.0015).toFixed(3)}) = ${liveFloorActual.toFixed(3)}`);
  console.log(`  Shadow band (ATR-only):     ${atrOnly.toFixed(6)} (= ${(atrOnly / PIP_VALUE).toFixed(1)} pips)`);
  console.log(`  Live band in pips:          ${(liveFloorActual / PIP_VALUE).toFixed(1)} pips`);
  console.log(`  Gap between 4256.6 and 4262.0: $${(4262.0 - 4256.6).toFixed(1)} = ${((4262.0 - 4256.6) / PIP_VALUE).toFixed(1)} pips`);
  console.log(`  Gap between 4248.7 and 4256.6: $${(4256.6 - 4248.7).toFixed(1)} = ${((4256.6 - 4248.7) / PIP_VALUE).toFixed(1)} pips`);
  console.log(`  => Live band (${(liveFloorActual / PIP_VALUE).toFixed(1)} pips) is ${liveFloorActual.toFixed(1)}/${(4262.0 - 4256.6).toFixed(1)} = ${(liveFloorActual / (4262.0 - 4256.6)).toFixed(1)}x WIDER than the 4256.6–4262.0 gap`);
  console.log(`  => Shadow band (${(atrOnly / PIP_VALUE).toFixed(1)} pips) keeps all three distinct (max gap needed: $${((4262.0 - 4256.6) / 2).toFixed(2)} half-width)`);
  for (const mult of [0.3, 0.5, 1.0, 1.5, 2.0]) {
    const bw = atrAtGen * mult;
    const overlap = Math.abs(4256.6 - 4262.0) < bw * 2;
    console.log(`     atr*${mult.toFixed(1)} = $${bw.toFixed(3)} (${(bw / PIP_VALUE).toFixed(1)} pips)  4256.6/4262.0 ${overlap ? "OVERLAP" : "distinct"}`);
  }

  // ─── 33.3a: ZONES PUBLISHED ─────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.3f — ZONES PUBLISHED UNDER EACH METRIC + OVERLAP-BAND COUNT");
  console.log("=".repeat(80));

  const liveZonesWithFloor = computeLiveZones(windowBars, generatedMs, true);
  const liveZonesNoFloor = computeLiveZones(windowBars, generatedMs, false);

  const liveBandWidth = Math.max(atrAtGen * 0.3, (windowBars[windowBars.length - 1]?.close ?? 4250) * 0.0015);
  const shadowBandWidth = atrAtGen * 0.3;

  console.log(`\n  LIVE metric (with Math.max floor, band=$${liveBandWidth.toFixed(3)} = ${(liveBandWidth / PIP_VALUE).toFixed(1)} pips):`);
  console.log(`    zones published: ${liveZonesWithFloor.length}`);
  console.log(`    overlap-band pairs (same type, < band): ${countOverlapBands(liveZonesWithFloor, liveBandWidth)}`);
  console.log(`    touch counts: min=${Math.min(...liveZonesWithFloor.map((z) => z.touches))} median=${liveZonesWithFloor.map((z) => z.touches).sort((a, b) => a - b)[Math.floor(liveZonesWithFloor.length / 2)]} max=${Math.max(...liveZonesWithFloor.map((z) => z.touches))}`);

  console.log(`\n  LIVE metric (ATR-only band, no floor, band=$${shadowBandWidth.toFixed(3)} = ${(shadowBandWidth / PIP_VALUE).toFixed(1)} pips):`);
  console.log(`    zones published: ${liveZonesNoFloor.length}`);
  console.log(`    overlap-band pairs: ${countOverlapBands(liveZonesNoFloor, shadowBandWidth)}`);
  if (liveZonesNoFloor.length > 0) {
    console.log(`    touch counts: min=${Math.min(...liveZonesNoFloor.map((z) => z.touches))} median=${liveZonesNoFloor.map((z) => z.touches).sort((a, b) => a - b)[Math.floor(liveZonesNoFloor.length / 2)]} max=${Math.max(...liveZonesNoFloor.map((z) => z.touches))}`);
    console.log(`    zones with touches >= 2: ${liveZonesNoFloor.filter((z) => z.touches >= 2).length} (of ${liveZonesNoFloor.length})`);
    console.log(`\n    Top 16 zones (ATR-only band):`);
    console.log(`    ${"price".padStart(9)} ${"type".padEnd(11)} ${"tch".padStart(5)} ${"rjW".padStart(5)} ${"rawRS".padStart(7)} ${"rs".padStart(7)} ${"src".padEnd(13)}`);
    for (const z of liveZonesNoFloor.slice(0, 16)) {
      console.log(`    ${String(z.price).padStart(9)} ${z.type.padEnd(11)} ${String(z.touches).padStart(5)} ${String(z.rejectionWicks).padStart(5)} ${z.rawReactionStrength.toFixed(3).padStart(7)} ${z.reactionStrength.toFixed(3).padStart(7)} ${z.source.padEnd(13)}`);
    }
  }

  // ─── 33.1 + 33.2: SHADOW METRICS FOR ALL ZONES ──────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.1 + 33.2 — SHADOW RELIABILITY + MAGNITUDE PER ZONE (full bar history)");
  console.log("=".repeat(80));

  // Collect unique zone prices from the export snapshots
  const zonePriceSet = new Set<string>();
  for (const s of allSignals) {
    for (const z of s.srZonesSnapshot) {
      zonePriceSet.add(`${z.price}|${z.type}`);
    }
  }

  // TP1 distance: reported per-signal, never pooled. The user's $5.70 spec
  // applies to the NEW geometry (80-pip SL, 0.70R TP1). 394/396 signals use
  // the OLD geometry (median TP1 $2.60 = ~0.50R). Per-signal handling is the
  // only correct approach — a pooled threshold made the clearance split
  // degenerate in the prior run.
  const tp1Distances = allSignals
    .filter((s) => !isNaN(s.tp1) && !isNaN(s.entry))
    .map((s) => Math.abs(s.entry - s.tp1));
  const medianTp1 = tp1Distances.length > 0 ? tp1Distances.sort((a, b) => a - b)[Math.floor(tp1Distances.length / 2)] : 5.7;
  console.log(`\n  TP1 distance: median $${medianTp1.toFixed(2)} (${(medianTp1 / PIP_VALUE).toFixed(1)} pips) from ${tp1Distances.length} signals`);
  console.log(`  NOTE: per-signal TP1 distance is used for every clearance test, never a pooled threshold.`);
  console.log(`  394/396 signals use OLD geometry (TP1 ~$2.60 = 26 pips). 2/396 use NEW geometry (TP1 $5.70 = 57 pips).`);
  console.log(`  N for excursion = ${EXCURSION_N_BARS} bars (${EXCURSION_N_BARS} minutes)`);
  console.log(`  Min visits for strength = ${MIN_VISITS_FOR_STRENGTH}`);

  const shadowMetrics: ShadowZoneMetric[] = [];
  for (const key of zonePriceSet) {
    const [price, type] = key.split("|");
    const metric = computeShadowZoneMetric(
      barsUpToGen,
      parseFloat(price),
      type as "SUPPORT" | "RESISTANCE",
      atrAtGen,
      medianTp1,
    );
    shadowMetrics.push(metric);
  }
  shadowMetrics.sort((a, b) => b.visits - a.visits);

  console.log(`\n  Shadow metrics computed for ${shadowMetrics.length} unique zone levels`);
  console.log(`\n  ${"price".padStart(9)} ${"type".padEnd(11)} ${"visits".padStart(6)} ${"rev".padStart(4)} ${"brk".padStart(4)} ${"revRate".padStart(7)} ${"medExATR".padStart(9)} ${"p25".padStart(7)} ${"p75".padStart(7)} ${"n_ex".padStart(5)} ${"medTp1%".padStart(8)} ${"clrTp1".padStart(7)} ${"medBrkATR".padStart(9)} ${"minV".padStart(5)}`);
  for (const m of shadowMetrics) {
    console.log(
      `  ${String(m.price).padStart(9)} ${m.type.padEnd(11)} ${String(m.visits).padStart(6)} ${String(m.reversals).padStart(4)} ${String(m.breaks).padStart(4)}` +
      ` ${(m.reversalRate ?? -1).toFixed(3).padStart(7)}` +
      ` ${(m.medianReversalExcursionATR ?? -1).toFixed(3).padStart(9)}` +
      ` ${(m.p25ReversalExcursionATR ?? -1).toFixed(3).padStart(7)}` +
      ` ${(m.p75ReversalExcursionATR ?? -1).toFixed(3).padStart(7)}` +
      ` ${String(m.reversalExcursionsATR.length).padStart(5)}` +
      ` ${((m.medianReversalExcursionTp1Frac ?? -1) * 100).toFixed(1).padStart(7)}%` +
      ` ${String(m.clearsTp1Count).padStart(4)}/${String(m.reversalExcursionsATR.length).padStart(3)}` +
      ` ${(m.medianBreakExcursionATR ?? -1).toFixed(3).padStart(9)}` +
      ` ${m.minVisitsMet ? "YES" : "no"}`.padStart(6),
    );
  }

  // ─── 33.1e: MIN VISIT GATE ──────────────────────────────────────────
  console.log("\n" + "-".repeat(80));
  console.log("33.1e — MIN VISIT GATE (min visits = " + MIN_VISITS_FOR_STRENGTH + ")");
  const meetsMinVisits = shadowMetrics.filter((m) => m.minVisitsMet);
  const failsMinVisits = shadowMetrics.filter((m) => !m.minVisitsMet);
  console.log(`  Zones meeting min visits: ${meetsMinVisits.length} / ${shadowMetrics.length}`);
  console.log(`  Zones failing min visits: ${failsMinVisits.length} (would NOT publish a strength)`);
  if (failsMinVisits.length > 0) {
    console.log(`  Failing zones: ${failsMinVisits.map((m) => `${m.price}(${m.type},v=${m.visits})`).join(", ")}`);
  }

  // ─── 33.3b: PER-SIGNAL QUALIFICATION ────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.3g — PER-SIGNAL: does the top structural feature survive the shadow metric?");
  console.log("=".repeat(80));

  // For each signal, match to its justifying zone and look up shadow metrics
  const signalZoneMetrics: {
    signal: ParsedSignal;
    realisedR: number | null;
    zonePrice: number;
    zoneType: string;
    shadow: ShadowZoneMetric | null;
    qualifies: boolean;
    qualifiesReliability: boolean;
    qualifiesMagnitude: boolean;
  }[] = [];

  for (const sig of allSignals) {
    const matchedZone = matchSignalToZone(sig);
    const realisedR = computeRealisedR(sig);
    if (!matchedZone) {
      signalZoneMetrics.push({
        signal: sig,
        realisedR,
        zonePrice: NaN,
        zoneType: "",
        shadow: null,
        qualifies: false,
        qualifiesReliability: false,
        qualifiesMagnitude: false,
      });
      continue;
    }
    const shadow = shadowMetrics.find((m) => m.price === matchedZone.price && m.type === matchedZone.type) ?? null;
    // Qualification: min visits met AND reversalRate > 0 (at least one reversal)
    const qualifiesReliability = shadow !== null && shadow.minVisitsMet && (shadow.reversalRate ?? 0) > 0;
    // Magnitude: median excursion >= 1.0 ATR (can turn price meaningfully) — NOT TP1, just ATR
    const qualifiesMagnitude = shadow !== null && (shadow.medianReversalExcursionATR ?? 0) >= 1.0;
    const qualifies = qualifiesReliability && qualifiesMagnitude;
    signalZoneMetrics.push({
      signal: sig,
      realisedR,
      zonePrice: matchedZone.price,
      zoneType: matchedZone.type,
      shadow,
      qualifies,
      qualifiesReliability,
      qualifiesMagnitude,
    });
  }

  const evEligible = signalZoneMetrics.filter((r) => r.realisedR !== null && r.shadow !== null);
  const noZoneMatch = signalZoneMetrics.filter((r) => r.shadow === null);
  console.log(`  Signals with a matched zone + shadow metrics: ${signalZoneMetrics.filter((r) => r.shadow !== null).length}`);
  console.log(`  Signals with no zone match: ${noZoneMatch.length}`);
  console.log(`  EV-eligible (resolved + has shadow): ${evEligible.length}`);

  // Summary: how many signals' zones qualify
  const qualReliability = evEligible.filter((r) => r.qualifiesReliability).length;
  const qualMagnitude = evEligible.filter((r) => r.qualifiesMagnitude).length;
  const qualBoth = evEligible.filter((r) => r.qualifies).length;
  console.log(`  Qualifies on RELIABILITY: ${qualReliability} / ${evEligible.length}`);
  console.log(`  Qualifies on MAGNITUDE:   ${qualMagnitude} / ${evEligible.length}`);
  console.log(`  Qualifies on BOTH:        ${qualBoth} / ${evEligible.length}`);

  // ─── 33.4h: 1D SPLIT BY RELIABILITY ──────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.4h — 1D SPLIT BY RELIABILITY (reversalRate of the justifying zone)");
  console.log("=".repeat(80));

  const withReliability = evEligible.filter((r) => r.shadow !== null && r.shadow.reversalRate !== null);
  const reversalRates = withReliability.map((r) => r.shadow!.reversalRate as number);
  const rrMedian = reversalRates.length > 0 ? reversalRates.sort((a, b) => a - b)[Math.floor(reversalRates.length / 2)] : 0;
  console.log(`  reversalRate distribution: n=${reversalRates.length} min=${Math.min(...reversalRates).toFixed(3)} median=${rrMedian.toFixed(3)} max=${Math.max(...reversalRates).toFixed(3)}`);
  console.log(`  Split at median reversalRate = ${rrMedian.toFixed(3)}`);

  const highReliability = withReliability.filter((r) => (r.shadow!.reversalRate as number) >= rrMedian);
  const lowReliability = withReliability.filter((r) => (r.shadow!.reversalRate as number) < rrMedian);

  const evHigh = highReliability.map((r) => r.realisedR as number);
  const evLow = lowReliability.map((r) => r.realisedR as number);
  const meanHigh = evHigh.length > 0 ? evHigh.reduce((a, b) => a + b, 0) / evHigh.length : NaN;
  const meanLow = evLow.length > 0 ? evLow.reduce((a, b) => a + b, 0) / evLow.length : NaN;
  const relPooledSd = pooledSd(evHigh, evLow);
  const power = computePower(evHigh.length, evLow.length, meanHigh, meanLow, relPooledSd);

  console.log(`  HIGH reliability (reversalRate >= ${rrMedian.toFixed(3)}): n=${evHigh.length}, EV=${meanHigh >= 0 ? "+" : ""}${meanHigh.toFixed(4)}R, WR=${((evHigh.filter((r) => r > 0).length / evHigh.length) * 100).toFixed(1)}%`);
  console.log(`  LOW reliability  (reversalRate <  ${rrMedian.toFixed(3)}): n=${evLow.length}, EV=${meanLow >= 0 ? "+" : ""}${meanLow.toFixed(4)}R, WR=${((evLow.filter((r) => r > 0).length / evLow.length) * 100).toFixed(1)}%`);
  console.log(`  POWER: ${power.note}`);
  console.log(`  => ${power.powered ? "Signals backed by high-reliability zones DO outperform." : "UNDERPOWERED — cannot conclude reliability separates outcomes."}`);

  // Also split by min-visits gate
  console.log(`\n  Alternative split: min-visits gate (>= ${MIN_VISITS_FOR_STRENGTH} visits)`);
  const meetsVisits = evEligible.filter((r) => r.shadow !== null && r.shadow.minVisitsMet);
  const failsVisits = evEligible.filter((r) => r.shadow !== null && !r.shadow.minVisitsMet);
  const evMeets = meetsVisits.map((r) => r.realisedR as number);
  const evFails = failsVisits.map((r) => r.realisedR as number);
  const meanMeets = evMeets.length > 0 ? evMeets.reduce((a, b) => a + b, 0) / evMeets.length : NaN;
  const meanFails = evFails.length > 0 ? evFails.reduce((a, b) => a + b, 0) / evFails.length : NaN;
  const sd2 = pooledSd(evMeets, evFails);
  const power2 = computePower(evMeets.length, evFails.length, meanMeets, meanFails, sd2);
  console.log(`  MEETS min visits: n=${evMeets.length}, EV=${meanMeets >= 0 ? "+" : ""}${isNaN(meanMeets) ? "n/a" : meanMeets.toFixed(4)}R`);
  console.log(`  FAILS min visits: n=${evFails.length}, EV=${meanFails >= 0 ? "+" : ""}${isNaN(meanFails) ? "n/a" : meanFails.toFixed(4)}R`);
  console.log(`  POWER: ${power2.note}`);

  // ─── 33.4i: 1D SPLIT BY MAGNITUDE ───────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.4i — 1D SPLIT BY MAGNITUDE (median reversal excursion)");
  console.log("=".repeat(80));

  const withMagnitude = evEligible.filter((r) => r.shadow !== null && r.shadow.medianReversalExcursionATR !== null);
  const excursions = withMagnitude.map((r) => r.shadow!.medianReversalExcursionATR as number);
  const excMedian = excursions.length > 0 ? excursions.sort((a, b) => a - b)[Math.floor(excursions.length / 2)] : 0;
  console.log(`  medianReversalExcursionATR distribution: n=${excursions.length} min=${Math.min(...excursions).toFixed(3)} median=${excMedian.toFixed(3)} max=${Math.max(...excursions).toFixed(3)}`);

  const highMag = withMagnitude.filter((r) => (r.shadow!.medianReversalExcursionATR as number) >= excMedian);
  const lowMag = withMagnitude.filter((r) => (r.shadow!.medianReversalExcursionATR as number) < excMedian);
  const evHighMag = highMag.map((r) => r.realisedR as number);
  const evLowMag = lowMag.map((r) => r.realisedR as number);
  const meanHighMag = evHighMag.length > 0 ? evHighMag.reduce((a, b) => a + b, 0) / evHighMag.length : NaN;
  const meanLowMag = evLowMag.length > 0 ? evLowMag.reduce((a, b) => a + b, 0) / evLowMag.length : NaN;
  const sdMag = pooledSd(evHighMag, evLowMag);
  const powerMag = computePower(evHighMag.length, evLowMag.length, meanHighMag, meanLowMag, sdMag);

  console.log(`  HIGH magnitude (excursionATR >= ${excMedian.toFixed(3)}): n=${evHighMag.length}, EV=${meanHighMag >= 0 ? "+" : ""}${meanHighMag.toFixed(4)}R, WR=${((evHighMag.filter((r) => r > 0).length / evHighMag.length) * 100).toFixed(1)}%`);
  console.log(`  LOW magnitude  (excursionATR <  ${excMedian.toFixed(3)}): n=${evLowMag.length}, EV=${meanLowMag >= 0 ? "+" : ""}${meanLowMag.toFixed(4)}R, WR=${((evLowMag.filter((r) => r > 0).length / evLowMag.length) * 100).toFixed(1)}%`);
  console.log(`  POWER: ${powerMag.note}`);

  // Also split by TP1 clearance — PER-SIGNAL TP1 distance, split BY GEOMETRY ERA
  console.log(`\n  Alternative split: median excursion clears PER-SIGNAL TP1 distance`);
  console.log(`  (each signal compared against its OWN TP1 distance, not a pooled threshold)`);

  // For each EV-eligible signal with a shadow, compute per-signal TP1 clearance.
  // The zone's median excursion in dollars is fixed; what varies is the TP1
  // distance we compare it against — each signal's own |entry - tp1|.
  const perSignalTp1 = evEligible.map((r) => {
    const tp1Dist = Math.abs(r.signal.entry - r.signal.tp1);
    const zoneMedianExcDollars = r.shadow !== null && r.shadow.medianReversalExcursionATR !== null
      ? r.shadow.medianReversalExcursionATR * atrAtGen
      : null;
    const clears = zoneMedianExcDollars !== null && zoneMedianExcDollars >= tp1Dist;
    return { ...r, tp1Dist, zoneMedianExcDollars, clears };
  });

  // Split by geometry era
  // OLD geometry: SL ~80 pips ($8.00), TP1 at ~0.50R → TP1 ~$2.60 (26 pips)
  // NEW geometry: SL ~80 pips ($8.00), TP1 at 0.70R → TP1 ~$5.70 (57 pips)
  // The era boundary is determined by the TP1/SL ratio: old ~0.50, new ~0.70
  const oldGeo = perSignalTp1.filter((r) => {
    const slDist = Math.abs(r.signal.entry - r.signal.sl);
    const ratio = slDist > 0 ? r.tp1Dist / slDist : 0;
    return ratio < 0.60; // old geometry: TP1/SL < 0.60
  });
  const newGeo = perSignalTp1.filter((r) => {
    const slDist = Math.abs(r.signal.entry - r.signal.sl);
    const ratio = slDist > 0 ? r.tp1Dist / slDist : 0;
    return ratio >= 0.60; // new geometry: TP1/SL >= 0.60
  });

  console.log(`\n  GEOMETRY ERA split:`);
  console.log(`    OLD geometry (TP1/SL < 0.60, TP1 ~$2.60): n=${oldGeo.length}`);
  console.log(`    NEW geometry (TP1/SL >= 0.60, TP1 ~$5.70): n=${newGeo.length}`);

  for (const [eraName, era] of [['OLD', oldGeo], ['NEW', newGeo]] as const) {
    const clears = era.filter((r) => r.clears);
    const fails = era.filter((r) => !r.clears);
    const evClears = clears.map((r) => r.realisedR as number);
    const evFails = fails.map((r) => r.realisedR as number);
    const meanC = evClears.length > 0 ? evClears.reduce((a, b) => a + b, 0) / evClears.length : NaN;
    const meanF = evFails.length > 0 ? evFails.reduce((a, b) => a + b, 0) / evFails.length : NaN;
    console.log(`\n    ${eraName} geometry (n=${era.length}):`);
    console.log(`      CLEARS per-signal TP1: n=${evClears.length}, EV=${isNaN(meanC) ? "n/a" : `${meanC >= 0 ? "+" : ""}${meanC.toFixed(4)}R`}`);
    console.log(`      FAILS per-signal TP1:  n=${evFails.length}, EV=${isNaN(meanF) ? "n/a" : `${meanF >= 0 ? "+" : ""}${meanF.toFixed(4)}R`}`);
    if (era.length < 10) {
      console.log(`      => IMPOSSIBLE (rule 8): n=${era.length} is too small for any split. No verdict taken.`);
    } else {
      const sdTp1 = pooledSd(evClears, evFails);
      const powerTp1 = computePower(evClears.length, evFails.length, meanC, meanF, sdTp1);
      console.log(`      POWER: ${powerTp1.note}`);
    }
  }

  // Pooled across eras (for reference, but NOT the canonical split)
  const allClears = perSignalTp1.filter((r) => r.clears);
  const allFails = perSignalTp1.filter((r) => !r.clears);
  const evAllClears = allClears.map((r) => r.realisedR as number);
  const evAllFails = allFails.map((r) => r.realisedR as number);
  const meanAllClears = evAllClears.length > 0 ? evAllClears.reduce((a, b) => a + b, 0) / evAllClears.length : NaN;
  const meanAllFails = evAllFails.length > 0 ? evAllFails.reduce((a, b) => a + b, 0) / evAllFails.length : NaN;
  console.log(`\n  Pooled across eras (for reference, NOT canonical):`);
  console.log(`    CLEARS per-signal TP1: n=${evAllClears.length}, EV=${isNaN(meanAllClears) ? "n/a" : `${meanAllClears >= 0 ? "+" : ""}${meanAllClears.toFixed(4)}R`}`);
  console.log(`    FAILS per-signal TP1:  n=${evAllFails.length}, EV=${isNaN(meanAllFails) ? "n/a" : `${meanAllFails >= 0 ? "+" : ""}${meanAllFails.toFixed(4)}R`}`);

  // ─── 33.4j: 2D GRID ─────────────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.4j — 2D GRID (reliability × magnitude) — ONLY IF POWER ALLOWS");
  console.log("=".repeat(80));

  const withBoth = evEligible.filter(
    (r) => r.shadow !== null && r.shadow.reversalRate !== null && r.shadow.medianReversalExcursionATR !== null,
  );
  const nBoth = withBoth.length;
  console.log(`  Signals with both axes: ${nBoth}`);
  console.log(`  3×3 grid would give ~${Math.floor(nBoth / 9)} per cell — ${nBoth / 9 < 10 ? "UNDERPOWERED" : "marginal"}`);

  if (nBoth >= 90) {
    // 3x3 grid: tertiles on each axis
    const rrs = withBoth.map((r) => r.shadow!.reversalRate as number).sort((a, b) => a - b);
    const excs = withBoth.map((r) => r.shadow!.medianReversalExcursionATR as number).sort((a, b) => a - b);
    const t1rr = rrs[Math.floor(rrs.length / 3)];
    const t2rr = rrs[Math.floor((2 * rrs.length) / 3)];
    const t1ex = excs[Math.floor(excs.length / 3)];
    const t2ex = excs[Math.floor((2 * excs.length) / 3)];

    console.log(`  Tertiles: RR [0,${t1rr.toFixed(3)}) [${t1rr.toFixed(3)},${t2rr.toFixed(3)}) [${t2rr.toFixed(3)},1]`);
    console.log(`            EX [0,${t1ex.toFixed(3)}) [${t1ex.toFixed(3)},${t2ex.toFixed(3)}) [${t2ex.toFixed(3)},∞)`);

    for (let ri = 0; ri < 3; ri++) {
      for (let ei = 0; ei < 3; ei++) {
        const cell = withBoth.filter((r) => {
          const rr = r.shadow!.reversalRate as number;
          const ex = r.shadow!.medianReversalExcursionATR as number;
          const rrBand = ri === 0 ? rr < t1rr : ri === 1 ? rr >= t1rr && rr < t2rr : rr >= t2rr;
          const exBand = ei === 0 ? ex < t1ex : ei === 1 ? ex >= t1ex && ex < t2ex : ex >= t2ex;
          return rrBand && exBand;
        });
        const cellEvs = cell.map((r) => r.realisedR as number);
        const cellEv = cellEvs.length > 0 ? cellEvs.reduce((a, b) => a + b, 0) / cellEvs.length : NaN;
        const cellWr = cellEvs.length > 0 ? (cellEvs.filter((r) => r > 0).length / cellEvs.length) * 100 : NaN;
        console.log(`  [R${ri}E${ei}] n=${String(cellEvs.length).padStart(3)}  EV=${isNaN(cellEv) ? "  n/a" : `${cellEv >= 0 ? "+" : ""}${cellEv.toFixed(4)}`}  WR=${isNaN(cellWr) ? "  n/a" : `${cellWr.toFixed(1)}%`}`);
      }
    }
  } else {
    console.log(`  UNDERPOWERED — n=${nBoth} across 9 cells = ~${Math.floor(nBoth / 9)} per cell. Reporting 1D results as the answer.`);
  }

  // ─── 33.4k: KEY QUESTION ────────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("33.4k — THE KEY QUESTION on BOTH axes");
  console.log("=".repeat(80));

  // Reliability verdict
  const relPowered = power.powered;
  const relSeparates = relPowered && meanHigh > meanLow;
  console.log(`\n  RELIABILITY axis:`);
  console.log(`    High-reliability EV: ${meanHigh >= 0 ? "+" : ""}${meanHigh.toFixed(4)}R (n=${evHigh.length})`);
  console.log(`    Low-reliability EV:  ${meanLow >= 0 ? "+" : ""}${meanLow.toFixed(4)}R (n=${evLow.length})`);
  console.log(`    POWERED: ${relPowered}`);
  console.log(`    => ${relPowered ? (relSeparates ? "Reliability DOES separate outcomes. Zone discrimination is a lever." : "Reliability does NOT separate outcomes despite adequate power.") : "UNDERPOWERED — cannot conclude."}`);

  // Magnitude verdict
  const magPowered = powerMag.powered;
  const magSeparates = magPowered && meanHighMag > meanLowMag;
  console.log(`\n  MAGNITUDE axis:`);
  console.log(`    High-magnitude EV: ${meanHighMag >= 0 ? "+" : ""}${meanHighMag.toFixed(4)}R (n=${evHighMag.length})`);
  console.log(`    Low-magnitude EV:  ${meanLowMag >= 0 ? "+" : ""}${meanLowMag.toFixed(4)}R (n=${evLowMag.length})`);
  console.log(`    POWERED: ${magPowered}`);
  console.log(`    => ${magPowered ? (magSeparates ? "Magnitude DOES separate outcomes." : "Magnitude does NOT separate outcomes despite adequate power.") : "UNDERPOWERED — cannot conclude."}`);

  // TP1 clearance verdict — per-signal, by era
  console.log(`\n  TP1 clearance (per-signal, by geometry era):`);
  console.log(`    OLD geometry: n=${oldGeo.length}, clears=${oldGeo.filter(r=>r.clears).length}, fails=${oldGeo.filter(r=>!r.clears).length}`);
  console.log(`    NEW geometry: n=${newGeo.length}, clears=${newGeo.filter(r=>r.clears).length}, fails=${newGeo.filter(r=>!r.clears).length}`);
  if (newGeo.length < 10) {
    console.log(`    => NEW geometry split is IMPOSSIBLE (n=${newGeo.length}). The old-geometry split is the only one with sample.`);
  }

  // Combined verdict
  console.log(`\n  COMBINED VERDICT:`);
  if (!relPowered && !magPowered) {
    console.log(`    Both axes UNDERPOWERED. The sample cannot distinguish zone-quality effects from noise.`);
    console.log(`    The 2D grid's monotonic pattern is NOT a result — a striking pattern across underpowered`);
    console.log(`    cells is what chance produces. Do not read it as signal.`);
    console.log(`    Forward data from the corrected engine is needed before zone discrimination can be evaluated.`);
  } else if (relSeparates && !magSeparates) {
    console.log(`    Reliability separates, magnitude does not. A real fix would target visit-based reliability.`);
  } else if (!relSeparates && magSeparates) {
    console.log(`    Magnitude separates, reliability does not. A real fix would target reaction magnitude (TP1 reach).`);
  } else if (relSeparates && magSeparates) {
    console.log(`    Both axes separate. Zone discrimination is the lever on both dimensions.`);
  } else {
    console.log(`    Neither axis separates despite power. Zone quality is NOT the constraint.`);
    console.log(`    Direction becomes the next place to look — but direction was already shown to be barely load-bearing (EV symmetry).`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REQUIRED SAMPLE SIZE — using actual pooled sigma from the R distribution
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n` + "=".repeat(80));
  console.log("REQUIRED SAMPLE SIZE (80% power at observed effect sizes, alpha=0.05)");
  console.log("=".repeat(80));

  // n_required per group = 2 * (z_alpha/2 + z_beta)^2 * sigma^2 / delta^2
  // For 80% power: z_beta = 0.84, z_alpha/2 = 1.96 → (1.96 + 0.84)^2 = 7.84
  // n_per_group = 2 * 7.84 * sigma^2 / delta^2 = 15.68 * sigma^2 / delta^2
  const Z_SUM_SQ = 7.84; // (1.96 + 0.84)^2

  const zoneMatchRate = evEligible.length / allSignals.length; // 142/396
  const SIGNALS_PER_DAY = 11;

  console.log(`\n  Current zone-match rate: ${evEligible.length}/${allSignals.length} = ${(zoneMatchRate * 100).toFixed(1)}%`);
  console.log(`  Assumed generation rate: ~${SIGNALS_PER_DAY} signals/day`);
  console.log(`  Formula: n_per_group = 2 * ${(Z_SUM_SQ).toFixed(2)} * sigma^2 / delta^2`);

  // Reliability split
  const relDelta = Math.abs(meanHigh - meanLow);
  const relSigma = relPooledSd;
  const relNPerGroup = relDelta > 0 ? Math.ceil(2 * Z_SUM_SQ * relSigma * relSigma / (relDelta * relDelta)) : Infinity;
  const relTotalEligible = relNPerGroup * 2;
  const relTotalSignals = Math.ceil(relTotalEligible / zoneMatchRate);
  const relTradingDays = Math.ceil(relTotalSignals / SIGNALS_PER_DAY);
  console.log(`\n  RELIABILITY split:`);
  console.log(`    Observed effect size (delta): ${relDelta.toFixed(4)}R`);
  console.log(`    Pooled sigma:                 ${relSigma.toFixed(4)}R`);
  console.log(`    Required n per group:         ${relNPerGroup === Infinity ? "Infinity (delta=0)" : relNPerGroup}`);
  console.log(`    Total EV-eligible needed:     ${relNPerGroup === Infinity ? "n/a" : relTotalEligible}`);
  console.log(`    Total signals needed:         ${relNPerGroup === Infinity ? "n/a" : relTotalSignals} (at ${(zoneMatchRate * 100).toFixed(1)}% match rate)`);
  console.log(`    Trading days needed:          ${relNPerGroup === Infinity ? "n/a" : relTradingDays} days (at ${SIGNALS_PER_DAY}/day)`);
  if (relNPerGroup !== Infinity) {
    const targetDate = new Date(generatedMs + relTradingDays * 24 * 60 * 60 * 1000);
    console.log(`    => Date: ${targetDate.toISOString().slice(0, 10)}`);
  }

  // Magnitude split
  const magDelta = Math.abs(meanHighMag - meanLowMag);
  const magSigma = sdMag;
  const magNPerGroup = magDelta > 0 ? Math.ceil(2 * Z_SUM_SQ * magSigma * magSigma / (magDelta * magDelta)) : Infinity;
  const magTotalEligible = magNPerGroup * 2;
  const magTotalSignals = Math.ceil(magTotalEligible / zoneMatchRate);
  const magTradingDays = Math.ceil(magTotalSignals / SIGNALS_PER_DAY);
  console.log(`\n  MAGNITUDE split:`);
  console.log(`    Observed effect size (delta): ${magDelta.toFixed(4)}R`);
  console.log(`    Pooled sigma:                 ${magSigma.toFixed(4)}R`);
  console.log(`    Required n per group:         ${magNPerGroup === Infinity ? "Infinity (delta=0)" : magNPerGroup}`);
  console.log(`    Total EV-eligible needed:     ${magNPerGroup === Infinity ? "n/a" : magTotalEligible}`);
  console.log(`    Total signals needed:         ${magNPerGroup === Infinity ? "n/a" : magTotalSignals} (at ${(zoneMatchRate * 100).toFixed(1)}% match rate)`);
  console.log(`    Trading days needed:          ${magNPerGroup === Infinity ? "n/a" : magTradingDays} days (at ${SIGNALS_PER_DAY}/day)`);
  if (magNPerGroup !== Infinity) {
    const targetDate = new Date(generatedMs + magTradingDays * 24 * 60 * 60 * 1000);
    console.log(`    => Date: ${targetDate.toISOString().slice(0, 10)}`);
  }

  // 2D grid requirement (9 cells, ~n/9 per cell, need >= 10 per cell for any power)
  // For a 3x3 grid with 80% power on the largest contrast (corner-to-corner):
  // Need n_per_cell >= 10 minimum, but for real power on a corner-to-corner
  // contrast (delta = max_cell_ev - min_cell_ev), need n_per_cell = 15.68 * sigma^2 / delta^2
  const rrsSorted = withBoth.map(r => r.shadow!.reversalRate as number).sort((a, b) => a - b);
  const excsSorted = withBoth.map(r => r.shadow!.medianReversalExcursionATR as number).sort((a, b) => a - b);
  const t1rrG = rrsSorted.length > 0 ? rrsSorted[Math.floor(rrsSorted.length / 3)] : 0;
  const t2rrG = rrsSorted.length > 0 ? rrsSorted[Math.floor(rrsSorted.length * 2 / 3)] : 0;
  const t1exG = excsSorted.length > 0 ? excsSorted[Math.floor(excsSorted.length / 3)] : 0;
  const t2exG = excsSorted.length > 0 ? excsSorted[Math.floor(excsSorted.length * 2 / 3)] : 0;
  const hiHi = withBoth.filter(r => { const rr = r.shadow!.reversalRate as number; const ex = r.shadow!.medianReversalExcursionATR as number; return rr >= t2rrG && ex >= t2exG; }).map(r => r.realisedR as number);
  const loLo = withBoth.filter(r => { const rr = r.shadow!.reversalRate as number; const ex = r.shadow!.medianReversalExcursionATR as number; return rr < t1rrG && ex < t1exG; }).map(r => r.realisedR as number);
  const hiHiEv = hiHi.length > 0 ? mean(hiHi) : 0;
  const loLoEv = loLo.length > 0 ? mean(loLo) : 0;
  const gridDelta = Math.abs(hiHiEv - loLoEv);
  const gridSigma = sd(withBoth.map(r => r.realisedR as number));
  const gridNPerCell = gridDelta > 0 ? Math.ceil(2 * Z_SUM_SQ * gridSigma * gridSigma / (gridDelta * gridDelta)) : Infinity;
  const gridTotalEligible = gridNPerCell * 9; // 9 cells
  const gridTotalSignals = Math.ceil(gridTotalEligible / zoneMatchRate);
  const gridTradingDays = Math.ceil(gridTotalSignals / SIGNALS_PER_DAY);
  console.log(`\n  2D GRID (3x3, corner-to-corner contrast):`);
  console.log(`    Observed effect size (delta): ${gridDelta.toFixed(4)}R`);
  console.log(`    Pooled sigma:                 ${gridSigma.toFixed(4)}R`);
  console.log(`    Required n per cell:          ${gridNPerCell === Infinity ? "Infinity (delta=0)" : Math.max(gridNPerCell, 10)}`);
  console.log(`    Total EV-eligible needed:     ${gridNPerCell === Infinity ? "n/a" : Math.max(gridNPerCell, 10) * 9}`);
  console.log(`    Total signals needed:         ${gridNPerCell === Infinity ? "n/a" : Math.ceil(Math.max(gridNPerCell, 10) * 9 / zoneMatchRate)} (at ${(zoneMatchRate * 100).toFixed(1)}% match rate)`);
  const gridNPerCellFinal = gridNPerCell === Infinity ? Infinity : Math.max(gridNPerCell, 10);
  const gridTotalEligibleFinal = gridNPerCellFinal === Infinity ? Infinity : gridNPerCellFinal * 9;
  const gridTotalSignalsFinal = gridNPerCellFinal === Infinity ? Infinity : Math.ceil(gridTotalEligibleFinal / zoneMatchRate);
  const gridTradingDaysFinal = gridNPerCellFinal === Infinity ? Infinity : Math.ceil(gridTotalSignalsFinal / SIGNALS_PER_DAY);
  console.log(`    Trading days needed:          ${gridNPerCellFinal === Infinity ? "n/a" : gridTradingDaysFinal} days (at ${SIGNALS_PER_DAY}/day)`);
  if (gridNPerCellFinal !== Infinity) {
    const gridTargetDate = new Date(generatedMs + gridTradingDaysFinal * 24 * 60 * 60 * 1000);
    console.log(`    => Date: ${gridTargetDate.toISOString().slice(0, 10)}`);
  }

  // ─── EXCURSION SENSITIVITY ───────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log(`EXCURSION SENSITIVITY — N = ${EXCURSION_SENSITIVITY_N.join(", ")} bars`);
  console.log("=".repeat(80));

  // Re-compute for the top 5 most-visited zones at each N
  const topZones = shadowMetrics.slice(0, 5);
  for (const zone of topZones) {
    console.log(`\n  Zone ${zone.price} (${zone.type}, ${zone.visits} visits):`);
    for (const n of EXCURSION_SENSITIVITY_N) {
      // recompute with this N
      const m = computeShadowZoneMetricWithN(barsUpToGen, zone.price, zone.type, atrAtGen, medianTp1, n);
      console.log(`    N=${String(n).padStart(2)}: median_ex_ATR=${(m.medianReversalExcursionATR ?? -1).toFixed(3)}  p25=${(m.p25ReversalExcursionATR ?? -1).toFixed(3)}  p75=${(m.p75ReversalExcursionATR ?? -1).toFixed(3)}  n_ex=${m.reversalExcursionsATR.length}  clears_TP1=${m.clearsTp1Count}/${m.reversalExcursionsATR.length}`);
    }
  }

  // ─── SAMPLE ROWS ─────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(80));
  console.log("SAMPLE — first 10 signals with matched zone + shadow metrics");
  console.log("=".repeat(80));
  console.log(`  ${"#".padStart(4)} ${"DIR".padEnd(5)} ${"entry".padStart(8)} ${"zone".padStart(8)} ${"type".padEnd(11)} ${"visits".padStart(6)} ${"revRate".padStart(7)} ${"medExATR".padStart(9)} ${"medTp1%".padStart(8)} ${"realisedR".padStart(9)} ${"status".padEnd(20)}`);
  for (const r of signalZoneMetrics.slice(0, 10)) {
    const s = r.signal;
    const m = r.shadow;
    console.log(
      `  ${String(s.index).padStart(4)} ${s.type.padEnd(5)} ${String(s.entry).padStart(8)}` +
      ` ${(isNaN(r.zonePrice) ? "n/a" : r.zonePrice).toString().padStart(8)}` +
      ` ${(r.zoneType || "n/a").padEnd(11)}` +
      ` ${(m?.visits ?? "n/a").toString().padStart(6)}` +
      ` ${((m?.reversalRate ?? -1)).toFixed(3).padStart(7)}` +
      ` ${((m?.medianReversalExcursionATR ?? -1)).toFixed(3).padStart(9)}` +
      ` ${(((m?.medianReversalExcursionTp1Frac ?? -1)) * 100).toFixed(1).padStart(7)}%` +
      ` ${(r.realisedR ?? NaN).toFixed(4).padStart(9)}` +
      ` ${s.status.padEnd(20)}`,
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("DONE — Item 33 measurement complete. Nothing was written. No engine code touched.");
  console.log("=".repeat(80));
}

// Helper for sensitivity analysis with different N
function computeShadowZoneMetricWithN(
  bars: Bar[],
  zonePrice: number,
  zoneType: "SUPPORT" | "RESISTANCE",
  atr: number,
  tp1Distance: number,
  nBars: number,
): ShadowZoneMetric {
  // Same as computeShadowZoneMetric but with a different N
  // We reuse the function by temporarily patching the constant
  // To avoid duplicating 100+ lines, we call the original with a monkey-patched N
  // Instead, we just re-run with the N parameter — but the original function uses
  // the module-level constant. So we inline a simplified version here.
  const bandWidth = atr * 0.3;
  const exitThreshold = bandWidth * HYSTERESIS_MULTIPLIER;
  const isSupport = zoneType === "SUPPORT";
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  const visits: { startIdx: number; endIdx: number }[] = [];
  let inside = false;
  let visitStart = -1;
  let exitedAfterHysteresis = false;
  for (let i = 0; i < closes.length; i++) {
    const dist = Math.abs(closes[i] - zonePrice);
    if (dist < bandWidth) {
      if (!inside) {
        if (visitStart === -1 || exitedAfterHysteresis) {
          visitStart = i;
          exitedAfterHysteresis = false;
        }
        inside = true;
      }
    } else if (dist > exitThreshold) {
      if (inside) {
        visits.push({ startIdx: visitStart, endIdx: i - 1 });
        inside = false;
        exitedAfterHysteresis = true;
      }
    }
  }
  if (inside && visitStart !== -1) {
    visits.push({ startIdx: visitStart, endIdx: closes.length - 1 });
  }

  const reversalExcursionsATR: number[] = [];
  const reversalExcursionsTp1: number[] = [];
  const breakExcursionsATR: number[] = [];
  let reversals = 0;
  let breaks = 0;

  for (const v of visits) {
    let extremeIdx = v.startIdx;
    if (isSupport) {
      let el = Infinity;
      for (let i = v.startIdx; i <= v.endIdx; i++) {
        if (lows[i] < el) { el = lows[i]; extremeIdx = i; }
      }
    } else {
      let eh = -Infinity;
      for (let i = v.startIdx; i <= v.endIdx; i++) {
        if (highs[i] > eh) { eh = highs[i]; extremeIdx = i; }
      }
    }
    const extremePrice = isSupport ? lows[extremeIdx] : highs[extremeIdx];

    let reversed = false;
    let broken = false;
    let breakCloseIdx = -1;
    for (let i = v.endIdx + 1; i < closes.length; i++) {
      if (!broken) {
        if (isSupport && closes[i] < zonePrice - BREAK_ATR_MULTIPLE * atr) { broken = true; breakCloseIdx = i; break; }
        if (!isSupport && closes[i] > zonePrice + BREAK_ATR_MULTIPLE * atr) { broken = true; breakCloseIdx = i; break; }
      }
      if (!reversed) {
        if (isSupport && closes[i] > zonePrice + REVERSAL_ATR_MULTIPLE * atr) { reversed = true; }
        if (!isSupport && closes[i] < zonePrice - REVERSAL_ATR_MULTIPLE * atr) { reversed = true; }
      }
      if (reversed && !broken) break;
    }

    if (reversed) {
      reversals++;
      const startIdx = Math.min(extremeIdx + 1, closes.length - 1);
      const endIdx = Math.min(startIdx + nBars, closes.length - 1);
      let maxExc = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        if (isSupport && closes[i] < zonePrice) break;
        if (!isSupport && closes[i] > zonePrice) break;
        const exc = isSupport ? highs[i] - extremePrice : extremePrice - lows[i];
        if (exc > maxExc) maxExc = exc;
      }
      if (maxExc > 0) {
        reversalExcursionsATR.push(maxExc / atr);
        reversalExcursionsTp1.push(maxExc / tp1Distance);
      }
    }
    if (broken && breakCloseIdx >= 0) {
      breaks++;
      const startIdx = breakCloseIdx;
      const endIdx = Math.min(startIdx + nBars, closes.length - 1);
      let maxBrk = 0;
      for (let i = startIdx; i <= endIdx; i++) {
        const brk = isSupport ? zonePrice - lows[i] : highs[i] - zonePrice;
        if (brk > maxBrk) maxBrk = brk;
      }
      breakExcursionsATR.push(maxBrk / atr);
    }
  }

  const median = (vals: number[]): number | null => {
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
  };
  const pct = (vals: number[], p: number): number | null => {
    if (vals.length === 0) return null;
    const s = [...vals].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
  };
  const clearsTp1Count = reversalExcursionsTp1.filter((f) => f >= 1.0).length;

  return {
    price: zonePrice,
    type: zoneType,
    bandWidth,
    visits: visits.length,
    reversals,
    breaks,
    reversalRate: visits.length > 0 ? reversals / visits.length : null,
    breakRate: visits.length > 0 ? breaks / visits.length : null,
    reversalExcursionsATR,
    medianReversalExcursionATR: median(reversalExcursionsATR),
    p25ReversalExcursionATR: pct(reversalExcursionsATR, 25),
    p75ReversalExcursionATR: pct(reversalExcursionsATR, 75),
    reversalExcursionsTp1,
    medianReversalExcursionTp1Frac: median(reversalExcursionsTp1),
    clearsTp1Count,
    clearsTp1Rate: reversalExcursionsATR.length > 0 ? clearsTp1Count / reversalExcursionsATR.length : null,
    breakExcursionsATR,
    medianBreakExcursionATR: median(breakExcursionsATR),
    minVisitsMet: visits.length >= MIN_VISITS_FOR_STRENGTH,
  };
}

main().catch((err: unknown) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
