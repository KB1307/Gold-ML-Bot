/**
 * ITEM 100 — MARKET STRUCTURE: SWING / BoS / ChoCh / ORDER BLOCKS.
 *
 * Implements standard SMC constructs from first principles using gold_m1_bars.
 * Telemetry ONLY — nothing is wired into scoring this round.
 *
 * - Swing structure: swing highs/lows with a derived lookback
 * - Break of Structure (BoS): price closing beyond prior swing high (uptrend)
 *   or prior swing low (downtrend) — trend continuation
 * - Change of Character (ChoCh): first break AGAINST the prevailing swing
 *   sequence — potential trend reversal
 * - Order Blocks: last opposing candle before an impulsive move that breaks
 *   structure. Reports the OB's price band, direction, and mitigation status.
 */

export interface SwingPoint {
  timestamp: number;
  price: number;
  type: 'HIGH' | 'LOW';
  index: number;
}

export interface StructureEvent {
  type: 'BOS' | 'CHOCH';
  direction: 'BULLISH' | 'BEARISH';
  timestamp: number;
  swingBroken: number;
  breakoutPrice: number;
}

export interface OrderBlock {
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  direction: 'BULLISH' | 'BEARISH';
  mitigated: boolean;
  mitigationTime?: number;
}

export interface MarketStructure {
  swings: SwingPoint[];
  structureEvents: StructureEvent[];
  orderBlocks: OrderBlock[];
  prevailingTrend: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastBos: StructureEvent | null;
  lastChoCh: StructureEvent | null;
}

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Derive swing points from a bar series using a fractal lookback.
 * A swing high is a bar whose high is higher than `lookback` bars on each side.
 */
export function detectSwings(bars: Bar[], lookback: number = 5): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].high <= bars[i - j].high || bars[i].high <= bars[i + j].high) isHigh = false;
      if (bars[i].low >= bars[i - j].low || bars[i].low >= bars[i + j].low) isLow = false;
    }
    if (isHigh) {
      swings.push({ timestamp: bars[i].timestamp, price: bars[i].high, type: 'HIGH', index: i });
    }
    if (isLow) {
      swings.push({ timestamp: bars[i].timestamp, price: bars[i].low, type: 'LOW', index: i });
    }
  }
  return swings.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Detect Break of Structure and Change of Character from swing sequence.
 *
 * In an uptrend (HH + HL): a close above the prior HH is a BOS (continuation).
 * A close below the prior HL is a ChoCh (reversal).
 * In a downtrend (LH + LL): a close below the prior LL is a BOS (continuation).
 * A close above the prior LH is a ChoCh (reversal).
 */
export function detectStructureEvents(
  bars: Bar[],
  swings: SwingPoint[],
): { events: StructureEvent[]; trend: 'BULLISH' | 'BEARISH' | 'RANGING' } {
  const events: StructureEvent[] = [];
  let trend: 'BULLISH' | 'BEARISH' | 'RANGING' = 'RANGING';

  // Track the last confirmed swing high and low
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let prevHigh: SwingPoint | null = null;
  let prevLow: SwingPoint | null = null;

  const swingByIndex = new Map(swings.map(s => [s.index, s]));

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const swing = swingByIndex.get(i);

    if (swing) {
      if (swing.type === 'HIGH') {
        prevHigh = lastHigh;
        lastHigh = swing;
      } else {
        prevLow = lastLow;
        lastLow = swing;
      }
    }

    if (!lastHigh || !lastLow) continue;

    // Check for breaks on this bar's close
    // BULLISH BOS: close above last swing high (in an uptrend)
    if (bar.close > lastHigh.price && trend !== 'BEARISH') {
      if (prevHigh && bar.close > prevHigh.price) {
        // Confirmed continuation
        events.push({
          type: 'BOS',
          direction: 'BULLISH',
          timestamp: bar.timestamp,
          swingBroken: lastHigh.price,
          breakoutPrice: bar.close,
        });
        trend = 'BULLISH';
      }
    }

    // BEARISH BOS: close below last swing low (in a downtrend)
    if (bar.close < lastLow.price && trend !== 'BULLISH') {
      if (prevLow && bar.close < prevLow.price) {
        events.push({
          type: 'BOS',
          direction: 'BEARISH',
          timestamp: bar.timestamp,
          swingBroken: lastLow.price,
          breakoutPrice: bar.close,
        });
        trend = 'BEARISH';
      }
    }

    // BULLISH ChoCh: close above last swing high when trend was BEARISH
    if (bar.close > lastHigh.price && trend === 'BEARISH') {
      events.push({
        type: 'CHOCH',
        direction: 'BULLISH',
        timestamp: bar.timestamp,
        swingBroken: lastHigh.price,
        breakoutPrice: bar.close,
      });
      trend = 'BULLISH';
    }

    // BEARISH ChoCh: close below last swing low when trend was BULLISH
    if (bar.close < lastLow.price && trend === 'BULLISH') {
      events.push({
        type: 'CHOCH',
        direction: 'BEARISH',
        timestamp: bar.timestamp,
        swingBroken: lastLow.price,
        breakoutPrice: bar.close,
      });
      trend = 'BEARISH';
    }
  }

  return { events, trend };
}

