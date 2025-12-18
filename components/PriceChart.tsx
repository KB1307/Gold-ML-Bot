import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { useState, useRef } from "react";
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

  const widgetConfig = {
    autosize: true,
    symbol: "OANDA:XAUUSD",
    interval: "1",
    timezone: "Africa/Johannesburg",
    theme: "dark",
    style: "1",
    allow_symbol_change: true,
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
  };

  const widgetUrl = `https://www.tradingview-widget.com/embed-widget/advanced-chart/?locale=en#${encodeURIComponent(JSON.stringify(widgetConfig))}`;

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
        <iframe
          src={widgetUrl}
          style={{
            width: '100%',
            height: 400,
            border: 'none',
            borderRadius: 12,
            overflow: 'hidden',
            display: hasError ? 'none' : 'block',
          }}
          title="TradingView Chart"
          onLoad={() => {
            console.log('Chart iframe loaded');
            setTimeout(() => setIsLoading(false), 3000);
          }}
          onError={() => {
            console.error('Chart iframe error');
            setHasError(true);
            setIsLoading(false);
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
        source={{ uri: widgetUrl }}
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
        cacheEnabled={false}
        incognito={false}
        setSupportMultipleWindows={false}
        allowsBackForwardNavigationGestures={false}
        onLoadStart={() => {
          console.log('📊 Chart: Load started');
          setIsLoading(true);
          setHasError(false);
        }}
        onLoadEnd={() => {
          console.log('📊 Chart: Load ended');
          setTimeout(() => {
            setIsLoading(false);
          }, 3000);
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
