import { createTRPCRouter, publicProcedure } from "../create-context";

export const goldPriceRouter = createTRPCRouter({
  getSpotPrice: publicProcedure.query(async () => {
    console.log('🔄 Backend: Fetching gold spot price...');
    
    try {
      const response = await fetch('https://data-asg.goldprice.org/dbXRates/USD', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
          'Accept': 'application/json',
        },
      });
      
      console.log('📥 GoldPrice.org status:', response.status);
      console.log('📥 GoldPrice.org content-type:', response.headers.get('content-type'));
      
      if (!response.ok) {
        throw new Error(`GoldPrice.org HTTP ${response.status}`);
      }
      
      const text = await response.text();
      console.log('📥 GoldPrice.org raw response (first 200 chars):', text.substring(0, 200));
      
      const data = JSON.parse(text);
      
      if (data.items && data.items[0] && data.items[0].xauPrice) {
        const price = parseFloat(data.items[0].xauPrice);
        console.log('✅ Backend: Fetched gold price from GoldPrice.org:', price);
        return { price, source: 'goldprice.org' };
      }
      
      throw new Error('Invalid response format from GoldPrice.org');
    } catch (primaryError) {
      console.warn('⚠️ Backend: Primary gold API failed, trying fallback...', primaryError);
      
      try {
        const response = await fetch('https://api.metals.live/v1/spot/gold', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)',
            'Accept': 'application/json',
          },
        });
        
        console.log('📥 Metals.live status:', response.status);
        console.log('📥 Metals.live content-type:', response.headers.get('content-type'));
        
        if (!response.ok) {
          throw new Error(`Metals.live HTTP ${response.status}`);
        }
        
        const text = await response.text();
        console.log('📥 Metals.live raw response (first 200 chars):', text.substring(0, 200));
        
        const data = JSON.parse(text);
        
        if (data && data[0] && data[0].price) {
          const price = parseFloat(data[0].price);
          console.log('✅ Backend: Fetched gold price from Metals.live:', price);
          return { price, source: 'metals.live' };
        }
        
        throw new Error('Invalid response format from Metals.live');
      } catch (fallbackError) {
        console.error('❌ Backend: Both gold price APIs failed');
        console.error('Primary:', primaryError);
        console.error('Fallback:', fallbackError);
        
        const defaultPrice = 2650;
        console.warn(`⚠️ Backend: Using default price: ${defaultPrice}`);
        return { price: defaultPrice, source: 'default' };
      }
    }
  }),
});
