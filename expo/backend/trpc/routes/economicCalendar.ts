import { createTRPCRouter, publicProcedure } from "../create-context";
import { readRuntimeEnv } from "../../runtimeEnv";

/**
 * Real economic calendar backed by FMP (financialmodelingprep.com), replacing
 * the client's old date-pattern NFP/CPI/FOMC heuristic. FMP_API_KEY is a
 * server-only env var (never sent to the client), matching the existing
 * goldPrice/telegram route conventions.
 */

export interface CalendarMacroEvent {
  name: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  timeUntilEvent: number;
  date: string;
  source: "FMP" | "HEURISTIC_FALLBACK";
}

// "UNAVAILABLE" means the fetch itself failed (bad key, network error, non-OK
// status such as 403, timeout, or malformed shape) — the client MUST treat
// this as a trigger to fall back to the date-pattern heuristic. It is
// distinct from "FMP" + empty events array, which means the fetch genuinely
// succeeded and FMP reported zero matching events.
export type CalendarSource = "FMP" | "UNAVAILABLE";

type FmpCalendarEntry = {
  event?: string;
  date?: string;
  country?: string;
  impact?: string;
  currency?: string;
};

type NormalizedCalendarEvent = { name: string; impact: string; date: string };

function normalizeFmpEntry(entry: FmpCalendarEntry): NormalizedCalendarEvent {
  const rawImpact = (entry.impact ?? "").toLowerCase();
  const impact = rawImpact === "high" ? "HIGH" : rawImpact === "medium" ? "MEDIUM" : rawImpact === "low" ? "LOW" : "HIGH";
  return {
    name: entry.event ?? "Economic Event",
    impact,
    date: entry.date ?? new Date().toISOString(),
  };
}

const CACHE_MS = 45 * 60 * 1000;
let calendarCache: { events: FmpCalendarEntry[]; timestamp: number } | null = null;

// Events that matter for gold trading, matched against FMP's free-text
// `event` field. FMP's own `impact` field marking "High" is also honored
// regardless of name.
const GOLD_RELEVANT_EVENT_PATTERNS = [
  /non.?farm/i,
  /\bnfp\b/i,
  /\bcpi\b/i,
  /consumer price index/i,
  /\bfomc\b/i,
  /federal funds rate/i,
  /fed interest rate/i,
  /rate decision/i,
  /\bpce\b/i,
  /personal consumption/i,
  /retail sales/i,
  /interest rate decision/i,
  /minutes/i,
];

function getFmpApiKey(): string | null {
  const key = readRuntimeEnv("FMP_API_KEY")?.trim();
  return key && key.length > 0 ? key : null;
}

function isGoldRelevantHighImpact(entry: FmpCalendarEntry): boolean {
  if (entry.currency !== "USD" && entry.country !== "US") return false;
  const impactHigh = (entry.impact ?? "").toLowerCase() === "high";
  const nameMatches = GOLD_RELEVANT_EVENT_PATTERNS.some((pattern) => pattern.test(entry.event ?? ""));
  return impactHigh || nameMatches;
}

type FmpFetchResult =
  | { ok: true; events: FmpCalendarEntry[] }
  | { ok: false; reason: "HTTP_ERROR" | "BAD_SHAPE" | "NETWORK_ERROR" | "TIMEOUT"; httpStatus?: number; body?: string; message: string };

/**
 * Fetches FMP's economic calendar. Returns a discriminated result so the
 * caller can tell a genuine "fetch failed" apart from a genuine "fetch
 * succeeded, zero matching events" — these must never be conflated (a
 * failed fetch must never silently look like "0 real events").
 */
