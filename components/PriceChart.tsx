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
        <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src * 'unsafe-inline'; img-src * data: blob: 'unsafe-inline'; frame-src *; style-src * 'unsafe-inline';">
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
          #tradingview_chart {
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>
        <div class="tradingview-widget-container">
          <div id="tradingview_chart"></div>
          <div class="tradingview-widget-copyright">
            <a href="https://www.tradingview.com/symbols/XAUUSD/?exchange=OANDA" rel="noopener nofollow" target="_blank">
              <span class="blue-text">XAUUSD chart</span>
            </a>
            <span class="trademark"> by TradingView</span>
          </div>
        </div>
        <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
        <script type="text/javascript">
          try {
            new TradingView.widget({
              "width": "100%",
              "height": "100%",
              "symbol": "OANDA:XAUUSD",
              "interval": "1",
              "timezone": "Etc/UTC",
              "theme": "dark",
              "style": "1",
              "locale": "en",
              "toolbar_bg": "#0F0F0F",
              "enable_publishing": false,
              "hide_side_toolbar": false,
              "allow_symbol_change": true,
              "save_image": false,
              "container_id": "tradingview_chart",
              "studies": [],
              "show_popup_button": false,
              "popup_width": "1000",
              "popup_height": "650",
              "support_host": "https://www.tradingview.com"
            });
          } catch (e) {
            console.error('TradingView widget error:', e);
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
