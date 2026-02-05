import { createTRPCRouter, publicProcedure } from "../create-context";
import * as z from "zod";

let goldPriceCache: { price: number; source: string; timestamp: number } | null = null;
let intermarketCache: { dxy: number; us10y: number; vix: number; timestamp: number } | null = null;
const GOLD_CACHE_MS = 10000; // 10 second cache to reduce API calls
const INTERMARKET_CACHE_MS = 30000; // 30 seconds
const RECENT_CACHE_MS = 120000; // 2 minute recent cache (acceptable for brief outages)

// Track API failures to avoid hammering failing endpoints
const apiFailures: Map<string, { count: number; lastFailure: number }> = new Map();
const FAILURE_COOLDOWN_MS = 60000; // 1 minute cooldown after 3 failures
const MAX_FAILURES_BEFORE_COOLDOWN = 3;

function shouldSkipApi(apiName: string): boolean {
  const failure = apiFailures.get(apiName);
  if (!failure) return false;
  if (failure.count >= MAX_FAILURES_BEFORE_COOLDOWN) {
    if (Date.now() - failure.lastFailure < FAILURE_COOLDOWN_MS) {
      return true;
    }
    // Reset after cooldown
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

async function fetchWithTimeout(url: string, timeout = 4000, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
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

async function fetchYahooGold(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('yahoo')) {
    console.log('[GOLD] Skipping Yahoo (in cooldown)');
    return null;
  }
  
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const symbols = ['GC=F', 'GC%3DF'];
  
  for (const host of hosts) {
    for (const symbol of symbols) {
      try {
        const url = `https://${host}/v8/finance/chart/${symbol}?interval=1m&range=1d`;
        console.log(`[GOLD] Trying Yahoo: ${url}`);
        const response = await fetchWithTimeout(url, 5000);
        
        if (!response.ok) {
          console.log(`[GOLD] Yahoo ${host} returned ${response.status}`);
          continue;
        }
        
        const data = await response.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && typeof price === 'number' && price > 1000) {
          console.log(`[GOLD] Yahoo success: ${price}`);
          recordApiSuccess('yahoo');
          return { price: parseFloat(price.toFixed(2)), source: `yahoo-${host}` };
        }
      } catch (e) {
        console.log(`[GOLD] Yahoo ${host} error:`, e instanceof Error ? e.message : 'Unknown');
        continue;
      }
    }
  }
  recordApiFailure('yahoo');
  return null;
}

async function fetchGoldApi(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('goldapi')) {
    console.log('[GOLD] Skipping GoldAPI (in cooldown)');
    return null;
  }
  
  try {
    console.log('[GOLD] Trying goldapi.io with premium key...');
    const response = await fetchWithTimeout('https://www.goldapi.io/api/XAU/USD', 4000, {
      'x-access-token': 'goldapi-1n5ovsmfwx8y1b-io',
    });
    if (response.ok) {
      const data = await response.json();
      if (data?.price && data.price > 1000) {
        console.log(`[GOLD] goldapi.io success: ${data.price}`);
        recordApiSuccess('goldapi');
        return { price: parseFloat(data.price.toFixed(2)), source: 'goldapi.io' };
      }
    } else {
      console.log(`[GOLD] goldapi.io returned ${response.status}`);
    }
  } catch (e) {
    console.log('[GOLD] goldapi.io error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('goldapi');
  return null;
}

async function fetchCoinGecko(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('coingecko')) {
    console.log('[GOLD] Skipping CoinGecko (in cooldown)');
    return null;
  }
  
  try {
    console.log('[GOLD] Trying CoinGecko (PAXG)...');
    const response = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd', 5000, {
      'Accept': 'application/json',
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data?.['pax-gold']?.usd) {
        const price = data['pax-gold'].usd;
        if (price > 1000) {
          console.log(`[GOLD] CoinGecko success: ${price}`);
          recordApiSuccess('coingecko');
          return { price: parseFloat(price.toFixed(2)), source: 'coingecko' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] CoinGecko error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('coingecko');
  return null;
}

async function fetchBinance(): Promise<{ price: number; source: string } | null> {
  try {
    console.log('[GOLD] Trying binance...');
    // Add timestamp to avoid caching
    const response = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT&t=${Date.now()}`, 4000);
    if (response.ok) {
      const data = await response.json();
      if (data?.price) {
        const price = Number(parseFloat(data.price).toFixed(2));
        console.log(`[GOLD] binance success: ${price}`);
        return { price, source: 'binance' };
      }
    }
  } catch (e) {
    console.log('[GOLD] binance error:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchKraken(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('kraken')) {
    console.log('[GOLD] Skipping Kraken (in cooldown)');
    return null;
  }
  
  try {
    console.log('[GOLD] Trying Kraken...');
    const response = await fetchWithTimeout('https://api.kraken.com/0/public/Ticker?pair=PAXGUSD', 5000);
    if (response.ok) {
      const data = await response.json();
      const pair = data?.result?.PAXGUSD || data?.result?.XPAXGZUSD;
      if (pair && pair.c && pair.c[0]) {
        const price = parseFloat(pair.c[0]);
        if (price > 1000) {
          console.log(`[GOLD] Kraken success: ${price}`);
          recordApiSuccess('kraken');
          return { price, source: 'kraken' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] Kraken error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('kraken');
  return null;
}

// New: Fetch from Bybit (reliable crypto exchange)
async function fetchBybit(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('bybit')) {
    console.log('[GOLD] Skipping Bybit (in cooldown)');
    return null;
  }
  
  try {
    console.log('[GOLD] Trying Bybit (PAXGUSDT)...');
    const response = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=spot&symbol=PAXGUSDT', 5000);
    if (response.ok) {
      const data = await response.json();
      const price = parseFloat(data?.result?.list?.[0]?.lastPrice);
      if (price && price > 1000) {
        console.log(`[GOLD] Bybit success: ${price}`);
        recordApiSuccess('bybit');
        return { price: parseFloat(price.toFixed(2)), source: 'bybit' };
      }
    }
  } catch (e) {
    console.log('[GOLD] Bybit error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('bybit');
  return null;
}

// New: Fetch from OKX
async function fetchOKX(): Promise<{ price: number; source: string } | null> {
  if (shouldSkipApi('okx')) {
    console.log('[GOLD] Skipping OKX (in cooldown)');
    return null;
  }
  
  try {
    console.log('[GOLD] Trying OKX (PAXG-USDT)...');
    const response = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=PAXG-USDT', 5000);
    if (response.ok) {
      const data = await response.json();
      const price = parseFloat(data?.data?.[0]?.last);
      if (price && price > 1000) {
        console.log(`[GOLD] OKX success: ${price}`);
        recordApiSuccess('okx');
        return { price: parseFloat(price.toFixed(2)), source: 'okx' };
      }
    }
  } catch (e) {
    console.log('[GOLD] OKX error:', e instanceof Error ? e.message : 'Unknown');
  }
  recordApiFailure('okx');
  return null;
}

// NO FALLBACK ESTIMATES - Only live market data is acceptable

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
    console.log('[GOLD] getSpotPrice called');
    
    if (goldPriceCache && now - goldPriceCache.timestamp < GOLD_CACHE_MS) {
      console.log(`[GOLD] Returning cached: ${goldPriceCache.price} from ${goldPriceCache.source}`);
      return { price: goldPriceCache.price, source: goldPriceCache.source, timestamp: goldPriceCache.timestamp, cached: true };
    }
    
    // Try all sources in parallel for faster response
    const [goldApiResult, yahooResult, krakenResult, bybitResult, okxResult, coinGeckoResult, binanceResult] = await Promise.allSettled([
      fetchGoldApi(),
      fetchYahooGold(),
      fetchKraken(),
      fetchBybit(),
      fetchOKX(),
      fetchCoinGecko(),
      fetchBinance(),
    ]);
    
    // Priority order: GoldAPI (premium) > Yahoo > Kraken > Bybit > OKX > CoinGecko > Binance
    const results = [
      { name: 'goldapi', result: goldApiResult },
      { name: 'yahoo', result: yahooResult },
      { name: 'kraken', result: krakenResult },
      { name: 'bybit', result: bybitResult },
      { name: 'okx', result: okxResult },
      { name: 'coingecko', result: coinGeckoResult },
      { name: 'binance', result: binanceResult },
    ];
    
    for (const { name, result } of results) {
      if (result.status === 'fulfilled' && result.value) {
        console.log(`[GOLD] Using ${name}: ${result.value.price}`);
        goldPriceCache = { price: result.value.price, source: result.value.source, timestamp: now };
        return { price: result.value.price, source: result.value.source, timestamp: now, cached: false };
      }
    }

    // Secondary fallbacks (less reliable)
    if (!shouldSkipApi('goldprice')) {
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
              goldPriceCache = { price, source: 'goldprice.org', timestamp: now };
              return { price, source: 'goldprice.org', timestamp: now, cached: false };
            }
          }
        }
        recordApiFailure('goldprice');
      } catch (e) {
        console.log('[GOLD] goldprice.org error:', e instanceof Error ? e.message : 'Unknown');
        recordApiFailure('goldprice');
      }
    }
    
    if (!shouldSkipApi('metalslive')) {
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
              goldPriceCache = { price, source: 'metals.live', timestamp: now };
              return { price, source: 'metals.live', timestamp: now, cached: false };
            }
          }
        }
        recordApiFailure('metalslive');
      } catch (e) {
        console.log('[GOLD] metals.live error:', e instanceof Error ? e.message : 'Unknown');
        recordApiFailure('metalslive');
      }
    }
    
    // Return recent cache if available (within 2 min) - this is acceptable for brief API outages
    if (goldPriceCache && now - goldPriceCache.timestamp < RECENT_CACHE_MS) {
      console.log(`[GOLD] Using recent cache (${((now - goldPriceCache.timestamp) / 1000).toFixed(0)}s old): ${goldPriceCache.price}`);
      return { price: goldPriceCache.price, source: 'recent-cache', timestamp: goldPriceCache.timestamp, cached: true };
    }
    
    // NO FALLBACK - Throw error so frontend knows live data is unavailable
    console.error('[GOLD] ❌ ALL LIVE PRICE SOURCES FAILED - No acceptable cached data');
    throw new Error('LIVE_PRICE_UNAVAILABLE: All price sources failed and no recent cache available')
  }),

  // Health check endpoint
  healthCheck: publicProcedure.query(async () => {
    const sources = [
      { name: 'yahoo', test: () => fetchYahooGold() },
      { name: 'kraken', test: () => fetchKraken() },
      { name: 'goldapi', test: () => fetchGoldApi() },
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
      // Convert to seconds for Yahoo API
      const period1 = Math.floor(fromTime / 1000);
      const period2 = Math.floor(toTime / 1000) + 120; // Add 2 min buffer

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
