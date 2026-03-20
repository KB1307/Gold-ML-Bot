import { httpLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import superjson from "superjson";

import type { AppRouter } from "@/backend/trpc/app-router";

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
        const headers: Record<string, string> = {
          Accept: "application/json",
          ...(options?.headers as Record<string, string> | undefined),
        };

        if (method !== "GET" && method !== "HEAD") {
          headers["Content-Type"] = "application/json";
        }

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
