import React, { useRef, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import PriceChart from '@/components/PriceChart';

// Module-level flag to track if chart has ever been mounted
let chartMountedOnce = false;
let chartInstanceId = 0;

const DashboardChart = React.memo(() => {
  const instanceIdRef = useRef(++chartInstanceId);
  const [shouldRenderChart, setShouldRenderChart] = useState(chartMountedOnce);
  
  useEffect(() => {
    // Only log once per app session
    if (!chartMountedOnce) {
      console.log(`[DashboardChart] First mount (instance #${instanceIdRef.current})`);
      chartMountedOnce = true;
      setShouldRenderChart(true);
    }
  }, []);
  
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartContainer}>
        {shouldRenderChart && <PriceChart />}
      </View>
    </View>
  );
}, () => true);

DashboardChart.displayName = 'DashboardChart';

const styles = StyleSheet.create({
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

export default DashboardChart;