async function fetchFmpCalendar(apiKey: string): Promise<FmpFetchResult> {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${from}&to=${to}&apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const body = await response.text().catch(() => "<unreadable body>");
      console.warn(`[EconCalendar] FMP returned ${response.status}. Body: ${body}`);
      return { ok: false, reason: "HTTP_ERROR", httpStatus: response.status, body, message: `FMP HTTP ${response.status}` };
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      const bodyPreview = JSON.stringify(data).slice(0, 500);
      console.warn("[EconCalendar] FMP returned unexpected shape:", bodyPreview);
      return { ok: false, reason: "BAD_SHAPE", message: "FMP returned non-array shape", body: bodyPreview };
    }
    return { ok: true, events: data as FmpCalendarEntry[] };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && error.name === "AbortError";
    console.warn(`[EconCalendar] FMP fetch failed (${isAbort ? "timeout" : "network error"}):`, message);
    return { ok: false, reason: isAbort ? "TIMEOUT" : "NETWORK_ERROR", message };
  }
}

export const economicCalendarRouter = createTRPCRouter({
  /**
   * Returns the raw, filtered set of USD-denominated gold-relevant high
   * impact events within [-24h, +72h] of now, cached server-side for
   * 30-60 minutes.
   *
   * source: "FMP" means the fetch genuinely succeeded (events may still be
   * an empty array — that's a real "no upcoming events" result, or a stale
   * cache serve from the last successful fetch).
   *
   * source: "UNAVAILABLE" means the fetch itself failed for any reason
   * (missing key, network error, timeout, or any non-OK HTTP status
   * including 403) and there is no usable cache to fall back to — the
   * client MUST treat this as a trigger to use its own date-pattern
   * heuristic, never as "0 real events".
   */
  getUpcomingEvents: publicProcedure.query(async () => {
    const now = Date.now();
    if (calendarCache && now - calendarCache.timestamp < CACHE_MS) {
      return {
        events: calendarCache.events.filter(isGoldRelevantHighImpact).map(normalizeFmpEntry),
        source: "FMP" as const,
        cached: true,
        timestamp: calendarCache.timestamp,
      };
    }

    const apiKey = getFmpApiKey();
    if (!apiKey) {
      console.warn("[EconCalendar] FMP_API_KEY not configured on the backend -> source: UNAVAILABLE");
      return { events: [] as NormalizedCalendarEvent[], source: "UNAVAILABLE" as const, cached: false, timestamp: now };
    }

    const result = await fetchFmpCalendar(apiKey);

    if (!result.ok) {
      // A genuine fetch failure. If we have any previous successful fetch
      // cached, serve that stale-but-real data rather than nothing. Only
      // when there's no cache at all do we report UNAVAILABLE.
      if (calendarCache) {
        const ageMin = ((now - calendarCache.timestamp) / 60000).toFixed(0);
        console.warn(
          `[EconCalendar] FMP fetch failed this cycle (${result.reason}${result.httpStatus ? ` ${result.httpStatus}` : ""}), serving stale cache (${ageMin}min old) -> source: FMP (cached)`
        );
        return {
          events: calendarCache.events.filter(isGoldRelevantHighImpact).map(normalizeFmpEntry),
          source: "FMP" as const,
          cached: true,
          timestamp: calendarCache.timestamp,
        };
      }
      console.warn(
        `[EconCalendar] FMP fetch failed (${result.reason}${result.httpStatus ? ` ${result.httpStatus}` : ""}), no cache available -> source: UNAVAILABLE. Detail: ${result.message}${result.body ? ` | body: ${result.body}` : ""}`
      );
      return { events: [] as NormalizedCalendarEvent[], source: "UNAVAILABLE" as const, cached: false, timestamp: now };
    }

    calendarCache = { events: result.events, timestamp: now };
    const filtered = result.events.filter(isGoldRelevantHighImpact);
    console.log(`[EconCalendar] FMP success: ${result.events.length} raw events, ${filtered.length} gold-relevant high-impact -> source: FMP`);
    return { events: filtered.map(normalizeFmpEntry), source: "FMP" as const, cached: false, timestamp: now };
  }),
});
