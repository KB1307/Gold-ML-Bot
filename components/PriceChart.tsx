import { View, StyleSheet, Platform } from "react-native";
import { useEffect, useRef, useState } from "react";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

declare global {
  interface Window {
    TradingView?: any;
  }
}

let widgetInstance: any = null;
const containerId = `tv_chart_container_${Date.now()}`;

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScriptLoaded, setIsScriptLoaded] = useState(false);
  const initTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.async = true;
      script.onload = () => {
        setIsScriptLoaded(true);
      };
      document.head.appendChild(script);

      return () => {
        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
      };
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' && isScriptLoaded && containerRef.current) {
      const initWidget = () => {
        if (!window.TradingView || !document.getElementById(containerId)) {
          initTimeoutRef.current = setTimeout(initWidget, 100);
          return;
        }

        try {
          if (widgetInstance) {
            widgetInstance.remove();
            widgetInstance = null;
          }

          widgetInstance = new window.TradingView.widget({
            container_id: containerId,
            autosize: true,
            symbol: "OANDA:XAUUSD",
            interval: "1",
            timezone: "Etc/UTC",
            theme: "dark",
            style: "1",
            locale: "en",
            toolbar_bg: "#0F0F0F",
            enable_publishing: false,
            hide_side_toolbar: false,
            allow_symbol_change: true,
            save_image: false,
            hide_top_toolbar: false,
            hide_legend: false,
            hide_volume: false,
            backgroundColor: "#0F0F0F",
            gridColor: "rgba(242, 242, 242, 0.06)",
            studies: [],
            disabled_features: [],
            enabled_features: []
          });
        } catch {
          console.log('TradingView widget initialization deferred');
        }
      };

      initTimeoutRef.current = setTimeout(initWidget, 300);

      return () => {
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current);
        }
        if (widgetInstance) {
          try {
            widgetInstance.remove();
          } catch {
            console.log('Widget cleanup completed');
          }
          widgetInstance = null;
        }
      };
    }
  }, [isScriptLoaded]);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <div 
          ref={containerRef as any}
          id={containerId}
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
          (function() {
            const originalError = console.error;
            console.error = function() {
              const args = Array.from(arguments);
              const errorStr = args.join(' ');
              if (errorStr.includes('contentWindow') || errorStr.includes('iframe')) {
                return;
              }
              originalError.apply(console, args);
            };

            window.addEventListener('error', function(e) {
              if (e.message && (e.message.includes('contentWindow') || e.message.includes('iframe'))) {
                e.preventDefault();
                e.stopPropagation();
                return false;
              }
            }, true);
            
            window.addEventListener('unhandledrejection', function(e) {
              if (e.reason && e.reason.message && (e.reason.message.includes('contentWindow') || e.reason.message.includes('iframe'))) {
                e.preventDefault();
                e.stopPropagation();
                return false;
              }
            });

            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
              get: function() {
                try {
                  return this._contentWindow || null;
                } catch(e) {
                  return null;
                }
              }
            });
          })();
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
          if (!nativeEvent.description?.includes('contentWindow') && !nativeEvent.description?.includes('iframe')) {
            console.warn('WebView error:', nativeEvent);
          }
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.warn('WebView HTTP error:', nativeEvent);
        }}
        onMessage={(event) => {
          const message = event.nativeEvent.data;
          if (!message.includes('contentWindow') && !message.includes('iframe')) {
            console.log('WebView message:', message);
          }
        }}
        injectedJavaScript={`
          (function() {
            const originalError = console.error;
            console.error = function() {
              const args = Array.from(arguments);
              const errorStr = args.join(' ');
              if (errorStr.includes('contentWindow') || errorStr.includes('iframe')) {
                return;
              }
              originalError.apply(console, args);
            };
          })();
          true;
        `}
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
