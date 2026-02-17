import { createTRPCRouter, publicProcedure } from "../create-context";
import * as z from "zod";

let goldPriceCache: { price: number; source: string; timestamp: number } | null = null;
let intermarketCache: { dxy: number; us10y: number; vix: number; timestamp: number } | null = null;
const GOLD_CACHE_MS = 15000;
const INTERMARKET_CACHE_MS = 60000;
const RECENT_CACHE_MS = 600000;
const STALE_CACHE_MS = 3600000;

const apiFailures: Map<string, { count: number; lastFailure: number }> = new Map();
const FAILURE_COOLDOWN_MS = 60000;
const MAX_FAILURES_BEFORE_COOLDOWN = 8;

function shouldSkipApi(apiName: string): boolean {
  const failure = apiFailures.get(apiName);
  if (!failure) return false;
  if (failure.count >= MAX_FAILURES_BEFORE_COOLDOWN) {
    if (Date.now() - failure.lastFailure < FAILURE_COOLDOWN_MS) {
      return true;
    }
    apiFailures.delete(apiName);
  }
  return false;
}

function recordApiFailure(apiName: string): void {
  const failure = apiFailures.get(apiName) || { count: 0, lastFailure: 0 };
  failure.count++;
  failure.lastFailure = Date.now();
  apiFailures.set(apiName, failure);
}

function recordApiSuccess(apiName: string): void {
  apiFailures.delete(apiName);
}

