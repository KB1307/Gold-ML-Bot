import createContextHook from "@nkzw/create-context-hook";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { TradingSignal, SignalStatus, Settings, MarketOutlook, PerformanceMetrics, PositionSizing, DailyOHLC } from "@/types/trading";
import { signalEngine, setExternalPrice, fetchLiveGoldPriceFallback } from "@/services/signalEngine";
import { Platform, AppState, type AppStateStatus } from "react-native";
import { fetchHistoricalData } from "@/lib/trpc";
import { goldWebSocketService } from "@/services/goldWebSocketService";
import { 
  registerBackgroundTask, 
  setupNotificationChannel, 
  requestNotificationPermissions,
  sendSignalNotification
} from "@/services/backgroundTaskService";
import { subscribeToChartPrice, subscribeToChartHeartbeat } from "@/services/chartPriceBridge";
import { ensureBarStoreReady, ingestTickAllTimeframes, upsertBars, getBars, getBarStoreStats, pruneOldBars, getLatestBarTimestamp, type OhlcBar } from "@/services/barStore";
import { resolveSignalWithBars } from "@/services/signalResolver";
import { sendTelegramAlert } from "@/services/telegramNotifier";

const INDEPENDENT_POLL_INTERVAL_MS = 12000;
const INDEPENDENT_POLL_NO_PRICE_INTERVAL_MS = 5000;
const PRICE_STALE_THRESHOLD_FOR_POLL_MS = 20000;

const DEFAULT_SETTINGS: Settings = {
  tp1Pips: 30,
  tp2Pips: 60,
  tp3Pips: 90,
  slPips: 70,
  numberOfTPs: 3,
  minConfidence: 0.68,
  enableNotifications: true,
  enableTelegramNotifier: true,
  basePositionSize: 0.01,
  maxRiskPercentage: 2.0,
  useKellyCriterion: true,
  useDynamicSL: true,
  maxSLPips: 90,
};

const DEFAULT_METRICS: PerformanceMetrics = {
  totalTrades: 0,
  winningTrades: 0,
  losingTrades: 0,
  totalProfit: 0,
  totalLoss: 0,
  maxDrawdown: 0,
  currentDrawdown: 0,
  sharpeRatio: 0,
  profitFactor: 0,
  winRate: 0,
  averageWin: 0,
  averageLoss: 0,
  expectancy: 0,
};

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface SignalTrackingSnapshot {
  price: number;
  source: string;
  updatedAt: number;
}

const CHART_PRICE_PRIORITY_WINDOW_MS = 15000;
const CHART_STALL_FAILOVER_MS = 20000;
const GUIDE_PRICE_STALE_THRESHOLD_MS = 12000;
const MIN_MEANINGFUL_PRICE_CHANGE = 0.03;
const HISTORICAL_RECONCILIATION_INTERVAL_MS = 30000;
const TERMINAL_SIGNAL_STATUSES: SignalStatus[] = ["CLOSED", "SL_HIT", "SL_AFTER_BE", "ALL_TARGETS_HIT", "TP3_HIT", "PARTIAL_WIN_SL_HIT", "EXPIRED_MISSED_ENTRY"];

/**
 * Density/coverage assessment for a set of 1-minute bars over a window.
 * Used to decide whether locally-stored (chart-derived) bars are complete
 * enough to be the authoritative audit source, or whether a remote feed is
 * needed to fill gaps. We require the history to start near the window open and
 * to cover at least ~70% of the expected 1-minute buckets (markets can have
 * genuinely thin minutes, so we don't demand a perfect 100%).
 */
function assessBarCoverage(
  bars: { timestamp: number }[],
  fromTime: number,
  toTime: number,
): { dense: boolean; reason: string } {
  const MINUTE = 60_000;
  if (bars.length === 0) return { dense: false, reason: "no local bars" };
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const earliest = sorted[0].timestamp;
  const windowMs = Math.max(MINUTE, toTime - fromTime);
  const expectedMinutes = Math.max(1, Math.round(windowMs / MINUTE));
  const within = sorted.filter(b => b.timestamp >= fromTime - MINUTE && b.timestamp <= toTime + MINUTE);
  const startCovered = earliest <= fromTime + 2 * MINUTE;
  const density = within.length / expectedMinutes;
  const dense = startCovered && density >= 0.7;
  return {
    dense,
    reason: `start=${startCovered} density=${(density * 100).toFixed(0)}% (${within.length}/${expectedMinutes}min)`,
  };
}

/**
 * Merge locally-stored (chart-derived) bars with remote bars on a 1-minute
 * grid. Local bars ALWAYS win on conflict because they are built from the live
 * TradingView chart stream the user actually saw; remote bars only fill the
 * minutes the local history is missing.
 */
function mergeBarsPreferLocal(local: OhlcBar[], remote: OhlcBar[]): OhlcBar[] {
  const MINUTE = 60_000;
  const byMinute = new Map<number, OhlcBar>();
  for (const b of remote) byMinute.set(Math.floor(b.timestamp / MINUTE) * MINUTE, b);
  for (const b of local) byMinute.set(Math.floor(b.timestamp / MINUTE) * MINUTE, b);
  return Array.from(byMinute.values()).sort((a, b) => a.timestamp - b.timestamp);
}
const ENFORCED_MIN_SIGNAL_CONFIDENCE = 0.68;

// False-SL protection thresholds.
// A single glitch tick that pokes 0.1 pips past SL for 0 ms was closing
// trades as losses (and poisoning the 1m bar store) even when the underlying
// market never printed that price. Two independent guards now apply:
//   1. BAR-INGEST SPIKE FILTER (see commitSignalPrice) drops outlier ticks
//      BEFORE they can be written into the OHLC bar store, so the historical
//      resolver can't later "confirm" a false SL from a corrupted wick.
//   2. LIVE SL CONFIRMATION now requires a sustained breach: at least
//      SL_CONFIRMATION_MIN_PENETRATION_PIPS past SL for at least
//      SL_CONFIRMATION_MIN_DURATION_MS of elapsed time AND at least
//      SL_CONFIRMATION_MIN_TICKS independent ticks past SL.
const SL_CONFIRMATION_MIN_PENETRATION_PIPS = 1.5;
const SL_CONFIRMATION_MIN_DURATION_MS = 2500;
const SL_CONFIRMATION_MIN_TICKS = 2;
// Spike (feed-glitch) rejection via a TWO-TICK GATE. A tick whose move from the
// last ACCEPTED price exceeds a time-scaled budget is treated as a *candidate*
// and is NOT trusted on its own: it must be corroborated by a SECOND independent
// tick near the same new level before we accept it (a genuine fast move / a
// post-reconnect gap). A lone tick that leaps far and immediately reverts (the
// phantom wick that banked false SL AND false TP1/TP2/TP3 fills, and poisoned
// the bar store the audit trusts) is dropped.
//
// The previous implementation had a fatal hole: beyond TICK_SPIKE_STALE_MS (30s)
// it STOPPED rejecting entirely, and the budget grew unbounded with the gap (a
// 25s gap allowed a ~150 pip jump). During thin pre-London hours gold ticks
// arrive far apart, so a single phantom spike sailed straight through — banking
// a false ALL_TARGETS_HIT off one tick AND corrupting the 1m bar. The gate below
// removes that hole without risking a deadlock (a real gap is accepted on the
// 2nd corroborating tick).
const TICK_SPIKE_BASE_PIPS = 8.0;
const TICK_SPIKE_RATE_PIPS_PER_SEC = 6.0;
// Cap how much the budget grows with the inter-tick gap. 10s cap => max budget
// 8 + 6*10 = 68 pips, so a quiet feed can never "earn" an unlimited jump.
const TICK_SPIKE_BUDGET_CAP_MS = 10000;
// A held spike candidate stays valid this long; a second tick within
// TICK_SPIKE_CONFIRM_TOL_PIPS of it confirms the new level is real.
const TICK_SPIKE_CONFIRM_WINDOW_MS = 60000;
const TICK_SPIKE_CONFIRM_TOL_PIPS = 25;
// Profit-lock after TP1: replaces the previous cosmetic "breakeven" indicator
// with a real trailing stop. Once TP1 is achieved, the effective SL becomes
// entry + 15 pips (BUY) or entry - 15 pips (SELL). If price retraces to that
// level, the trade closes as SL_AFTER_BE banking TP1 + 15 pip lock (WIN).
const POST_TP1_PROFIT_LOCK_PIPS = 15;
const PIP_VALUE = 0.1;
// Part A fix #2: Path 3 (catch-up fallback) no longer echoes signal.sl exactly
// as the exit price for a confirmed SL_HIT - it now reflects the actual
// confirmed price read plus a small realistic exit-fill slippage (in the same
// raw-price-unit convention as SL_CONFIRMATION_MIN_PENETRATION_PIPS above).
const FALLBACK_SL_EXIT_SLIPPAGE_PIPS = 0.3;

interface TickGateState {
  lastPrice: number;
  lastAt: number;
  lastTickId: number;
  pendingPrice: number;
  pendingAt: number;
  pendingTickId: number;
}

function createTickGateState(): TickGateState {
  return { lastPrice: 0, lastAt: 0, lastTickId: 0, pendingPrice: 0, pendingAt: 0, pendingTickId: 0 };
}

/**
 * Two-tick spike gate. Decides whether to ACCEPT an incoming tick as a genuine
 * price (updating the baseline) or REJECT it as an uncorroborated feed glitch.
 * Used by BOTH the bar-ingest path (keeps the OHLC store clean for audits) and
 * the live signal evaluator (stops a single phantom tick banking a false TP/SL).
 * Mutates `state`, so each caller keeps one TickGateState per stream.
 *
 * `tickId` identifies the underlying tick (snapshot.updatedAt for the live path,
 * the commit time for the bar path) so a re-read of the SAME stale tick on the
 * 5s safety interval can never "corroborate" itself.
 */
function classifyTick(
  price: number,
  now: number,
  tickId: number,
  state: TickGateState,
): { accept: boolean; gapPips: number; budgetPips: number; dtMs: number; corroborated: boolean } {
  // No baseline yet, or a backwards clock — seed and accept.
  if (!(state.lastPrice > 0) || !(state.lastAt > 0) || now < state.lastAt) {
    state.lastPrice = price;
    state.lastAt = now;
    state.lastTickId = tickId;
    state.pendingPrice = 0;
    state.pendingAt = 0;
    state.pendingTickId = 0;
    return { accept: true, gapPips: 0, budgetPips: Number.POSITIVE_INFINITY, dtMs: 0, corroborated: false };
  }

  const dtMs = now - state.lastAt;
  const gapPips = Math.abs(price - state.lastPrice) / PIP_VALUE;
  const effectiveDtMs = Math.min(dtMs, TICK_SPIKE_BUDGET_CAP_MS);
  const budgetPips = TICK_SPIKE_BASE_PIPS + TICK_SPIKE_RATE_PIPS_PER_SEC * (effectiveDtMs / 1000);

  if (gapPips <= budgetPips) {
    // Plausible move — accept and clear any stale candidate.
    state.lastPrice = price;
    state.lastAt = now;
    state.lastTickId = tickId;
    state.pendingPrice = 0;
    state.pendingAt = 0;
    state.pendingTickId = 0;
    return { accept: true, gapPips, budgetPips, dtMs, corroborated: false };
  }

  // Large jump: only trust it if a recent, DIFFERENT pending tick corroborates
  // the new level (two independent ticks agree => real move, not a glitch).
  const isNewTick = tickId !== state.pendingTickId;
  const pendingFresh = state.pendingAt > 0 && now - state.pendingAt <= TICK_SPIKE_CONFIRM_WINDOW_MS;
  const corroborated =
    isNewTick &&
    pendingFresh &&
    Math.abs(price - state.pendingPrice) / PIP_VALUE <= TICK_SPIKE_CONFIRM_TOL_PIPS;
  if (corroborated) {
    state.lastPrice = price;
    state.lastAt = now;
    state.lastTickId = tickId;
    state.pendingPrice = 0;
    state.pendingAt = 0;
    state.pendingTickId = 0;
    return { accept: true, gapPips, budgetPips, dtMs, corroborated: true };
  }

  // Record/refresh the candidate only for a genuinely new tick, then reject.
  if (isNewTick) {
    state.pendingPrice = price;
    state.pendingAt = now;
    state.pendingTickId = tickId;
  }
  return { accept: false, gapPips, budgetPips, dtMs, corroborated: false };
}
// Failsafe-only: normal release happens within ~5-25s once
// updateAllSignalsStatus() transitions a signal away from "ACTIVE" (see the
// explicit status check below). This constant only matters if status-sync
// itself stalls (app backgrounded, a missed status-check tick), so it's kept
// short rather than the old 45-minute value which made it look like the
// primary release path.
const ACTIVE_SIGNAL_LOCK_RELEASE_MS = 5 * 60 * 1000;
const SIGNAL_GENERATION_INTERVAL_MS = 20000;

function clampSignalConfidenceThreshold(value: number): number {
  return Number(Math.min(0.98, Math.max(ENFORCED_MIN_SIGNAL_CONFIDENCE, value)).toFixed(2));
}

function sanitizeSettings(settings: Settings): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    minConfidence: clampSignalConfidenceThreshold(settings.minConfidence ?? DEFAULT_SETTINGS.minConfidence),
    maxSLPips: typeof settings.maxSLPips === 'number' && Number.isFinite(settings.maxSLPips) ? settings.maxSLPips : DEFAULT_SETTINGS.maxSLPips,
    useDynamicSL: typeof settings.useDynamicSL === 'boolean' ? settings.useDynamicSL : DEFAULT_SETTINGS.useDynamicSL,
    enableTelegramNotifier: typeof settings.enableTelegramNotifier === 'boolean' ? settings.enableTelegramNotifier : DEFAULT_SETTINGS.enableTelegramNotifier,
  };
}

