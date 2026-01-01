import React, { useMemo, useRef } from "react";
import { View, StyleSheet, Platform } from "react-native";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
  onPriceUpdate?: (price: number) => void;
}

const PriceChart = React.memo(({ data, currentPrice, onPriceUpdate }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);

  const tradingViewHTML = useMemo(() => `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      body { margin: 0; padding: 0; overflow: hidden; background: #0F0F0F; }
      .tradingview-widget-container { height: 100vh; width: 100vw; }
      .tradingview-widget-container__widget { height: calc(100% - 32px); width: 100%; }
    </style>
  </head>
  <body>
    <div class="tradingview-widget-container">
      <div id="tradingview_chart" class="tradingview-widget-container__widget"></div>
    </div>
    <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
    <script type="text/javascript">
      (function() {
        let chartWidget = null;
        let isChartReady = false;
        
        try {
          chartWidget = new TradingView.widget({
            autosize: true,
            symbol: "OANDA:XAUUSD",
            interval: "5",
            timezone: "Etc/UTC",
            theme: "dark",
            style: "1",
            locale: "en",
            toolbar_bg: "#0F0F0F",
            enable_publishing: false,
            allow_symbol_change: true,
            container_id: "tradingview_chart",
            hide_side_toolbar: false,
            studies: [],
            show_popup_button: true,
            popup_width: "1000",
            popup_height: "800",
            
            onChartReady: function() {
              console.log("✅ TradingView chart ready and WebSocket stable");
              isChartReady = true;
              
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ 
                  type: 'chartReady', 
                  timestamp: Date.now() 
                }));
              }
            }
          });
          
          setInterval(function() {
            if (!isChartReady) return;
            
            try {
              const iframe = document.querySelector('iframe');
              if (iframe && iframe.contentWindow) {
                const priceElement = iframe.contentDocument?.querySelector('.price-axis-last-price');
                if (priceElement) {
                  const price = parseFloat(priceElement.textContent);
                  if (!isNaN(price) && price > 0) {
                    if (window.ReactNativeWebView) {
                      window.ReactNativeWebView.postMessage(JSON.stringify({ 
                        type: 'price', 
                        value: price 
                      }));
                    }
                  }
                }
              }
            } catch (e) {
              console.log('Cannot access chart price:', e);
            }
          }, 2000);
          
        } catch (error) {
          console.error("❌ TradingView widget initialization failed:", error);
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ 
              type: 'chartError', 
              error: error.message 
            }));
          }
        }
      })();
    </script>
  </body>
</html>
  `, []);

  const chartUrl = useMemo(() => {
    const params = {
      frameElementId: "tradingview_chart",
      symbol: "OANDA:XAUUSD",
      interval: "5",
      theme: "dark",
      style: "1",
      timezone: "Etc/UTC",
      studies: "[]",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      locale: "en",
      toolbar_bg: "#0F0F0F",
      enable_publishing: "false",
    };
    
    const queryString = Object.entries(params)
      .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
      .join('&');
      
    return `https://s.tradingview.com/widgetembed/?${queryString}`;
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <iframe
          src={chartUrl}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          } as any}
          title="TradingView Chart"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: tradingViewHTML }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'price' && data.value && onPriceUpdate) {
              onPriceUpdate(data.value);
            }
          } catch (e) {
            console.log('Error parsing WebView message:', e);
          }
        }}
        testID="tradingview-chart"
      />
    </View>
  );
});

PriceChart.displayName = 'PriceChart';

export default PriceChart;

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 345,
    backgroundColor: '#0F0F0F',
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
});
