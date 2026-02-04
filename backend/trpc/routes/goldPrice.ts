import { createTRPCRouter, publicProcedure } from "../create-context";

let goldPriceCache: { price: number; source: string; timestamp: number } | null = null;
let intermarketCache: { dxy: number; us10y: number; vix: number; timestamp: number } | null = null;
const GOLD_CACHE_MS = 5000;
const INTERMARKET_CACHE_MS = 15000;

async function fetchWithTimeout(url: string, timeout = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
        'Accept': 'application/json',
      },
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function fetchYahooSymbol(symbol: string): Promise<number | null> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const timestamp = Date.now();
  
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${symbol}?interval=1m&range=1d&_t=${timestamp}`;
      const response = await fetchWithTimeout(url);
      
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
    
    if (goldPriceCache && now - goldPriceCache.timestamp < GOLD_CACHE_MS) {
      return { price: goldPriceCache.price, source: goldPriceCache.source, timestamp: goldPriceCache.timestamp };
    }
    
    const timestamp = now;
    
    try {
      const response = await fetchWithTimeout(`https://data-asg.goldprice.org/dbXRates/USD?_t=${timestamp}`);
      
      if (response.ok) {
        const data = await response.json();
        if (data.items?.[0]?.xauPrice) {
          const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
          goldPriceCache = { price, source: 'goldprice.org', timestamp: now };
          return { price, source: 'goldprice.org', timestamp: now };
        }
      }
    } catch {}
    
    try {
      const response = await fetchWithTimeout(`https://api.metals.live/v1/spot/gold?_t=${timestamp}`);
      if (response.ok) {
        const data = await response.json();
        if (data?.[0]?.price) {
          const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
          goldPriceCache = { price, source: 'metals.live', timestamp: now };
          return { price, source: 'metals.live', timestamp: now };
        }
      }
    } catch {}
    
    try {
      const response = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT&_t=${timestamp}`);
      if (response.ok) {
        const data = await response.json();
        if (data?.price) {
          const price = Number(parseFloat(data.price).toFixed(2));
          goldPriceCache = { price, source: 'binance', timestamp: now };
          return { price, source: 'binance', timestamp: now };
        }
      }
    } catch {}
    
    const defaultPrice = goldPriceCache?.price || 2650;
    return { price: defaultPrice, source: 'cached', timestamp: now };
  }),

  getIntermarketData: publicProcedure.query(async () => {
    const now = Date.now();
    
    if (intermarketCache && now - intermarketCache.timestamp < INTERMARKET_CACHE_MS) {
      return { 
        dxy: intermarketCache.dxy, 
        us10y: intermarketCache.us10y, 
        vix: intermarketCache.vix, 
        timestamp: intermarketCache.timestamp,
        cached: true
      };
    }
    
    const [dxyResult, us10yResult, vixResult] = await Promise.allSettled([
      fetchYahooSymbol('DX=F'),
      fetchYahooSymbol('%5ETNX'),
      fetchYahooSymbol('%5EVIX'),
    ]);
    
    const dxy = dxyResult.status === 'fulfilled' && dxyResult.value ? dxyResult.value : (intermarketCache?.dxy || 103.5);
    const us10y = us10yResult.status === 'fulfilled' && us10yResult.value ? us10yResult.value : (intermarketCache?.us10y || 4.2);
    const vix = vixResult.status === 'fulfilled' && vixResult.value ? vixResult.value : (intermarketCache?.vix || 18);
    
    intermarketCache = { dxy, us10y, vix, timestamp: now };
    
    return { dxy, us10y, vix, timestamp: now, cached: false };
  }),
});