async function fetchWithTimeout(url: string, timeout = 6000, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        ...headers,
      },
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function fetchFinnhubGold(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('finnhub')) {
    console.log('[GOLD] Skipping Finnhub (in cooldown)');
    return null;
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    console.log('[GOLD] Finnhub API key not configured');
    return null;
  }

  try {
    console.log('[GOLD] Trying Finnhub OANDA:XAU_USD...');
    const response = await fetchWithTimeout(
      `https://finnhub.io/api/v1/quote?symbol=OANDA:XAU_USD&token=${apiKey}`,
      8000
    );
    if (response.ok) {
      const data = await response.json();
      const price = data?.c;
      if (typeof price === 'number' && price > 1000 && price < 10000) {
        console.log(`[GOLD] Finnhub success: ${price} (c=${data.c}, h=${data.h}, l=${data.l}, o=${data.o})`);
        recordApiSuccess('finnhub');
        return { price: parseFloat(price.toFixed(2)), source: 'finnhub-spot' };
      } else {
        console.log(`[GOLD] Finnhub returned invalid price: ${price}`, data);
      }
    } else {
      console.log(`[GOLD] Finnhub returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] Finnhub error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('finnhub');
  return null;
}

async function fetchSwissquoteGold(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('swissquote')) {
    console.log('[GOLD] Skipping Swissquote (in cooldown)');
    return null;
  }

  try {
    console.log('[GOLD] Trying Swissquote XAU/USD...');
    const response = await fetchWithTimeout(
      'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
      8000
    );
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const quote = data[0];
        const bid = quote?.spreadProfilePrices?.[0]?.bid;
        const ask = quote?.spreadProfilePrices?.[0]?.ask;
        if (bid && ask && typeof bid === 'number' && typeof ask === 'number') {
          const price = parseFloat(((bid + ask) / 2).toFixed(2));
          if (price > 1000 && price < 10000) {
            console.log(`[GOLD] Swissquote success: ${price} (bid: ${bid}, ask: ${ask})`);
            recordApiSuccess('swissquote');
            return { price, source: 'swissquote-spot' };
          }
        }
      }
    } else {
      console.log(`[GOLD] Swissquote returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] Swissquote error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('swissquote');
  return null;
}

async function fetchFXCMGold(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('fxcm')) {
    console.log('[GOLD] Skipping FXCM (in cooldown)');
    return null;
  }

  try {
    console.log('[GOLD] Trying FXCM rates...');
    const response = await fetchWithTimeout(
      'https://ratesjson.fxcm.com/DataDisplayer',
      8000
    );
    if (response.ok) {
      let text = await response.text();
      text = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
      try {
        const data = JSON.parse(text);
        const rates = data?.Rates;
        if (Array.isArray(rates)) {
          const goldRate = rates.find((r: any) => r.Symbol === 'XAU/USD' || r.Symbol === 'XAUUSD');
          if (goldRate) {
            const bid = parseFloat(goldRate.Bid);
            const ask = parseFloat(goldRate.Ask);
            if (!isNaN(bid) && !isNaN(ask) && bid > 1000) {
              const price = parseFloat(((bid + ask) / 2).toFixed(2));
              console.log(`[GOLD] FXCM success: ${price} (bid: ${bid}, ask: ${ask})`);
              recordApiSuccess('fxcm');
              return { price, source: 'fxcm-spot' };
            }
          }
        }
      } catch {
        console.log('[GOLD] FXCM JSON parse failed');
      }
    } else {
      console.log(`[GOLD] FXCM returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] FXCM error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('fxcm');
  return null;
}

async function fetchMetalsLive(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('metalslive')) {
    console.log('[GOLD] Skipping metals.live (in cooldown)');
    return null;
  }

  try {
    console.log('[GOLD] Trying metals.live...');
    const response = await fetchWithTimeout('https://api.metals.live/v1/spot/gold', 6000);
    if (response.ok) {
      const data = await response.json();
      if (data?.[0]?.price) {
        const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
        if (price > 1000) {
          console.log(`[GOLD] metals.live success: ${price}`);
          recordApiSuccess('metalslive');
          return { price, source: 'metals.live-spot' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] metals.live error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('metalslive');
  return null;
}

async function fetchGoldPriceOrg(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('goldprice')) {
    console.log('[GOLD] Skipping goldprice.org (in cooldown)');
    return null;
  }

  try {
    console.log('[GOLD] Trying goldprice.org...');
    const response = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD', 6000);
    if (response.ok) {
      const data = await response.json();
      if (data.items?.[0]?.xauPrice) {
        const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
        if (price > 1000) {
          console.log(`[GOLD] goldprice.org success: ${price}`);
          recordApiSuccess('goldprice');
          return { price, source: 'goldprice.org-spot' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] goldprice.org error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('goldprice');
  return null;
}

async function fetchForexSpot(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('forexspot')) {
    console.log('[GOLD] Skipping forex spot (in cooldown)');
    return null;
  }

  try {
    console.log('[GOLD] Trying open.er-api.com (XAU spot)...');
    const response = await fetchWithTimeout('https://open.er-api.com/v6/latest/XAU', 6000);
    if (response.ok) {
      const data = await response.json();
      if (data?.rates?.USD) {
        const price = parseFloat((1 / data.rates.USD).toFixed(2));
        if (price > 1000 && price < 10000) {
          console.log(`[GOLD] open.er-api spot success: ${price}`);
          recordApiSuccess('forexspot');
          return { price, source: 'forex-spot' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] open.er-api error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('forexspot');
  return null;
}

async function fetchYahooSymbol(symbol: string): Promise<number | null> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${symbol}?interval=1m&range=1d`;
      const response = await fetchWithTimeout(url, 4000);

      if (!response.ok) continue;

      const data = await response.json();
      if (data?.chart?.result?.[0]?.meta?.regularMarketPrice) {
        return parseFloat(data.chart.result[0].meta.regularMarketPrice);
      }
    } catch {
      continue;
    }
  }
  return null;
}

export const goldPriceRouter = createTRPCRouter({
  getSpotPrice: publicProcedure.query(async () => {
    const now = Date.now();
    console.log('[GOLD] getSpotPrice called - using forex spot sources only');

    if (goldPriceCache && now - goldPriceCache.timestamp < GOLD_CACHE_MS) {
      return { price: goldPriceCache.price, source: goldPriceCache.source, timestamp: goldPriceCache.timestamp, cached: true };
    }

    const [finnhubResult, swissquoteResult, fxcmResult, metalsResult, goldpriceResult, forexResult] = await Promise.allSettled([
      fetchFinnhubGold(),
      fetchSwissquoteGold(),
      fetchFXCMGold(),
      fetchMetalsLive(),
      fetchGoldPriceOrg(),
      fetchForexSpot(),
    ]);

    const results = [
      { name: 'finnhub', result: finnhubResult },
      { name: 'swissquote', result: swissquoteResult },
      { name: 'fxcm', result: fxcmResult },
      { name: 'metalslive', result: metalsResult },
      { name: 'goldprice', result: goldpriceResult },
      { name: 'forexspot', result: forexResult },
    ];

    const validPrices: { price: number; source: string; name: string }[] = [];
    for (const { name, result } of results) {
      if (result.status === 'fulfilled' && result.value) {
        validPrices.push({ price: result.value.price, source: result.value.source, name });
      }
    }

    if (validPrices.length > 0) {
      if (validPrices.length >= 2) {
        validPrices.sort((a, b) => a.price - b.price);
        const median = validPrices[Math.floor(validPrices.length / 2)];
        const filtered = validPrices.filter(p => Math.abs(p.price - median.price) < 15);

        if (filtered.length >= 2) {
          const avgPrice = parseFloat((filtered.reduce((sum, p) => sum + p.price, 0) / filtered.length).toFixed(2));
          const sourceNames = filtered.map(p => p.name).join('+');
          console.log(`[GOLD] Using consensus of ${filtered.length} sources: ${avgPrice} (${sourceNames})`);
          goldPriceCache = { price: avgPrice, source: `consensus-${sourceNames}`, timestamp: now };
          return { price: avgPrice, source: `consensus-${sourceNames}`, timestamp: now, cached: false };
        }
      }

      const best = validPrices[0];
      console.log(`[GOLD] Using single source ${best.name}: ${best.price}`);
      goldPriceCache = { price: best.price, source: best.source, timestamp: now };
      return { price: best.price, source: best.source, timestamp: now, cached: false };
    }

    if (goldPriceCache && now - goldPriceCache.timestamp < RECENT_CACHE_MS) {
      const ageS = ((now - goldPriceCache.timestamp) / 1000).toFixed(0);
      console.log(`[GOLD] Using recent cache (${ageS}s old): ${goldPriceCache.price}`);
      return { price: goldPriceCache.price, source: `recent-cache-${ageS}s`, timestamp: goldPriceCache.timestamp, cached: true };
    }

    if (goldPriceCache) {
      const ageS = ((now - goldPriceCache.timestamp) / 1000).toFixed(0);
      console.warn(`[GOLD] Using stale cache (${ageS}s old): ${goldPriceCache.price}`);
      return { price: goldPriceCache.price, source: `stale-cache-${ageS}s`, timestamp: goldPriceCache.timestamp, cached: true };
    }

    console.error('[GOLD] ALL SPOT PRICE SOURCES FAILED - No cache available');
    return { price: 0, source: 'unavailable', timestamp: now, cached: false };
  }),

  healthCheck: publicProcedure.query(async () => {
    const sources = [
      { name: 'finnhub', test: () => fetchFinnhubGold() },
      { name: 'swissquote', test: () => fetchSwissquoteGold() },
      { name: 'fxcm', test: () => fetchFXCMGold() },
      { name: 'metals.live', test: () => fetchMetalsLive() },
      { name: 'goldprice.org', test: () => fetchGoldPriceOrg() },
      { name: 'forex-spot', test: () => fetchForexSpot() },
    ];

    const results = await Promise.allSettled(
      sources.map(async (s) => {
        const result = await s.test();
        return { name: s.name, working: !!result, price: result?.price };
      })
    );

    return {
      timestamp: Date.now(),
      cache: goldPriceCache ? { price: goldPriceCache.price, age: Date.now() - goldPriceCache.timestamp } : null,
      sources: results.map((r) => r.status === 'fulfilled' ? r.value : { name: 'unknown', working: false }),
    };
  }),

  getHistoricalData: publicProcedure
    .input(z.object({
      fromTime: z.number(),
      toTime: z.number(),
    }))
    .query(async ({ input }) => {
      const { fromTime, toTime } = input;
      const period1 = Math.floor(fromTime / 1000);
      const period2 = Math.floor(toTime / 1000) + 120;

      const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

      for (const host of hosts) {
        try {
          const url = `https://${host}/v8/finance/chart/GC=F?interval=1m&period1=${period1}&period2=${period2}`;
          console.log(`[GOLD-HISTORY] Fetching ${url}`);
          const response = await fetchWithTimeout(url, 5000);

          if (!response.ok) {
            console.log(`[GOLD-HISTORY] ${host} returned ${response.status}`);
            continue;
          }

          const data = await response.json();
          if (!data?.chart?.result?.[0]?.timestamp) {
            console.log(`[GOLD-HISTORY] Invalid data from ${host}`);
            continue;
          }

          const result = data.chart.result[0];
          const timestamps = result.timestamp;
          const quotes = result.indicators.quote[0];

          const bars = [];

          for (let i = 0; i < timestamps.length; i++) {
            const barTime = timestamps[i] * 1000;

            if (barTime >= fromTime && barTime <= toTime) {
              const open = quotes.open[i];
              const high = quotes.high[i];
              const low = quotes.low[i];
              const close = quotes.close[i];

              if (open !== null && high !== null && low !== null && close !== null) {
                bars.push({
                  timestamp: barTime,
                  open,
                  high,
                  low,
                  close,
                });
              }
            }
          }

          console.log(`[GOLD-HISTORY] Success: fetched ${bars.length} bars`);
          return bars;
        } catch (e) {
          console.error(`[GOLD-HISTORY] Error fetching from ${host}:`, e);
          continue;
        }
      }

      return [];
    }),

  getIntermarketData: publicProcedure.query(async () => {
    const now = Date.now();
    console.log('[INTERMARKET] getIntermarketData called');

    if (intermarketCache && now - intermarketCache.timestamp < INTERMARKET_CACHE_MS) {
      console.log('[INTERMARKET] Returning cached data');
      return {
        dxy: intermarketCache.dxy,
        us10y: intermarketCache.us10y,
        vix: intermarketCache.vix,
        timestamp: intermarketCache.timestamp,
        cached: true
      };
    }

    console.log('[INTERMARKET] Fetching fresh data from Yahoo...');
    const [dxyResult, us10yResult, vixResult] = await Promise.allSettled([
      fetchYahooSymbol('DX=F'),
      fetchYahooSymbol('%5ETNX'),
      fetchYahooSymbol('%5EVIX'),
    ]);

    const dxy = dxyResult.status === 'fulfilled' && dxyResult.value ? dxyResult.value : (intermarketCache?.dxy || 103.5);
    const us10y = us10yResult.status === 'fulfilled' && us10yResult.value ? us10yResult.value : (intermarketCache?.us10y || 4.2);
    const vix = vixResult.status === 'fulfilled' && vixResult.value ? vixResult.value : (intermarketCache?.vix || 18);

    console.log(`[INTERMARKET] Results - DXY: ${dxy}, US10Y: ${us10y}, VIX: ${vix}`);

    intermarketCache = { dxy, us10y, vix, timestamp: now };

    return { dxy, us10y, vix, timestamp: now, cached: false };
  }),
});
