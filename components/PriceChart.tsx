import { View, StyleSheet, Platform } from "react-native";
import { useEffect, useRef } from "react";
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Platform.OS === 'web' && containerRef.current) {
      const widgetContainer = document.createElement('div');
      widgetContainer.className = 'tradingview-widget-container__widget';
      widgetContainer.style.height = 'calc(100% - 32px)';
      widgetContainer.style.width = '100%';
      
      const copyrightContainer = document.createElement('div');
      copyrightContainer.className = 'tradingview-widget-copyright';
      copyrightContainer.innerHTML = '<a href="https://www.tradingview.com/symbols/XAUUSD/?exchange=OANDA" rel="noopener nofollow" target="_blank"><span class="blue-text">XAUUSD chart</span></a><span class="trademark"> by TradingView</span>';
      
      containerRef.current.innerHTML = '';
      containerRef.current.appendChild(widgetContainer);
      containerRef.current.appendChild(copyrightContainer);
      
      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
      script.async = true;
      script.innerHTML = JSON.stringify({
        allow_symbol_change: true,
        calendar: false,
        details: false,
        hide_side_toolbar: true,
        hide_top_toolbar: false,
        hide_legend: false,
        hide_volume: false,
        hotlist: false,
        interval: "1",
        locale: "en",
        save_image: true,
        style: "1",
        symbol: "OANDA:XAUUSD",
        theme: "dark",
        timezone: "Etc/UTC",
        backgroundColor: "#0F0F0F",
        gridColor: "rgba(242, 242, 242, 0.06)",
        watchlist: [],
        withdateranges: false,
        compareSymbols: [],
        studies: [],
        autosize: true
      });
      
      containerRef.current.appendChild(script);
    }
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <div 
          ref={containerRef as any}
          className="tradingview-widget-container" 
          style={{ height: '100%', width: '100%' }}
        />
      </View>
    );
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { height: 100%; width: 100%; overflow: hidden; background-color: #0F0F0F; }
          .tradingview-widget-container { height: 100%; width: 100%; }
          .tradingview-widget-container__widget { height: calc(100% - 32px); width: 100%; }
        </style>
        <script>
          window.addEventListener('error', function(e) {
            if (e.message && e.message.includes('contentWindow')) {
              e.preventDefault();
              e.stopPropagation();
              return false;
            }
          }, true);
          
          window.addEventListener('unhandledrejection', function(e) {
            if (e.reason && e.reason.message && e.reason.message.includes('contentWindow')) {
              e.preventDefault();
              e.stopPropagation();
              return false;
            }
          });
        </script>
      </head>
      <body>
        <div class="tradingview-widget-container">
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
          "timezone": "Etc/UTC",
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

  return (
    <View style={styles.container}>
      <WebView
        source={{ html: htmlContent }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        scrollEnabled={false}
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.warn('WebView error:', nativeEvent);
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.warn('WebView HTTP error:', nativeEvent);
        }}
        mixedContentMode="always"
        thirdPartyCookiesEnabled={true}
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
