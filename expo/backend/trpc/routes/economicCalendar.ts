import { createTRPCRouter, publicProcedure } from "../create-context";

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
  const key = process.env.FMP_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

function isGoldRelevantHighImpact(entry: FmpCalendarEntry): boolean {
  if (entry.currency !== "USD" && entry.country !== "US") return false;
  const impactHigh = (entry.impact ?? "").toLowerCase() === "high";
  const nameMatches = GOLD_RELEVANT_EVENT_PATTERNS.some((pattern) => pattern.test(entry.event ?? ""));
  return impactHigh || nameMatches;
}

async function fetchFmpCalendar(apiKey: string): Promise<FmpCalendarEntry[]> {
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
      console.warn(`[EconCalendar] FMP returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      console.warn("[EconCalendar] FMP returned unexpected shape:", data);
      return [];
    }
    return data as FmpCalendarEntry[];
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[EconCalendar] FMP fetch failed:", message);
    return [];
  }
}

export const economicCalendarRouter = createTRPCRouter({
  /**
   * Returns the raw, filtered set of USD-denominated gold-relevant high
   * impact events within [-24h, +72h] of now, cached server-side for
   * 30-60 minutes. Empty array (not an error) means "no upcoming events" OR
   * "FMP unreachable" — the client falls back to its own date-pattern
   * heuristic in either case, so it never silently reports "no macro event".
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
      console.warn("[EconCalendar] FMP_API_KEY not configured on the backend");
      return { events: [] as NormalizedCalendarEvent[], source: "UNAVAILABLE" as const, cached: false, timestamp: now };
    }

    const rawEvents = await fetchFmpCalendar(apiKey);
    if (rawEvents.length === 0 && calendarCache) {
      // FMP failed this cycle — serve stale cache rather than nothing, if we have it.
      const ageMin = ((now - calendarCache.timestamp) / 60000).toFixed(0);
      console.warn(`[EconCalendar] FMP fetch failed this cycle, serving stale cache (${ageMin}min old)`);
      return {
        events: calendarCache.events.filter(isGoldRelevantHighImpact).map(normalizeFmpEntry),
        source: "FMP" as const,
        cached: true,
        timestamp: calendarCache.timestamp,
      };
    }

    calendarCache = { events: rawEvents, timestamp: now };
    const filtered = rawEvents.filter(isGoldRelevantHighImpact);
    console.log(`[EconCalendar] FMP success: ${rawEvents.length} raw events, ${filtered.length} gold-relevant high-impact`);
    return { events: filtered.map(normalizeFmpEntry), source: "FMP" as const, cached: false, timestamp: now };
  }),
});
