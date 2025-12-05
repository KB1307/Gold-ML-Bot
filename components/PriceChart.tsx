import { View, StyleSheet, Platform } from "react-native";
import { useState, useEffect } from "react";
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

  useEffect(() => {
    setChartKey(prev => prev + 1);
  }, []);

  const chartHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <style>
          body, html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #0F0F0F;
          }
          .tradingview-widget-container {
            height: 100%;
            width: 100%;
          }
          .tradingview-widget-container__widget {
            height: 100%;
            width: 100%;
          }
        </style>
      </head>
      <body>
        <div class="tradingview-widget-container">
          <div class="tradingview-widget-container__widget"></div>
        </div>
        <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
        {
          "autosize": true,
          "symbol": "OANDA:XAUUSD",
          "interval": "1",
          "timezone": "Africa/Johannesburg",
          "theme": "dark",
          "style": "1",
          "locale": "en",
          "allow_symbol_change": true,
          "calendar": false,
          "hide_top_toolbar": false,
          "hide_side_toolbar": true,
          "save_image": true,
          "backgroundColor": "rgba(15, 15, 15, 1)",
          "gridColor": "rgba(242, 242, 242, 0.06)",
          "support_host": "https://www.tradingview.com"
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
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        javaScriptCanOpenWindowsAutomatically={true}
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
