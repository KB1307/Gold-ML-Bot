import { trpcClient } from "@/lib/trpc";

type FinnhubRuntimeConfig = {
  apiKey: string | null;
  source: string;
};

let cachedFinnhubApiKey: string | null = null;
let finnhubApiKeyPromise: Promise<string | null> | null = null;

function normalizeFinnhubApiKey(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim() ?? "";
  return trimmedValue.length > 0 ? trimmedValue : null;
}

function getBundledFinnhubApiKey(): FinnhubRuntimeConfig {
  const publicApiKey = normalizeFinnhubApiKey(process.env.EXPO_PUBLIC_FINNHUB_API_KEY);
  if (publicApiKey) {
    cachedFinnhubApiKey = publicApiKey;
    return {
      apiKey: publicApiKey,
      source: "EXPO_PUBLIC_FINNHUB_API_KEY",
    };
  }

  const privateApiKey = normalizeFinnhubApiKey(process.env.FINNHUB_API_KEY);
  if (privateApiKey) {
    cachedFinnhubApiKey = privateApiKey;
    return {
      apiKey: privateApiKey,
      source: "FINNHUB_API_KEY",
    };
  }

  if (cachedFinnhubApiKey) {
    return {
      apiKey: cachedFinnhubApiKey,
      source: "cached-runtime-key",
    };
  }

  return {
    apiKey: null,
    source: "unavailable",
  };
}

async function fetchFinnhubApiKeyFromBackend(): Promise<string | null> {
  try {
    const result = await trpcClient.goldPrice.getFinnhubWebSocketConfig.query();
    const apiKey = normalizeFinnhubApiKey(result?.apiKey);

    if (!apiKey) {
      console.error("❌ [Finnhub] Backend runtime config did not return an API key");
      return null;
    }

    cachedFinnhubApiKey = apiKey;
    console.log(`🔑 [Finnhub] Loaded runtime API key from ${result.source}`);
    return apiKey;
  } catch (error) {
    console.error("❌ [Finnhub] Failed to fetch runtime API key from backend:", error);
    return null;
  }
}

export async function getRuntimeFinnhubApiKey(): Promise<FinnhubRuntimeConfig> {
  const bundledConfig = getBundledFinnhubApiKey();
  if (bundledConfig.apiKey) {
    return bundledConfig;
  }

  if (!finnhubApiKeyPromise) {
    finnhubApiKeyPromise = fetchFinnhubApiKeyFromBackend().finally(() => {
      finnhubApiKeyPromise = null;
    });
  }

  const apiKey = await finnhubApiKeyPromise;

  if (!apiKey) {
    return {
      apiKey: null,
      source: "backend-runtime-config-missing",
    };
  }

  return {
    apiKey,
    source: "backend-runtime-config",
  };
}