/**
 * Detect Order Blocks: the last opposing candle before an impulsive move
 * that breaks structure.
 *
 * A BULLISH OB is the last bearish (red) candle before a bullish impulsive
 * move that breaks above a swing high. A BEARISH OB is the last bullish
 * (green) candle before a bearish impulsive move that breaks below a swing low.
 *
 * An OB is "mitigated" when price subsequently returns to its range.
 */
export function detectOrderBlocks(
  bars: Bar[],
  swings: SwingPoint[],
  structureEvents: StructureEvent[],
): OrderBlock[] {
  const obs: OrderBlock[] = [];

  for (const event of structureEvents) {
    // Find the impulsive move leading to this structure event
    const eventBarIdx = bars.findIndex(b => b.timestamp === event.timestamp);
    if (eventBarIdx < 0) continue;

    // Look back for the last opposing candle (impulse threshold: >= 2x average bar range)
    const lookback = Math.min(20, eventBarIdx);
    if (lookback < 3) continue;

    const recentBars = bars.slice(eventBarIdx - lookback, eventBarIdx);
    const avgRange = recentBars.reduce((s, b) => s + (b.high - b.low), 0) / recentBars.length;
    if (avgRange <= 0) continue;

    if (event.direction === 'BULLISH') {
      // Find the last bearish candle before the impulsive move up
      for (let i = eventBarIdx - 1; i >= eventBarIdx - lookback; i--) {
        const bar = bars[i];
        if (bar.close < bar.open) {
          // Bearish candle — check if the subsequent move is impulsive
          const moveBars = bars.slice(i + 1, eventBarIdx + 1);
          const move = moveBars[moveBars.length - 1].close - bar.close;
          if (move > avgRange * 2) {
            // Impulsive move confirmed — this is a bullish OB
            // Check mitigation: did price return to this OB's range after the event?
            const postEventBars = bars.slice(eventBarIdx + 1);
            const mitigation = postEventBars.find(b => b.low <= bar.high && b.low >= bar.low);
            obs.push({
              startTime: bar.timestamp,
              endTime: bars[Math.min(i + 1, bars.length - 1)].timestamp,
              high: bar.high,
              low: bar.low,
              direction: 'BULLISH',
              mitigated: !!mitigation,
              mitigationTime: mitigation?.timestamp,
            });
            break;
          }
        }
      }
    } else {
      // Find the last bullish candle before the impulsive move down
      for (let i = eventBarIdx - 1; i >= eventBarIdx - lookback; i--) {
        const bar = bars[i];
        if (bar.close > bar.open) {
          // Bullish candle — check if the subsequent move is impulsive
          const moveBars = bars.slice(i + 1, eventBarIdx + 1);
          const move = bar.close - moveBars[moveBars.length - 1].close;
          if (move > avgRange * 2) {
            // Impulsive move confirmed — this is a bearish OB
            const postEventBars = bars.slice(eventBarIdx + 1);
            const mitigation = postEventBars.find(b => b.high >= bar.low && b.high <= bar.high);
            obs.push({
              startTime: bar.timestamp,
              endTime: bars[Math.min(i + 1, bars.length - 1)].timestamp,
              high: bar.high,
              low: bar.low,
              direction: 'BEARISH',
              mitigated: !!mitigation,
              mitigationTime: mitigation?.timestamp,
            });
            break;
          }
        }
      }
    }
  }

  return obs;
}

/**
 * Compute full market structure from a bar series.
 */
export function computeMarketStructure(bars: Bar[], lookback: number = 5): MarketStructure {
  if (bars.length < lookback * 2 + 1) {
    return {
      swings: [],
      structureEvents: [],
      orderBlocks: [],
      prevailingTrend: 'RANGING',
      lastBos: null,
      lastChoCh: null,
    };
  }

  const swings = detectSwings(bars, lookback);
  const { events, trend } = detectStructureEvents(bars, swings);
  const orderBlocks = detectOrderBlocks(bars, swings, events);

  const bosEvents = events.filter(e => e.type === 'BOS');
  const chochEvents = events.filter(e => e.type === 'CHOCH');
  const lastBos = bosEvents.length > 0 ? bosEvents[bosEvents.length - 1] : null;
  const lastChoCh = chochEvents.length > 0 ? chochEvents[chochEvents.length - 1] : null;

  return {
    swings,
    structureEvents: events,
    orderBlocks,
    prevailingTrend: trend,
    lastBos,
    lastChoCh,
  };
}

/**
 * Find unmitigated order blocks within a given ATR distance of current price.
 */
export function findNearbyUnmitigatedOBs(
  structure: MarketStructure,
  currentPrice: number,
  atr: number,
  proximityATR: number = 3,
): OrderBlock[] {
  const threshold = atr * proximityATR;
  return structure.orderBlocks.filter(ob => {
    if (ob.mitigated) return false;
    const dist = Math.min(Math.abs(ob.high - currentPrice), Math.abs(ob.low - currentPrice));
    return dist <= threshold;
  });
}
