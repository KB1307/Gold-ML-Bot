import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { useState, memo, useMemo } from "react";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

function PriceChart({ data, currentPrice }: PriceChartProps) {
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);

  const widgetUrl = useMemo(() => {
    const config = {
      autosize: true,
      symbol: 'OANDA:XAUUSD',
      interval: '1',
      timezone: 'Africa/Johannesburg',
      theme: 'dark',
      style: '1',
      allow_symbol_change: true,
      hide_top_toolbar: false,
      hide_side_toolbar: true,
      hide_legend: false,
      hide_volume: false,
      hotlist: false,
      save_image: true,
      details: false,
      withdateranges: false,
      backgroundColor: 'rgba(15, 15, 15, 1)',
      gridColor: 'rgba(242, 242, 242, 0.06)',
      support_host: 'https://www.tradingview.com',
      width: '100%',
      height: '100%',
      utm_source: '',
      utm_medium: 'widget',
      utm_campaign: 'advanced-chart',
      'page-uri': '__NHTTP__'
    };
    const encodedConfig = encodeURIComponent(JSON.stringify(config));
    return `https://www.tradingview-widget.com/embed-widget/advanced-chart/?locale=en#${encodedConfig}`;
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
            <Text style={styles.errorText}>Chart unavailable</Text>
            <Text style={styles.errorSubtext}>Please refresh or try on mobile</Text>
          </View>
        )}
        <WebView
          source={{ uri: widgetUrl }}
          style={[styles.webview, hasError && { display: 'none' as any }]}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          scrollEnabled={false}
          originWhitelist={['*']}
          onLoadStart={() => {
            console.log('📊 Chart: WebView load started');
            setIsLoading(true);
            setHasError(false);
          }}
          onLoadEnd={() => {
            console.log('📊 Chart: WebView load ended');
            setTimeout(() => setIsLoading(false), 2000);
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
              setIsLoading(false);
            }
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
        onMessage={(event) => {
          console.log('📊 Chart message:', event.nativeEvent.data);
        }}
      />
    </View>
  );
}

export default memo(PriceChart);

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
    textAlign: 'center',
  },
  errorSubtext: {
    color: '#999',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
});
