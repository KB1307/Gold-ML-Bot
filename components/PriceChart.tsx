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
            height: calc(100% - 32px);
            width: 100%;
          }
          .tradingview-widget-copyright {
            font-size: 11px !important;
            text-align: center;
            padding: 8px 0;
          }
          .blue-text {
            color: #2962FF !important;
          }
          .trademark {
            color: #999 !important;
          }
        </style>
      </head>
      <body>
        <div class="tradingview-widget-container" ref="container">
          <div class="tradingview-widget-container__widget"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://www.tradingview.com/symbols/XAUUSD/?exchange=OANDA" rel="noopener nofollow" target="_blank">
              <span class="blue-text">XAUUSD chart</span>
            </a>
            <span class="trademark"> by TradingView</span>
          </div>
        </div>
        <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
        {
          "allow_symbol_change": true,
          "calendar": false,
          "details": false,
          "hide_side_toolbar": true,
          "hide_top_toolbar": false,
          "hide_legend": false,
          "hide_volume": false,
          "hotlist": false,
          "interval": "1",
          "locale": "en",
          "save_image": true,
          "style": "1",
          "symbol": "OANDA:XAUUSD",
          "theme": "dark",
          "timezone": "Africa/Johannesburg",
          "backgroundColor": "#0F0F0F",
          "gridColor": "rgba(242, 242, 242, 0.06)",
          "watchlist": [],
          "withdateranges": false,
          "compareSymbols": [],
          "studies": [],
          "autosize": true
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
