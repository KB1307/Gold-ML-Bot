import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { useState, useRef, useEffect } from "react";
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
  const [hasError, setHasError] = useState<boolean>(false);
  const webViewRef = useRef<WebView>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const htmlContent = `
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
        html, body {
          width: 100%;
          height: 100%;
          overflow: hidden;
          background-color: #0F0F0F;
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
        "hide_legend": false,
        "hide_volume": false,
        "hotlist": false,
        "save_image": true,
        "details": false,
        "withdateranges": false,
        "backgroundColor": "rgba(15, 15, 15, 1)",
        "gridColor": "rgba(242, 242, 242, 0.06)",
        "support_host": "https://www.tradingview.com",
        "utm_source": "",
        "utm_medium": "widget",
        "utm_campaign": "chart"
      }
      </script>
    </body>
    </html>
  `;

  useEffect(() => {
    if (Platform.OS === 'web' && containerRef.current) {
      console.log('📊 Initializing TradingView widget for web');
      setIsLoading(true);
      
      const container = containerRef.current;
      
      container.innerHTML = '';
      
      const widgetContainer = document.createElement('div');
      widgetContainer.className = 'tradingview-widget-container';
      widgetContainer.style.cssText = 'height:100%;width:100%';
      
      const widgetDiv = document.createElement('div');
      widgetDiv.className = 'tradingview-widget-container__widget';
      widgetDiv.style.cssText = 'height:100%;width:100%';
      
      widgetContainer.appendChild(widgetDiv);
      container.appendChild(widgetContainer);
      
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.async = true;
      script.innerHTML = JSON.stringify({
        autosize: true,
        symbol: "OANDA:XAUUSD",
        interval: "1",
        timezone: "Africa/Johannesburg",
        theme: "dark",
        style: "1",
        locale: "en",
        allow_symbol_change: true,
        calendar: false,
        hide_top_toolbar: false,
        hide_side_toolbar: true,
        hide_legend: false,
        hide_volume: false,
        hotlist: false,
        save_image: true,
        details: false,
        withdateranges: false,
        backgroundColor: "rgba(15, 15, 15, 1)",
        gridColor: "rgba(242, 242, 242, 0.06)",
        support_host: "https://www.tradingview.com"
      });
      
      script.onload = () => {
        console.log('📊 TradingView widget script loaded');
        setTimeout(() => setIsLoading(false), 3000);
      };
      
      script.onerror = (error) => {
        console.error('📊 TradingView widget script failed:', error);
        setHasError(true);
        setIsLoading(false);
      };
      
      widgetContainer.appendChild(script);
      
      return () => {
        container.innerHTML = '';
      };
    }
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        {isLoading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#FFD700" />
            <Text style={styles.loadingText}>Loading Chart...</Text>
          </View>
        )}
        {hasError && (
          <View style={styles.errorOverlay}>
            <Text style={styles.errorText}>Failed to load chart</Text>
          </View>
        )}
        <div 
          ref={containerRef as any}
          style={{
            width: '100%',
            height: '400px',
            backgroundColor: '#0F0F0F',
            borderRadius: '12px',
            overflow: 'hidden',
            display: hasError ? 'none' : 'block',
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
          <Text style={styles.loadingText}>Loading Chart...</Text>
        </View>
      )}
      {hasError && (
        <View style={styles.errorOverlay}>
          <Text style={styles.errorText}>Failed to load chart</Text>
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ html: htmlContent }}
        style={[styles.webview, hasError && { display: 'none' }]}
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
          console.log('📊 Chart: WebView load started');
          setIsLoading(true);
          setHasError(false);
        }}
        onLoadEnd={() => {
          console.log('📊 Chart: WebView load ended');
          setTimeout(() => {
            setIsLoading(false);
          }, 4000);
        }}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('📊 Chart WebView error:', nativeEvent);
          setHasError(true);
          setIsLoading(false);
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('📊 Chart WebView HTTP error:', nativeEvent.statusCode);
          if (nativeEvent.statusCode >= 400) {
            setHasError(true);
          }
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
  loadingText: {
    color: '#FFD700',
    marginTop: 12,
    fontSize: 14,
  },
  errorOverlay: {
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
  errorText: {
    color: '#FF4444',
    fontSize: 14,
  },
});
