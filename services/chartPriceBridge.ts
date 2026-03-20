export type ChartPriceListener = (price: number, source: string) => void;

const chartPriceListeners = new Set<ChartPriceListener>();

function isValidChartPrice(price: number): boolean {
  return Number.isFinite(price) && price > 1000 && price < 10000;
}

export function publishChartPrice(price: number, source: string = 'tradingview-chart'): void {
  if (!isValidChartPrice(price)) {
    console.warn(`[ChartPriceBridge] Ignoring invalid chart price: ${price}`);
    return;
  }

  const normalizedPrice = Number(price.toFixed(2));

  chartPriceListeners.forEach((listener) => {
    try {
      listener(normalizedPrice, source);
    } catch (error) {
      console.error('[ChartPriceBridge] Listener error:', error);
    }
  });
}

export function subscribeToChartPrice(listener: ChartPriceListener): () => void {
  chartPriceListeners.add(listener);
  console.log(`[ChartPriceBridge] Subscriber connected. Total listeners: ${chartPriceListeners.size}`);

  return () => {
    chartPriceListeners.delete(listener);
    console.log(`[ChartPriceBridge] Subscriber removed. Total listeners: ${chartPriceListeners.size}`);
  };
}
