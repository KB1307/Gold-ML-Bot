import { createTRPCRouter, publicProcedure } from "../create-context";

export const goldPriceRouter = createTRPCRouter({
  getSpotPrice: publicProcedure.query(async () => {
    console.log('🔄 Backend: Fetching gold spot price...');
    
    try {
      const response = await fetch('https://api.metals.live/v1/spot/gold', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
          'Accept': 'application/json',
        },
      });
      
      console.log('📥 Metals.live status:', response.status);
      
      if (!response.ok) {
        throw new Error(`Metals.live HTTP ${response.status}`);
      }
      
      const text = await response.text();
      const data = JSON.parse(text);
      
      if (data && data[0] && typeof data[0].price === 'number') {
        const price = parseFloat(data[0].price.toString());
        console.log('✅ Backend: Fetched gold price from Metals.live:', price);
        return { 
          price: Number(price.toFixed(2)), 
          source: 'metals.live',
          timestamp: Date.now()
        };
      }
      
      throw new Error('Invalid response format from Metals.live');
    } catch {
      console.warn('⚠️ Backend: Primary gold API failed, trying fallback...');
      
      try {
        const response = await fetch('https://data-asg.goldprice.org/dbXRates/USD', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
            'Accept': 'application/json',
          },
        });
        
        console.log('📥 GoldPrice.org status:', response.status);
        
        if (!response.ok) {
          throw new Error(`GoldPrice.org HTTP ${response.status}`);
        }
        
        const text = await response.text();
        const data = JSON.parse(text);
        
        if (data.items && data.items[0] && data.items[0].xauPrice) {
          const price = parseFloat(data.items[0].xauPrice);
          console.log('✅ Backend: Fetched gold price from GoldPrice.org:', price);
          return { 
            price: Number(price.toFixed(2)), 
            source: 'goldprice.org',
            timestamp: Date.now()
          };
        }
        
        throw new Error('Invalid response format from GoldPrice.org');
      } catch {
        console.error('❌ Backend: Both gold price APIs failed');
        
        const defaultPrice = 2650;
        console.warn(`⚠️ Backend: Using default price: ${defaultPrice}`);
        return { 
          price: defaultPrice, 
          source: 'default',
          timestamp: Date.now()
        };
      }
    }
  }),
});
