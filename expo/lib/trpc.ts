import { httpLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";
import { createClient } from "@supabase/supabase-js";

import type { AppRouter } from "@/backend/trpc/app-router";

export interface HistoricalPriceBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * STEP 1 FIX (instrument mismatch): which real instrument/tier actually
   * produced this bar -- 'twelvedata-spot' (correct, primary), 'yahoo-futures-fallback'
   * (GC=F futures, approximation-only last-real-data resort), 'twelvedata-spot-direct'
   * (client-side direct fallback when the backend itself is unreachable), or
   * 'swissquote-synthetic' (single extrapolated point, last resort). Optional so
   * older cached/test data without this field still type-checks.
   */
  source?: string;
}

export const trpc = createTRPCReact<AppRouter>();

const TRPC_PATH = "/api/trpc";

const normalizeBaseUrl = (url: string): string => {
  const trimmedUrl = url.trim().replace(/\/+$/, "");

  if (trimmedUrl.endsWith(TRPC_PATH)) {
    return trimmedUrl.slice(0, -TRPC_PATH.length);
  }

  if (trimmedUrl.endsWith("/api")) {
    return trimmedUrl.slice(0, -4);
  }

  return trimmedUrl;
};

const getBaseUrlCandidates = (): string[] => {
  const candidates: string[] = [];
  const configuredBaseUrl = process.env.EXPO_PUBLIC_RORK_API_BASE_URL;

  if (configuredBaseUrl) {
    candidates.push(normalizeBaseUrl(configuredBaseUrl));
  }

  if (typeof window !== "undefined" && typeof window.location?.origin === "string") {
    candidates.push(normalizeBaseUrl(window.location.origin));
  }

  const uniqueCandidates = Array.from(new Set(candidates.filter(Boolean)));

  if (uniqueCandidates.length === 0) {
    throw new Error(
      "Rork did not set EXPO_PUBLIC_RORK_API_BASE_URL, please use support",
    );
  }

  return uniqueCandidates;
};

const getPrimaryTrpcUrl = (): string => `${getBaseUrlCandidates()[0]}${TRPC_PATH}`;

/**
 * Base API origin (no /api/trpc suffix) — used to build plain, non-tRPC
 * download links such as the Export Diagnostics pull-by-URL endpoint
 * (`${getApiOrigin()}/api/export/latest`).
 */
export const getApiOrigin = (): string => getBaseUrlCandidates()[0];

const isNetworkRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("networkerror") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("load failed") ||
    message.includes("network request failed")
  );
};

const buildAttemptUrls = (requestUrl: string): string[] => {
  const attemptUrls = [requestUrl];

  try {
    const parsedRequestUrl = new URL(requestUrl);
    const pathIndex = parsedRequestUrl.pathname.indexOf(TRPC_PATH);
    const suffixPath = pathIndex >= 0
      ? parsedRequestUrl.pathname.slice(pathIndex + TRPC_PATH.length)
      : "";
    const suffix = `${suffixPath}${parsedRequestUrl.search}`;

    getBaseUrlCandidates().forEach((baseUrl) => {
      attemptUrls.push(`${baseUrl}${TRPC_PATH}${suffix}`);
    });
  } catch (error) {
    console.warn("⚠️ [tRPC] Failed to parse request URL for fallback attempts:", error);
  }

  return Array.from(new Set(attemptUrls));
};

