import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform, RefreshControl } from "react-native";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { TrendingUp, TrendingDown, Target, Shield, Clock, Zap, BarChart3, Percent, AlertTriangle, Activity, Lightbulb, TrendingUpDown } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { Stack } from "expo-router";
import PriceChart from "@/components/PriceChart";

const StableChartSection = React.memo(() => {
  return (
    <View style={chartSectionStyles.chartCard}>
      <View style={chartSectionStyles.chartContainer}>
        <PriceChart />
      </View>
    </View>
  );
}, () => true);

StableChartSection.displayName = 'StableChartSection';

const chartSectionStyles = StyleSheet.create({
  chartCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  chartContainer: {
    width: "100%",
    height: 350,
    borderRadius: 8,
    overflow: "hidden",
  },
});

function formatFeatureName(feature: string): string {
  const featureMap: { [key: string]: string } = {
    'strong_support_bounce': 'Strong Support Zone',
    'strong_resistance_rejection': 'Strong Resistance Zone',
    'bullish_reversal': 'Bullish Reversal Pattern',
    'bearish_reversal': 'Bearish Reversal Pattern',
    'strong_uptrend': 'Strong Uptrend Confirmed',
    'strong_downtrend': 'Strong Downtrend Confirmed',
    'high_liquidity_session': 'High Liquidity Session',
    'buy_order_imbalance': 'Buy Order Flow Imbalance',
    'sell_order_imbalance': 'Sell Order Flow Imbalance',
    'institutional_buy_footprint': 'Institutional Buy Activity',
    'institutional_sell_footprint': 'Institutional Sell Activity',
    'volume_node_support_resistance': 'High Volume Node S/R',
    'volatile_opportunities': 'Volatile Market Conditions',
    'positive_sentiment': 'Positive Market Sentiment',
    'negative_sentiment': 'Negative Market Sentiment',
    'rsi': 'RSI Indicator',
    'macd': 'MACD Signal',
    'ema_crossover': 'EMA Crossover',
    'fibonacci': 'Fibonacci Level',
    'dxy_correlation': 'DXY Correlation',
    'bullish_ema_crossover': 'Bullish EMA Crossover',
    'bearish_ema_crossover': 'Bearish EMA Crossover',
    'bullish_macd_momentum': 'Bullish MACD',
    'bearish_macd_momentum': 'Bearish MACD',
    'bullish_divergence': 'Bullish Divergence',
    'bearish_divergence': 'Bearish Divergence',
    'bullish_quasimodo': 'Bullish Quasimodo',
    'bearish_quasimodo': 'Bearish Quasimodo',
    'session_low_sweep': 'Session Low Sweep',
    'session_high_sweep': 'Session High Sweep',
    'weekly_pivot': 'Weekly Pivot',
    'fibonacci_alignment': 'Fibonacci Alignment',
  };
  return featureMap[feature] || feature.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getIndicatorInfo(feature: string, signalType: string): { description: string, contribution: string } {
  const indicators: { [key: string]: { description: string, contribution: string } } = {
    'rsi_oversold': {
      description: 'RSI below 30 indicates oversold conditions',
      contribution: 'Generated BUY directional bias through mean-reversion probability'
    },
    'rsi_overbought': {
      description: 'RSI above 70 indicates overbought conditions',
      contribution: 'Generated SELL directional bias through mean-reversion probability'
    },
    'strong_support_bounce': {
      description: 'Price testing strong support zone from historical turning points',
      contribution: 'Increased signal confidence by confirming price reaction at key level'
    },
    'strong_resistance_rejection': {
      description: 'Price testing resistance zone with multiple historical rejections',
      contribution: 'Increased signal confidence by confirming price reaction at key level'
    },
    'bullish_reversal': {
      description: 'Bullish reversal pattern (hammer/engulfing) on lower timeframes',
      contribution: 'Triggered BUY signal through pattern recognition confirmation'
    },
    'bearish_reversal': {
      description: 'Bearish reversal pattern (shooting star/engulfing) on lower timeframes',
      contribution: 'Triggered SELL signal through pattern recognition confirmation'
    },
    'strong_uptrend': {
      description: 'Price above EMAs on multiple timeframes',
      contribution: 'Validated BUY direction through trend alignment confirmation'
    },
    'strong_downtrend': {
      description: 'Price below EMAs on multiple timeframes',
      contribution: 'Validated SELL direction through trend alignment confirmation'
    },
    'high_liquidity_session': {
      description: 'London/NY overlap - optimal execution conditions',
      contribution: 'Boosted confidence with tight spreads and better fill probability'
    },
    'buy_order_imbalance': {
      description: 'Order flow showing 60%+ buy-side volume imbalance',
      contribution: 'Confirmed BUY bias through institutional buying pressure'
    },
    'sell_order_imbalance': {
      description: 'Order flow showing 60%+ sell-side volume imbalance',
      contribution: 'Confirmed SELL bias through institutional selling pressure'
    },
    'institutional_buy_footprint': {
      description: 'Large block orders detected on bid side',
      contribution: 'Strengthened BUY confidence with smart money accumulation'
    },
    'institutional_sell_footprint': {
      description: 'Large block orders detected on ask side',
      contribution: 'Strengthened SELL confidence with smart money distribution'
    },
    'volume_node_support_resistance': {
      description: 'Price at high volume node (point of control)',
      contribution: 'Added confidence through volume profile level validation'
    },
    'positive_sentiment': {
      description: 'Net positive market sentiment from data analysis',
      contribution: 'Supported BUY signal with bullish sentiment confirmation'
    },
    'negative_sentiment': {
      description: 'Net negative market sentiment from data analysis',
      contribution: 'Supported SELL signal with bearish sentiment confirmation'
    },
    'bullish_ema_crossover': {
      description: 'Fast EMA crossed above slow EMA signaling momentum shift',
      contribution: 'Triggered BUY signal with trend-following confirmation'
    },
    'bearish_ema_crossover': {
      description: 'Fast EMA crossed below slow EMA signaling momentum shift',
      contribution: 'Triggered SELL signal with trend-following confirmation'
    },
    'bullish_macd_momentum': {
      description: 'MACD histogram positive and expanding',
      contribution: 'Increased BUY confidence through momentum acceleration'
    },
    'bearish_macd_momentum': {
      description: 'MACD histogram negative and expanding',
      contribution: 'Increased SELL confidence through momentum acceleration'
    },
    'bullish_divergence': {
      description: 'Price lower lows vs RSI higher lows (hidden strength)',
      contribution: 'Identified BUY opportunity via divergence reversal'
    },
    'bearish_divergence': {
      description: 'Price higher highs vs RSI lower highs (hidden weakness)',
      contribution: 'Identified SELL opportunity via divergence reversal'
    },
    'bullish_quasimodo': {
      description: 'Failed lower low + break of structure (liquidity trap)',
      contribution: 'Generated BUY from institutional trap reversal pattern'
    },
    'bearish_quasimodo': {
      description: 'Failed higher high + break of structure (liquidity trap)',
      contribution: 'Generated SELL from institutional trap reversal pattern'
    },
    'session_low_sweep': {
      description: 'Asian session low swept then reversed (liquidity grab)',
      contribution: 'Confirmed BUY through session sweep reversal'
    },
    'session_high_sweep': {
      description: 'Asian session high swept then reversed (liquidity grab)',
      contribution: 'Confirmed SELL through session sweep reversal'
    },
    'weekly_pivot': {
      description: 'Price near weekly pivot - historically significant level',
      contribution: 'Enhanced precision by identifying pivot reaction zone'
    },
    'fibonacci_alignment': {
      description: 'Price at major Fib level (38.2%, 50%, 61.8%)',
      contribution: 'Validated entry timing via Fibonacci confluence'
    },
    'volatile_opportunities': {
      description: 'ATR elevated above 20-day average',
      contribution: 'Improved profit potential with increased volatility range'
    },
    'dxy_correlation': {
      description: 'US Dollar Index inverse correlation confirmed',
      contribution: 'Reinforced direction via intermarket analysis'
    },
  };
  
  return indicators[feature] || {
    description: `${formatFeatureName(feature)} supporting ${signalType.toLowerCase()} bias`,
    contribution: `Contributed to ${signalType} signal confidence calculation`
  };
}

export default function DashboardScreen() {
  const { signalHistory, marketOutlook, performanceMetrics, positionSizing, currentPrice, refreshData, signalUpdateTrigger } = useTrading();
  
  const currentSignal = signalHistory.find(s => s.status === "ACTIVE" || s.status === "PARTIALLY_MANAGED" || s.status === "TP1_HIT" || s.status === "TP2_HIT") || null;
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshData();
    setRefreshing(false);
  }, [refreshData]);

  useEffect(() => {
    console.log(`📊 Dashboard UI update triggered (TP status changed) - Trigger: ${signalUpdateTrigger}`);
  }, [signalUpdateTrigger, signalHistory]);

  const isDataLoading = !marketOutlook;

  const getProgressPercentage = useCallback(() => {
    if (!currentSignal) return 0;
    
    const target = currentSignal.tp3;
    const sl = currentSignal.sl;
    
    if (currentSignal.type === "BUY") {
      if (currentPrice >= target) return 100;
      if (currentPrice <= sl) return 0;
      
      const totalRange = target - sl;
      const progressFromSL = currentPrice - sl;
      const percentage = (progressFromSL / totalRange) * 100;
      
      return Math.min(100, Math.max(0, percentage));
    } else {
      if (currentPrice <= target) return 100;
      if (currentPrice >= sl) return 0;
      
      const totalRange = sl - target;
      const progressFromSL = sl - currentPrice;
      const percentage = (progressFromSL / totalRange) * 100;
      
      return Math.min(100, Math.max(0, percentage));
    }
  }, [currentSignal, currentPrice]);

  const pnl = useMemo(() => {
    if (!currentSignal) return 0;
    
    const diff = currentSignal.type === "BUY" 
      ? currentPrice - currentSignal.entryPrice 
      : currentSignal.entryPrice - currentPrice;
    
    return diff;
  }, [currentSignal, currentPrice]);

  const progress = getProgressPercentage();

  const refreshControl = useMemo(() => (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor="#FFD700"
      colors={["#FFD700"]}
    />
  ), [refreshing, onRefresh]);

  const chartSection = useMemo(() => (
    <View style={{ height: 350, width: '100%', marginBottom: 20 }}>
      <StableChartSection />
    </View>
  ), []);

  return (
    <>
      <Stack.Screen options={{ 
        headerShown: false,
      }} />
      <View style={styles.container}>
        <LinearGradient
          colors={["#0a0a0a", "#1a1a2e"]}
          style={styles.gradient}
        >
          <ScrollView 
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={false}
            refreshControl={refreshControl}
          >
            <View style={styles.header}>
              <View>
                <Text style={styles.headerTitle}>XAUUSD</Text>
                <Text style={styles.headerSubtitle}>Gold Trading Signals</Text>
              </View>
              <View style={styles.priceContainer}>
                <Text style={styles.currentPrice}>${currentPrice.toFixed(1)}</Text>
                <View style={[styles.sessionBadge, marketOutlook?.isMarketOpen && styles.sessionBadgeActive]}>
                  <View style={[styles.sessionDot, marketOutlook?.isMarketOpen && styles.sessionDotActive]} />
                  <Text style={styles.sessionText}>
                    {marketOutlook?.isMarketOpen ? marketOutlook.currentSession : "CLOSED"}
                  </Text>
                </View>
              </View>
            </View>

            {chartSection}

            {isDataLoading && (
              <View style={styles.dataLoadingBanner}>
                <ActivityIndicator size="small" color="#FFD700" />
                <Text style={styles.dataLoadingText}>Loading market data...</Text>
              </View>
            )}

            {marketOutlook && !marketOutlook.isMarketOpen && (
              <View style={styles.closedBanner}>
                <Clock size={16} color="#FFA500" />
                <Text style={styles.closedText}>Market is currently closed. No signals will be generated.</Text>
              </View>
            )}

            {currentSignal ? (
              <View style={styles.signalCard}>
                <LinearGradient
                  colors={currentSignal.type === "BUY" 
                    ? ["rgba(34, 197, 94, 0.15)", "rgba(34, 197, 94, 0.05)"]
                    : ["rgba(239, 68, 68, 0.15)", "rgba(239, 68, 68, 0.05)"]
                  }
                  style={styles.signalGradient}
                >
                  <View style={styles.signalHeader}>
                    <View style={styles.signalTypeContainer}>
                      {currentSignal.type === "BUY" ? (
                        <TrendingUp size={32} color="#22c55e" strokeWidth={2.5} />
                      ) : (
                        <TrendingDown size={32} color="#ef4444" strokeWidth={2.5} />
                      )}
                      <View>
                        <Text style={styles.signalType}>{currentSignal.type} SIGNAL</Text>
                        <Text style={styles.signalTime}>{new Date(currentSignal.timestamp).toLocaleString()}</Text>
                      </View>
                    </View>
                    <View style={styles.confidenceContainer}>
                      <Zap size={16} color="#FFD700" fill="#FFD700" />
                      <Text style={styles.confidenceText}>{(currentSignal.confidence * 100).toFixed(0)}%</Text>
                    </View>
                  </View>

                  {currentSignal.latencyWarning && currentSignal.latencyWarning > 100 && (
                    <View style={styles.warningBanner}>
                      <AlertTriangle size={14} color="#FFA500" />
                      <Text style={styles.warningText}>High Latency: {currentSignal.latencyWarning}ms - Entry price may have shifted</Text>
                    </View>
                  )}

                  {currentSignal.nextMoveContext && (
                    <View style={styles.contextBanner}>
                      <Activity size={14} color="#9C27B0" />
                      <Text style={styles.contextText}>{currentSignal.nextMoveContext}</Text>
                    </View>
                  )}

                  <View style={styles.divider} />

                  <View style={styles.priceGrid}>
                    <View style={styles.priceItem}>
                      <Text style={styles.priceLabel}>Entry</Text>
                      <Text style={styles.priceValue}>${currentSignal.entryPrice.toFixed(1)}</Text>
                    </View>
                    <View style={styles.priceItem}>
                      <Text style={[styles.priceLabel, { color: pnl >= 0 ? "#22c55e" : "#ef4444" }]}>P/L</Text>
                      <Text style={[styles.priceValue, { color: pnl >= 0 ? "#22c55e" : "#ef4444" }]}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(1)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                      <View style={[
                        styles.progressFill, 
                        { 
                          width: `${progress}%`,
                          backgroundColor: currentSignal.type === "BUY" ? "#22c55e" : "#ef4444"
                        }
                      ]} />
                    </View>
                    <Text style={styles.progressText}>{progress.toFixed(0)}% to TP3</Text>
                  </View>

                  <View style={styles.targetsContainer}>
                    <View style={[
                      styles.targetRow,
                      currentSignal.targetsHit >= 1 && styles.targetRowActive
                    ]}>
                      <Target size={16} color={currentSignal.targetsHit >= 1 ? "#22c55e" : "#666"} />
                      <Text style={styles.targetLabel}>TP1</Text>
                      <Text style={[
                        styles.targetValue,
                        currentSignal.targetsHit >= 1 && { color: "#22c55e" }
                      ]}>${currentSignal.tp1.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 1 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={[
                      styles.targetRow,
                      currentSignal.targetsHit >= 2 && styles.targetRowActive
                    ]}>
                      <Target size={16} color={currentSignal.targetsHit >= 2 ? "#22c55e" : "#666"} />
                      <Text style={styles.targetLabel}>TP2</Text>
                      <Text style={[
                        styles.targetValue,
                        currentSignal.targetsHit >= 2 && { color: "#22c55e" }
                      ]}>${currentSignal.tp2.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 2 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={[
                      styles.targetRow,
                      currentSignal.targetsHit >= 3 && styles.targetRowActive
                    ]}>
                      <Target size={16} color={currentSignal.targetsHit >= 3 ? "#22c55e" : "#666"} />
                      <Text style={styles.targetLabel}>TP3</Text>
                      <Text style={[
                        styles.targetValue,
                        currentSignal.targetsHit >= 3 && { color: "#22c55e" }
                      ]}>${currentSignal.tp3.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 3 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.targetRow}>
                      <Shield size={16} color="#ef4444" />
                      <Text style={[styles.targetLabel, { color: "#ef4444" }]}>SL</Text>
                      <Text style={[styles.targetValue, { color: "#ef4444" }]}>${currentSignal.sl.toFixed(1)}</Text>
                    </View>
                  </View>

                  {currentSignal.breakevenReached && (
                    <View style={styles.breakevenInfoCard}>
                      <View style={styles.breakevenIcon}>
                        <Text style={styles.breakevenIconText}>⚖️</Text>
                      </View>
                      <View style={styles.breakevenTextContainer}>
                        <Text style={styles.breakevenTitle}>Breakeven Protection Active</Text>
                        <Text style={styles.breakevenSubtext}>TP1 hit at {currentSignal.breakevenTime || 'N/A'} - Original SL maintained at ${currentSignal.sl.toFixed(1)}</Text>
                      </View>
                    </View>
                  )}

                  <View style={{ height: 0 }}>
                  </View>
                </LinearGradient>
              </View>
            ) : null}

            {currentSignal && (
              <View style={styles.confidenceCard}>
                <View style={styles.confidenceHeader}>
                  <Lightbulb size={18} color="#FFD700" fill="#FFD700" />
                  <Text style={styles.confidenceTitle}>Signal Analysis</Text>
                  <View style={styles.confidenceBadge}>
                    <Text style={styles.confidenceBadgeText}>{(currentSignal.confidence * 100).toFixed(0)}%</Text>
                  </View>
                </View>
                
                {currentSignal.topFeatures && currentSignal.topFeatures.length > 0 && (
                  <View style={styles.featuresContainer}>
                    <Text style={styles.featuresTitle}>Key Indicators That Generated This Signal:</Text>
                    <Text style={styles.featuresSubtitle}>{currentSignal.topFeatures.length} indicators aligned to create {currentSignal.type} signal with {(currentSignal.confidence * 100).toFixed(0)}% confidence</Text>
                    {currentSignal.topFeatures.slice(0, 6).map((feature, index) => {
                      const indicatorInfo = getIndicatorInfo(feature.feature, currentSignal.type);
                      const impact = feature.score >= 0.15 ? 'HIGH' : feature.score >= 0.10 ? 'MEDIUM' : 'LOW';
                      const impactColor = impact === 'HIGH' ? '#22c55e' : impact === 'MEDIUM' ? '#FFD700' : '#999';
                      
                      return (
                        <View key={index} style={styles.featureCard}>
                          <View style={styles.featureHeader}>
                            <View style={styles.featureHeaderLeft}>
                              <View style={[styles.featureDot, { backgroundColor: impactColor }]} />
                              <Text style={styles.featureName}>
                                {formatFeatureName(feature.feature)}
                              </Text>
                            </View>
                            <View style={styles.featureImpactBadge}>
                              <Text style={[styles.featureImpactText, { color: impactColor }]}>{impact} IMPACT</Text>
                            </View>
                          </View>
                          <Text style={styles.featureDescription}>📊 {indicatorInfo.description}</Text>
                          <View style={styles.contributionBanner}>
                            <Text style={styles.contributionText}>💡 {indicatorInfo.contribution}</Text>
                          </View>
                          <View style={styles.featureScoreRow}>
                            <Text style={styles.featureScoreLabel}>Confidence Contribution:</Text>
                            <View style={styles.featureScoreBarWrapper}>
                              <View style={styles.featureScoreContainer}>
                                <View style={[styles.featureBar, { width: `${feature.score * 100}%`, backgroundColor: impactColor }]} />
                              </View>
                              <Text style={[styles.featureScore, { color: impactColor }]}>{(feature.score * 100).toFixed(0)}%</Text>
                            </View>
                          </View>
                        </View>
                      );
                    })}
                  </View>
                )}
                
                <View style={styles.divider} />
                
                <View style={styles.reasoningSection}>
                  <Text style={styles.reasoningTitle}>Why This Signal Has High Probability:</Text>
                  <Text style={styles.confidenceDescription}>
                    {currentSignal.riskJustification}
                  </Text>
                </View>
                
                <View style={styles.probabilityBanner}>
                  <TrendingUpDown size={14} color="#22c55e" />
                  <Text style={styles.probabilityText}>
                    {currentSignal.confidence >= 0.75 ? 'Strong' : currentSignal.confidence >= 0.65 ? 'Moderate' : 'Cautious'} {currentSignal.type.toLowerCase()} setup with multiple confirming indicators across different timeframes and analysis methods.
                  </Text>
                </View>
              </View>
            )}

            {!currentSignal && !isDataLoading && (
              <View style={styles.noSignalCard}>
                <TrendingUp size={48} color="#444" strokeWidth={1.5} />
                <Text style={styles.noSignalTitle}>No Active Signal</Text>
                <Text style={styles.noSignalText}>
                  {marketOutlook?.isMarketOpen 
                    ? "Analyzing market conditions. New signal will appear when high-confidence setup is detected."
                    : "Market is closed. Signals will resume when market opens."
                  }
                </Text>
              </View>
            )}

            {performanceMetrics.totalTrades > 0 && marketOutlook && (
              <View style={styles.metricsCard}>
                <View style={styles.metricsHeader}>
                  <BarChart3 size={20} color="#FFD700" />
                  <Text style={styles.sectionTitle}>Performance Metrics</Text>
                </View>
                
                {performanceMetrics.modelHealthScore !== undefined && (
                  <View style={[
                    styles.healthScoreBanner,
                    performanceMetrics.modelHealthScore < 70 && styles.healthScoreWarning
                  ]}>
                    <Activity size={16} color={performanceMetrics.modelHealthScore < 70 ? "#FFA500" : "#22c55e"} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={styles.healthScoreLabel}>Model Health Score</Text>
                        <Text style={[
                          styles.healthScoreValue,
                          { color: performanceMetrics.modelHealthScore < 70 ? "#FFA500" : "#22c55e" }
                        ]}>{performanceMetrics.modelHealthScore.toFixed(0)}/100</Text>
                      </View>
                      {performanceMetrics.featureCorrelationStatus && (
                        <Text style={styles.healthScoreSubtext}>Feature Correlation: {performanceMetrics.featureCorrelationStatus}</Text>
                      )}
                      {performanceMetrics.modelHealthScore < 70 && (
                        <Text style={styles.healthScoreWarningText}>System check recommended before degradation</Text>
                      )}
                    </View>
                  </View>
                )}
                
                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Total Trades</Text>
                    <Text style={styles.metricValue}>{performanceMetrics.totalTrades}</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Win Rate</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.winRate >= 60 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.winRate.toFixed(1)}%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Profit Factor</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.profitFactor >= 2 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.profitFactor.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Sharpe Ratio</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.sharpeRatio >= 1.5 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.sharpeRatio.toFixed(2)}
                    </Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Total P/L</Text>
                    <Text style={[styles.metricValue, { color: (performanceMetrics.totalProfit - performanceMetrics.totalLoss) >= 0 ? "#22c55e" : "#ef4444" }]}>
                      ${(performanceMetrics.totalProfit - performanceMetrics.totalLoss).toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Max Drawdown</Text>
                    <Text style={[styles.metricValue, { color: "#ef4444" }]}>
                      {performanceMetrics.maxDrawdown.toFixed(2)}%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Avg Win</Text>
                    <Text style={[styles.metricValue, { color: "#22c55e" }]}>
                      ${performanceMetrics.averageWin.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Avg Loss</Text>
                    <Text style={[styles.metricValue, { color: "#ef4444" }]}>
                      ${performanceMetrics.averageLoss.toFixed(2)}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {positionSizing && currentSignal && marketOutlook && (
              <View style={styles.positionCard}>
                <View style={styles.positionHeader}>
                  <Percent size={16} color="#FFD700" />
                  <Text style={styles.sectionTitle}>Dynamic Position Sizing</Text>
                </View>
                
                <View style={styles.positionGrid}>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Base Size</Text>
                    <Text style={styles.positionValue}>{positionSizing.baseSize.toFixed(2)} lots</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Confidence Multiplier</Text>
                    <Text style={[styles.positionValue, { color: "#FFD700" }]}>{positionSizing.confidenceMultiplier}x</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Recommended Size</Text>
                    <Text style={[styles.positionValue, { color: "#22c55e" }]}>{positionSizing.recommendedSize.toFixed(2)} lots</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Risk %</Text>
                    <Text style={[styles.positionValue, { color: positionSizing.riskPercentage > 5 ? "#ef4444" : "#22c55e" }]}>
                      {positionSizing.riskPercentage.toFixed(2)}%
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {marketOutlook && (
            <View style={styles.marketInfoCard}>
              <Text style={styles.sectionTitle}>Market Status</Text>
              <View style={styles.sessionGrid}>
                {marketOutlook.sessions.map((session) => {
                  let hours = "";
                  const getLocalTime = (utcHour: number) => {
                    const date = new Date();
                    date.setUTCHours(utcHour, 0, 0, 0);
                    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                  };
                  
                  if (session.name === "ASIAN") {
                    hours = `${getLocalTime(0)}-${getLocalTime(6)}\n${getLocalTime(21)}-${getLocalTime(24)}`;
                  } else if (session.name === "LONDON") {
                    hours = `${getLocalTime(6)}-${getLocalTime(13)}`;
                  } else if (session.name === "NEW_YORK") {
                    hours = `${getLocalTime(13)}-${getLocalTime(21)}`;
                  }
                  
                  return (
                    <View 
                      key={session.name} 
                      style={[
                        styles.sessionCard,
                        session.isActive && styles.sessionCardActive
                      ]}
                    >
                      <View style={[
                        styles.sessionIndicator,
                        session.isActive && styles.sessionIndicatorActive
                      ]} />
                      <Text style={[
                        styles.sessionName,
                        session.isActive && styles.sessionNameActive
                      ]}>{session.name}</Text>
                      <Text style={styles.sessionHours}>{hours}</Text>
                    </View>
                  );
                })}
              </View>
              
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Trend</Text>
                  <Text style={[
                    styles.statValue,
                    { color: marketOutlook.trend === "BULLISH" ? "#22c55e" : 
                             marketOutlook.trend === "BEARISH" ? "#ef4444" : "#999" }
                  ]}>{marketOutlook.trend}</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Volatility</Text>
                  <Text style={styles.statValue}>{marketOutlook.volatility}</Text>
                </View>
              </View>

              <View style={styles.divider} />

              <Text style={styles.srTitle}>Support & Resistance Zones</Text>
              <View style={styles.srGrid}>
                <View style={styles.srColumn}>
                  <Text style={styles.srColumnTitle}>Resistance</Text>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R3</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r3.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R2</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r2.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R1</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r1.toFixed(1)}</Text>
                  </View>
                </View>
                <View style={styles.srDivider} />
                <View style={styles.srColumn}>
                  <Text style={styles.srColumnTitle}>Support</Text>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S1</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s1.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S2</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s2.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S3</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s3.toFixed(1)}</Text>
                  </View>
                </View>
              </View>
              <View style={styles.pivotRow}>
                <Text style={styles.pivotLabel}>Daily Pivot</Text>
                <Text style={styles.pivotValue}>${marketOutlook.dailyPivot.toFixed(1)}</Text>
              </View>
            </View>
            )}
          </ScrollView>
        </LinearGradient>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0a0a0a",
  },
  dataLoadingBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 215, 0, 0.1)",
    padding: 12,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.3)",
    gap: 10,
  },
  dataLoadingText: {
    fontSize: 13,
    color: "#FFD700",
  },
  gradient: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: Platform.OS === "ios" ? 60 : 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  } as const,
  headerSubtitle: {
    fontSize: 14,
    color: "#999",
  },
  priceContainer: {
    alignItems: "flex-end",
  },
  currentPrice: {
    fontSize: 24,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 8,
  } as const,
  sessionBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  sessionBadgeActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  sessionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#666",
    marginRight: 6,
  },
  sessionDotActive: {
    backgroundColor: "#22c55e",
  },
  sessionText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#999",
    letterSpacing: 0.5,
  } as const,
  closedBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  closedText: {
    flex: 1,
    fontSize: 13,
    color: "#FFA500",
    marginLeft: 12,
    lineHeight: 18,
  },
  signalCard: {
    marginBottom: 20,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  signalGradient: {
    padding: 20,
  },
  signalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  signalTypeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  signalType: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  } as const,
  signalTime: {
    fontSize: 12,
    color: "#999",
  },
  confidenceContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  confidenceText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  divider: {
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    marginBottom: 20,
  },
  priceGrid: {
    flexDirection: "row",
    marginBottom: 20,
    gap: 16,
  },
  priceItem: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  priceLabel: {
    fontSize: 12,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  priceValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
  } as const,
  progressContainer: {
    marginBottom: 20,
  },
  progressBar: {
    height: 8,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
  },
  progressText: {
    fontSize: 11,
    color: "#999",
    textAlign: "right",
  },
  targetsContainer: {
    gap: 12,
  },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  targetRowActive: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    borderColor: "rgba(34, 197, 94, 0.3)",
    borderWidth: 1.5,
  },
  targetLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#fff",
    marginLeft: 8,
    flex: 1,
  } as const,
  targetValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  hitBadge: {
    backgroundColor: "rgba(34, 197, 94, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  hitText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#22c55e",
    letterSpacing: 0.5,
  } as const,
  breakevenBadge: {
    backgroundColor: "rgba(255, 215, 0, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.4)",
  },
  breakevenText: {
    fontSize: 9,
    fontWeight: "700",
    color: "#FFD700",
    letterSpacing: 0.5,
  } as const,
  noSignalCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 40,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  noSignalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#666",
    marginTop: 16,
    marginBottom: 8,
  } as const,
  noSignalText: {
    fontSize: 14,
    color: "#555",
    textAlign: "center",
    lineHeight: 20,
  },
  marketInfoCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 16,
  } as const,
  sessionGrid: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  sessionCard: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    minHeight: 90,
  },
  sessionCardActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  sessionIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#333",
    marginBottom: 8,
  },
  sessionIndicatorActive: {
    backgroundColor: "#22c55e",
  },
  sessionName: {
    fontSize: 10,
    fontWeight: "600",
    color: "#666",
    textAlign: "center",
  } as const,
  sessionNameActive: {
    color: "#22c55e",
  },
  sessionHours: {
    fontSize: 8,
    color: "#555",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 11,
  },
  statsRow: {
    flexDirection: "row",
    gap: 12,
  },
  statItem: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  statLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  srTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#999",
    marginBottom: 12,
    marginTop: 4,
  } as const,
  srGrid: {
    flexDirection: "row",
    gap: 16,
  },
  srColumn: {
    flex: 1,
  },
  srColumnTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
    textAlign: "center",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  } as const,
  srItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  srLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
  } as const,
  srValue: {
    fontSize: 14,
    fontWeight: "700",
  } as const,
  srDivider: {
    width: 1,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  pivotRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.3)",
  },
  pivotLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFD700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  pivotValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  metricsCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  metricsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  metricBox: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  metricLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
  } as const,
  positionCard: {
    backgroundColor: "rgba(255, 215, 0, 0.05)",
    padding: 12,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.2)",
  },
  positionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  positionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  positionItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.1)",
  },
  positionLabel: {
    fontSize: 9,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  positionValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  } as const,
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  warningText: {
    flex: 1,
    fontSize: 11,
    color: "#FFA500",
    marginLeft: 8,
    lineHeight: 16,
  },
  contextBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(156, 39, 176, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(156, 39, 176, 0.3)",
  },
  contextText: {
    flex: 1,
    fontSize: 11,
    color: "#9C27B0",
    marginLeft: 8,
    lineHeight: 16,
  },
  healthScoreBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  healthScoreWarning: {
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  healthScoreLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  } as const,
  healthScoreValue: {
    fontSize: 18,
    fontWeight: "700",
  } as const,
  healthScoreSubtext: {
    fontSize: 11,
    color: "#999",
    marginTop: 4,
  },
  healthScoreWarningText: {
    fontSize: 10,
    color: "#FFA500",
    marginTop: 4,
    fontStyle: "italic",
  },
  chartCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  chartTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 16,
  } as const,
  chartContainer: {
    width: "100%",
    height: 350,
    borderRadius: 8,
    overflow: "hidden",
  },
  confidenceCard: {
    backgroundColor: "rgba(255, 215, 0, 0.08)",
    padding: 18,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.25)",
  },
  confidenceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 14,
  },
  confidenceTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  confidenceDescription: {
    fontSize: 13,
    color: "#ddd",
    lineHeight: 20,
    marginBottom: 16,
  },
  featuresContainer: {
    marginBottom: 14,
  },
  featuresTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 6,
  } as const,
  featuresSubtitle: {
    fontSize: 11,
    fontWeight: "500",
    color: "#999",
    marginBottom: 12,
    lineHeight: 16,
  } as const,
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 10,
    gap: 10,
  },
  featureDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FFD700",
  },
  featureName: {
    fontSize: 12,
    color: "#ccc",
    flex: 1,
  },
  featureScoreContainer: {
    position: "relative",
    width: 60,
    height: 20,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 4,
    overflow: "hidden",
    justifyContent: "center",
    alignItems: "flex-end",
    paddingRight: 6,
  },
  featureBar: {
    position: "absolute",
    left: 0,
    top: 0,
    height: "100%",
    backgroundColor: "rgba(255, 215, 0, 0.4)",
    borderRadius: 4,
  },
  featureScore: {
    fontSize: 9,
    fontWeight: "600",
    color: "#FFD700",
    zIndex: 1,
  } as const,
  probabilityBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    padding: 12,
    borderRadius: 8,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  probabilityText: {
    flex: 1,
    fontSize: 11,
    color: "#22c55e",
    lineHeight: 16,
    fontWeight: "600",
  } as const,
  confidenceBadge: {
    backgroundColor: "rgba(255, 215, 0, 0.2)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: "auto",
  },
  confidenceBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  featureCard: {
    backgroundColor: "rgba(0, 0, 0, 0.25)",
    padding: 12,
    borderRadius: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.15)",
  },
  featureHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  featureHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    gap: 8,
  },
  featureImpactBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
  },
  featureImpactText: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 0.5,
  } as const,
  featureDescription: {
    fontSize: 11,
    color: "#aaa",
    lineHeight: 16,
    marginBottom: 8,
  },
  featureScoreRow: {
    marginTop: 8,
  },
  featureScoreLabel: {
    fontSize: 9,
    color: "#999",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  featureScoreBarWrapper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  contributionBanner: {
    backgroundColor: "rgba(156, 39, 176, 0.12)",
    padding: 10,
    borderRadius: 8,
    marginTop: 8,
    borderWidth: 1,
    borderColor: "rgba(156, 39, 176, 0.25)",
  },
  contributionText: {
    fontSize: 10,
    color: "#BB86FC",
    lineHeight: 15,
    fontWeight: "500",
  } as const,
  reasoningSection: {
    marginBottom: 14,
  },
  reasoningTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#FFD700",
    marginBottom: 8,
  } as const,
  breakevenInfoCard: {
    marginTop: 16,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.12)",
    padding: 14,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: "rgba(255, 215, 0, 0.35)",
  },
  breakevenIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255, 215, 0, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  breakevenIconText: {
    fontSize: 18,
  },
  breakevenTextContainer: {
    flex: 1,
  },
  breakevenTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 4,
  } as const,
  breakevenSubtext: {
    fontSize: 10,
    color: "#bbb",
    lineHeight: 15,
  },
});
