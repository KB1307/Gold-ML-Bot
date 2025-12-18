import { View, StyleSheet, Platform, ActivityIndicator } from "react-native";
import { useState, useRef, useMemo } from "react";
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
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const webViewRef = useRef<WebView>(null);

  const chartHTML = useMemo(() => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>TradingView Chart</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body, html {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #0F0F0F;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .tradingview-widget-container {
      width: 100%;
      height: 100%;
      position: relative;
    }
    .tradingview-widget-container__widget {
      width: 100%;
      height: 100%;
    }
    .tradingview-widget-copyright {
      display: none !important;
    }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
  </div>
  <script type="text/javascript">
    (function() {
      var script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.async = true;
      script.innerHTML = JSON.stringify({
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
        "hide_legend": false,
        "hide_volume": false,
        "hotlist": false,
        "save_image": true,
        "details": false,
        "withdateranges": false,
        "backgroundColor": "rgba(15, 15, 15, 1)",
        "gridColor": "rgba(242, 242, 242, 0.06)",
        "support_host": "https://www.tradingview.com",
        "width": "100%",
        "height": "100%"
      });
      document.querySelector('.tradingview-widget-container__widget').appendChild(script);
      console.log('TradingView script injected');
    })();
  </script>
</body>
</html>
  `, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        {isLoading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#FFD700" />
          </View>
        )}
        <iframe
          srcDoc={chartHTML}
          style={{
            width: '100%',
            height: 400,
            border: 'none',
            borderRadius: 12,
            overflow: 'hidden',
          }}
          title="TradingView Chart"
          onLoad={() => {
            setTimeout(() => setIsLoading(false), 2000);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFD700" />
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ html: chartHTML }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        scalesPageToFit={true}
        scrollEnabled={false}
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        javaScriptCanOpenWindowsAutomatically={true}
        mixedContentMode="always"
        thirdPartyCookiesEnabled={true}
        sharedCookiesEnabled={true}
        cacheEnabled={true}
        incognito={false}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        onLoadStart={() => {
          console.log('📊 Chart: Load started');
          setIsLoading(true);
        }}
        onLoadEnd={() => {
          console.log('📊 Chart: Load ended');
          setTimeout(() => {
            setIsLoading(false);
          }, 2000);
        }}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('📊 Chart WebView error:', nativeEvent);
          setIsLoading(false);
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('📊 Chart WebView HTTP error:', nativeEvent.statusCode);
        }}
        onMessage={(event) => {
          console.log('📊 Chart message:', event.nativeEvent.data);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 400,
    position: 'relative' as const,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    borderRadius: 12,
    overflow: 'hidden',
  },
  loadingOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0F0F0F',
    zIndex: 10,
    borderRadius: 12,
  },
});