const getRequestHeaders = (headersInit: HeadersInit | undefined, method: string): Headers => {
  const headers = new Headers(headersInit);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (headers.get("trpc-accept") === "application/jsonl") {
    headers.set("trpc-accept", "application/json");
  }

  if (method !== "GET" && method !== "HEAD" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return headers;
};

const isAbortError = (error: unknown): boolean => {
  return error instanceof Error && error.name === "AbortError";
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isHistoricalPriceBar = (value: unknown): value is HistoricalPriceBar => {
  if (!isObjectRecord(value)) {
    return false;
  }

  const { timestamp, open, high, low, close } = value;

  return [timestamp, open, high, low, close].every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
};

/** Normalizes a raw parsed bar into HistoricalPriceBar, preserving an optional `source` tag if present. */
const withSourceTag = (value: unknown, fallbackSource: string): HistoricalPriceBar => {
  const record = value as Record<string, unknown>;
  const rawSource = record.source;
  return {
    timestamp: record.timestamp as number,
    open: record.open as number,
    high: record.high as number,
    low: record.low as number,
    close: record.close as number,
    source: typeof rawSource === "string" && rawSource.length > 0 ? rawSource : fallbackSource,
  };
};

const normalizeHistoricalBars = (value: unknown): HistoricalPriceBar[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isHistoricalPriceBar);
};

const recoverJsonPayload = (rawBody: string): unknown => {
  const sanitized = rawBody.replace(/^\uFEFF/, "").trim();

  if (!sanitized) {
    return null;
  }

  const attempts: string[] = [];

  const pushAttempt = (value: string): void => {
    const trimmedValue = value.trim();
    if (trimmedValue && !attempts.includes(trimmedValue)) {
      attempts.push(trimmedValue);
    }
  };

  pushAttempt(sanitized);

  const firstObjectIndex = sanitized.indexOf("{");
  const lastObjectIndex = sanitized.lastIndexOf("}");
  if (firstObjectIndex >= 0 && lastObjectIndex > firstObjectIndex) {
    pushAttempt(sanitized.slice(firstObjectIndex, lastObjectIndex + 1));
  }

  const firstArrayIndex = sanitized.indexOf("[");
  const lastArrayIndex = sanitized.lastIndexOf("]");
  if (firstArrayIndex >= 0 && lastArrayIndex > firstArrayIndex) {
    pushAttempt(sanitized.slice(firstArrayIndex, lastArrayIndex + 1));
  }

  sanitized.split(/\r?\n/).forEach((line) => {
    pushAttempt(line);
  });

  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }

  return null;
};

const extractHistoricalBars = (payload: unknown): HistoricalPriceBar[] => {
  const directBars = normalizeHistoricalBars(payload);
  if (directBars.length > 0) {
    return directBars;
  }

  if (!isObjectRecord(payload)) {
    return [];
  }

  const payloadJsonBars = normalizeHistoricalBars(payload.json);
  if (payloadJsonBars.length > 0) {
    return payloadJsonBars;
  }

  const payloadData = payload.data;
  if (isObjectRecord(payloadData)) {
    const payloadDataJsonBars = normalizeHistoricalBars(payloadData.json);
    if (payloadDataJsonBars.length > 0) {
      return payloadDataJsonBars;
    }
  }

  const result = payload.result;
  if (isObjectRecord(result)) {
    const resultJsonBars = normalizeHistoricalBars(result.json);
    if (resultJsonBars.length > 0) {
      return resultJsonBars;
    }

    const resultData = result.data;
    if (isObjectRecord(resultData)) {
      const resultDataJsonBars = normalizeHistoricalBars(resultData.json);
      if (resultDataJsonBars.length > 0) {
        return resultDataJsonBars;
      }
    }
  }

  return [];
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithClientTimeout = async (
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
};

const fetchTwelveDataDirect = async (
  fromTime: number,
  toTime: number,
): Promise<HistoricalPriceBar[]> => {
  const apiKey = process.env.EXPO_PUBLIC_TWELVEDATA_API_KEY?.trim();
  if (!apiKey) {
    console.log("[History-Direct] TwelveData key not configured");
    return [];
  }

  try {
    const startDate = new Date(fromTime).toISOString().slice(0, 19);
    const endDate = new Date(toTime).toISOString().slice(0, 19);
    // ITEM 1 FIX: TwelveData defaults Forex symbols (XAU/USD included) to
    // Australia/Sydney time unless &timezone=UTC is explicitly passed - only
    // Crypto defaults to UTC per TwelveData's own docs. Without this, a
    // timezone-less date string can be silently misinterpreted by up to 10
    // hours. This explicit parameter is the real fix, not the ISO string shape.
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&start_date=${startDate}&end_date=${endDate}&outputsize=500&timezone=UTC&apikey=${apiKey}`;
    // ITEM 5: log the raw request URL (API key redacted) so any future audit
    // investigation has hard evidence the timezone=UTC parameter is actually
    // present on the real outbound call, without re-deriving it from scratch.
    console.log(`[History-Direct] Fetching from TwelveData. Raw URL (redacted): ${url.replace(apiKey, "***REDACTED***")}`);
    const response = await fetchWithClientTimeout(url, 12000);

    if (!response.ok) {
      console.log(`[History-Direct] TwelveData returned ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (data?.status === "error") {
      console.log(`[History-Direct] TwelveData API error: ${data?.message}`);
      return [];
    }

    const values = data?.values;
    if (!Array.isArray(values) || values.length === 0) {
      console.log("[History-Direct] TwelveData: No values returned");
      return [];
    }

    const bars: HistoricalPriceBar[] = [];
    for (const v of values) {
      const ts = new Date(v.datetime + "Z").getTime();
      const open = parseFloat(v.open);
      const high = parseFloat(v.high);
      const low = parseFloat(v.low);
      const close = parseFloat(v.close);
      if (
        !isNaN(ts) &&
        !isNaN(open) &&
        !isNaN(high) &&
        !isNaN(low) &&
        !isNaN(close) &&
        open > 1000
      ) {
        if (ts >= fromTime && ts <= toTime) {
          // STEP 1 FIX: this direct client-side fallback already correctly targets
          // spot XAU/USD (not futures) -- tag it distinctly from the backend's
          // primary tier so diagnostics can tell the two apart.
          bars.push({ timestamp: ts, open, high, low, close, source: "twelvedata-spot-direct" });
        }
      }
    }

    bars.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`✅ [History-Direct] TwelveData success: ${bars.length} bars`);
    return bars;
  } catch (e) {
    console.warn(
      "[History-Direct] TwelveData error:",
      e instanceof Error ? e.message : "Unknown",
    );
    return [];
  }
};