function sanitizePriceField(value: unknown, fallback: number = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function sanitizeSignalForRender(signal: TradingSignal): TradingSignal {
  return {
    ...signal,
    entryPrice: sanitizePriceField(signal.entryPrice),
    entryPriceWithSlippage: sanitizePriceField(signal.entryPriceWithSlippage, sanitizePriceField(signal.entryPrice)),
    tp1: sanitizePriceField(signal.tp1),
    tp2: sanitizePriceField(signal.tp2),
    tp3: sanitizePriceField(signal.tp3),
    sl: sanitizePriceField(signal.sl),
    confidence: sanitizePriceField(signal.confidence, 0),
    targetsHit: typeof signal.targetsHit === 'number' && Number.isFinite(signal.targetsHit) ? signal.targetsHit : 0,
    type: signal.type === 'BUY' || signal.type === 'SELL' ? signal.type : 'BUY',
    status: typeof signal.status === 'string' ? signal.status : 'CLOSED',
    id: typeof signal.id === 'string' ? signal.id : `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    entryTime: typeof signal.entryTime === 'string' ? signal.entryTime : '',
  };
}

function sanitizeHistoryForRender(history: TradingSignal[]): TradingSignal[] {
  return history.map(sanitizeSignalForRender);
}

export function getPostTP1LockPrice(signal: TradingSignal): number {
  const delta = POST_TP1_PROFIT_LOCK_PIPS * PIP_VALUE;
  const raw = signal.type === 'BUY' ? signal.entryPrice + delta : signal.entryPrice - delta;
  return Number(raw.toFixed(1));
}

function getProtectedExitPrice(signal: TradingSignal, targetsHit: number): number {
  const normalizedTargetsHit = Math.max(0, Math.min(2, targetsHit));

  if (normalizedTargetsHit >= 2) {
    return Number(((signal.tp1 + signal.tp2 + signal.entryPrice) / 3).toFixed(1));
  }

  if (normalizedTargetsHit === 1) {
    // Post-TP1 protected exit = 15 pip profit lock (entry +/- 15 pips).
    // This banks TP1 runner + 15 pip lock when price retraces past the lock.
    return getPostTP1LockPrice(signal);
  }

  return signal.entryPrice;
}

export function getEffectiveExitPrice(signal: TradingSignal): number {
  switch (signal.status) {
    case "ALL_TARGETS_HIT":
    case "TP3_HIT":
      return signal.tp3;
    case "PARTIAL_WIN_SL_HIT":
      return getProtectedExitPrice(signal, Math.max(signal.targetsHit, 2));
    case "SL_AFTER_BE":
      return getProtectedExitPrice(signal, Math.max(signal.targetsHit, 1));
    case "TP2_HIT":
      return signal.exitPrice ?? getProtectedExitPrice(signal, 2);
    case "TP1_HIT":
      return signal.exitPrice ?? getProtectedExitPrice(signal, 1);
    case "SL_HIT":
      return signal.sl;
    case "CLOSED":
      return signal.exitPrice ?? signal.entryPrice;
    case "EXPIRED_MISSED_ENTRY":
      return signal.entryPrice;
    default:
      return signal.exitPrice ?? signal.entryPrice;
  }
}

/**
 * Single source of truth for how a signal's terminal outcome is bucketed.
 *
 * Every screen (Dashboard performance metrics, Telemetry day-stats, History)
 * MUST use this so the same signal can never be a win on one screen and a loss
 * (or ignored) on another. Key rules:
 *  - OPEN: still being monitored (ACTIVE / PARTIALLY_MANAGED / TP1 / TP2 runner).
 *  - NO_TRADE: no position was ever taken (EXPIRED_MISSED_ENTRY) or a flat close.
 *    These are excluded from win/loss and from totalTrades.
 *  - WIN/LOSS: a real position that reached a profitable/losing terminal state.
 */
export type SignalOutcomeClass = "WIN" | "LOSS" | "NO_TRADE" | "OPEN";

const OPEN_OUTCOME_STATUSES: SignalStatus[] = ["ACTIVE", "PARTIALLY_MANAGED", "TP1_HIT", "TP2_HIT"];
const WIN_OUTCOME_STATUSES: SignalStatus[] = ["ALL_TARGETS_HIT", "TP3_HIT", "PARTIAL_WIN_SL_HIT", "SL_AFTER_BE"];

export function classifySignalOutcome(signal: TradingSignal, basePositionSize: number): SignalOutcomeClass {
  if (OPEN_OUTCOME_STATUSES.includes(signal.status)) return "OPEN";
  if (signal.status === "EXPIRED_MISSED_ENTRY") return "NO_TRADE";
  if (WIN_OUTCOME_STATUSES.includes(signal.status)) return "WIN";
  if (signal.status === "SL_HIT") return "LOSS";
  // CLOSED (manual/expired close): decide by realized P/L.
  const pnl = computeSignalPnL(signal, basePositionSize);
  if (pnl > 0.01) return "WIN";
  if (pnl < -0.01) return "LOSS";
  return "NO_TRADE";
}

export interface FallbackBreachTrackerState {
  firstBreachAt: number;
  maxPenetrationPips: number;
  lastPrice: number;
  tickCount: number;
}

/**
 * Pure, unit-testable core of Part A's Path 3 (catch-up fallback) hardening.
 * Mirrors the live tick monitor's confirmSLHit standard (multi-read
 * corroboration + minimum sustained duration + minimum real penetration), but
 * is designed to span SEPARATE catch-up passes (the fallback only samples one
 * price snapshot per pass) rather than live sub-second ticks. A single
 * bad/stale/glitched read can never alone confirm - `tracker` must already
 * hold a PRIOR pending candidate for this exact key, and the elapsed/
 * penetration/tick-count thresholds must all be met, before this returns true.
 * Mutates `tracker` in place (per-signal, per-kind keyed map).
 */
export function evaluateFallbackBreachConfirmation(
  tracker: Map<string, FallbackBreachTrackerState>,
  trackKey: string,
  penetrationPips: number,
  price: number,
  now: number,
  opts: { minDurationMs: number; minPenetrationPips: number; minTicks: number },
): boolean {
  if (penetrationPips < 0) {
    tracker.delete(trackKey);
    return false;
  }
  const existing = tracker.get(trackKey);
  if (!existing) {
    tracker.set(trackKey, { firstBreachAt: now, maxPenetrationPips: penetrationPips, lastPrice: price, tickCount: 1 });
    return false;
  }
  existing.maxPenetrationPips = Math.max(existing.maxPenetrationPips, penetrationPips);
  existing.lastPrice = price;
  existing.tickCount += 1;
  const elapsed = now - existing.firstBreachAt;
  const confirmed = elapsed >= opts.minDurationMs
    && existing.maxPenetrationPips >= opts.minPenetrationPips
    && existing.tickCount >= opts.minTicks;
  if (!confirmed) {
    return false;
  }
  tracker.delete(trackKey);
  return true;
}

export function computeSignalPnL(signal: TradingSignal, basePositionSize: number): number {
  const terminalStatuses: SignalStatus[] = [
    "ALL_TARGETS_HIT",
    "TP3_HIT",
    "PARTIAL_WIN_SL_HIT",
    "SL_AFTER_BE",
    "SL_HIT",
    "CLOSED",
    "EXPIRED_MISSED_ENTRY",
  ];
  if (!terminalStatuses.includes(signal.status)) return 0;

  // Guard against corrupt/legacy signals whose stored prices are missing or zero.
  // A signal with no valid entry, SL or TP3 cannot have a meaningful P/L, and
  // letting a zeroed exit through (e.g. exit=0 against a ~$3000 entry) poisons
  // the running total with absurd outliers like a single -$100+ trade.
  const entry = signal.entryPrice;
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  if (!Number.isFinite(signal.sl) || signal.sl <= 0) return 0;
  if (!Number.isFinite(signal.tp3) || signal.tp3 <= 0) return 0;

  const exit = getEffectiveExitPrice(signal);
  if (!Number.isFinite(exit) || exit <= 0) return 0;

  const contractSize = 100;
  const rawDirectional = signal.type === "BUY" ? exit - entry : entry - exit;

  // A trade can never realize more than its full TP3 reward, nor lose more than
  // its full SL risk — we always exit at SL or a target, never beyond. Clamp the
  // per-unit move to that structural envelope so a single bad bar/price can't
  // fabricate an impossible win or loss in the metrics.
  const rewardDistance = Math.abs(signal.tp3 - entry);
  const riskDistance = Math.abs(entry - signal.sl);
  const clampedDirectional = Math.max(-riskDistance, Math.min(rewardDistance, rawDirectional));

  return clampedDirectional * basePositionSize * contractSize;
}

/**
 * Dollar risk a signal was actually exposed to (entry -> SL distance), scaled
 * by the same position-sizing convention as computeSignalPnL. This is the
 * denominator for R-multiple normalization — required because SL distance is
 * NOT fixed across signals (dynamic/ATR-based SL means a 40-pip-risk signal
 * and a 90-pip-risk signal are not comparable in raw dollar terms).
 */
export function computeSignalRiskAmount(signal: TradingSignal, basePositionSize: number): number {
  if (!Number.isFinite(signal.entryPrice) || signal.entryPrice <= 0) return 0;
  if (!Number.isFinite(signal.sl) || signal.sl <= 0) return 0;
  const contractSize = 100;
  const riskDistance = Math.abs(signal.entryPrice - signal.sl);
  return riskDistance * basePositionSize * contractSize;
}

/**
 * Risk-normalized return for a single closed trade: how many multiples of its
 * own initial risk it made or lost (R-multiple). A trade that risked $20 and
 * made $40 is +2R regardless of whether another signal that day risked $50.
 * Returns 0 when risk is unknown/invalid rather than throwing, so a single
 * corrupt signal can't NaN-poison an aggregate.
 */
export function computeSignalRMultiple(signal: TradingSignal, basePositionSize: number): number {
  const riskAmount = computeSignalRiskAmount(signal, basePositionSize);
  if (riskAmount <= 0) return 0;
  const pnl = computeSignalPnL(signal, basePositionSize);
  return pnl / riskAmount;
}

function areMarketSessionsEqual(left: MarketOutlook["sessions"], right: MarketOutlook["sessions"]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((session, index) => {
    const rightSession = right[index];
    return session.name === rightSession?.name && session.isActive === rightSession?.isActive;
  });
}

function areMarketOutlooksEqual(previousValue: MarketOutlook | null, nextValue: MarketOutlook): boolean {
  if (!previousValue) {
    return false;
  }

  return (
    previousValue.isMarketOpen === nextValue.isMarketOpen &&
    previousValue.currentSession === nextValue.currentSession &&
    previousValue.trend === nextValue.trend &&
    previousValue.volatility === nextValue.volatility &&
    previousValue.dailyPivot === nextValue.dailyPivot &&
    previousValue.r1 === nextValue.r1 &&
    previousValue.r2 === nextValue.r2 &&
    previousValue.r3 === nextValue.r3 &&
    previousValue.s1 === nextValue.s1 &&
    previousValue.s2 === nextValue.s2 &&
    previousValue.s3 === nextValue.s3 &&
    areMarketSessionsEqual(previousValue.sessions, nextValue.sessions)
  );
}

export const [TradingProvider, useTrading] = createContextHook(() => {
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(true);
  const [signalHistory, setSignalHistory] = useState<TradingSignal[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [marketOutlook, setMarketOutlook] = useState<MarketOutlook | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [performanceMetrics, setPerformanceMetrics] = useState<PerformanceMetrics>(DEFAULT_METRICS);
  const [positionSizing, setPositionSizing] = useState<PositionSizing | null>(null);
  const [accountBalance, setAccountBalance] = useState<number>(100);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [currentPriceUpdatedAt, setCurrentPriceUpdatedAt] = useState<number>(0);
  const [chartPrice, setChartPrice] = useState<number>(0);
  const [chartPriceUpdatedAt, setChartPriceUpdatedAt] = useState<number>(0);
  const [guidePrice, setGuidePrice] = useState<number>(0);
  const [priceHistory, setPriceHistory] = useState<PriceDataPoint[]>([]);
  const [dailyOHLCHistory, setDailyOHLCHistory] = useState<DailyOHLC[]>([]);
  const [signalUpdateTrigger, setSignalUpdateTrigger] = useState<number>(0);
  const [appLaunchTime] = useState<number>(Date.now());
  const [backgroundTaskActive, setBackgroundTaskActive] = useState<boolean>(false);
  const [priceSource, setPriceSource] = useState<string>('connecting...');
  const [chartPriceSource, setChartPriceSource] = useState<string>('connecting...');
  const [guidePriceSource, setGuidePriceSource] = useState<string>('connecting...');
  const [guidePriceUpdatedAt, setGuidePriceUpdatedAt] = useState<number>(0);
  const [livePriceError, setLivePriceError] = useState<string | null>(null);
  const chartPriceHeartbeatRef = useRef<number>(0);
  const lastChartPriceRef = useRef<number>(0);
  const chartPriceLastMeaningfulMoveRef = useRef<number>(0);
  const historicalReconciliationInFlightRef = useRef<boolean>(false);
  const signalHistoryRef = useRef<TradingSignal[]>([]);
  const signalTrackingSnapshotRef = useRef<SignalTrackingSnapshot>({
    price: 0,
    source: '🔴 no live price',
    updatedAt: 0,
  });
  const historicalFallbackPriceRef = useRef<number>(0);
  const guidePriceRef = useRef<number>(0);
  const guidePriceUpdatedAtRef = useRef<number>(0);
  const wsConnectedRef = useRef<boolean>(false);
  // Per-signal SL breach tracking (in-memory). Key = signal.id.
  // Tracks when price first broke the SL; we only confirm SL_HIT after the
  // required duration AND minimum penetration are satisfied.
  const slBreachTrackerRef = useRef<Map<string, { firstBreachAt: number; maxPenetrationPips: number; lastPrice: number; tickCount: number }>>(new Map());
  // Path 3 (catch-up fallback, fires when NO historical bars are available)
  // breach confirmation tracker. Hardens the fallback with the SAME standard
  // Path 1 (confirmSLHit above) already has: a single point-in-time price read
  // can never alone terminate a signal - it must be corroborated by ANOTHER
  // read on a LATER catch-up pass, spanning a minimum duration, before a
  // terminal (SL-side) outcome is confirmed. Key = `${signal.id}:${kind}`.
  const fallbackBreachTrackerRef = useRef<Map<string, { firstBreachAt: number; maxPenetrationPips: number; lastPrice: number; tickCount: number }>>(new Map());
  // Diagnostic counters (Part A, item 4): how often each catch-up resolution
  // path actually fires, to gauge how many existing stored signals may have
  // been resolved via the (now-hardened) single-snapshot fallback path.
  const resolutionPathFireCountsRef = useRef<{ path3FallbackEntered: number; path3FallbackTerminalConfirmed: number; path2BarsResolved: number }>({ path3FallbackEntered: 0, path3FallbackTerminalConfirmed: 0, path2BarsResolved: 0 });
  // Two-tick spike gate state for the live signal evaluator (stops an
  // uncorroborated glitch tick from banking a false TP/SL).
  const liveTickGateRef = useRef<TickGateState>(createTickGateState());
  // Separate gate state for BAR ingest so a single phantom tick can't poison
  // the OHLC store the audit relies on.
  const barTickGateRef = useRef<TickGateState>(createTickGateState());
  // Debounced AsyncStorage writer for signal_history. High-frequency tick-driven
  // updaters (status monitor, reconciliation interval) were each writing the
  // entire history JSON on every change. We coalesce those writes into a single
  // flush ~400ms later so the UI thread isn't blocked by repeated stringify+IO.
  const pendingHistoryWriteRef = useRef<TradingSignal[] | null>(null);
  const historyWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushHistoryWrite = useCallback(async (): Promise<void> => {
    const payload = pendingHistoryWriteRef.current;
    if (!payload) return;
    pendingHistoryWriteRef.current = null;
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
      historyWriteTimerRef.current = null;
    }
    try {
      await AsyncStorage.setItem('signal_history', JSON.stringify(payload));
    } catch (err) {
      console.error('❌ Failed to persist signal history (debounced):', err);
    }
  }, []);
  const persistSignalHistory = useCallback((history: TradingSignal[], options?: { immediate?: boolean }) => {
    pendingHistoryWriteRef.current = history;
    if (options?.immediate) {
      void flushHistoryWrite();
      return;
    }
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
    }
    historyWriteTimerRef.current = setTimeout(() => {
      historyWriteTimerRef.current = null;
      void flushHistoryWrite();
    }, 400);
  }, [flushHistoryWrite]);

  /**
   * Absorb signals written to storage by the background task while the app was
   * suspended. The foreground keeps an authoritative in-memory copy and persists
   * it (debounced) on every tick; without this merge, the next foreground write
   * would clobber any background-generated signals, making history "fall out of
   * sync" and appear to lose older days. We union by id (foreground wins on
   * conflicts since it actively monitors live status) and re-sort newest-first.
   */
  const reconcileBackgroundSignals = useCallback(async () => {
    try {
      const saved = await AsyncStorage.getItem('signal_history');
      if (!saved) return;
      const raw: unknown = JSON.parse(saved);
      if (!Array.isArray(raw)) return;
      const current = signalHistoryRef.current;
      const knownIds = new Set(current.map(s => s.id));
      const additions: TradingSignal[] = raw
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).id === 'string' && !knownIds.has((s as Record<string, unknown>).id as string))
        .map((s) => ({
          ...s,
          timestamp: s.timestamp ? new Date(s.timestamp as string | number) : new Date(),
        } as TradingSignal));
      if (additions.length === 0) return;
      const merged = [...additions, ...current].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      signalHistoryRef.current = merged;
      setSignalHistory(sanitizeHistoryForRender(merged));
      persistSignalHistory(merged, { immediate: true });
      console.log(`🔁 Reconciled ${additions.length} background-generated signal(s) into history`);
    } catch (err) {
      console.warn('⚠️ Background signal reconciliation failed:', err instanceof Error ? err.message : 'Unknown');
    }
  }, [persistSignalHistory]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        void reconcileBackgroundSignals();
      }
    };
    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [reconcileBackgroundSignals]);

  useEffect(() => {
    const init = async () => {
      console.log('🚀 Initializing Trading Context...');
      try {
        await ensureBarStoreReady();
        await pruneOldBars();
        try {
          const stats = await getBarStoreStats();
          console.log('🗄️ [BarStore] stats at init:', stats);
        } catch (err) {
          console.warn('⚠️ [BarStore] stats lookup failed:', err);
        }
        const loadedDailyOHLC = await signalEngine.loadPersistedLearningData();
        await loadPersistedData();
        if (loadedDailyOHLC && loadedDailyOHLC.length > 0) {
          setDailyOHLCHistory(loadedDailyOHLC);
        }

        if (Platform.OS !== 'web') {
          console.log('📱 Setting up mobile features...');
          await setupNotificationChannel();
          await requestNotificationPermissions();
          
          if (settings.enableNotifications) {
            const registered = await registerBackgroundTask();
            setBackgroundTaskActive(registered);
            
            if (registered) {
              console.log('✅ Background signal generation active');
              console.log('   - App will generate signals even when closed');
              console.log('   - Push notifications enabled');
            }
          }
        }

        console.log('✅ Trading Context initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize Trading Context:', error);
        setIsLoading(false);
      }
    };
    void init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commitSignalPrice = useCallback((price: number, source: string, options?: { markChartFresh?: boolean }) => {
    setExternalPrice(price, source);
    setCurrentPrice(price);
    setPriceSource(source);
    setLivePriceError(null);

    const now = Date.now();
    setCurrentPriceUpdatedAt(now);

    if (options?.markChartFresh) {
      setChartPrice(price);
      setChartPriceSource(source);
      setChartPriceUpdatedAt(now);
    }

    setPriceHistory(prev => {
      const newHistory = [...prev, { timestamp: now, price }];
      const maxPoints = 60;
      if (newHistory.length > maxPoints) {
        return newHistory.slice(newHistory.length - maxPoints);
      }
      return newHistory;
    });

    // BAR-INGEST SPIKE GATE: a single phantom tick that leaps far and reverts
    // was contaminating the 1m/5m/1h bar high/low, which then made the audit
    // "confirm" false SL/TP fills. The two-tick gate only writes a large move
    // into the bar store once a SECOND tick corroborates the new level, so a
    // lone glitch is never ingested. The on-screen price still updates every
    // tick above (no user-visible regression).
    const barGate = classifyTick(price, now, now, barTickGateRef.current);
    if (!barGate.accept) {
      console.warn(`🛡️ [BarStore] Holding unconfirmed tick ${price.toFixed(1)} (${barGate.gapPips.toFixed(1)} pips in ${barGate.dtMs}ms vs budget ${barGate.budgetPips.toFixed(1)} pips) - awaiting a 2nd corroborating tick before ingesting`);
    } else {
      void ingestTickAllTimeframes(price, now).catch(err => {
        console.warn('⚠️ [BarStore] tick ingest failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
      });
    }

    signalEngine.updateDailyOHLC(price).then(updatedOHLC => {
      if (!updatedOHLC) return;
      setDailyOHLCHistory(prev => {
        const existingIndex = prev.findIndex(d => d.date === updatedOHLC.date);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = updatedOHLC;
          return updated;
        }
        const newHistory = [...prev, updatedOHLC];
        if (newHistory.length > 30) {
          return newHistory.slice(-30);
        }
        return newHistory;
      });
    }).catch(err => {
      console.warn('⚠️ Daily OHLC update failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
    });
  }, []);

  const commitGuidePrice = useCallback((price: number, source: string) => {
    guidePriceRef.current = price;
    guidePriceUpdatedAtRef.current = Date.now();
    setGuidePrice(price);
    setGuidePriceSource(source);
    setGuidePriceUpdatedAt(Date.now());
  }, []);

  const applyLivePrice = useCallback((price: number, source: string, origin: "chart" | "feed") => {
    if (price <= 1000 || price > 10000 || Number.isNaN(price)) {
      console.warn(`⚠️ Ignoring invalid ${origin} price: ${price}`);
      return;
    }

    const now = Date.now();
    const isChartFeedFresh = chartPriceHeartbeatRef.current > 0 && (now - chartPriceHeartbeatRef.current) < CHART_PRICE_PRIORITY_WINDOW_MS;
    const chartFeedLooksStalled = chartPriceLastMeaningfulMoveRef.current > 0 && (now - chartPriceLastMeaningfulMoveRef.current) >= CHART_STALL_FAILOVER_MS;

    if (origin === "chart") {
      chartPriceHeartbeatRef.current = now;

      if (lastChartPriceRef.current <= 0 || Math.abs(price - lastChartPriceRef.current) >= MIN_MEANINGFUL_PRICE_CHANGE) {
        chartPriceLastMeaningfulMoveRef.current = now;
      }

      lastChartPriceRef.current = price;
      commitSignalPrice(price, source, { markChartFresh: true });
      return;
    }

    if (isChartFeedFresh && !chartFeedLooksStalled) {
      console.log(`ℹ️ Ignoring ${source} tick because TradingView chart price is active`);
      return;
    }

    if (isChartFeedFresh && chartFeedLooksStalled) {
      console.warn(`⚠️ Promoting ${source} tick because TradingView chart price appears stalled`);
      commitSignalPrice(price, `${source} • chart-failover`);
      return;
    }

    commitSignalPrice(price, source);
  }, [commitSignalPrice]);

  const ingestChartPrice = useCallback((price: number, source: string = 'tradingview-chart') => {
    const normalizedSource = source.startsWith('🟢') ? source : `🟢 ${source}`;
    applyLivePrice(price, normalizedSource, "chart");

    const now = Date.now();
    const lastGuidePriceAt = guidePriceUpdatedAtRef.current;
    const lastGuidePrice = guidePriceRef.current;
    const guideFeedStale = lastGuidePriceAt <= 0 || (now - lastGuidePriceAt) > GUIDE_PRICE_STALE_THRESHOLD_MS;
    const guidePriceZero = lastGuidePrice <= 0;
    const wsDown = !wsConnectedRef.current;

    if (guidePriceZero || guideFeedStale || wsDown) {
      console.log(`📊 [GuidePrice] Promoting chart price ${price.toFixed(2)} to guide (${guidePriceZero ? 'no guide price' : guideFeedStale ? `stale ${((now - lastGuidePriceAt) / 1000).toFixed(1)}s` : 'WS down'})`);
      commitGuidePrice(price, normalizedSource);
    }
  }, [applyLivePrice, commitGuidePrice]);

  useEffect(() => {
    console.log('📈 Subscribing to TradingView chart price bridge...');
    const unsubscribe = subscribeToChartPrice((price: number, source: string) => {
      ingestChartPrice(price, source);
    });

    return () => {
      console.log('📉 Unsubscribing from TradingView chart price bridge...');
      unsubscribe();
    };
  }, [ingestChartPrice]);

  useEffect(() => {
    let isMounted = true;

    console.log('🔌 Starting Swissquote live price feed...');

    const unsubPrice = goldWebSocketService.onPrice((price: number, source: string) => {
      if (!isMounted) return;
      wsConnectedRef.current = true;
      commitGuidePrice(price, source);
      applyLivePrice(price, source, 'feed');
    });

    const unsubStatus = goldWebSocketService.onStatus((status) => {
      if (!isMounted) return;

      console.log(`📡 Price feed status: ${status}`);

      if (status === 'connected') {
        wsConnectedRef.current = true;
        const lastGuidePrice = goldWebSocketService.getLastPrice();
        const lastGuidePriceSource = goldWebSocketService.getLastPriceSource();

        if (lastGuidePrice > 0) {
          commitGuidePrice(lastGuidePrice, lastGuidePriceSource);
        } else {
          setGuidePriceSource('🟢 Swissquote-Live');
        }
      } else if (status === 'waiting_for_trade') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0) {
          setGuidePriceSource('🟠 Waiting for Data');
        }
      } else if (status === 'disconnected') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0) {
          setGuidePriceSource('🔴 Disconnected');
        }
      } else if (status === 'reconnecting') {
        wsConnectedRef.current = false;
        if (guidePriceRef.current <= 0 && !goldWebSocketService.isRestFallbackActive()) {
          setGuidePriceSource('🔴 Reconnecting...');
        }
      }
    });

    goldWebSocketService.start();

    return () => {
      isMounted = false;
      wsConnectedRef.current = false;
      unsubPrice();
      unsubStatus();
      goldWebSocketService.stop();
    };
  }, [commitGuidePrice, applyLivePrice]);

  useEffect(() => {
    const CHART_GUIDE_PROMOTION_INTERVAL_MS = 5000;
    const timer = setInterval(() => {
      const now = Date.now();
      const chartPx = lastChartPriceRef.current;
      const chartFresh = chartPriceHeartbeatRef.current > 0 && (now - chartPriceHeartbeatRef.current) < 15000;
      const guidePx = guidePriceRef.current;
      const guideAt = guidePriceUpdatedAtRef.current;
      const guideStale = guideAt <= 0 || (now - guideAt) > GUIDE_PRICE_STALE_THRESHOLD_MS;
      const wsUp = wsConnectedRef.current;

      if (chartPx > 1000 && chartFresh && (guidePx <= 0 || (guideStale && !wsUp))) {
        console.log(`🔄 [GuidePromoTimer] Promoting chart price ${chartPx.toFixed(2)} to guide (guidePx=${guidePx.toFixed(2)}, guideStale=${guideStale}, wsUp=${wsUp})`);
        commitGuidePrice(chartPx, '🟢 TradingView (auto)');
      }
    }, CHART_GUIDE_PROMOTION_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [commitGuidePrice]);

  useEffect(() => {
    const unsubHeartbeat = subscribeToChartHeartbeat((isAlive, lastPriceAt, _lastPrice) => {
      if (!isAlive && lastPriceAt > 0) {
        const staleSec = ((Date.now() - lastPriceAt) / 1000).toFixed(1);
        console.log(`💔 [ChartHeartbeat] Chart feed stale for ${staleSec}s — Tiingo feed is active backup`);
      }
    });

    return () => {
      unsubHeartbeat();
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void updateMarketOutlook();
    }, 5000);

    void updateMarketOutlook();

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let isMounted = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let consecutiveSuccesses = 0;

    const runIndependentPricePoll = async () => {
      if (!isMounted) return;

      const now = Date.now();
      const guidePx = guidePriceRef.current;
      const guideAt = guidePriceUpdatedAtRef.current;
      const chartPx = lastChartPriceRef.current;
      const chartAt = chartPriceHeartbeatRef.current;
      const guideAge = guideAt > 0 ? now - guideAt : Number.POSITIVE_INFINITY;
      const chartAge = chartAt > 0 ? now - chartAt : Number.POSITIVE_INFINITY;
      const hasFreshPrice = (guidePx > 0 && guideAge < PRICE_STALE_THRESHOLD_FOR_POLL_MS) ||
                            (chartPx > 0 && chartAge < PRICE_STALE_THRESHOLD_FOR_POLL_MS);

      if (hasFreshPrice && consecutiveSuccesses > 2) {
        schedulePoll(INDEPENDENT_POLL_INTERVAL_MS);
        return;
      }

      const pollLabel = guidePx <= 0 ? 'no-price' : guideAge > PRICE_STALE_THRESHOLD_FOR_POLL_MS ? `stale-${(guideAge / 1000).toFixed(0)}s` : 'routine';
      console.log(`🔄 [IndependentPoll] Fetching price (reason=${pollLabel}, guidePx=${guidePx.toFixed(2)}, guideAge=${guideAge === Number.POSITIVE_INFINITY ? '∞' : (guideAge / 1000).toFixed(1) + 's'})`);

      try {
        const result = await fetchLiveGoldPriceFallback();
        if (!isMounted) return;

        if (result.price > 0) {
          consecutiveSuccesses++;
          const freshSource = `🟢 ${result.source.replace(/🟢 |🟠 |🟡 |🔴 /g, '')} (poll)`;
          console.log(`✅ [IndependentPoll] Got price: ${result.price.toFixed(2)} from ${freshSource}`);

          commitGuidePrice(result.price, freshSource);
          applyLivePrice(result.price, freshSource, 'feed');
        } else {
          consecutiveSuccesses = 0;
          console.warn('⚠️ [IndependentPoll] All price sources returned 0');
        }
      } catch (err) {
        consecutiveSuccesses = 0;
        console.warn('⚠️ [IndependentPoll] Price fetch failed:', err instanceof Error ? err.message : 'Unknown');
      }

      const nextInterval = guidePriceRef.current <= 0
        ? INDEPENDENT_POLL_NO_PRICE_INTERVAL_MS
        : INDEPENDENT_POLL_INTERVAL_MS;
      schedulePoll(nextInterval);
    };

    const schedulePoll = (delayMs: number) => {
      if (!isMounted) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        void runIndependentPricePoll();
      }, delayMs);
    };

    console.log('🛡️ [IndependentPoll] Starting independent price safety net (first poll in 3s)');
    schedulePoll(3000);

    return () => {
      isMounted = false;
      if (pollTimer) clearTimeout(pollTimer);
      console.log('🛑 [IndependentPoll] Stopped independent price safety net');
    };
  }, [commitGuidePrice, applyLivePrice]);

  const fetchPriceHistory = useCallback(async (fromTime: number, toTime: number): Promise<{timestamp: number, open: number, high: number, low: number, close: number}[]> => {
    try {
      console.log(`📊 Fetching historical 1-MINUTE OHLCV data...`);
      console.log(`   From: ${new Date(fromTime).toISOString()}`);
      console.log(`   To: ${new Date(toTime).toISOString()}`);

      const localBars = await getBars('1m', fromTime, toTime);
      const latestLocalTs = localBars.length > 0 ? localBars[localBars.length - 1].timestamp : null;
      const now = Date.now();
      const localCoversWindow = latestLocalTs !== null && (toTime - latestLocalTs) <= 90_000 && localBars.length > 0;
      if (localCoversWindow) {
        console.log(`✅ [BarStore] Serving ${localBars.length} 1-min bars from sqlite ring buffer (covers window)`);
        return localBars;
      }

      const bars = await fetchHistoricalData({
        fromTime,
        toTime,
        timeoutMs: 15000,
      });

      console.log(`✅ Fetched ${bars.length} historical 1-MINUTE bars (remote)`);

      if (bars.length > 0) {
        console.log(`   First bar: ${new Date(bars[0].timestamp).toISOString()} - Close: ${bars[0].close.toFixed(2)}`);
        console.log(`   Last bar: ${new Date(bars[bars.length - 1].timestamp).toISOString()} - Close: ${bars[bars.length - 1].close.toFixed(2)}`);
        void upsertBars('1m', bars).catch(err => {
          console.warn('⚠️ [BarStore] persisting fetched bars failed:', err instanceof Error ? err.message : 'Unknown');
        });
        if (latestLocalTs !== null && bars.length > 0) {
          void getLatestBarTimestamp('1m').then(newestTs => {
            console.log(`🗄️ [BarStore] merged remote bars; newest local ts now ${newestTs ? new Date(newestTs).toISOString() : 'n/a'}`);
          });
        }
      }

      return bars;
    } catch (error) {
      console.error('❌ Error fetching price history:', error);
      return [];
    }
  }, []);

  const analyzeSignalWithHistoricalData = useCallback(async (
    signal: TradingSignal,
    historicalBars: {timestamp: number, open: number, high: number, low: number, close: number}[]
  ): Promise<{newStatus: SignalStatus, targetsHit: number, exitPrice: number, outcomeResult: 'WIN' | 'LOSS' | null, breakevenReached?: boolean, breakevenTime?: string}> => {
    console.log(`\n📊 UPGRADED SEQUENTIAL ANALYSIS (1-Min Bars)`);
    console.log(`   Signal ID: ${signal.id.slice(-6)}`);
    console.log(`   Signal Type: ${signal.type}`);
    console.log(`   Entry Range: ${signal.entryPrice.toFixed(1)} - ${signal.entryPriceWithSlippage.toFixed(1)}`);
    console.log(`   TP1: ${signal.tp1.toFixed(1)} | TP2: ${signal.tp2.toFixed(1)} | TP3: ${signal.tp3.toFixed(1)}`);
    console.log(`   SL: ${signal.sl.toFixed(1)}`);
    console.log(`   Current Targets Hit: ${signal.targetsHit}`);
    console.log(`   Historical Bars: ${historicalBars.length} (1-minute resolution)`);
    
    let currentStatus = signal.status;
    let currentTargetsHit = signal.targetsHit;
    let exitPrice = signal.entryPrice;
    let outcomeResult: 'WIN' | 'LOSS' | null = null;
    let entryConfirmed = false;
    let tp1HitTime: number | null = null;
    let breakevenReached = signal.breakevenReached || false;
    let breakevenTime = signal.breakevenTime;

    // CRITICAL FIX: Filter out bars that overlap the signal creation time.
    // A 1-minute bar with timestamp 11:08:00 covers 11:08:00 - 11:08:59. If the
    // signal was created at 11:08:30, any pre-signal wick inside that bar's
    // high/low would falsely trigger an SL hit "1 minute after" the signal.
    // We skip the partial bar that contains (or precedes) the signal timestamp
    // and only evaluate bars that fully start AFTER the signal was generated.
    const signalCreatedAtMs = signal.createdAt ?? new Date(signal.timestamp).getTime();
    const oneMinuteMs = 60 * 1000;
    const safeBarStart = signalCreatedAtMs + oneMinuteMs;
    const originalBarCount = historicalBars.length;
    historicalBars = historicalBars.filter(b => b.timestamp >= safeBarStart);
    if (originalBarCount !== historicalBars.length) {
      console.log(`   🛡️ Filtered ${originalBarCount - historicalBars.length} bar(s) that overlap signal creation time (${new Date(signalCreatedAtMs).toISOString()})`);
      console.log(`      Only evaluating bars with timestamp >= ${new Date(safeBarStart).toISOString()}`);
    }

    const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
    const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
    const ENTRY_TOLERANCE = 1.0;
    const EXTENDED_ENTRY_TOLERANCE = 3.0;
    
    if (signal.targetsHit >= 1 || signal.status === "TP1_HIT" || signal.status === "TP2_HIT" || signal.status === "TP3_HIT" || signal.status === "ALL_TARGETS_HIT") {
      entryConfirmed = true;
      console.log(`   ✅ ENTRY AUTO-CONFIRMED: signal already reached TP${signal.targetsHit} - entry was obviously filled`);
    }
    
    console.log(`\n🔍 STEP 1: Entry Validation (${signal.type})`);
    console.log(`   Entry Zone (strict): ${(entryMin - ENTRY_TOLERANCE).toFixed(1)} - ${(entryMax + ENTRY_TOLERANCE).toFixed(1)}`);
    console.log(`   Entry Zone (extended): ${(entryMin - EXTENDED_ENTRY_TOLERANCE).toFixed(1)} - ${(entryMax + EXTENDED_ENTRY_TOLERANCE).toFixed(1)}`);
    
    for (let i = 0; i < historicalBars.length; i++) {
      const bar = historicalBars[i];
      
      if (!entryConfirmed) {
        const touchedEntryZone = signal.type === "BUY" 
          ? bar.low <= (entryMax + ENTRY_TOLERANCE) && bar.high >= (entryMin - ENTRY_TOLERANCE)
          : bar.high >= (entryMin - ENTRY_TOLERANCE) && bar.low <= (entryMax + ENTRY_TOLERANCE);
        
        const tpReachedFromEntry = signal.type === "BUY"
          ? bar.high >= signal.tp1
          : bar.low <= signal.tp1;
        
        const slReachedFromEntry = signal.type === "BUY"
          ? bar.low <= signal.sl
          : bar.high >= signal.sl;
        
        const crossedEntryByExtendedZone = signal.type === "BUY"
          ? bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE) && bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE)
          : bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE) && bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE);
        
        if (touchedEntryZone) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY CONFIRMED on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar H/L: ${bar.high.toFixed(1)}/${bar.low.toFixed(1)}`);
        } else if (tpReachedFromEntry || slReachedFromEntry) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY AUTO-CONFIRMED on bar ${i + 1}: price reached ${tpReachedFromEntry ? 'TP1' : 'SL'} so must have traversed entry zone`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
        } else if (crossedEntryByExtendedZone) {
          entryConfirmed = true;
          console.log(`   ✅ ENTRY CONFIRMED (extended ±${EXTENDED_ENTRY_TOLERANCE} tolerance) on bar ${i + 1} - gapped fill`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar H/L: ${bar.high.toFixed(1)}/${bar.low.toFixed(1)}`);
        } else {
          continue;
        }
      }
      
      console.log(`   [Bar ${i+1}] ${new Date(bar.timestamp).toLocaleTimeString()} - H:${bar.high.toFixed(1)} L:${bar.low.toFixed(1)} C:${bar.close.toFixed(1)}`);
      
      if (signal.type === "BUY") {
        if (bar.low <= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= Original SL: ${signal.sl.toFixed(1)}`);

          if (currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ✅ Managed runner protected after TP2 - closing as partial win at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
          } else if (breakevenReached || currentTargetsHit >= 1) {
            currentStatus = "SL_AFTER_BE";
            currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ⚖️ SL HIT AFTER BREAKEVEN - no capital loss, TP1 banked @ ${exitPrice.toFixed(1)}`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = signal.sl;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (Original SL hit before breakeven)`);
          }

          break;
        }
        
        if (bar.high >= signal.tp3 && currentTargetsHit < 3) {
          console.log(`   🎯🎯🎯 TP3 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP3: ${signal.tp3.toFixed(1)}`);
          currentStatus = "ALL_TARGETS_HIT";
          currentTargetsHit = 3;
          exitPrice = signal.tp3;
          outcomeResult = 'WIN';
          console.log(`      📊 Result: FULL WIN (All targets hit)`);
          break;
        } else if (bar.high >= signal.tp2 && currentTargetsHit < 2) {
          console.log(`   🎯🎯 TP2 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP2: ${signal.tp2.toFixed(1)}`);
          currentStatus = "TP2_HIT";
          currentTargetsHit = 2;
          exitPrice = signal.tp2;
          console.log(`      🔓 Lock released - Can generate new signals`);
          console.log(`      📋 Breakeven indicator active at entry - trade continues to TP3 or original SL`);
        } else if (bar.high >= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN INDICATOR: Notifier triggered at entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
          console.log(`      🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
        }

        if (currentTargetsHit >= 2 && bar.low <= signal.entryPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT";
          currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
          outcomeResult = 'WIN';
          console.log(`      ✅ TP2 runner returned to breakeven - closing as protected partial win @ ${exitPrice.toFixed(1)}`);
          break;
        }

        if (breakevenReached && bar.low <= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      } else {
        if (bar.high >= signal.sl) {
          console.log(`   🚨 ORIGINAL SL HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar High: ${bar.high.toFixed(1)} >= Original SL: ${signal.sl.toFixed(1)}`);

          if (currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT";
            currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ✅ Managed runner protected after TP2 - closing as partial win at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
          } else if (breakevenReached || currentTargetsHit >= 1) {
            currentStatus = "SL_AFTER_BE";
            currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
            outcomeResult = 'WIN';
            console.log(`      ⚖️ SL HIT AFTER BREAKEVEN - no capital loss, TP1 banked @ ${exitPrice.toFixed(1)}`);
          } else {
            currentStatus = "SL_HIT";
            exitPrice = signal.sl;
            outcomeResult = 'LOSS';
            console.log(`      📊 Result: LOSS (Original SL hit before breakeven)`);
          }

          break;
        }
        
        if (bar.low <= signal.tp3 && currentTargetsHit < 3) {
          console.log(`   🎯🎯🎯 TP3 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP3: ${signal.tp3.toFixed(1)}`);
          currentStatus = "ALL_TARGETS_HIT";
          currentTargetsHit = 3;
          exitPrice = signal.tp3;
          outcomeResult = 'WIN';
          console.log(`      📊 Result: FULL WIN (All targets hit)`);
          break;
        } else if (bar.low <= signal.tp2 && currentTargetsHit < 2) {
          console.log(`   🎯🎯 TP2 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP2: ${signal.tp2.toFixed(1)}`);
          currentStatus = "TP2_HIT";
          currentTargetsHit = 2;
          exitPrice = signal.tp2;
          console.log(`      🔓 Lock released - Can generate new signals`);
          console.log(`      📋 Breakeven indicator active at entry - trade continues to TP3 or original SL`);
        } else if (bar.low <= signal.tp1 && currentTargetsHit < 1) {
          console.log(`   🎯 TP1 HIT on bar ${i + 1}/${historicalBars.length}`);
          console.log(`      Time: ${new Date(bar.timestamp).toLocaleTimeString()}`);
          console.log(`      Bar Low: ${bar.low.toFixed(1)} <= TP1: ${signal.tp1.toFixed(1)}`);
          currentStatus = "TP1_HIT";
          currentTargetsHit = 1;
          exitPrice = signal.tp1;
          tp1HitTime = bar.timestamp;
          breakevenReached = true;
          breakevenTime = new Date(bar.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          
          console.log(`      ⚖️ BREAKEVEN INDICATOR: Notifier triggered at entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
          console.log(`      🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
        }

        if (currentTargetsHit >= 2 && bar.high >= signal.entryPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT";
          currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit);
          outcomeResult = 'WIN';
          console.log(`      ✅ TP2 runner returned to breakeven - closing as protected partial win @ ${exitPrice.toFixed(1)}`);
          break;
        }

        if (breakevenReached && bar.high >= signal.entryPrice && currentTargetsHit < 3) {
          console.log(`      📋 BREAKEVEN NOTIFICATION: Price touched entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
        }
      }
    }
    
    if (!entryConfirmed) {
      const anyTargetHit = currentTargetsHit > 0
        || currentStatus === "TP1_HIT"
        || currentStatus === "TP2_HIT"
        || currentStatus === "TP3_HIT"
        || currentStatus === "ALL_TARGETS_HIT"
        || currentStatus === "PARTIAL_WIN_SL_HIT"
        || currentStatus === "SL_AFTER_BE";
      
      if (anyTargetHit) {
        console.log(`   ⚠️ Entry not flagged within zone but signal already reached targets - keeping status ${currentStatus}`);
      } else {
        console.log(`   ❌ ENTRY VALIDATION FAILED: Price never entered the entry zone`);
        console.log(`      Signal marked as EXPIRED_MISSED_ENTRY`);
        currentStatus = "EXPIRED_MISSED_ENTRY";
        outcomeResult = null;
      }
    }
    
    console.log(`\n✅ Analysis Complete:`);
    console.log(`   Final Status: ${currentStatus}`);
    console.log(`   Targets Hit: ${currentTargetsHit}/3`);
    console.log(`   Exit Price: ${exitPrice.toFixed(1)}`);
    console.log(`   Outcome: ${outcomeResult || 'N/A'}`);
    if (tp1HitTime) {
      console.log(`   TP1 Hit Time: ${new Date(tp1HitTime).toLocaleTimeString()}`);
    }
    
    return {
      newStatus: currentStatus,
      targetsHit: currentTargetsHit,
      exitPrice,
      outcomeResult,
      breakevenReached,
      breakevenTime,
    };
  }, []);

  const catchUpAndEvaluateSignals = useCallback(async (history: TradingSignal[], fallbackPrice?: number) => {
    console.log('\n' + '='.repeat(80));
    console.log('🔄 SIGNAL CATCH-UP EVALUATION INITIATED');
    console.log('='.repeat(80));
    console.log('   Checking for stale ACTIVE signals that need evaluation...');
    
    const now = Date.now();
    const currentFallbackPrice = fallbackPrice ?? signalEngine.getCurrentPrice();
    const currentPrice = currentFallbackPrice;
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    
    if (currentFallbackPrice <= 0) {
      console.log('⚠️ Catch-up evaluation running without live fallback price - historical bars only');
    }
    
    let updatedHistory = [...history];
    let hasChanges = false;
    
    for (let i = 0; i < updatedHistory.length; i++) {
      const signal = updatedHistory[i];
      
      if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "SL_AFTER_BE" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
        continue;
      }

      // Clear any in-flight SL breach tracker while we do the authoritative
      // historical reconciliation - the historical path is truthful and must
      // not be short-circuited by stale tick-level breach state.
      slBreachTrackerRef.current.delete(signal.id);

      const signalAge = now - new Date(signal.timestamp).getTime();
      console.log(`\n🔍 Evaluating Signal ${signal.id.slice(-6)}:`);
      console.log(`   Type: ${signal.type}`);
      console.log(`   Status: ${signal.status}`);
      console.log(`   Entry: ${signal.entryPrice.toFixed(1)}`);
      console.log(`   Age: ${(signalAge / 1000 / 60 / 60).toFixed(1)} hours`);
      console.log(`   TP1: ${signal.tp1.toFixed(1)} | TP2: ${signal.tp2.toFixed(1)} | TP3: ${signal.tp3.toFixed(1)}`);
      console.log(`   SL: ${signal.sl.toFixed(1)}`);
      
      if (signalAge > twoHoursInMs) {
        console.log(`   ⏰ Signal expired (>2 hours) - marking as CLOSED`);
        updatedHistory[i] = {
          ...signal,
          status: "CLOSED" as const,
          exitTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          exitPrice: currentFallbackPrice > 0 ? currentFallbackPrice : signal.entryPrice,
        };
        hasChanges = true;
        
        await signalEngine.recordTradeOutcome(
          signal.id,
          signal.entryPrice,
          currentFallbackPrice > 0 ? currentFallbackPrice : signal.entryPrice,
          'LOSS',
          signal.learningContext,
          undefined,
          signalAge
        ).catch(err => {
          console.error(`Failed to record expired signal outcome:`, err);
        });
        continue;
      }
      
      const signalTime = new Date(signal.timestamp).getTime();
      const historicalBars = await fetchPriceHistory(signalTime, now);
      
      if (historicalBars.length === 0) {
        resolutionPathFireCountsRef.current.path3FallbackEntered += 1;
        const signalCreatedAtEpoch = signal.createdAt ?? new Date(signal.timestamp).getTime();
        console.log(`   ⚠️ No historical data available - using current price fallback [Path 3 - fire count: ${resolutionPathFireCountsRef.current.path3FallbackEntered}]`);
        console.log(`   🕓 [Path 3 diag] signal.createdAt(epoch ms)=${signalCreatedAtEpoch} now(epoch ms)=${now} currentFallbackPrice=${currentFallbackPrice.toFixed(2)}`);

        if (currentFallbackPrice <= 0) {
          console.log(`   ⏳ No fallback live price available - leaving signal unchanged until next reconciliation`);
          continue;
        }
        
        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let shouldRecord = false;
        let outcomeResult: 'WIN' | 'LOSS' = 'LOSS';
        let exitPrice = currentPrice;

        // HARDENED (Part A fix): a single point-in-time snapshot must never be
        // able to single-handedly terminate a signal via SL_HIT. This mirrors
        // Path 1's confirmSLHit standard (multi-read corroboration + minimum
        // sustained duration + real confirmed penetration), but spans SEPARATE
        // catch-up passes (this fallback only samples one price per pass, ~30s
        // apart) instead of live sub-second ticks. A lone bad/stale/glitched
        // read is recorded as a pending candidate and can only confirm if it is
        // STILL past threshold on a LATER pass, satisfying the same duration/
        // penetration/tick-count thresholds already used live.
        const confirmFallbackBreach = (kind: 'SL' | 'TP2_RUNNER_RETRACE', penetrationPips: number): boolean => {
          const trackKey = `${signal.id}:${kind}`;
          const hadCandidate = fallbackBreachTrackerRef.current.has(trackKey);
          const confirmed = evaluateFallbackBreachConfirmation(
            fallbackBreachTrackerRef.current,
            trackKey,
            penetrationPips,
            currentPrice,
            now,
            {
              minDurationMs: SL_CONFIRMATION_MIN_DURATION_MS,
              minPenetrationPips: SL_CONFIRMATION_MIN_PENETRATION_PIPS,
              minTicks: SL_CONFIRMATION_MIN_TICKS,
            },
          );
          if (penetrationPips < 0) {
            if (hadCandidate) {
              console.log(`   🛡️ [Path 3] breach candidate for ${signal.id.slice(-6)} (${kind}) reset - price recovered past threshold`);
            }
            return false;
          }
          if (!hadCandidate && !confirmed) {
            console.log(`   🛡️ [Path 3] BREACH CANDIDATE (pending confirmation on a later pass): ${signal.id.slice(-6)} kind=${kind} penetration=${penetrationPips.toFixed(2)} @ ${currentPrice.toFixed(1)} - needs a corroborating later read (>=${SL_CONFIRMATION_MIN_DURATION_MS}ms elapsed, >=${SL_CONFIRMATION_MIN_TICKS} reads)`);
            return false;
          }
          if (!confirmed) {
            const existing = fallbackBreachTrackerRef.current.get(trackKey);
            console.log(`   🛡️ [Path 3] breach ongoing for ${signal.id.slice(-6)} kind=${kind}: maxPen=${existing?.maxPenetrationPips.toFixed(2) ?? '?'} reads=${existing?.tickCount ?? '?'}`);
            return false;
          }
          console.log(`   ✅ [Path 3] BREACH CONFIRMED for ${signal.id.slice(-6)} kind=${kind}: confirmed across separate catch-up passes, pen ${penetrationPips.toFixed(2)}`);
          resolutionPathFireCountsRef.current.path3FallbackTerminalConfirmed += 1;
          return true;
        };
        
        if (signal.type === "BUY") {
          // TP conditions evaluated FIRST (forward price progress), before any
          // protective-stop / raw-SL condition is even considered.
          if (currentPrice >= signal.tp3) {
            console.log(`   🎯 CATCH-UP (Fallback): All targets hit @ ${currentPrice.toFixed(1)} (TP3: ${signal.tp3.toFixed(1)})`);
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            shouldRecord = true;
            outcomeResult = 'WIN';
            exitPrice = signal.tp3;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
            fallbackBreachTrackerRef.current.delete(`${signal.id}:TP2_RUNNER_RETRACE`);
          } else if (currentPrice >= signal.tp2 && targetsHit < 2) {
            console.log(`   🎯 CATCH-UP (Fallback): TP2 hit @ ${currentPrice.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            newStatus = "TP2_HIT";
            targetsHit = 2;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
          } else if (currentPrice >= signal.tp1 && targetsHit < 1) {
            console.log(`   🎯 CATCH-UP (Fallback): TP1 hit @ ${currentPrice.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            newStatus = "TP1_HIT";
            targetsHit = 1;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
          } else if (targetsHit >= 2 && currentPrice <= signal.entryPrice && confirmFallbackBreach('TP2_RUNNER_RETRACE', (signal.entryPrice - currentPrice))) {
            console.log(`   ✅ CATCH-UP (Fallback): TP2 runner returned to entry @ ${currentPrice.toFixed(1)} - closing as protected partial win`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            outcomeResult = 'WIN';
            exitPrice = getProtectedExitPrice(signal, targetsHit);
            shouldRecord = true;
          } else if (currentPrice <= signal.sl - SL_CONFIRMATION_MIN_PENETRATION_PIPS && confirmFallbackBreach('SL', (signal.sl - currentPrice))) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)}) - penetration ${(signal.sl - currentPrice).toFixed(2)} confirmed across separate catch-up passes`);
            if (targetsHit >= 2) {
              newStatus = "PARTIAL_WIN_SL_HIT";
              targetsHit = Math.max(targetsHit, 2);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ✅ Managed runner was already breakeven-protected after TP2 - recording partial win @ ${exitPrice.toFixed(1)}`);
            } else if (signal.breakevenReached || targetsHit >= 1) {
              newStatus = "SL_AFTER_BE";
              targetsHit = Math.max(targetsHit, 1);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ⚖️ SL AFTER BREAKEVEN - no capital loss (TP1 banked) @ ${exitPrice.toFixed(1)}`);
            } else {
              newStatus = "SL_HIT";
              outcomeResult = 'LOSS';
              // Part A fix #2: reflect the actual confirmed read (with a small,
              // realistic exit-fill slippage), never echo signal.sl exactly.
              exitPrice = parseFloat((currentPrice - FALLBACK_SL_EXIT_SLIPPAGE_PIPS * PIP_VALUE).toFixed(1));
            }
            shouldRecord = true;
          }
        } else {
          if (currentPrice <= signal.tp3) {
            console.log(`   🎯 CATCH-UP (Fallback): All targets hit @ ${currentPrice.toFixed(1)} (TP3: ${signal.tp3.toFixed(1)})`);
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            shouldRecord = true;
            outcomeResult = 'WIN';
            exitPrice = signal.tp3;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
            fallbackBreachTrackerRef.current.delete(`${signal.id}:TP2_RUNNER_RETRACE`);
          } else if (currentPrice <= signal.tp2 && targetsHit < 2) {
            console.log(`   🎯 CATCH-UP (Fallback): TP2 hit @ ${currentPrice.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            newStatus = "TP2_HIT";
            targetsHit = 2;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
          } else if (currentPrice <= signal.tp1 && targetsHit < 1) {
            console.log(`   🎯 CATCH-UP (Fallback): TP1 hit @ ${currentPrice.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            newStatus = "TP1_HIT";
            targetsHit = 1;
            fallbackBreachTrackerRef.current.delete(`${signal.id}:SL`);
          } else if (targetsHit >= 2 && currentPrice >= signal.entryPrice && confirmFallbackBreach('TP2_RUNNER_RETRACE', (currentPrice - signal.entryPrice))) {
            console.log(`   ✅ CATCH-UP (Fallback): TP2 runner returned to entry @ ${currentPrice.toFixed(1)} - closing as protected partial win`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            outcomeResult = 'WIN';
            exitPrice = getProtectedExitPrice(signal, targetsHit);
            shouldRecord = true;
          } else if (currentPrice >= signal.sl + SL_CONFIRMATION_MIN_PENETRATION_PIPS && confirmFallbackBreach('SL', (currentPrice - signal.sl))) {
            console.log(`   🚨 CATCH-UP (Fallback): Original SL hit @ ${currentPrice.toFixed(1)} (SL: ${signal.sl.toFixed(1)}) - penetration ${(currentPrice - signal.sl).toFixed(2)} confirmed across separate catch-up passes`);
            if (targetsHit >= 2) {
              newStatus = "PARTIAL_WIN_SL_HIT";
              targetsHit = Math.max(targetsHit, 2);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ✅ Managed runner was already breakeven-protected after TP2 - recording partial win @ ${exitPrice.toFixed(1)}`);
            } else if (signal.breakevenReached || targetsHit >= 1) {
              newStatus = "SL_AFTER_BE";
              targetsHit = Math.max(targetsHit, 1);
              outcomeResult = 'WIN';
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              console.log(`   ⚖️ SL AFTER BREAKEVEN - no capital loss (TP1 banked) @ ${exitPrice.toFixed(1)}`);
            } else {
              newStatus = "SL_HIT";
              outcomeResult = 'LOSS';
              // Part A fix #2: reflect the actual confirmed read (with a small,
              // realistic exit-fill slippage), never echo signal.sl exactly.
              exitPrice = parseFloat((currentPrice + FALLBACK_SL_EXIT_SLIPPAGE_PIPS * PIP_VALUE).toFixed(1));
            }
            shouldRecord = true;
          }
        }
        
        if (newStatus !== signal.status || targetsHit !== signal.targetsHit) {
          hasChanges = true;
          const exitDate = new Date();
          
          updatedHistory[i] = {
            ...signal,
            status: newStatus,
            targetsHit,
            exitTime: (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT")
              ? exitPrice
              : signal.exitPrice,
          };
          
          if (shouldRecord) {
            console.log(`   📊 [Path 3] Recording ${outcomeResult} outcome for learning engine (resolvedAt epoch ms=${exitDate.getTime()})...`);
            await signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              exitPrice,
              outcomeResult,
              signal.learningContext,
              undefined,
              signalAge
            ).catch(err => {
              console.error(`Failed to record catch-up outcome:`, err);
            });
          }
        } else {
          console.log(`   ✅ Signal still valid - no changes needed`);
        }
      } else {
        resolutionPathFireCountsRef.current.path2BarsResolved += 1;
        const barResolution = resolveSignalWithBars(signal, historicalBars, { logPrefix: `   [Resolver ${signal.id.slice(-6)}]` });
        const legacy = await analyzeSignalWithHistoricalData(signal, historicalBars);
        // Bar-based resolver is the AUTHORITATIVE source of truth because it
        // walks 1-minute bars tick-by-tick (by wick) from the signal creation
        // time forward and respects SL-before-TP ordering. The legacy path is
        // retained only for diagnostic logging. If the bar resolver and legacy
        // disagree on the final status we ALWAYS trust the bar resolver —
        // including the case where legacy reports a TP hit but bars show the
        // SL was actually hit first (false TP win) or vice versa.
        const legacyDiffers = legacy.newStatus !== barResolution.newStatus
          || legacy.targetsHit !== barResolution.targetsHit
          || Math.abs((legacy.exitPrice ?? 0) - (barResolution.exitPrice ?? 0)) > 0.05;
        const analysis = {
          newStatus: barResolution.newStatus,
          targetsHit: barResolution.targetsHit,
          exitPrice: barResolution.exitPrice,
          outcomeResult: barResolution.outcomeResult,
          breakevenReached: barResolution.breakevenReached,
          breakevenTime: barResolution.breakevenTime,
        };
        if (legacyDiffers) {
          console.log(`   🔧 Bar resolver overrode legacy: legacy=${legacy.newStatus}(tgt ${legacy.targetsHit}) -> bars=${barResolution.newStatus}(tgt ${barResolution.targetsHit})`);
        }
        if (analysis.newStatus !== signal.status) {
          console.log(`   📝 Signal ${signal.id.slice(-6)} status change: ${signal.status} -> ${analysis.newStatus} (bar-resolved, tick-by-wick on 1m)`);
        }
        
        if (analysis.newStatus !== signal.status || analysis.targetsHit !== signal.targetsHit || analysis.breakevenReached !== signal.breakevenReached) {
          hasChanges = true;
          // Part A fix #5: use the bar's REAL resolution timestamp
          // (resolvedAtBarTs) when the bar resolver produced one, instead of
          // new Date() at whatever moment this reconciliation happens to run -
          // the old code silently displayed a wall-clock time that could be
          // minutes/hours after the price actually crossed the level.
          const exitDate = barResolution.resolvedAtBarTs != null ? new Date(barResolution.resolvedAtBarTs) : new Date();
          
          updatedHistory[i] = {
            ...signal,
            status: analysis.newStatus,
            targetsHit: analysis.targetsHit,
            breakevenReached: analysis.breakevenReached,
            breakevenTime: analysis.breakevenTime,
            exitTime: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "SL_AFTER_BE" || analysis.newStatus === "ALL_TARGETS_HIT" || analysis.newStatus === "PARTIAL_WIN_SL_HIT") 
              ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
              : signal.exitTime,
            exitPrice: (analysis.newStatus === "SL_HIT" || analysis.newStatus === "SL_AFTER_BE" || analysis.newStatus === "ALL_TARGETS_HIT" || analysis.newStatus === "PARTIAL_WIN_SL_HIT")
              ? analysis.exitPrice
              : signal.exitPrice,
          };
          
          if (analysis.outcomeResult) {
            console.log(`   📊 Recording ${analysis.outcomeResult} outcome for learning engine...`);
            await signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              analysis.exitPrice,
              analysis.outcomeResult,
              signal.learningContext,
              undefined,
              signalAge
            ).catch(err => {
              console.error(`Failed to record catch-up outcome:`, err);
            });
          }
        } else {
          console.log(`   ✅ Signal still valid - no changes needed`);
        }
      }
    }
    
    console.log('\n' + '='.repeat(80));
    if (hasChanges) {
      console.log('✅ CATCH-UP COMPLETE: Signal statuses updated');
      console.log(`   Updated signals will be saved to AsyncStorage`);
    } else {
      console.log('✅ CATCH-UP COMPLETE: All signals were up-to-date');
    }
    console.log('='.repeat(80) + '\n');
    
    return updatedHistory;
  }, [analyzeSignalWithHistoricalData, fetchPriceHistory]);

  /**
   * Two-tier authoritative bar source for auditing a signal's window.
   *
   * Tier 1 (primary): locally-stored 1-minute bars. While the app is open these
   *   are built directly from the live TradingView chart price stream, so they
   *   are the closest possible match to what the user actually saw on the chart.
   *   We trust them whenever they (a) already capture a terminal event for the
   *   signal and (b) densely cover the window up to that resolution point.
   * Tier 2 (fallback): a remote matched-instrument feed (TwelveData / Tiingo),
   *   used only to fill the windows the chart-derived bars do not cover. When
   *   both exist, the chart-derived bar wins on every conflicting minute.
   */
  const getAuditBars = useCallback(async (
    signal: TradingSignal,
    fromTime: number,
    toTime: number,
  ): Promise<{ bars: OhlcBar[]; source: string }> => {
    const localBars = await getBars('1m', fromTime, toTime);

    // ITEM 4: local 1m retention is now 7 days (barStore RETENTION_MS['1m']).
    // Any portion of [fromTime, toTime] older than that boundary structurally
    // CANNOT have local bars regardless of coverage - flag it distinctly so a
    // wide (Item 4 safety-net) audit window makes it obvious when a correction
    // is based on data that could never be cross-checked against local bars.
    const LOCAL_1M_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
    const localRetentionBoundary = Date.now() - LOCAL_1M_RETENTION_MS;
    const requestPreDatesLocalRetention = fromTime < localRetentionBoundary;

    // Probe: does the chart-derived local history already capture a terminal
    // event (SL / TP / protected exit) for this signal? We replay from scratch
    // purely to locate the resolution point — the real resolution still runs
    // later with the caller's chosen mode.
    const probe = resolveSignalWithBars(signal, localBars, {
      fromScratch: true,
      evalNowMs: Date.now(),
      logPrefix: `   [Audit-probe ${signal.id.slice(-6)}]`,
    });
    const resolutionTs = probe.resolvedAtBarTs;
    const localResolvesTerminal = resolutionTs != null;
    const coverage = assessBarCoverage(localBars, fromTime, resolutionTs ?? toTime);

    if (localResolvesTerminal && coverage.dense) {
      console.log(`   📈 [Audit ${signal.id.slice(-6)}] Using TradingView chart-derived bars (authoritative): ${localBars.length} local bars, ${coverage.reason}`);
      return { bars: localBars, source: '🟢 chart-derived (local)' };
    }

    console.log(`   🌐 [Audit ${signal.id.slice(-6)}] Chart-derived bars insufficient (terminal=${localResolvesTerminal}, ${coverage.reason}) — pulling remote feed to fill gaps`);
    let remoteBars: OhlcBar[] = [];
    try {
      remoteBars = await fetchHistoricalData({ fromTime, toTime, timeoutMs: 15000 });
    } catch (err) {
      console.warn(`   ⚠️ [Audit ${signal.id.slice(-6)}] remote fetch failed:`, err instanceof Error ? err.message : 'Unknown');
    }

    if (remoteBars.length === 0) {
      if (localBars.length > 0) {
        console.log(`   ↩️ [Audit ${signal.id.slice(-6)}] remote empty — using ${localBars.length} chart-derived bars anyway`);
        return { bars: localBars, source: '🟢 chart-derived (local, remote empty)' };
      }
      return { bars: [], source: 'none' };
    }

    // Persist remote bars so future audits/catch-ups can reuse them.
    void upsertBars('1m', remoteBars).catch(err => {
      console.warn(`   ⚠️ [Audit ${signal.id.slice(-6)}] failed to persist remote bars:`, err instanceof Error ? err.message : 'Unknown');
    });

    const merged = mergeBarsPreferLocal(localBars, remoteBars);
    // ITEM 4: when the window (or part of it) predates local retention entirely,
    // tag this distinctly as remote-only-beyond-retention rather than the normal
    // merged/remote-feed tags, so it's visible this correction could NOT be
    // cross-checked against any local chart-derived bar for that stretch.
    const source = localBars.length === 0 && requestPreDatesLocalRetention
      ? '🟣 remote-only (beyond 7d local retention boundary)'
      : localBars.length > 0 ? '🟡 merged (chart-derived + remote gap-fill)' : '🟠 remote feed';
    console.log(`   🔀 [Audit ${signal.id.slice(-6)}] ${source}: ${localBars.length} local + ${remoteBars.length} remote → ${merged.length} bars`);
    // ITEM 5: diagnostic logging - explicit source tag for every getAuditBars call.
    console.log(`   🧾 [Audit-diagnostic ${signal.id.slice(-6)}] sourceTag="${source}" window=[${new Date(fromTime).toISOString()}, ${new Date(toTime).toISOString()}] preDatesLocalRetention=${requestPreDatesLocalRetention}`);
    return { bars: merged, source };
  }, []);

  const auditTerminalSLSignals = useCallback(async (history: TradingSignal[], opts: { force?: boolean; windowMs?: number } = {}): Promise<TradingSignal[]> => {
    console.log('\n' + '='.repeat(80));
    console.log('🔬 FULL OUTCOME AUDIT: re-evaluating every terminal signal against 1-min bars (catches false SL AND false TP)');
    console.log('='.repeat(80));

    // v5 expands the audit in two critical ways beyond v4:
    //   1. NEVER apply a permanent one-shot audit lock to signals that may
    //      still benefit from additional 1m bars (i.e. signals < 24h old,
    //      which is our sqlite ring-buffer retention). This means if a false
    //      TP3 was recorded because the live tick monitor missed the SL-side
    //      wick, every subsequent audit pass will keep rechecking until the
    //      bar-based resolver converges. v4's lock caused wrong-direction
    //      outcomes (BUY recorded as TP3 but actually SL, SELL recorded as
    //      SL but actually TP) to be frozen after the first unsuccessful audit.
    //   2. DO NOT mark a signal audited when no bars were available — that
    //      silently locked in whatever the live monitor committed.
    const SL_AUDIT_VERSION = 'v5-rolling-full-outcome-audit';
    const force = opts.force === true;
    if (force) {
      console.log('🧨 MANUAL AUDIT: force=true - clearing audit locks and re-evaluating every terminal signal from scratch');
    }
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    // ITEM 4 (secondary safety net): callers may pass an explicit windowMs to
    // look further past signal creation than the default 2h - e.g. a manual
    // re-investigation of a signal suspected to have resolved later than the
    // live monitor/first audit pass ever looked. Default is UNCHANGED (2h) so
    // normal/periodic/daily-sweep audit calls behave exactly as before (this is
    // required for the byte-identical before/after simulation in this pass's
    // scope boundary) - only an explicit override widens it.
    const resolutionWindowMs = typeof opts.windowMs === 'number' && opts.windowMs > 0 ? opts.windowMs : twoHoursInMs;
    // Bars retention is now 7 days (barStore RETENTION_MS['1m'], Item 2) - the
    // audit-lock skip below is keyed off that, not the old 24h assumption.
    const localBarRetentionMs = 7 * 24 * 60 * 60 * 1000;
    let corrected = 0;
    const updated: TradingSignal[] = [];

    for (const signal of history) {
      const isTerminal = TERMINAL_SIGNAL_STATUSES.includes(signal.status);
      const signalAgeMs = now - new Date(signal.timestamp).getTime();
      const alreadyAudited = (signal as TradingSignal & { slAuditVersion?: string }).slAuditVersion === SL_AUDIT_VERSION;
      // If the signal is older than local bar retention AND already audited, we
      // cannot do better than the prior pass using local bars - safe to skip to
      // save CPU. force=true (manual audit) bypasses both the audit lock and
      // this skip.
      const tooOldForBars = signalAgeMs > localBarRetentionMs;
      if (!isTerminal || (!force && alreadyAudited && tooOldForBars)) {
        updated.push(signal);
        continue;
      }

      const signalTs = new Date(signal.timestamp).getTime();
      const fromTime = signalTs;
      const toTime = Math.min(now, signalTs + resolutionWindowMs);

      console.log(`\n🔍 Auditing ${signal.id.slice(-6)} (${signal.type}, status=${signal.status}) entry=${signal.entryPrice.toFixed(1)} SL=${signal.sl.toFixed(1)} TP1=${signal.tp1.toFixed(1)} TP3=${signal.tp3.toFixed(1)}${alreadyAudited ? ' [RE-AUDIT]' : ''}`);

      // Two-tier authoritative source: TradingView chart-derived local bars are
      // primary (they match what the user saw on the chart); a remote feed only
      // fills windows the chart-derived bars don't cover. This keeps the audit in
      // agreement with the chart instead of a divergent third-party feed.
      const { bars, source: barSource } = await getAuditBars(signal, fromTime, toTime);
      console.log(`   🧭 [Audit ${signal.id.slice(-6)}] bar source: ${barSource} (${bars.length} bars)`);
      if (bars.length === 0) {
        // IMPORTANT: do NOT mark audited - we want to retry once bars arrive.
        console.log(`   ⚠️ No 1-min bars returned - leaving signal unchanged, will retry next audit pass`);
        updated.push(signal);
        continue;
      }

      const barOutcome = resolveSignalWithBars(signal, bars, {
        logPrefix: `   [Audit ${signal.id.slice(-6)}]`,
        // The manual/force audit fetches authoritative remote bars and may need
        // to UNDO a falsely-recorded terminal (e.g. an ALL_TARGETS_HIT banked
        // off a phantom spike when price never reached TP1). Forward-seeded
        // resolution can only ratchet forward, so we re-derive from scratch
        // when force-auditing.
        fromScratch: force,
        evalNowMs: now,
      });
      // Bar resolver is authoritative for the audit too. Legacy evaluation is
      // kept only for diagnostic comparison.
      const legacyOutcome = await analyzeSignalWithHistoricalData(signal, bars);
      const analysis = {
        newStatus: barOutcome.newStatus,
        targetsHit: barOutcome.targetsHit,
        exitPrice: barOutcome.exitPrice,
        outcomeResult: barOutcome.outcomeResult,
        breakevenReached: barOutcome.breakevenReached,
        breakevenTime: barOutcome.breakevenTime,
      };
      if (legacyOutcome.newStatus !== barOutcome.newStatus) {
        console.log(`   🔍 Legacy vs bars disagreement during audit: legacy=${legacyOutcome.newStatus} bars=${barOutcome.newStatus} — trusting bars`);
      }

      const winStatuses: SignalStatus[] = ['ALL_TARGETS_HIT', 'TP3_HIT', 'TP2_HIT', 'TP1_HIT', 'PARTIAL_WIN_SL_HIT', 'SL_AFTER_BE'];
      const originalOutcomeWasLoss = signal.status === 'SL_HIT';
      const originalOutcomeWasWin = winStatuses.includes(signal.status);
      const newOutcomeIsWin = winStatuses.includes(analysis.newStatus);
      const newOutcomeIsLoss = analysis.newStatus === 'SL_HIT';
      const statusChanged = analysis.newStatus !== signal.status;
      const targetsChanged = analysis.targetsHit !== signal.targetsHit;

      if (statusChanged || targetsChanged) {
        corrected++;
        // Part A fix #5: prefer the bar's REAL resolution timestamp
        // (resolvedAtBarTs) over new Date() at whatever moment the audit
        // happens to run, for the same reason as the catch-up path above.
        const exitDate = barOutcome.resolvedAtBarTs != null ? new Date(barOutcome.resolvedAtBarTs) : new Date();
        const patched: TradingSignal = {
          ...signal,
          status: analysis.newStatus,
          targetsHit: analysis.targetsHit,
          breakevenReached: analysis.breakevenReached ?? signal.breakevenReached,
          breakevenTime: analysis.breakevenTime ?? signal.breakevenTime,
          exitPrice: analysis.exitPrice,
          exitTime: statusChanged ? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : (signal.exitTime ?? exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })),
        };
        (patched as TradingSignal & { slAuditVersion?: string }).slAuditVersion = SL_AUDIT_VERSION;
        updated.push(patched);

        console.log(`   🔧 CORRECTED: ${signal.status} -> ${analysis.newStatus} (targets ${signal.targetsHit} -> ${analysis.targetsHit})`);
        console.log(`      exitPrice ${signal.exitPrice?.toFixed(1) ?? 'n/a'} -> ${analysis.exitPrice.toFixed(1)}`);

        if (originalOutcomeWasLoss && newOutcomeIsWin) {
          console.log(`   🧠 Submitting corrected WIN outcome to learning engine (was false SL)`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'WIN',
            signal.learningContext,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected WIN outcome:', err));
        } else if (originalOutcomeWasWin && newOutcomeIsLoss) {
          console.log(`   🧠 Submitting corrected LOSS outcome to learning engine (was false TP)`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'LOSS',
            signal.learningContext,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected LOSS outcome:', err));
        } else if (!originalOutcomeWasLoss && newOutcomeIsLoss) {
          console.log(`   🧠 Submitting corrected LOSS outcome to learning engine`);
          await signalEngine.recordTradeOutcome(
            signal.id,
            signal.entryPrice,
            analysis.exitPrice,
            'LOSS',
            signal.learningContext,
            undefined,
            now - signalTs
          ).catch(err => console.error('Failed to record corrected LOSS outcome:', err));
        }
      } else {
        console.log(`   ✅ Audit confirms original status - marking audited`);
        updated.push({ ...signal, slAuditVersion: SL_AUDIT_VERSION } as TradingSignal);
      }
    }

    console.log(`\n✅ FALSE-SL AUDIT COMPLETE: ${corrected} signal(s) corrected`);
    console.log('='.repeat(80) + '\n');
    return updated;
  }, [analyzeSignalWithHistoricalData, getAuditBars]);

  const safeGetModelHealth = useCallback(() => {
    try {
      return signalEngine.getModelHealthMetrics();
    } catch (err) {
      console.error('[TradingContext] signalEngine.getModelHealthMetrics crashed:', err);
      return {
        modelHealthScore: 0,
        featureCorrelationStatus: 'ERROR' as const,
        confidenceDegradation: 0,
        conceptDriftScore: 0,
        featureImportanceDrift: [],
        driftAlertLevel: 'NONE' as const,
        daysSinceRetrain: 0,
        retrainingRecommended: false,
        retrainScheduled: false,
      };
    }
  }, []);

  const calculatePerformanceMetrics = useCallback((history: TradingSignal[]) => {
    if (history.length === 0) {
      const healthMetrics = safeGetModelHealth();
      return {
        ...DEFAULT_METRICS,
        modelHealthScore: healthMetrics.modelHealthScore,
        featureCorrelationStatus: healthMetrics.featureCorrelationStatus,
        confidenceDegradation: healthMetrics.confidenceDegradation,
        conceptDriftScore: healthMetrics.conceptDriftScore,
        featureImportanceDrift: healthMetrics.featureImportanceDrift,
        driftAlertLevel: healthMetrics.driftAlertLevel,
        daysSinceRetrain: healthMetrics.daysSinceRetrain,
        retrainingRecommended: healthMetrics.retrainingRecommended,
      };
    }

    // A single classifier (shared with Telemetry & History) decides win/loss so
    // the same signal can never be counted differently across screens. Only
    // signals where a real position was taken AND reached a profit/loss terminal
    // state count as trades — EXPIRED_MISSED_ENTRY (no entry) and flat closes are
    // excluded. Previously TP3_HIT wins were silently dropped here, desyncing the
    // Dashboard metrics from the History/Telemetry views.
    const closedTrades = history.filter(s => {
      const outcome = classifySignalOutcome(s, settings.basePositionSize);
      return outcome === "WIN" || outcome === "LOSS";
    });

    const totalTrades = closedTrades.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    const profits: number[] = [];
    const losses: number[] = [];

    closedTrades.forEach(signal => {
      const pnl = computeSignalPnL(signal, settings.basePositionSize);
      const outcome = classifySignalOutcome(signal, settings.basePositionSize);

      if (outcome === "WIN") {
        winningTrades++;
        totalProfit += Math.max(0, pnl);
        if (pnl > 0) profits.push(pnl);
      } else {
        losingTrades++;
        totalLoss += Math.abs(pnl);
        losses.push(Math.abs(pnl));
      }
    });

    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
    const averageWin = profits.length > 0 ? totalProfit / profits.length : 0;
    const averageLoss = losses.length > 0 ? totalLoss / losses.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? 999 : 0;

    // Expectancy in R-multiples, not raw dollars: SL distance varies per signal
    // (dynamic/ATR-based SL), so a $-per-trade average conflates a trade that
    // risked $10 with one that risked $50. Risk-normalizing first makes
    // expectancy comparable across signals and over time as SL width shifts.
    const rMultiples = closedTrades.map(signal => computeSignalRMultiple(signal, settings.basePositionSize));
    const expectancy = rMultiples.length > 0
      ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length
      : 0;

    let runningBalance = accountBalance;
    let peak = accountBalance;
    let maxDrawdown = 0;

    const chronologicalTrades = [...closedTrades].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    chronologicalTrades.forEach(signal => {
      const pnl = computeSignalPnL(signal, settings.basePositionSize);

      runningBalance += pnl;
      if (runningBalance > peak) {
        peak = runningBalance;
      }
      const drawdown = ((peak - runningBalance) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    });

    const currentDrawdown = runningBalance < peak ? ((peak - runningBalance) / peak) * 100 : 0;

    // Risk-normalized (R-multiple) per-trade returns — same rationale as
    // expectancy above: dollar P&L isn't comparable across signals with
    // different SL distances, so Sharpe's mean/stdDev must be computed on R,
    // not raw dollars, or a run of wide-SL trades silently dominates the ratio.
    const returns = rMultiples;
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1 
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 0;

    // Intraday-correct annualization: this system can generate many signals per
    // day (not one trade/day like a typical daily-bar equity strategy), so a
    // fixed sqrt(252) daily-annualization massively UNDER-annualizes real risk
    // taken. Derive actual trades/day from the real timestamp span of the
    // closed-trade history instead of assuming a frequency.
    const chronoTimestamps = chronologicalTrades.map(s => new Date(s.timestamp).getTime());
    const spanMs = chronoTimestamps.length > 1
      ? chronoTimestamps[chronoTimestamps.length - 1] - chronoTimestamps[0]
      : 0;
    // Floor the span at 1 day so a burst of trades within a few hours doesn't
    // divide by a near-zero span and produce an absurd trades/day figure.
    const spanDays = Math.max(spanMs / (1000 * 60 * 60 * 24), 1);
    const tradesPerDay = totalTrades > 0 ? totalTrades / spanDays : 0;
    const annualizationFactor = tradesPerDay > 0 ? Math.sqrt(tradesPerDay * 252) : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * annualizationFactor : 0;

    const healthMetrics = safeGetModelHealth();

    return {
      totalTrades,
      winningTrades,
      losingTrades,
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalLoss: parseFloat(totalLoss.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      currentDrawdown: parseFloat(currentDrawdown.toFixed(2)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      winRate: parseFloat(winRate.toFixed(2)),
      averageWin: parseFloat(averageWin.toFixed(2)),
      averageLoss: parseFloat(averageLoss.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      modelHealthScore: healthMetrics.modelHealthScore,
      featureCorrelationStatus: healthMetrics.featureCorrelationStatus,
      confidenceDegradation: healthMetrics.confidenceDegradation,
      conceptDriftScore: healthMetrics.conceptDriftScore,
      featureImportanceDrift: healthMetrics.featureImportanceDrift,
      driftAlertLevel: healthMetrics.driftAlertLevel,
      daysSinceRetrain: healthMetrics.daysSinceRetrain,
      retrainingRecommended: healthMetrics.retrainingRecommended,
    };
  }, [accountBalance, settings.basePositionSize, safeGetModelHealth]);

  const runManualAudit = useCallback(async (): Promise<{ corrected: number; total: number }> => {
    console.log('🛠️ MANUAL AUDIT triggered from UI');
    const current = signalHistoryRef.current;
    const terminalCount = current.filter(s => TERMINAL_SIGNAL_STATUSES.includes(s.status)).length;
    // Strip any prior audit locks so every terminal signal is re-evaluated against fresh bars.
    const stripped = current.map(s => {
      const copy: TradingSignal & { slAuditVersion?: string } = { ...s };
      delete copy.slAuditVersion;
      return copy as TradingSignal;
    });
    const reconciled = await catchUpAndEvaluateSignals(stripped);
    const audited = await auditTerminalSLSignals(reconciled, { force: true });
    let corrected = 0;
    for (let i = 0; i < current.length; i++) {
      const before = current[i];
      const after = audited.find(a => a.id === before.id);
      if (!after) continue;
      if (after.status !== before.status || after.targetsHit !== before.targetsHit) {
        corrected++;
      }
    }
    signalHistoryRef.current = audited;
    setSignalHistory(sanitizeHistoryForRender(audited));
    persistSignalHistory(audited, { immediate: true });
    setSignalUpdateTrigger(prev => prev + 1);
    const metrics = calculatePerformanceMetrics(audited);
    setPerformanceMetrics(metrics);
    await AsyncStorage.setItem('performance_metrics', JSON.stringify(metrics));
    console.log(`🛠️ MANUAL AUDIT complete: ${corrected} of ${terminalCount} terminal signals corrected`);
    return { corrected, total: terminalCount };
  }, [auditTerminalSLSignals, catchUpAndEvaluateSignals, calculatePerformanceMetrics]);

  const loadPersistedData = async () => {
    try {
      console.log('🔄 Loading persisted data from AsyncStorage...');
      const [savedSettings, savedHistory, loginStatus, savedMetrics, savedBalance] = await Promise.all([
        AsyncStorage.getItem("trading_settings"),
        AsyncStorage.getItem("signal_history"),
        AsyncStorage.getItem("is_logged_in"),
        AsyncStorage.getItem("performance_metrics"),
        AsyncStorage.getItem("account_balance"),
      ]);

      console.log('📦 Raw saved history from storage:', savedHistory);

      if (savedSettings) {
        const rawParsedSettings = JSON.parse(savedSettings) as Settings;
        const parsedSettings = sanitizeSettings(rawParsedSettings);
        setSettings(parsedSettings);
        console.log('✅ Settings loaded:', parsedSettings);

        if (parsedSettings.minConfidence !== rawParsedSettings.minConfidence) {
          await AsyncStorage.setItem("trading_settings", JSON.stringify(parsedSettings));
          console.log(`🔒 Raised persisted minimum confidence to enforced floor ${(ENFORCED_MIN_SIGNAL_CONFIDENCE * 100).toFixed(0)}%`);
        }
      } else {
        console.log('⚠️ No saved settings found - using defaults');
        setSettings(DEFAULT_SETTINGS);
      }

      if (savedHistory) {
        const rawHistory = JSON.parse(savedHistory);
        const parsedHistory = (Array.isArray(rawHistory) ? rawHistory : [])
          .filter((s: unknown) => s && typeof s === 'object' && 'id' in (s as Record<string, unknown>))
          .map((s: Record<string, unknown>) => ({
            ...s,
            timestamp: s.timestamp ? new Date(s.timestamp as string | number) : new Date(),
            // Defensive: ensure critical price fields are numbers to avoid .toFixed() crashes during render.
            entryPrice: typeof s.entryPrice === 'number' ? s.entryPrice : 0,
            entryPriceWithSlippage: typeof s.entryPriceWithSlippage === 'number' ? s.entryPriceWithSlippage : (typeof s.entryPrice === 'number' ? s.entryPrice : 0),
            tp1: typeof s.tp1 === 'number' ? s.tp1 : 0,
            tp2: typeof s.tp2 === 'number' ? s.tp2 : 0,
            tp3: typeof s.tp3 === 'number' ? s.tp3 : 0,
            sl: typeof s.sl === 'number' ? s.sl : 0,
            confidence: typeof s.confidence === 'number' ? s.confidence : 0,
            targetsHit: typeof s.targetsHit === 'number' ? s.targetsHit : 0,
            type: s.type === 'BUY' || s.type === 'SELL' ? s.type : 'BUY',
            status: typeof s.status === 'string' ? s.status : 'CLOSED',
            id: typeof s.id === 'string' ? s.id : `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            entryTime: typeof s.entryTime === 'string' ? s.entryTime : '',
          } as TradingSignal));
        
        // Show raw persisted data immediately — UI renders now.
        // Catch-up evaluation and false-SL audit run in background to avoid
        // blocking the loading screen for 10-30s on every cold start.
        signalHistoryRef.current = parsedHistory;
        setSignalHistory(sanitizeHistoryForRender(parsedHistory));
        console.log(`✅ History loaded: ${parsedHistory.length} signals (raw — background audit pending)`);

        // Fire background audit (non-blocking — don't await).
        void (async () => {
          try {
            console.log('🔍 [Boot Audit] Starting background catch-up + false-SL audit...');
            const evaluatedHistory = await catchUpAndEvaluateSignals(parsedHistory);
            const auditedHistory = await auditTerminalSLSignals(evaluatedHistory);
            signalHistoryRef.current = auditedHistory;
            setSignalHistory(sanitizeHistoryForRender(auditedHistory));
            if (JSON.stringify(auditedHistory) !== JSON.stringify(parsedHistory)) {
              persistSignalHistory(auditedHistory, { immediate: true });
              console.log('💾 [Boot Audit] Updated signal history saved after catch-up + false-SL audit');
            }
            const metrics = calculatePerformanceMetrics(auditedHistory);
            setPerformanceMetrics(metrics);
            void AsyncStorage.setItem('performance_metrics', JSON.stringify(metrics));
            console.log(`✅ [Boot Audit] Complete: ${auditedHistory.length} signals (${parsedHistory.filter(s => TERMINAL_SIGNAL_STATUSES.includes(s.status)).length} terminal)`);
          } catch (err) {
            console.warn('⚠️ [Boot Audit] Background audit failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
          }
        })();
      } else {
        console.log('⚠️ No saved history found in AsyncStorage');
        setSignalHistory([]);
      }

      if (loginStatus) {
        const parsedLoginStatus = JSON.parse(loginStatus);
        setIsLoggedIn(parsedLoginStatus);
        console.log('✅ Login status loaded:', parsedLoginStatus);
      } else {
        console.log('⚠️ No login status found - defaulting to logged in');
        setIsLoggedIn(true);
      }

      if (savedMetrics) {
        const parsedMetrics = JSON.parse(savedMetrics);
        setPerformanceMetrics(parsedMetrics);
        console.log('✅ Metrics loaded');
      } else {
        console.log('⚠️ No saved metrics found - using defaults');
        setPerformanceMetrics(DEFAULT_METRICS);
      }

      if (savedBalance) {
        const parsedBalance = JSON.parse(savedBalance);
        setAccountBalance(parsedBalance);
        console.log('✅ Balance loaded:', parsedBalance);
      } else {
        console.log('⚠️ No saved balance found - using default: 100');
        setAccountBalance(100);
      }

      console.log('✅ All persisted data loaded successfully');
    } catch (error) {
      console.error("❌ Failed to load persisted data:", error);
      setSignalHistory([]);
      setSettings(DEFAULT_SETTINGS);
      setPerformanceMetrics(DEFAULT_METRICS);
      setAccountBalance(100);
      setIsLoggedIn(true);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 100));
      setIsLoading(false);
      console.log('✅ Loading complete - UI will render now');
      console.log(`🛡️ Launch cooldown active: Signal generation will wait 5 seconds to prevent race conditions`);
    }
  };

  const updateMarketOutlook = async () => {
    const outlook = await signalEngine.getMarketOutlook();

    setMarketOutlook((previousValue) => {
      if (areMarketOutlooksEqual(previousValue, outlook)) {
        return previousValue;
      }

      console.log('📊 Market outlook changed — updating dashboard state');
      return outlook;
    });
  };

  useEffect(() => {
    try {
      const metrics = calculatePerformanceMetrics(signalHistory);
      setPerformanceMetrics(metrics);
      void AsyncStorage.setItem("performance_metrics", JSON.stringify(metrics)).catch((err) => {
        console.error('[TradingContext] Failed to persist performance metrics:', err);
      });
    } catch (err) {
      console.error('[TradingContext] calculatePerformanceMetrics crashed in effect:', err);
      // Don't let a metrics calculation crash take down the app
    }
  }, [signalHistory, calculatePerformanceMetrics]);

  const closeSignal = useCallback((signalId: string) => {
    const now = new Date();
    const livePrice = signalEngine.getCurrentPrice();

    setSignalHistory((prev) => {
      const updated = prev.map(signal => {
        if (signal.id === signalId) {
          const resolvedExitPrice = signal.exitPrice ?? (livePrice > 0 ? livePrice : signal.entryPrice);
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            exitPrice: resolvedExitPrice,
          };
        }
        return signal;
      });
      persistSignalHistory(updated, { immediate: true });
      return updated;
    });
  }, [persistSignalHistory]);



  const syncSignalPriceFromEngine = useCallback((nextPrice?: number) => {
    const enginePrice = nextPrice ?? signalEngine.getCurrentPrice();
    const engineSource = signalEngine.getPriceSource();

    if (enginePrice > 0) {
      setCurrentPrice(enginePrice);
      setCurrentPriceUpdatedAt(Date.now());
      setPriceSource(engineSource);
      setLivePriceError(null);
    }
  }, []);

  const signalTrackingSnapshot = useMemo<SignalTrackingSnapshot>(() => {
    const now = Date.now();
    const chartAgeMs = chartPriceUpdatedAt > 0 ? now - chartPriceUpdatedAt : Number.POSITIVE_INFINITY;
    const chartMovementAgeMs = chartPriceLastMeaningfulMoveRef.current > 0
      ? now - chartPriceLastMeaningfulMoveRef.current
      : Number.POSITIVE_INFINITY;
    const guideAgeMs = guidePriceUpdatedAt > 0 ? now - guidePriceUpdatedAt : Number.POSITIVE_INFINITY;
    const hasFreshChartPrice = chartPrice > 0 && chartAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;
    const hasFreshGuidePrice = guidePrice > 0 && guideAgeMs < CHART_PRICE_PRIORITY_WINDOW_MS;
    const chartFeedLooksStalled = hasFreshChartPrice && chartMovementAgeMs >= CHART_STALL_FAILOVER_MS;

    if (hasFreshChartPrice && !chartFeedLooksStalled) {
      return {
        price: chartPrice,
        source: chartPriceSource || '🟢 tradingview-chart',
        updatedAt: chartPriceUpdatedAt,
      };
    }

    if (chartFeedLooksStalled && hasFreshGuidePrice) {
      return {
        price: guidePrice,
        source: `${guidePriceSource || '🟢 Tiingo-Live'} • chart-failover`,
        updatedAt: guidePriceUpdatedAt,
      };
    }

    if (hasFreshGuidePrice) {
      return {
        price: guidePrice,
        source: guidePriceSource || '🟢 Tiingo-Live',
        updatedAt: guidePriceUpdatedAt,
      };
    }

    const enginePrice = signalEngine.getCurrentPrice();
    const engineSource = signalEngine.getPriceSource();

    if (enginePrice > 0) {
      return {
        price: enginePrice,
        source: engineSource || '🟡 engine-cache',
        updatedAt: currentPriceUpdatedAt,
      };
    }

    return {
      price: 0,
      source: '🔴 no live price',
      updatedAt: 0,
    };
  }, [chartPrice, chartPriceSource, chartPriceUpdatedAt, currentPriceUpdatedAt, guidePrice, guidePriceSource, guidePriceUpdatedAt]);

  useEffect(() => {
    signalHistoryRef.current = signalHistory;
  }, [signalHistory]);

  useEffect(() => {
    signalTrackingSnapshotRef.current = signalTrackingSnapshot;
    historicalFallbackPriceRef.current = signalTrackingSnapshot.price;
  }, [signalTrackingSnapshot]);

  const checkAndGenerateSignal = useCallback(async () => {
    const timeSinceLaunch = Date.now() - appLaunchTime;
    const LAUNCH_COOLDOWN_MS = 5000;
    const currentSignalTrackingSnapshot = signalTrackingSnapshotRef.current;
    const currentSignalHistory = signalHistoryRef.current;
    
    if (timeSinceLaunch < LAUNCH_COOLDOWN_MS) {
      const remainingCooldown = ((LAUNCH_COOLDOWN_MS - timeSinceLaunch) / 1000).toFixed(1);
      console.log(`🛡️ LAUNCH COOLDOWN: Preventing signal generation for ${remainingCooldown}s after app start`);
      console.log(`   This prevents duplicate signals during initialization`);
      return;
    }

    if (currentSignalTrackingSnapshot.price > 0) {
      if (currentSignalTrackingSnapshot.source.includes('chart-failover')) {
        console.warn(`⚠️ Signal generation running on chart failover price ${currentSignalTrackingSnapshot.price.toFixed(2)} from ${currentSignalTrackingSnapshot.source}`);
      }

      setExternalPrice(currentSignalTrackingSnapshot.price, currentSignalTrackingSnapshot.source);
      syncSignalPriceFromEngine(currentSignalTrackingSnapshot.price);
    } else {
      console.warn('⚠️ [SignalGen] No tracking price available — force-fetching via REST...');
      try {
        const fallback = await fetchLiveGoldPriceFallback();
        if (fallback.price > 0) {
          console.log(`✅ [SignalGen] Force-fetched price: ${fallback.price.toFixed(2)} from ${fallback.source}`);
          setExternalPrice(fallback.price, fallback.source);
          syncSignalPriceFromEngine(fallback.price);
          commitGuidePrice(fallback.price, `🟢 ${fallback.source.replace(/🟢 |🟠 |🟡 |🔴 /g, '')} (signal-force)`);
        } else {
          const refreshedEnginePrice = await signalEngine.updateCurrentPrice();
          syncSignalPriceFromEngine(refreshedEnginePrice);
        }
      } catch (err) {
        console.warn('⚠️ [SignalGen] Force-fetch failed:', err instanceof Error ? err.message : 'Unknown');
        const refreshedEnginePrice = await signalEngine.updateCurrentPrice();
        syncSignalPriceFromEngine(refreshedEnginePrice);
      }
    }
    
    const outlook = await signalEngine.getMarketOutlook();
    const now = new Date();
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 SIGNAL CHECK [${now.toLocaleTimeString()}]`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Market Open: ${outlook.isMarketOpen}`);
    console.log(`Current Session: ${outlook.currentSession}`);
    
    const fullyActiveSignals = currentSignalHistory.filter((signal) => (
      signal.status === "ACTIVE" && signal.confidence >= ENFORCED_MIN_SIGNAL_CONFIDENCE
    ));
    
    console.log(`Active Signals: ${fullyActiveSignals.length}`);
    fullyActiveSignals.forEach(s => {
      const signalAge = (Date.now() - new Date(s.timestamp).getTime()) / 1000 / 60;
      console.log(`  - ${s.type} @ ${s.entryPrice} (Age: ${signalAge.toFixed(1)}m, Targets: ${s.targetsHit}/3)`);
    });
    
    console.log(`Min Confidence: ${(settings.minConfidence * 100).toFixed(0)}%`);
    console.log(`Account Balance: ${accountBalance}`);
    console.log(`Settings - TP1: ${settings.tp1Pips}, TP2: ${settings.tp2Pips}, TP3: ${settings.tp3Pips}, SL: ${settings.slPips}`);
    console.log(`${'='.repeat(60)}\n`);
    
    if (!outlook.isMarketOpen) {
      console.log("❌ BLOCKED: Market is closed. No signal generation.");
      return;
    }

    if (fullyActiveSignals.length > 0) {
      const activeSignal = fullyActiveSignals[0];
      const signalAgeMs = Date.now() - new Date(activeSignal.timestamp).getTime();
      const activeSignalLockReleaseMs = ACTIVE_SIGNAL_LOCK_RELEASE_MS;
      
      // Explicit release check: the lock is meant to apply ONLY to genuinely
      // ACTIVE signals. updateAllSignalsStatus() runs every 5s and moves a
      // signal's status away from "ACTIVE" the instant it resolves (SL_HIT,
      // SL_AFTER_BE, TP*_HIT, ALL_TARGETS_HIT, PARTIAL_WIN_SL_HIT are all
      // non-"ACTIVE"), so checking status directly here - rather than relying
      // on the implicit side effect of the upstream fullyActiveSignals filter -
      // makes the real release condition self-documenting and refactor-safe.
      const statusReleased = activeSignal.status !== "ACTIVE";
      const targetsReleased = activeSignal.targetsHit >= 2;
      const failsafeReleased = signalAgeMs > activeSignalLockReleaseMs;
      
      const canGenerateNewSignal = statusReleased || targetsReleased || failsafeReleased;
      
      if (!canGenerateNewSignal) {
        console.log("❌ BLOCKED: Active signal exists and lock not released.");
        console.log(`   Active Signal: ${activeSignal.type} @ ${activeSignal.entryPrice}`);
        console.log(`   Status: ${activeSignal.status} | Targets Hit: ${activeSignal.targetsHit}/3`);
        console.log(`   Age: ${(signalAgeMs / 1000 / 60).toFixed(1)} minutes`);
        console.log(`   💡 New signal allowed when: status leaves ACTIVE (SL hit, SL-after-BE, any TP hit, or resolved), targetsHit >= 2, or the ${(ACTIVE_SIGNAL_LOCK_RELEASE_MS / 1000 / 60).toFixed(0)}-minute failsafe elapses`);
        return;
      }
      
      console.log(`✅ Lock released - New signal generation allowed:`);
      if (statusReleased) {
        console.log(`   - Status resolved to ${activeSignal.status} (no longer ACTIVE) - Lock released`);
      }
      if (targetsReleased) {
        console.log(`   - TP2+ hit (${activeSignal.targetsHit}/3 targets) - Lock released`);
      }
      if (failsafeReleased) {
        console.log(`   - ⚠️ Failsafe triggered: signal age exceeds ${(ACTIVE_SIGNAL_LOCK_RELEASE_MS / 1000 / 60).toFixed(0)} minutes (${(signalAgeMs / 1000 / 60).toFixed(1)}m) without a detected status transition - check status-sync health`);
      }
    }

    try {
      console.log(`🎯 ATTEMPTING SIGNAL GENERATION...`);
      console.log(`   Settings: minConfidence=${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   Account Balance: ${accountBalance}`);
      
      const signal = await signalEngine.generateSignal(settings, accountBalance, currentSignalHistory);
      syncSignalPriceFromEngine();
      
      if (signal) {
        // Telegram alert — fired FIRST, before any processing.
        // The fetch is truly fire-and-forget (no await), so the message
        // dispatches to Telegram in <100ms. Gated by the dedicated notifier
        // toggle so it can be muted during testing/updates.
        if (settings.enableTelegramNotifier) {
          sendTelegramAlert(signal, settings.numberOfTPs);
        } else {
          console.log('🔕 Telegram notifier disabled — skipping signal alert');
        }

        setSignalHistory((prev) => {
          console.log("\n" + "=".repeat(60));
          console.log("✅ ✅ ✅ NEW SIGNAL GENERATED ✅ ✅ ✅");
          console.log("=".repeat(60));
          console.log(`Type: ${signal.type}`);
          console.log(`Entry: ${signal.entryPrice}`);
          console.log(`Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
          console.log(`TP1: ${signal.tp1} | TP2: ${signal.tp2} | TP3: ${signal.tp3}`);
          console.log(`SL: ${signal.sl}`);
          console.log(`📊 Signal added to dashboard AND history immediately`);
          console.log("=".repeat(60) + "\n");
          
          const updated = [signal, ...prev];
          persistSignalHistory(updated, { immediate: true });
          console.log(`💾 History save scheduled: ${updated.length} signals queued for AsyncStorage`);
          return sanitizeHistoryForRender(updated);
        });

        if (Platform.OS !== 'web' && settings.enableNotifications) {
          sendSignalNotification(signal).catch(err => {
            console.error('❌ Failed to send notification:', err);
          });
        }

        const sizing = signalEngine.calculatePositionSizing(signal.confidence, settings, accountBalance);
        setPositionSizing(sizing);
        console.log("📊 Position sizing calculated:", sizing);
        console.log(`💰 Fractional Kelly: ${sizing.fractionalKelly * 100}% | Optimal: ${sizing.optimalKellyPercentage}% of Account`);
      } else {
        console.log("\n⚠️ ⚠️ ⚠️ SIGNAL GENERATION RETURNED NULL ⚠️ ⚠️ ⚠️");
        console.log("Check the detailed logs above for the specific rejection reason.");
        console.log("Common reasons:");
        console.log("  - Confidence below threshold");
        console.log("  - Dynamic cooldown still active");
        console.log("  - Macro event suppression");
        console.log("  - Signal conflict (opposite direction)");
        console.log("  - Price proximity filter (too close to existing signal)\n");
      }
    } catch (error) {
      console.error("\n❌ ❌ ❌ CRITICAL ERROR IN SIGNAL GENERATION ❌ ❌ ❌");
      console.error("Error:", error);
      console.error("Stack:", error instanceof Error ? error.stack : 'No stack trace');
    }
  }, [settings, accountBalance, appLaunchTime, syncSignalPriceFromEngine, commitGuidePrice]);

  const updateAllSignalsStatus = useCallback(() => {
    const price = signalTrackingSnapshot.price;
    const signalPriceSource = signalTrackingSnapshot.source;
    const now = Date.now();
    const twoHoursInMs = 2 * 60 * 60 * 1000;
    const GRACE_PERIOD_MS = 5000;
    
    if (price <= 0) {
      console.log('⏳ Skipping signal status update - no valid price yet');
      return;
    }
    
    console.log(`🔄 [${Platform.OS}] Checking signal status updates - Tracking Price: ${price.toFixed(1)} from ${signalPriceSource}`);

    // SPIKE GATE: a lone glitch tick that leaps past TP/SL and reverts must not
    // bank a false outcome. The two-tick gate holds a large jump until a SECOND
    // tick corroborates the new level; an uncorroborated spike is skipped so it
    // can neither bank a false TP (all 3 targets off one tick) nor a false SL.
    const liveGate = classifyTick(price, now, signalTrackingSnapshot.updatedAt, liveTickGateRef.current);
    if (!liveGate.accept) {
      console.warn(`🛡️ SPIKE HELD: tick ${price.toFixed(1)} jumped ${liveGate.gapPips.toFixed(1)} pips in ${liveGate.dtMs}ms (budget ${liveGate.budgetPips.toFixed(1)} pips) - awaiting a 2nd corroborating tick before evaluating signals`);
      return;
    }

    setSignalHistory((prevHistory) => {
      let updated = false;
      let immediateUpdate = false;
      const updatedHistory = prevHistory.map(signal => {
        if (signal.status === "CLOSED" || signal.status === "SL_HIT" || signal.status === "SL_AFTER_BE" || signal.status === "ALL_TARGETS_HIT" || signal.status === "PARTIAL_WIN_SL_HIT") {
          return signal;
        }

        const signalAge = now - new Date(signal.timestamp).getTime();
        const signalCreationAge = signal.createdAt ? now - signal.createdAt : signalAge;
        
        if (signalCreationAge < GRACE_PERIOD_MS) {
          console.log(`⏸️ Signal ${signal.id.slice(-6)} in grace period (${(signalCreationAge / 1000).toFixed(1)}s < 5s) - skipping SL/TP check`);
          return signal;
        }
        if (signalAge > twoHoursInMs) {
          updated = true;
          const exitDate = new Date();
          const livePrice = signalEngine.getCurrentPrice();
          console.log(`⏰ Signal ${signal.id.slice(-6)} expired after 2 hours`);
          return {
            ...signal,
            status: "CLOSED" as const,
            exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            exitPrice: signal.exitPrice ?? (livePrice > 0 ? livePrice : signal.entryPrice),
          };
        }

        let newStatus: SignalStatus = signal.status as SignalStatus;
        let targetsHit = signal.targetsHit;
        let updatedSignal = signal;
        let breakevenReached = signal.breakevenReached || false;
        let breakevenTime = signal.breakevenTime;

        let trailingSLPrice = signal.trailingSLPrice || signal.sl;
        let trailingSLLevel = signal.trailingSLLevel || undefined;

        console.log(`🔍 Monitoring Signal ${signal.id.slice(-6)}: Type=${signal.type}, Status=${signal.status}, Targets=${targetsHit}/3, Price=${price.toFixed(1)}, TP1=${signal.tp1.toFixed(1)}, TP2=${signal.tp2.toFixed(1)}, TP3=${signal.tp3.toFixed(1)}, SL=${signal.sl.toFixed(1)}, TrailingSL=${trailingSLPrice.toFixed(1)} (${trailingSLLevel || 'ORIGINAL'}), Breakeven=${breakevenReached}`);

        // Effective SL level: after TP1 we switch to the 15-pip profit lock;
        // after TP2 we switch to entry (existing behavior).
        const hasTP1 = (signal.targetsHit >= 1) || signal.breakevenReached === true;
        const hasTP2 = signal.targetsHit >= 2;
        const postTP1Lock = getPostTP1LockPrice(signal);
        const effectiveSLPrice = hasTP2
          ? signal.entryPrice
          : hasTP1
            ? postTP1Lock
            : signal.sl;

        // SL-hit confirmation helper: returns true only if the breach of the
        // EFFECTIVE SL level is genuine (sustained duration + penetration +
        // multiple independent ticks). This prevents a single glitchy tick
        // from closing the trade.
        const confirmSLHit = (refPrice: number): boolean => {
          const penetrationPips = signal.type === "BUY"
            ? (refPrice - price) / PIP_VALUE
            : (price - refPrice) / PIP_VALUE;
          if (penetrationPips < 0) {
            if (slBreachTrackerRef.current.has(signal.id)) {
              console.log(`🛡️ SL breach for ${signal.id.slice(-6)} reset - price recovered above/below effective SL ${refPrice.toFixed(1)}`);
              slBreachTrackerRef.current.delete(signal.id);
            }
            return false;
          }
          const existing = slBreachTrackerRef.current.get(signal.id);
          if (!existing) {
            slBreachTrackerRef.current.set(signal.id, {
              firstBreachAt: now,
              maxPenetrationPips: penetrationPips,
              lastPrice: price,
              tickCount: 1,
            });
            console.log(`🛡️ SL BREACH DETECTED (pending confirmation): ${signal.id.slice(-6)} penetration=${penetrationPips.toFixed(2)} pips @ ${price.toFixed(1)} vs effective SL ${refPrice.toFixed(1)} - need ${SL_CONFIRMATION_MIN_DURATION_MS}ms + ${SL_CONFIRMATION_MIN_PENETRATION_PIPS} pips + ${SL_CONFIRMATION_MIN_TICKS} ticks`);
            return false;
          }
          existing.maxPenetrationPips = Math.max(existing.maxPenetrationPips, penetrationPips);
          existing.lastPrice = price;
          existing.tickCount += 1;
          const elapsed = now - existing.firstBreachAt;
          const confirmed = elapsed >= SL_CONFIRMATION_MIN_DURATION_MS
            && existing.maxPenetrationPips >= SL_CONFIRMATION_MIN_PENETRATION_PIPS
            && existing.tickCount >= SL_CONFIRMATION_MIN_TICKS;
          if (!confirmed) {
            console.log(`🛡️ SL breach ongoing for ${signal.id.slice(-6)}: elapsed=${elapsed}ms (need ${SL_CONFIRMATION_MIN_DURATION_MS}), maxPen=${existing.maxPenetrationPips.toFixed(2)}p (need ${SL_CONFIRMATION_MIN_PENETRATION_PIPS}), ticks=${existing.tickCount} (need ${SL_CONFIRMATION_MIN_TICKS})`);
            return false;
          }
          console.log(`✅ SL HIT CONFIRMED for ${signal.id.slice(-6)}: sustained ${elapsed}ms, pen ${existing.maxPenetrationPips.toFixed(2)}p, ${existing.tickCount} ticks (effective SL ${refPrice.toFixed(1)})`);
          slBreachTrackerRef.current.delete(signal.id);
          return true;
        };

        if (signal.type === "BUY") {
          if (hasTP2 && price <= signal.entryPrice && confirmSLHit(signal.entryPrice)) {
            console.log(`✅ TP2 runner returned to entry: BUY signal ${signal.id.slice(-6)} closing as protected partial win @ ${price.toFixed(1)}`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            updated = true;
            immediateUpdate = true;
          } else if (hasTP1 && !hasTP2 && price <= postTP1Lock && confirmSLHit(postTP1Lock)) {
            console.log(`⚖️ 15-PIP PROFIT LOCK HIT: BUY signal ${signal.id.slice(-6)} retraced to entry+15 (${postTP1Lock.toFixed(1)}) after TP1 - banking lock @ ${price.toFixed(1)}`);
            newStatus = "SL_AFTER_BE";
            targetsHit = Math.max(targetsHit, 1);
            updated = true;
            immediateUpdate = true;
          } else if (!hasTP1 && price <= signal.sl && confirmSLHit(signal.sl)) {
            console.log(`🚨 ORIGINAL SL HIT (CONFIRMED): BUY signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
          } else if (price >= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price >= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`📋 BREAKEVEN INDICATOR at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade continues to TP3 or original SL)`);
          } else if (price >= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN INDICATOR activated at ${breakevenTime} - entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
            console.log(`🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
          }

          if (breakevenReached && price <= signal.entryPrice && price > signal.sl && targetsHit < 3) {
            console.log(`📋 BREAKEVEN NOTIFICATION: BUY Signal ${signal.id.slice(-6)} price at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
          }
        } else {
          if (hasTP2 && price >= signal.entryPrice && confirmSLHit(signal.entryPrice)) {
            console.log(`✅ TP2 runner returned to entry: SELL signal ${signal.id.slice(-6)} closing as protected partial win @ ${price.toFixed(1)}`);
            newStatus = "PARTIAL_WIN_SL_HIT";
            targetsHit = Math.max(targetsHit, 2);
            updated = true;
            immediateUpdate = true;
          } else if (hasTP1 && !hasTP2 && price >= postTP1Lock && confirmSLHit(postTP1Lock)) {
            console.log(`⚖️ 15-PIP PROFIT LOCK HIT: SELL signal ${signal.id.slice(-6)} retraced to entry-15 (${postTP1Lock.toFixed(1)}) after TP1 - banking lock @ ${price.toFixed(1)}`);
            newStatus = "SL_AFTER_BE";
            targetsHit = Math.max(targetsHit, 1);
            updated = true;
            immediateUpdate = true;
          } else if (!hasTP1 && price >= signal.sl && confirmSLHit(signal.sl)) {
            console.log(`🚨 ORIGINAL SL HIT (CONFIRMED): SELL signal @ Entry=${signal.entryPrice.toFixed(1)}, Original SL=${signal.sl.toFixed(1)}, Current=${price.toFixed(1)}`);
            newStatus = "SL_HIT";
            updated = true;
            immediateUpdate = true;
          } else if (price <= signal.tp3 && targetsHit < 3) {
            newStatus = "ALL_TARGETS_HIT";
            targetsHit = 3;
            updated = true;
            immediateUpdate = true;
            console.log(`🎯 🎯 🎯 ALL TARGETS HIT: Signal ${signal.id.slice(-6)} reached TP3 @ ${price.toFixed(1)}`);
          } else if (price <= signal.tp2 && targetsHit < 2) {
            newStatus = "TP2_HIT";
            targetsHit = 2;
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 🎯 TP2 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP2: ${signal.tp2.toFixed(1)})`);
            console.log(`📋 BREAKEVEN INDICATOR at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade continues to TP3 or original SL)`);
          } else if (price <= signal.tp1 && targetsHit < 1) {
            newStatus = "TP1_HIT";
            targetsHit = 1;
            breakevenReached = true;
            breakevenTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            trailingSLPrice = signal.entryPrice;
            trailingSLLevel = 'ENTRY';
            updated = true;
            console.log(`🎯 TP1 HIT: Signal ${signal.id.slice(-6)} @ ${price.toFixed(1)} (TP1: ${signal.tp1.toFixed(1)})`);
            console.log(`⚖️ BREAKEVEN INDICATOR activated at ${breakevenTime} - entry ${signal.entryPrice.toFixed(1)} (indicator only, trade stays open)`);
            console.log(`🧠 Trade continues to TP3 (${signal.tp3.toFixed(1)}) or original SL (${signal.sl.toFixed(1)}) for ML learning`);
          }

          if (breakevenReached && price >= signal.entryPrice && price < signal.sl && targetsHit < 3) {
            console.log(`📋 BREAKEVEN NOTIFICATION: SELL Signal ${signal.id.slice(-6)} price at entry ${signal.entryPrice.toFixed(1)} (indicator only - trade remains open)`);
          }
        }

        if (newStatus !== signal.status || targetsHit !== signal.targetsHit || trailingSLPrice !== signal.trailingSLPrice) {
          if (newStatus === "SL_HIT" || newStatus === "SL_AFTER_BE" || newStatus === "ALL_TARGETS_HIT" || newStatus === "PARTIAL_WIN_SL_HIT") {
            const exitDate = new Date();
            console.log(`✅ Terminal status reached: Signal ${signal.id.slice(-6)} will remain in history only`);
            
            let exitPrice: number;
            let result: 'WIN' | 'LOSS';
            
            if (newStatus === "ALL_TARGETS_HIT") {
              exitPrice = signal.tp3;
              result = "WIN";
            } else if (newStatus === "PARTIAL_WIN_SL_HIT") {
              exitPrice = getProtectedExitPrice(signal, targetsHit);
              result = "WIN";
              console.log(`   ✅ TP1/TP2 partials banked, runner stopped at breakeven-weighted exit ${exitPrice.toFixed(1)}`);
            } else if (newStatus === "SL_AFTER_BE") {
              exitPrice = getProtectedExitPrice(signal, Math.max(targetsHit, 1));
              result = "WIN";
              console.log(`   ⚖️ SL hit AFTER breakeven - TP1 banked, no capital loss recorded as WIN @ ${exitPrice.toFixed(1)}`);
            } else {
              exitPrice = signal.sl;
              result = "LOSS";
            }
            
            signalEngine.recordTradeOutcome(
              signal.id,
              signal.entryPrice,
              exitPrice,
              result,
              signal.learningContext,
              undefined,
              now - new Date(signal.timestamp).getTime()
            ).catch(err => {
              console.error(`Failed to record trade outcome for ${signal.id}:`, err);
            });
            
            // Proposal #7: Reset cooldown on resolution so opposite-direction signals aren't blocked
            signalEngine.resetSignalLock();
            
            console.log(`📊 Learning System: Recorded ${result} outcome for signal ${signal.id.slice(-6)}`);
            
            return {
              ...updatedSignal,
              status: newStatus,
              targetsHit,
              breakevenReached,
              breakevenTime,
              trailingSLPrice,
              trailingSLLevel,
              exitTime: exitDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
              exitPrice,
            };
          }
          
          if (targetsHit === 2 && signal.targetsHit < 2) {
            console.log(`🔓 LOCK RELEASED: Signal ${signal.id.slice(-6)} hit TP2 - New signals can now be generated`);
            console.log(`   This signal continues to be monitored for TP3 or SL`);
          }
          
          return { ...updatedSignal, status: newStatus, targetsHit, breakevenReached, breakevenTime, trailingSLPrice, trailingSLLevel };
        }

        return signal;
      });

      if (updated) {
        console.log(`✅ Signal status updated - triggering UI refresh (trigger: ${signalUpdateTrigger + 1})`);
        console.log(`📱 Platform: ${Platform.OS} | Immediate: ${immediateUpdate}`);
        
        setSignalUpdateTrigger(prev => prev + 1);
        
        persistSignalHistory(updatedHistory, { immediate: immediateUpdate });
        if (immediateUpdate) {
          console.log(`🚨 Critical update (SL/TP hit) - Force UI refresh on ${Platform.OS}`);
          setTimeout(() => {
            setSignalUpdateTrigger(prev => prev + 1);
          }, 50);
        }
      }

      return updated ? updatedHistory : prevHistory;
    });
  }, [signalTrackingSnapshot, signalUpdateTrigger, setSignalUpdateTrigger]);

  useEffect(() => {
    updateAllSignalsStatus();
  }, [signalTrackingSnapshot.price, signalTrackingSnapshot.updatedAt, updateAllSignalsStatus]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const signalMonitorInterval = setInterval(() => {
      updateAllSignalsStatus();
    }, 5000);

    return () => {
      clearInterval(signalMonitorInterval);
    };
  }, [isLoading, updateAllSignalsStatus]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    let isMounted = true;

    const runHistoricalReconciliation = async (reason: string) => {
      if (historicalReconciliationInFlightRef.current) {
        console.log(`⏳ Historical reconciliation already running - skipping ${reason}`);
        return;
      }

      const currentHistory = signalHistoryRef.current;
      const openSignals = currentHistory.filter(signal => !TERMINAL_SIGNAL_STATUSES.includes(signal.status));
      const now = Date.now();
      const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
      const recentTerminals = currentHistory.filter(signal => {
        if (!TERMINAL_SIGNAL_STATUSES.includes(signal.status)) return false;
        const signalTs = new Date(signal.timestamp).getTime();
        return (now - signalTs) <= twentyFourHoursInMs;
      });

      if (openSignals.length === 0 && recentTerminals.length === 0) {
        return;
      }

      historicalReconciliationInFlightRef.current = true;
      console.log(`🧭 Historical reconciliation triggered (${reason}) for ${openSignals.length} open + ${recentTerminals.length} recent-terminal signal(s)`);

      try {
        // 1. Reconcile open signals (catch-up detects TP/SL hits the live tick
        //    monitor may have missed).
        const reconciledHistory = await catchUpAndEvaluateSignals(currentHistory, historicalFallbackPriceRef.current);

        if (!isMounted) {
          return;
        }

        // 2. Re-audit every terminal signal from the last 24h against 1m bars.
        //    This catches the reverse failure mode: the live tick monitor
        //    committed a wrong-direction terminal (e.g. BUY → TP3 when price
        //    actually went straight to SL) because it missed ticks on the
        //    SL side. The bar-based resolver is authoritative and will flip
        //    these back to the correct status.
        const auditedHistory = await auditTerminalSLSignals(reconciledHistory);

        if (!isMounted) {
          return;
        }

        const previousSerialized = JSON.stringify(currentHistory);
        const nextSerialized = JSON.stringify(auditedHistory);

        if (previousSerialized !== nextSerialized) {
          signalHistoryRef.current = auditedHistory;
          setSignalHistory(sanitizeHistoryForRender(auditedHistory));
          persistSignalHistory(auditedHistory, { immediate: true });
          setSignalUpdateTrigger(prev => prev + 1);
          console.log('✅ Historical reconciliation + audit applied missed/wrong TP/SL updates');
        } else {
          console.log('✅ Historical reconciliation + audit found no missed/wrong TP/SL events');
        }
      } catch (error) {
        console.error('❌ Historical reconciliation failed:', error);
      } finally {
        historicalReconciliationInFlightRef.current = false;
      }
    };

    void runHistoricalReconciliation('startup');

    const historicalReconciliationInterval = setInterval(() => {
      void runHistoricalReconciliation('interval');
    }, HISTORICAL_RECONCILIATION_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(historicalReconciliationInterval);
    };
  }, [catchUpAndEvaluateSignals, auditTerminalSLSignals, isLoading]);

  // ITEM 3: guaranteed daily full audit sweep. This is a NEW, fully independent
  // scheduled task operating ONLY on already-resolved/terminal signal history -
  // it never touches, blocks, delays, or is called by signal-GENERATION
  // scheduling (SIGNAL_GENERATION_INTERVAL_MS / registerBackgroundTask), which
  // continue to run entirely on their own separate timers untouched by this.
  // Runs once per UTC calendar day, timed to the ~21:00-22:00 UTC low-liquidity
  // rollover window (NY close / Asia pre-open) so that day's signals' local 1m
  // bars still exist (well within the 7-day retention from Item 2), giving
  // every recent signal at least one full, unhurried, force=true audit pass -
  // not just the opportunistic 30s-interval reconciliation above (which skips
  // already-audited signals unless they're stale/old).
  useEffect(() => {
    if (isLoading) {
      return;
    }

    let isMounted = true;
    const DAILY_SWEEP_UTC_HOUR = 21; // 21:00-22:00 UTC window
    const DAILY_SWEEP_STORAGE_KEY = 'last_daily_full_audit_sweep_utc_date';
    const DAILY_SWEEP_CHECK_INTERVAL_MS = 60_000;

    const utcDateString = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

    const runDailyFullAuditSweep = async () => {
      if (historicalReconciliationInFlightRef.current) {
        console.log('⏳ [DailySweep] Skipping - historical reconciliation already in flight this tick, will retry next check');
        return;
      }
      historicalReconciliationInFlightRef.current = true;
      const todayUtc = utcDateString(Date.now());
      console.log(`\n${'='.repeat(80)}\n🌙 [DailySweep] GUARANTEED DAILY FULL AUDIT SWEEP starting (UTC date ${todayUtc}, rollover window)\n${'='.repeat(80)}`);
      try {
        const currentHistory = signalHistoryRef.current;
        const reconciledHistory = await catchUpAndEvaluateSignals(currentHistory, historicalFallbackPriceRef.current);
        if (!isMounted) return;
        // force=true: every recent terminal signal gets a full re-audit, not just
        // ones that failed the alreadyAudited/tooOldForBars skip check.
        const auditedHistory = await auditTerminalSLSignals(reconciledHistory, { force: true });
        if (!isMounted) return;

        const previousSerialized = JSON.stringify(currentHistory);
        const nextSerialized = JSON.stringify(auditedHistory);
        if (previousSerialized !== nextSerialized) {
          signalHistoryRef.current = auditedHistory;
          setSignalHistory(sanitizeHistoryForRender(auditedHistory));
          persistSignalHistory(auditedHistory, { immediate: true });
          setSignalUpdateTrigger(prev => prev + 1);
          console.log('✅ [DailySweep] Daily full audit sweep corrected one or more signals');
        } else {
          console.log('✅ [DailySweep] Daily full audit sweep found no corrections needed');
        }
        await AsyncStorage.setItem(DAILY_SWEEP_STORAGE_KEY, todayUtc);
        console.log(`🌙 [DailySweep] Recorded sweep completion for UTC date ${todayUtc}`);
      } catch (error) {
        console.error('❌ [DailySweep] Daily full audit sweep failed:', error);
      } finally {
        historicalReconciliationInFlightRef.current = false;
      }
    };

    const checkAndMaybeRunDailySweep = async () => {
      if (!isMounted) return;
      try {
        const now = new Date();
        const utcHour = now.getUTCHours();
        if (utcHour !== DAILY_SWEEP_UTC_HOUR) {
          return;
        }
        const todayUtc = utcDateString(now.getTime());
        const lastSweepDate = await AsyncStorage.getItem(DAILY_SWEEP_STORAGE_KEY);
        if (lastSweepDate === todayUtc) {
          return; // Already swept today.
        }
        console.log(`🌙 [DailySweep] Entering rollover window (UTC hour=${utcHour}), last sweep=${lastSweepDate ?? 'never'} - running now`);
        await runDailyFullAuditSweep();
      } catch (err) {
        console.warn('⚠️ [DailySweep] Check failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
      }
    };

    console.log('🌙 [DailySweep] Guaranteed daily full audit sweep scheduler started (checks every 60s for the 21:00-22:00 UTC window)');
    void checkAndMaybeRunDailySweep();
    const dailySweepCheckInterval = setInterval(() => {
      void checkAndMaybeRunDailySweep();
    }, DAILY_SWEEP_CHECK_INTERVAL_MS);

    return () => {
      isMounted = false;
      clearInterval(dailySweepCheckInterval);
    };
  }, [catchUpAndEvaluateSignals, auditTerminalSLSignals, persistSignalHistory, isLoading]);

  useEffect(() => {
    if (!isLoggedIn) {
      console.log('⚠️ User not logged in - signal generation paused');
      return;
    }

    if (isLoading) {
      console.log('⚠️ Still loading data - signal generation waiting for initialization...');
      return;
    }

    console.log(`✅ Signal generation system activated - checking every ${(SIGNAL_GENERATION_INTERVAL_MS / 1000).toFixed(0)}s`);
    console.log(`   Data loaded: ${signalHistoryRef.current.length} signals in history`);
    console.log(`   Launch cooldown: 5 seconds (prevents duplicate signals at startup)`);
    
    const signalInterval = setInterval(() => {
      console.log(`⏰ ${(SIGNAL_GENERATION_INTERVAL_MS / 1000).toFixed(0)}s interval - checking for signal generation...`);
      void checkAndGenerateSignal();
    }, SIGNAL_GENERATION_INTERVAL_MS);

    console.log('🚀 Scheduling initial signal generation check (after 5s cooldown)...');
    const initialSignalCheckTimeout = setTimeout(() => {
      console.log('✅ Launch cooldown complete - starting signal generation');
      void checkAndGenerateSignal();
    }, 5000);

    return () => {
      console.log('🛑 Signal generation system deactivated');
      clearInterval(signalInterval);
      clearTimeout(initialSignalCheckTimeout);
    };
  }, [isLoggedIn, isLoading, checkAndGenerateSignal]);

  const login = useCallback(async (username: string) => {
    setIsLoggedIn(true);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(true));
    console.log(`User logged in: ${username}`);
  }, []);

  const logout = useCallback(async () => {
    setIsLoggedIn(false);
    await AsyncStorage.setItem("is_logged_in", JSON.stringify(false));
  }, []);

  const clearHistory = useCallback(async () => {
    setSignalHistory([]);
    // Cancel any pending debounced write so it can't resurrect cleared history.
    pendingHistoryWriteRef.current = [];
    if (historyWriteTimerRef.current) {
      clearTimeout(historyWriteTimerRef.current);
      historyWriteTimerRef.current = null;
    }
    await AsyncStorage.setItem("signal_history", JSON.stringify([]));
    console.log('🧹 Signal history cleared');
    console.log('✅ All signals removed from storage and UI');
  }, []);

  const updateSettings = useCallback(async (newSettings: Partial<Settings>) => {
    const updated = sanitizeSettings({ ...settings, ...newSettings });
    setSettings(updated);
    await AsyncStorage.setItem("trading_settings", JSON.stringify(updated));

    if (Platform.OS !== 'web' && 'enableNotifications' in newSettings) {
      if (newSettings.enableNotifications) {
        const registered = await registerBackgroundTask();
        setBackgroundTaskActive(registered);
        console.log('✅ Background task enabled');
      } else {
        setBackgroundTaskActive(false);
        console.log('⚠️ Background task disabled');
      }
    }
  }, [settings]);

  const deleteSignalFromHistory = useCallback(async (signalId: string) => {
    setSignalHistory((prev) => {
      const updated = prev.filter((s) => s.id !== signalId);
      persistSignalHistory(updated, { immediate: true });
      return updated;
    });
  }, [persistSignalHistory]);

  const manualCloseSignal = useCallback((signalId: string) => {
    closeSignal(signalId);
  }, [closeSignal]);

  const refreshData = useCallback(async () => {
    await updateMarketOutlook();

    let price = signalEngine.getCurrentPrice();
    if (price <= 0) {
      price = await signalEngine.updateCurrentPrice();
    }

    if (price > 0) {
      syncSignalPriceFromEngine(price);
    }

    console.log(`Data refreshed successfully | price=${price.toFixed(2)} | source=${signalEngine.getPriceSource()}`);
  }, [syncSignalPriceFromEngine]);

  const triggerManualRetrain = useCallback(async (reason?: string) => {
    const result = await signalEngine.manualRetrain(reason || 'User Triggered');
    
    if (result.success) {
      const metrics = calculatePerformanceMetrics(signalHistory);
      setPerformanceMetrics(metrics);
      console.log('✅ Manual retrain completed - performance metrics refreshed');
    }
    
    return result;
  }, [signalHistory, calculatePerformanceMetrics]);

  return useMemo(() => ({
    isLoggedIn,
    isLoading,
    signalHistory,
    settings,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    accountBalance,
    currentPrice,
    signalTrackingPrice: signalTrackingSnapshot.price,
    signalTrackingSource: signalTrackingSnapshot.source,
    signalTrackingUpdatedAt: signalTrackingSnapshot.updatedAt,
    guidePrice,
    chartPrice,
    priceHistory,
    dailyOHLCHistory,
    signalUpdateTrigger,
    priceSource,
    chartPriceSource,
    guidePriceSource,
    guidePriceUpdatedAt,
    livePriceError,
    ingestChartPrice,
    login,
    logout,
    clearHistory,
    updateSettings,
    deleteSignalFromHistory,
    manualCloseSignal,
    refreshData,
    triggerManualRetrain,
    runManualAudit,
    backgroundTaskActive,
  }), [
    accountBalance,
    backgroundTaskActive,
    clearHistory,
    chartPrice,
    chartPriceSource,
    currentPrice,
    dailyOHLCHistory,
    deleteSignalFromHistory,
    guidePrice,
    guidePriceSource,
    guidePriceUpdatedAt,
    isLoading,
    isLoggedIn,
    ingestChartPrice,
    livePriceError,
    login,
    logout,
    manualCloseSignal,
    marketOutlook,
    performanceMetrics,
    positionSizing,
    priceHistory,
    priceSource,
    refreshData,
    runManualAudit,
    settings,
    signalHistory,
    signalTrackingSnapshot.price,
    signalTrackingSnapshot.source,
    signalTrackingSnapshot.updatedAt,
    signalUpdateTrigger,
    triggerManualRetrain,
    updateSettings,
  ]);
});
