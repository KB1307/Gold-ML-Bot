import { View, StyleSheet, Platform } from "react-native";
import { useState, useEffect, useRef } from "react";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  const [chartKey, setChartKey] = useState<number>(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    setChartKey(prev => prev + 1);
  }, []);

  const chartHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #131722;
          }
          .tradingview-widget-container {
            height: 100%;
            width: 100%;
          }
          #tradingview_widget {
            height: 100%;
            width: 100%;
          }
        </style>
      </head>
      <body>
        <div class="tradingview-widget-container">
          <div id="tradingview_widget"></div>
        </div>
        <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
        <script type="text/javascript">
          if (typeof TradingView !== 'undefined') {
            new TradingView.widget({
              "autosize": true,
              "symbol": "OANDA:XAUUSD",
              "interval": "1",
              "timezone": "Etc/UTC",
              "theme": "dark",
              "style": "1",
              "locale": "en",
              "toolbar_bg": "#131722",
              "enable_publishing": false,
              "backgroundColor": "#131722",
              "gridColor": "rgba(42, 46, 57, 0.06)",
              "hide_top_toolbar": false,
              "hide_legend": false,
              "save_image": false,
              "container_id": "tradingview_widget"
            });
          }
        </script>
      </body>
    </html>
  `;

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <iframe
          key={chartKey}
          ref={iframeRef as any}
          srcDoc={chartHTML}
          style={{
            width: '100%',
            height: 400,
            border: 'none',
            borderRadius: 12,
            overflow: 'hidden',
          }}
          title="TradingView Chart"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        key={chartKey}
        source={{ html: chartHTML }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        scrollEnabled={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 400,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    borderRadius: 12,
    overflow: 'hidden',
  },
});