// Tiingo's IEX endpoint (previously the middle tier here) was removed: verified via a
// real live call on 2026-07-13 that it returns HTTP 200 with an empty `[]` body for
// xauusd — it's a US-equities/crypto product with no forex data, so it was a guaranteed
// wasted round-trip (plus its own timeout) in exactly the worst-case fallback scenario.
const fetchSwissquoteSyntheticBars = async (
  fromTime: number,
  toTime: number,
): Promise<HistoricalPriceBar[]> => {
  try {
    console.log("[History-Direct] Fetching Swissquote current price for synthetic bars...");
    const response = await fetchWithClientTimeout(
      "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
      8000,
    );

    if (!response.ok) return [];

    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return [];

    const quote = data[0];
    const bid = quote?.spreadProfilePrices?.[0]?.bid;
    const ask = quote?.spreadProfilePrices?.[0]?.ask;

    if (
      typeof bid !== "number" ||
      typeof ask !== "number" ||
      bid <= 1000
    ) {
      return [];
    }

    const price = parseFloat(((bid + ask) / 2).toFixed(2));
    const now = Date.now();
    const bar: HistoricalPriceBar = {
      timestamp: now,
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      source: "swissquote-synthetic",
    };

    console.log(
      `✅ [History-Direct] Swissquote synthetic bar: ${price} (single point)`,
    );
    return [bar];
  } catch (e) {
    console.warn(
      "[History-Direct] Swissquote error:",
      e instanceof Error ? e.message : "Unknown",
    );
    return [];
  }
};

const fetchDirectHistoricalFallback = async (
  fromTime: number,
  toTime: number,
): Promise<HistoricalPriceBar[]> => {
  console.log("🔄 [History-Direct] Backend unreachable — trying direct API fallbacks...");

  const twelveDataBars = await fetchTwelveDataDirect(fromTime, toTime);
  if (twelveDataBars.length > 0) return twelveDataBars;

  const syntheticBars = await fetchSwissquoteSyntheticBars(fromTime, toTime);
  if (syntheticBars.length > 0) return syntheticBars;

  console.warn("❌ [History-Direct] All direct fallbacks also failed");
  return [];
};

/**
 * PRIMARY OHLC source: queries gold_m1_bars (Vantage MT5 / Exness XAUUSDm)
 * directly from Supabase — the SAME venue used for audit/resolution/S-R zones.
 * This eliminates the ~$59 median basis between the GC=F/TwelveData chain and
 * Vantage bars that was mis-sizing SL/TP risk on ~44% of trading hours.
 *
 * gold_m1_bars.timestamp is an ISO string (open-timestamped, per the Phase 0
 * verification). We convert to epoch-ms to match HistoricalPriceBar's shape.
 * Bars are returned ascending by timestamp, same as the backend route.
 *
 * A stale-bar guard (STALE_BAR_THRESHOLD_MS): if the newest bar's timestamp is
 * older than this threshold relative to `toTime`, the bars are considered stale
 * (the sync script may be down) and we return an EMPTY array so the caller falls
 * through to the existing GC=F/TwelveData fallback chain — we never silently
 * serve stale bars as if current.
 */
