import React, { memo, useMemo, useState } from "react";
import { View, StyleSheet, useWindowDimensions } from "react-native";
import Svg, { Defs, LinearGradient, Stop, Path, Rect, Line, Text as SvgText } from "react-native-svg";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
  height?: number;
}

function formatPrice(p: number): string {
  return p.toFixed(1);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function PriceChartImpl({ data, currentPrice, height }: PriceChartProps) {
  const { width: windowWidth } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number>(0);

  const chartWidth = measuredWidth > 0 ? measuredWidth : windowWidth;
  const computedHeight = useMemo(() => {
    if (typeof height === "number") return height;
    const h = chartWidth * 0.58;
    return Math.round(clamp(h, 220, 480));
  }, [chartWidth, height]);

  const normalizedData = useMemo(() => {
    const valid = data.filter((p) => Number.isFinite(p.price));
    if (valid.length < 2) return { points: [] as PriceDataPoint[], min: 0, max: 0 };

    const prices = valid.map((p) => p.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    return { points: valid, min, max };
  }, [data]);

  const path = useMemo(() => {
    const pts = normalizedData.points;
    if (pts.length < 2 || chartWidth <= 0 || computedHeight <= 0) return "";

    const paddingX = 14;
    const paddingY = 16;
    const innerW = Math.max(1, chartWidth - paddingX * 2);
    const innerH = Math.max(1, computedHeight - paddingY * 2);

    const min = normalizedData.min;
    const max = normalizedData.max;
    const range = Math.max(0.0001, max - min);

    const toX = (i: number) => paddingX + (i / (pts.length - 1)) * innerW;
    const toY = (price: number) => {
      const t = (price - min) / range;
      return paddingY + (1 - t) * innerH;
    };

    let d = "";
    for (let i = 0; i < pts.length; i += 1) {
      const x = toX(i);
      const y = toY(pts[i]!.price);
      d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return d;
  }, [chartWidth, computedHeight, normalizedData.min, normalizedData.max, normalizedData.points]);

  const currentLineY = useMemo(() => {
    if (normalizedData.points.length < 2) return null;
    const paddingY = 16;
    const innerH = Math.max(1, computedHeight - paddingY * 2);
    const min = normalizedData.min;
    const max = normalizedData.max;
    const range = Math.max(0.0001, max - min);
    const t = (currentPrice - min) / range;
    const y = paddingY + (1 - t) * innerH;
    return clamp(y, paddingY, computedHeight - paddingY);
  }, [computedHeight, currentPrice, normalizedData.max, normalizedData.min, normalizedData.points.length]);

  const yAxisLabels = useMemo(() => {
    if (normalizedData.points.length < 2) return null;
    const min = normalizedData.min;
    const max = normalizedData.max;
    const mid = (min + max) / 2;
    return {
      top: max,
      mid,
      bottom: min,
    };
  }, [normalizedData.max, normalizedData.min, normalizedData.points.length]);

  return (
    <View
      testID="price-chart"
      style={styles.container}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (Number.isFinite(w) && w > 0) setMeasuredWidth(w);
      }}
    >
      <View style={[styles.card, { height: computedHeight }]} testID="price-chart-card">
        {normalizedData.points.length < 2 ? (
          <View style={styles.emptyState} testID="price-chart-empty">
            <View style={styles.emptyDot} />
          </View>
        ) : (
          <Svg width={chartWidth} height={computedHeight} testID="price-chart-svg">
            <Defs>
              <LinearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#0b1220" stopOpacity={1} />
                <Stop offset="1" stopColor="#06070a" stopOpacity={1} />
              </LinearGradient>
              <LinearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#FFD700" stopOpacity={0.9} />
                <Stop offset="1" stopColor="#22c55e" stopOpacity={0.9} />
              </LinearGradient>
            </Defs>

            <Rect x={0} y={0} width={chartWidth} height={computedHeight} fill="url(#bg)" rx={14} ry={14} />

            <Line x1={0} y1={computedHeight * 0.33} x2={chartWidth} y2={computedHeight * 0.33} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
            <Line x1={0} y1={computedHeight * 0.66} x2={chartWidth} y2={computedHeight * 0.66} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />

            {currentLineY !== null && (
              <Line x1={0} y1={currentLineY} x2={chartWidth} y2={currentLineY} stroke="rgba(255,215,0,0.25)" strokeWidth={1} strokeDasharray="4 4" />
            )}

            <Path d={path} fill="none" stroke="url(#stroke)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

            {yAxisLabels && (
              <>
                <SvgText x={10} y={22} fill="rgba(255,255,255,0.65)" fontSize={10} fontWeight={"600"}>
                  {formatPrice(yAxisLabels.top)}
                </SvgText>
                <SvgText x={10} y={computedHeight / 2} fill="rgba(255,255,255,0.45)" fontSize={10} fontWeight={"600"}>
                  {formatPrice(yAxisLabels.mid)}
                </SvgText>
                <SvgText x={10} y={computedHeight - 10} fill="rgba(255,255,255,0.65)" fontSize={10} fontWeight={"600"}>
                  {formatPrice(yAxisLabels.bottom)}
                </SvgText>
              </>
            )}

            <SvgText
              x={chartWidth - 10}
              y={22}
              fill="#FFD700"
              fontSize={11}
              fontWeight={"700"}
              textAnchor="end"
            >
              {`${formatPrice(currentPrice)}`}
            </SvgText>
          </Svg>
        )}
      </View>
    </View>
  );
}

export default memo(PriceChartImpl);

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  card: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    backgroundColor: "#06070a",
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#06070a",
  },
  emptyDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255, 215, 0, 0.35)",
  },
});
