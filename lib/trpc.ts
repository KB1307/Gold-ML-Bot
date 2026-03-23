import { httpLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";

import type { AppRouter } from "@/backend/trpc/app-router";

export interface HistoricalPriceBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
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

export const fetchHistoricalData = async (
  input: { fromTime: number; toTime: number; timeoutMs?: number },
): Promise<HistoricalPriceBar[]> => {
  const { fromTime, toTime, timeoutMs = 25000 } = input;
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;

  const requestUrl = `${getPrimaryTrpcUrl()}/goldPrice.getHistoricalData?input=${encodeURIComponent(
    JSON.stringify({ json: { fromTime, toTime } }),
  )}`;
  const attemptUrls = buildAttemptUrls(requestUrl);
  let lastError: unknown = null;

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

        const rawBody = await response.text();

        if (!response.ok) {
          console.warn(
            `⚠️ [History] Request failed with status ${response.status}: ${rawBody.slice(0, 240)}`,
          );
          continue;
        }

        const payload = recoverJsonPayload(rawBody);
        const bars = extractHistoricalBars(payload);

        if (bars.length > 0 || rawBody.includes("[]")) {
          console.log(`✅ [History] Parsed ${bars.length} historical bar(s)`);
          return bars;
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
    console.error("❌ [History] All historical data fetch attempts failed:", lastError);
  }

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
