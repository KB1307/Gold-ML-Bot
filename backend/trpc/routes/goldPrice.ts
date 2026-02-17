import { createTRPCRouter, publicProcedure } from "../create-context";
import * as z from "zod";

let goldPriceCache: { price: number; source: string; timestamp: number } | null = null;
let intermarketCache: { dxy: number; us10y: number; vix: number; timestamp: number } | null = null;
const GOLD_CACHE_MS = 10000;
const INTERMARKET_CACHE_MS = 60000;
const RECENT_CACHE_MS = 600000;

const apiFailures: Map<string, { count: number; lastFailure: number }> = new Map();
const FAILURE_COOLDOWN_MS = 60000;
const MAX_FAILURES_BEFORE_COOLDOWN = 5;

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

async function fetchWithTimeout(url: string, timeout = 5000, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'GoldSignalBot/1.0',
        'Accept': 'application/json',
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

async function fetchGoldApiIo(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('goldapiio')) {
    console.log('[GOLD] Skipping GoldAPI.io (in cooldown)');
    return null;
  }

  const apiKey = process.env.GOLDAPI_IO_KEY;
  if (!apiKey) {
    console.log('[GOLD] GoldAPI.io key not configured');
    return null;
  }

  try {
    console.log('[GOLD] Trying GoldAPI.io XAU/USD...');
    const response = await fetchWithTimeout(
      'https://www.goldapi.io/api/XAU/USD',
      5000,
      { 'x-access-token': apiKey }
    );
    if (response.ok) {
      const data = await response.json();
      const price = data?.price;
      if (typeof price === 'number' && price > 1000 && price < 10000) {
        console.log(`[GOLD] GoldAPI.io success: ${price} (ask=${data.ask}, bid=${data.bid})`);
        recordApiSuccess('goldapiio');
        return { price: parseFloat(price.toFixed(2)), source: 'goldapi.io' };
      } else {
        console.log(`[GOLD] GoldAPI.io invalid price:`, data);
      }
    } else {
      console.log(`[GOLD] GoldAPI.io returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] GoldAPI.io error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('goldapiio');
  return null;
}

async function fetchMetalsDev(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('metalsdev')) {
    console.log('[GOLD] Skipping Metals.dev (in cooldown)');
    return null;
  }

  const apiKey = process.env.METALS_DEV_KEY;
  if (!apiKey) {
    console.log('[GOLD] Metals.dev key not configured');
    return null;
  }

  try {
    console.log('[GOLD] Trying Metals.dev...');
    const response = await fetchWithTimeout(
      `https://api.metals.dev/v1/latest?api_key=${apiKey}&currency=USD&unit=toz`,
      5000
    );
    if (response.ok) {
      const data = await response.json();
      const price = data?.metals?.gold;
      if (typeof price === 'number' && price > 1000 && price < 10000) {
        console.log(`[GOLD] Metals.dev success: ${price}`);
        recordApiSuccess('metalsdev');
        return { price: parseFloat(price.toFixed(2)), source: 'metals.dev' };
      } else {
        console.log(`[GOLD] Metals.dev invalid price:`, data?.metals);
      }
    } else {
      console.log(`[GOLD] Metals.dev returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] Metals.dev error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('metalsdev');
  return null;
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
      5000
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

async function fetchMetalPriceApi(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('metalpriceapi')) {
    console.log('[GOLD] Skipping MetalPriceAPI (in cooldown)');
    return null;
  }

  const apiKey = process.env.METALPRICE_API_KEY;
  if (!apiKey) {
    console.log('[GOLD] MetalPriceAPI key not configured');
    return null;
  }

  try {
    console.log('[GOLD] Trying MetalPriceAPI XAU/USD...');
    const response = await fetchWithTimeout(
      `https://api.metalpriceapi.com/v1/latest?api_key=${apiKey}&base=USD&currencies=XAU`,
      5000
    );
    if (response.ok) {
      const data = await response.json();
      if (data?.success && data?.rates) {
        let price = 0;
        if (data.rates.XAU && typeof data.rates.XAU === 'number' && data.rates.XAU > 0 && data.rates.XAU < 1) {
          price = parseFloat((1 / data.rates.XAU).toFixed(2));
        } else if (data.rates.USDXAU && typeof data.rates.USDXAU === 'number') {
          if (data.rates.USDXAU > 1000) {
            price = parseFloat(data.rates.USDXAU.toFixed(2));
          } else if (data.rates.USDXAU > 0 && data.rates.USDXAU < 1) {
            price = parseFloat((1 / data.rates.USDXAU).toFixed(2));
          }
        }
        if (price > 1000 && price < 10000) {
          console.log(`[GOLD] MetalPriceAPI success: ${price} (XAU=${data.rates.XAU}, USDXAU=${data.rates.USDXAU})`);
          recordApiSuccess('metalpriceapi');
          return { price, source: 'metalpriceapi' };
        } else {
          console.log(`[GOLD] MetalPriceAPI invalid price: ${price}`, data.rates);
        }
      } else {
        console.log(`[GOLD] MetalPriceAPI invalid response:`, data);
      }
    } else {
      console.log(`[GOLD] MetalPriceAPI returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] MetalPriceAPI error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('metalpriceapi');
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
      5000
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
      5000
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
    const response = await fetchWithTimeout('https://api.metals.live/v1/spot/gold', 5000);
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
    const response = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD', 5000);
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
    const response = await fetchWithTimeout('https://open.er-api.com/v6/latest/XAU', 5000);
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

    console.log('[GOLD] Tier 1: Authenticated APIs (GoldAPI.io, Metals.dev, Finnhub)...');
    const tier1Results = await Promise.allSettled([
      fetchGoldApiIo(),
      fetchMetalsDev(),
      fetchFinnhubGold(),
      fetchMetalPriceApi(),
    ]);

    const tier1Prices: { price: number; source: string; name: string }[] = [];
    const tier1Names = ['goldapiio', 'metalsdev', 'finnhub', 'metalpriceapi'];
    for (let i = 0; i < tier1Results.length; i++) {
      const r = tier1Results[i];
      if (r.status === 'fulfilled' && r.value) {
        tier1Prices.push({ price: r.value.price, source: r.value.source, name: tier1Names[i] });
      }
    }

    if (tier1Prices.length >= 2) {
      tier1Prices.sort((a, b) => a.price - b.price);
      const median = tier1Prices[Math.floor(tier1Prices.length / 2)];
      const filtered = tier1Prices.filter(p => Math.abs(p.price - median.price) < 15);
      if (filtered.length >= 2) {
        const avgPrice = parseFloat((filtered.reduce((sum, p) => sum + p.price, 0) / filtered.length).toFixed(2));
        const sourceNames = filtered.map(p => p.name).join('+');
        console.log(`[GOLD] Tier 1 consensus (${filtered.length} sources): ${avgPrice} (${sourceNames})`);
        goldPriceCache = { price: avgPrice, source: `t1-consensus-${sourceNames}`, timestamp: now };
        return { price: avgPrice, source: `t1-consensus-${sourceNames}`, timestamp: now, cached: false };
      }
    }

    if (tier1Prices.length === 1) {
      const best = tier1Prices[0];
      console.log(`[GOLD] Tier 1 single source ${best.name}: ${best.price}`);
      goldPriceCache = { price: best.price, source: best.source, timestamp: now };
      return { price: best.price, source: best.source, timestamp: now, cached: false };
    }

    console.log('[GOLD] Tier 1 failed, trying Tier 2: Free APIs...');
    const tier2Results = await Promise.allSettled([
      fetchSwissquoteGold(),
      fetchFXCMGold(),
      fetchMetalsLive(),
      fetchGoldPriceOrg(),
      fetchForexSpot(),
    ]);

    const tier2Names = ['swissquote', 'fxcm', 'metalslive', 'goldprice', 'forexspot'];
    const results = tier2Names.map((name, i) => ({ name, result: tier2Results[i] }));

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
      { name: 'goldapi.io', test: () => fetchGoldApiIo() },
      { name: 'metals.dev', test: () => fetchMetalsDev() },
      { name: 'finnhub', test: () => fetchFinnhubGold() },
      { name: 'metalpriceapi', test: () => fetchMetalPriceApi() },
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
