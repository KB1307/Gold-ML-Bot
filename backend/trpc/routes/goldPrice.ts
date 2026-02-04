import { createTRPCRouter, publicProcedure } from "../create-context";

let goldPriceCache: { price: number; source: string; timestamp: number } | null = null;
let intermarketCache: { dxy: number; us10y: number; vix: number; timestamp: number } | null = null;
const GOLD_CACHE_MS = 5000;
const INTERMARKET_CACHE_MS = 15000;
const STALE_CACHE_MS = 60000;

async function fetchWithTimeout(url: string, timeout = 10000, headers?: Record<string, string>): Promise<Response> {
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
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const symbols = ['GC=F', 'GC%3DF'];
  
  for (const host of hosts) {
    for (const symbol of symbols) {
      try {
        const url = `https://${host}/v8/finance/chart/${symbol}?interval=1m&range=1d`;
        console.log(`[GOLD] Trying Yahoo: ${url}`);
        const response = await fetchWithTimeout(url, 8000);
        
        if (!response.ok) {
          console.log(`[GOLD] Yahoo ${host} returned ${response.status}`);
          continue;
        }
        
        const data = await response.json();
        const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (price && typeof price === 'number' && price > 1000) {
          console.log(`[GOLD] Yahoo success: ${price}`);
          return { price: parseFloat(price.toFixed(2)), source: `yahoo-${host}` };
        }
      } catch (e) {
        console.log(`[GOLD] Yahoo ${host} error:`, e instanceof Error ? e.message : 'Unknown');
        continue;
      }
    }
  }
  return null;
}

async function fetchGoldApi(): Promise<{ price: number; source: string } | null> {
  try {
    console.log('[GOLD] Trying goldapi.io...');
    const response = await fetchWithTimeout('https://www.goldapi.io/api/XAU/USD', 8000, {
      'x-access-token': 'goldapi-free-demo',
    });
    if (response.ok) {
      const data = await response.json();
      if (data?.price && data.price > 1000) {
        console.log(`[GOLD] goldapi.io success: ${data.price}`);
        return { price: parseFloat(data.price.toFixed(2)), source: 'goldapi.io' };
      }
    }
  } catch (e) {
    console.log('[GOLD] goldapi.io error:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchForexApi(): Promise<{ price: number; source: string } | null> {
  try {
    console.log('[GOLD] Trying frankfurter (forex rates)...');
    const response = await fetchWithTimeout('https://api.frankfurter.app/latest?from=XAU&to=USD', 8000);
    if (response.ok) {
      const data = await response.json();
      if (data?.rates?.USD) {
        const price = 1 / data.rates.USD;
        if (price > 1000) {
          console.log(`[GOLD] frankfurter success: ${price}`);
          return { price: parseFloat(price.toFixed(2)), source: 'frankfurter' };
        }
      }
    }
  } catch (e) {
    console.log('[GOLD] frankfurter error:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchYahooSymbol(symbol: string): Promise<number | null> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${symbol}?interval=1m&range=1d`;
      const response = await fetchWithTimeout(url, 8000);
      
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
    const [yahooResult, goldApiResult, forexResult] = await Promise.allSettled([
      fetchYahooGold(),
      fetchGoldApi(),
      fetchForexApi(),
    ]);
    
    // Check Yahoo first (most reliable)
    if (yahooResult.status === 'fulfilled' && yahooResult.value) {
      goldPriceCache = { price: yahooResult.value.price, source: yahooResult.value.source, timestamp: now };
      return { price: yahooResult.value.price, source: yahooResult.value.source, timestamp: now, cached: false };
    }
    
    // Check goldapi.io
    if (goldApiResult.status === 'fulfilled' && goldApiResult.value) {
      goldPriceCache = { price: goldApiResult.value.price, source: goldApiResult.value.source, timestamp: now };
      return { price: goldApiResult.value.price, source: goldApiResult.value.source, timestamp: now, cached: false };
    }
    
    // Check forex API
    if (forexResult.status === 'fulfilled' && forexResult.value) {
      goldPriceCache = { price: forexResult.value.price, source: forexResult.value.source, timestamp: now };
      return { price: forexResult.value.price, source: forexResult.value.source, timestamp: now, cached: false };
    }
    
    // Fallback: goldprice.org
    try {
      console.log('[GOLD] Trying goldprice.org...');
      const response = await fetchWithTimeout('https://data-asg.goldprice.org/dbXRates/USD', 8000);
      
      if (response.ok) {
        const data = await response.json();
        if (data.items?.[0]?.xauPrice) {
          const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
          console.log(`[GOLD] goldprice.org success: ${price}`);
          goldPriceCache = { price, source: 'goldprice.org', timestamp: now };
          return { price, source: 'goldprice.org', timestamp: now, cached: false };
        }
      }
    } catch (e) {
      console.log('[GOLD] goldprice.org error:', e instanceof Error ? e.message : 'Unknown');
    }
    
    // Fallback: metals.live
    try {
      console.log('[GOLD] Trying metals.live...');
      const response = await fetchWithTimeout('https://api.metals.live/v1/spot/gold', 8000);
      if (response.ok) {
        const data = await response.json();
        if (data?.[0]?.price) {
          const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
          console.log(`[GOLD] metals.live success: ${price}`);
          goldPriceCache = { price, source: 'metals.live', timestamp: now };
          return { price, source: 'metals.live', timestamp: now, cached: false };
        }
      }
    } catch (e) {
      console.log('[GOLD] metals.live error:', e instanceof Error ? e.message : 'Unknown');
    }
    
    // Fallback: Binance PAXG
    try {
      console.log('[GOLD] Trying binance...');
      const response = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT', 8000);
      if (response.ok) {
        const data = await response.json();
        if (data?.price) {
          const price = Number(parseFloat(data.price).toFixed(2));
          console.log(`[GOLD] binance success: ${price}`);
          goldPriceCache = { price, source: 'binance', timestamp: now };
          return { price, source: 'binance', timestamp: now, cached: false };
        }
      }
    } catch (e) {
      console.log('[GOLD] binance error:', e instanceof Error ? e.message : 'Unknown');
    }
    
    // Return stale cache if available (within 60s)
    if (goldPriceCache && now - goldPriceCache.timestamp < STALE_CACHE_MS) {
      console.log(`[GOLD] All sources failed, returning stale cache: ${goldPriceCache.price}`);
      return { price: goldPriceCache.price, source: 'stale-cache', timestamp: goldPriceCache.timestamp, cached: true };
    }
    
    // Very stale cache (better than nothing)
    if (goldPriceCache) {
      console.log(`[GOLD] All sources failed, returning very stale cache: ${goldPriceCache.price}`);
      return { price: goldPriceCache.price, source: 'very-stale-cache', timestamp: goldPriceCache.timestamp, cached: true };
    }
    
    console.log('[GOLD] All sources failed, no cache available');
    return { price: 0, source: 'unavailable', timestamp: now, cached: false };
  }),

  // Health check endpoint
  healthCheck: publicProcedure.query(async () => {
    const sources = [
      { name: 'yahoo', test: () => fetchYahooGold() },
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