const STALE_BAR_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes — bars older than this vs toTime are stale

const supabaseOhlcClient = (() => {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
})();

const fetchOHLCHistoryFromSupabase = async (
  fromTime: number,
  toTime: number,
): Promise<HistoricalPriceBar[]> => {
  if (!supabaseOhlcClient) {
    console.log("📊 [History-Supabase] No Supabase client — skipping primary OHLC source");
    return [];
  }

  const fromIso = new Date(fromTime).toISOString();
  const toIso = new Date(toTime).toISOString();

  try {
    // Phase B1 fix: PostgREST caps responses at 1000 rows server-side, so
    // .limit() alone cannot override it. The 72h daily-OHLC refresh lookback
    // needs ~4320 bars (72*60), so a single capped query silently truncated
    // the result to ~16h, which then failed the stale-bar guard (newest bar
    // ~55h old vs toTime) and returned empty — breaking the daily OHLC feed.
    // Paginate with .range() in 1000-row pages until the window is exhausted.
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 10; // 10k bars = ~7 days of 1-min bars, well above any lookback
    let allData: { timestamp: string; open: number; high: number; low: number; close: number }[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const startIdx = page * PAGE_SIZE;
      const endIdx = startIdx + PAGE_SIZE - 1;

      const { data: pageData, error: pageError } = await supabaseOhlcClient
        .from("gold_m1_bars")
        .select("timestamp, open, high, low, close")
        .gte("timestamp", fromIso)
        .lte("timestamp", toIso)
        .order("timestamp", { ascending: true })
        .range(startIdx, endIdx);

      if (pageError) {
        console.warn(`⚠️ [History-Supabase] Query failed (page ${page}): ${pageError.message}`);
        return [];
      }

      if (!pageData || pageData.length === 0) {
        break; // no more rows
      }

      allData = allData.concat(pageData as typeof allData);

      if (pageData.length < PAGE_SIZE) {
        break; // last page — window exhausted
      }
    }

    if (allData.length === 0) {
      console.log("📊 [History-Supabase] No bars in window — falling through to backend chain");
      return [];
    }

    // Stale-bar guard: if the newest bar is far older than toTime, the sync
    // script is likely down. Do NOT serve stale bars as current — return empty
    // so the caller falls through to the fallback chain.
    const newestTs = new Date(allData[allData.length - 1].timestamp).getTime();
    const staleness = toTime - newestTs;
    if (staleness > STALE_BAR_THRESHOLD_MS) {
      console.warn(
        `⚠️ [History-Supabase] Newest bar is ${(staleness / 60000).toFixed(1)}min stale (threshold ${STALE_BAR_THRESHOLD_MS / 60000}min) — NOT serving stale bars; falling through to backend chain`,
      );
      return [];
    }

    const bars: HistoricalPriceBar[] = allData.map((row) => ({
      timestamp: new Date(row.timestamp).getTime(),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      source: "vantage-mt5-supabase",
    }));

    console.log(
      `✅ [History-Supabase] Loaded ${bars.length} bars from gold_m1_bars (Vantage MT5) — SAME venue as audit/resolution`,
    );
    return bars;
  } catch (err) {
    console.warn(
      `⚠️ [History-Supabase] Error: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return [];
  }
};

export const fetchHistoricalData = async (
  input: { fromTime: number; toTime: number; timeoutMs?: number },
): Promise<HistoricalPriceBar[]> => {
  const { fromTime, toTime, timeoutMs = 15000 } = input;

  // PRIMARY: gold_m1_bars from Supabase (same venue as audit/resolution/S-R zones).
  // This is the Step 2b fix — generation and audit now share one spot-accurate,
  // quota-free venue. The existing GC=F/TwelveData backend chain below is the FALLBACK
  // for when Supabase is unreachable or has a stale/missing bar gap.
  const supabaseBars = await fetchOHLCHistoryFromSupabase(fromTime, toTime);
  if (supabaseBars.length > 0) {
    return supabaseBars;
  }

  console.log(
    "🔄 [History] Supabase primary returned no bars — falling back to backend GC=F/TwelveData chain",
  );

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 1500;

  const requestUrl = `${getPrimaryTrpcUrl()}/goldPrice.getHistoricalData?input=${encodeURIComponent(
    JSON.stringify({ json: { fromTime, toTime } }),
  )}`;
  const attemptUrls = buildAttemptUrls(requestUrl);
  let lastError: unknown = null;
  let backendReachable = false;
  let backendReturnedEmpty = false;

  for (let retry = 0; retry < MAX_RETRIES; retry += 1) {
    if (retry > 0) {
      const waitMs = RETRY_DELAY_MS * retry;
      console.log(`⏳ [History] Retry ${retry}/${MAX_RETRIES - 1} after ${waitMs}ms...`);
      await delay(waitMs);
    }

    for (let index = 0; index < attemptUrls.length; index += 1) {
      const attemptUrl = attemptUrls[index];
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        console.log(
          `🌐 [History] GET ${attemptUrl} (retry ${retry}, attempt ${index + 1}/${attemptUrls.length})`,
        );

        const response = await fetch(attemptUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });

        backendReachable = true;
        const rawBody = await response.text();

        if (!response.ok) {
          console.warn(
            `⚠️ [History] Request failed with status ${response.status}: ${rawBody.slice(0, 240)}`,
          );
          continue;
        }

        const payload = recoverJsonPayload(rawBody);
        const bars = extractHistoricalBars(payload);

        if (bars.length > 0) {
          console.log(`✅ [History] Parsed ${bars.length} historical bar(s)`);
          return bars;
        }

        if (rawBody.includes("\"json\":[]") || /\[\s*\]/.test(rawBody)) {
          console.warn(`⚠️ [History] Backend returned empty bars array — will try direct fallback`);
          backendReturnedEmpty = true;
          break;
        }

        console.warn(
          `⚠️ [History] Response parsed but no historical bars were extracted. Prefix: ${rawBody.slice(0, 240)}`,
        );
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : "Unknown";
        console.warn(`⚠️ [History] Request failed for ${attemptUrl}: ${msg}`);

        if (!isNetworkRetryableError(error) && !isAbortError(error)) {
          break;
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  if (lastError) {
    console.warn("⚠️ [History] Backend fetch failed:", lastError instanceof Error ? lastError.message : "Unknown");
  }

  const reason = !backendReachable
    ? "Backend unreachable"
    : backendReturnedEmpty
      ? "Backend returned empty"
      : "Backend returned no parseable bars";
  console.log(`🔄 [History] ${reason} — falling back to direct client-side APIs`);
  const directBars = await fetchDirectHistoricalFallback(fromTime, toTime);
  if (directBars.length > 0) {
    return directBars;
  }

  const syntheticBars = await fetchSwissquoteSyntheticBars(fromTime, toTime);
  if (syntheticBars.length > 0) {
    console.log(
      `✅ [History] Using Swissquote synthetic bar as last-resort fallback (${syntheticBars.length} point)`,
    );
    return syntheticBars;
  }

  console.warn(
    "⚠️ [History] All historical data sources exhausted (backend + direct) — returning empty set; UI should keep showing last known data",
  );
  return [];
};

export const trpcClient = trpc.createClient({
  links: [
    httpLink({
      url: getPrimaryTrpcUrl(),
      transformer: superjson,
      async fetch(url, options) {
        const requestUrl = typeof url === "string"
          ? url
          : url instanceof URL
            ? url.href
            : url.url;
        const method = options?.method?.toUpperCase() ?? "GET";
        const headers = getRequestHeaders(options?.headers as HeadersInit | undefined, method);
        const attemptUrls = buildAttemptUrls(requestUrl);
        let lastError: unknown = null;

        for (let index = 0; index < attemptUrls.length; index += 1) {
          const attemptUrl = attemptUrls[index];

          try {
            console.log(`🌐 [tRPC] ${method} ${attemptUrl} (attempt ${index + 1}/${attemptUrls.length})`);
            return await fetch(attemptUrl, {
              ...options,
              headers,
            });
          } catch (error) {
            lastError = error;
            const shouldRetry = isNetworkRetryableError(error) && index < attemptUrls.length - 1;

            console.warn(`⚠️ [tRPC] Request failed for ${attemptUrl}:`, error);

            if (!shouldRetry) {
              throw error;
            }
          }
        }

        throw lastError instanceof Error ? lastError : new Error("Unknown tRPC fetch failure");
      },
    }),
  ],
});
