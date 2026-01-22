import { createTRPCRouter, publicProcedure } from "../create-context";

export const goldPriceRouter = createTRPCRouter({
  getSpotPrice: publicProcedure.query(async () => {
    console.log('🔄 Backend: Fetching gold spot price...');
    const timestamp = Date.now();
    
    // Try GoldPrice.org first as it's more reliable
    try {
      const response = await fetch(`https://data-asg.goldprice.org/dbXRates/USD?_t=${timestamp}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
          'Accept': 'application/json',
        },
      });
      
      console.log('📥 GoldPrice.org status:', response.status);
      
      if (!response.ok) {
        throw new Error(`GoldPrice.org HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data.items && data.items[0] && data.items[0].xauPrice) {
        const price = parseFloat(data.items[0].xauPrice);
        console.log('✅ Backend: Fetched gold price from GoldPrice.org:', price);
        return { 
          price: Number(price.toFixed(2)), 
          source: 'goldprice.org' as const,
          timestamp: Date.now()
        };
      }
      
      throw new Error('Invalid response format from GoldPrice.org');
    } catch (error) {
      console.warn('⚠️ Backend: Primary gold API (GoldPrice.org) failed, trying fallbacks...', error);
      
      // Try Metals.live
      try {
        const response = await fetch(`https://api.metals.live/v1/spot/gold?_t=${timestamp}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
            'Accept': 'application/json',
          },
        });
        
        console.log('📥 Metals.live status:', response.status);
        
        if (!response.ok) {
          throw new Error(`Metals.live HTTP ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data && data[0] && typeof data[0].price === 'number') {
          const price = parseFloat(data[0].price.toString());
          console.log('✅ Backend: Fetched gold price from Metals.live:', price);
          return { 
            price: Number(price.toFixed(2)), 
            source: 'metals.live' as const,
            timestamp: Date.now()
          };
        }
        
        throw new Error('Invalid response format from Metals.live');
      } catch (metalsError) {
        console.warn('⚠️ Backend: Metals.live failed, trying Binance...', metalsError);
        
        // Try Binance (PAXG)
        try {
          const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT&_t=${timestamp}`);
          
          if (!response.ok) {
            throw new Error(`Binance HTTP ${response.status}`);
          }
          
          const data = await response.json();
          
          if (data && data.price) {
            const price = parseFloat(data.price);
            console.log('✅ Backend: Fetched gold price from Binance:', price);
            return { 
              price: Number(price.toFixed(2)), 
              source: 'binance' as const,
              timestamp: Date.now()
            };
          }
          
          throw new Error('Invalid response format from Binance');
        } catch (fallbackError) {
          console.error('❌ Backend: All gold price APIs failed', fallbackError);
          
          const defaultPrice = 2650;
          console.warn(`⚠️ Backend: Using default price: ${defaultPrice}`);
          return { 
            price: defaultPrice, 
            source: 'default' as const,
            timestamp: Date.now()
          };
        }
      }
    }
  }),
});
