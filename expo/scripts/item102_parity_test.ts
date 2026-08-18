/**
 * ITEM 102(d) — PARITY TEST: Edge Function resolver vs canonical signalResolver.
 *
 * Runs a fixture set through both resolvers and asserts identical status and R.
 * Both must agree on:
 *   - post-TP1 lock = 0.35R profit lock (NOT breakeven/entry)
 *   - post-TP2 lock = entry (breakeven), exit = (tp1+tp2+entry)/3
 *   - SL_AFTER_BE = WIN with R > 0
 */
import { resolveSignalWithBars, getPostTP1LockPrice } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

// ── Edge Function mirror (resolveFromBars) ──────────────────────────────
// Copied from backend/functions/resolve-emitted-signals/index.ts to verify
// it produces the same results as signalResolver.ts on identical input.

const PIP = 0.1;
const POST_TP1_PROFIT_LOCK_R = 0.35;
const POST_TP1_PROFIT_LOCK_MIN_PIPS = 5;
const POST_TP1_LOCK_MAX_FRACTION_OF_TP1 = 0.9;
const EXECUTION_COST_PER_TRADE_USD = 0.20;
const DOLLAR_PER_PRICE_UNIT = 1;
const SCRATCH_R_THRESHOLD = 0.15;

function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

function computePostTP1LockPrice(entry: number, sl: number, tp1: number, isBuy: boolean): number {
  const stopDistance = Math.abs(entry - sl);
  const tp1Distance = Math.abs(tp1 - entry);
  const minDelta = POST_TP1_PROFIT_LOCK_MIN_PIPS * PIP;
  const base = Number.isFinite(stopDistance) && stopDistance > 0
    ? stopDistance * POST_TP1_PROFIT_LOCK_R : minDelta;
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0
    ? tp1Distance * POST_TP1_LOCK_MAX_FRACTION_OF_TP1 : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(base, minDelta), ceiling);
  const raw = isBuy ? entry + delta : entry - delta;
  return Number(raw.toFixed(1));
}

function computeProtectedExitPrice(entry: number, tp1: number, tp2: number, targetsHit: number): number {
  const n = Math.max(0, Math.min(2, targetsHit));
  if (n >= 2) return Number(((tp1 + tp2 + entry) / 3).toFixed(1));
  if (n === 1) return computePostTP1LockPrice(entry, 0, tp1, true); // not used in test
  return entry;
}

interface EdgeResolution {
  status: string;
  exitPrice: number;
  realizedR: number;
}

/** Mirror of resolveFromBars from the Edge Function. */
function edgeResolveFromBars(
  entry: number, sl: number, tp1: number, tp2: number, tp3: number,
  isBuy: boolean, bars: { timestamp: number; high: number; low: number; close: number }[],
): EdgeResolution | null {
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || bars.length === 0) return null;
  const rOfGross = (exit: number): number => isBuy ? (exit - entry) / risk : (entry - exit) / risk;
  const rOf = (exit: number): number => rOfGross(exit) - costInR(risk);
  const touched = (bar: { high: number; low: number }, level: number): boolean => bar.low <= level && bar.high >= level;

  let entryFilled = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let lockPrice = sl;

  for (const bar of bars) {
    if (!entryFilled) { if (!touched(bar, entry)) continue; entryFilled = true; }

    if (touched(bar, lockPrice)) {
      if (tp2Hit) {
        const exitPrice = computeProtectedExitPrice(entry, tp1, tp2, 2);
        const r = rOf(exitPrice);
        return { status: 'PARTIAL_WIN_SL_HIT', exitPrice, realizedR: r };
      }
      if (tp1Hit) {
        const exitPrice = lockPrice;
        const r = rOf(exitPrice);
        if (r <= 0) throw new Error(`ASSERTION FAILED: SL_AFTER_BE r=${r} <= 0`);
        return { status: 'SL_AFTER_BE', exitPrice, realizedR: r };
      }
      const r = rOf(lockPrice);
      return { status: 'SL_HIT', exitPrice: lockPrice, realizedR: r };
    }
    if (touched(bar, tp3)) {
      const r = rOf(tp3);
      return { status: 'ALL_TARGETS_HIT', exitPrice: tp3, realizedR: r };
    }
    if (!tp2Hit && touched(bar, tp2)) {
      tp2Hit = true;
      lockPrice = entry; // ITEM 94 FIX: lock at entry after TP2
    }
    if (!tp1Hit && touched(bar, tp1)) {
      tp1Hit = true;
      lockPrice = computePostTP1LockPrice(entry, sl, tp1, isBuy); // ITEM 94 FIX: 0.35R lock
    }
  }
  if (!entryFilled) return null;
  const last = bars[bars.length - 1];
  const r = rOf(last.close);
  return { status: 'CLOSED', exitPrice: last.close, realizedR: r };
}

// ── Fixtures ────────────────────────────────────────────────────────────

interface Fixture {
  name: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
  isBuy: boolean;
  bars: { timestamp: number; high: number; low: number; close: number; open: number }[];
}

const T = 1700000000000;
const bar = (open: number, high: number, low: number, close: number, offset: number) => ({
  timestamp: T + offset, open, high, low, close,
});

const fixtures: Fixture[] = [
  // FIXTURE 1: BUY — TP1 hit, then retrace to 0.35R lock → SL_AFTER_BE
  {
    name: 'BUY TP1 then lock retrace',
    entry: 4400.0, sl: 4393.0, tp1: 4404.9, tp2: 4407.4, tp3: 4409.8,
    isBuy: true,
    bars: [
      bar(4399.5, 4400.5, 4399.0, 4400.0, 60000),  // entry fill
      bar(4400.0, 4405.0, 4399.8, 4404.5, 120000), // TP1 hit
      bar(4404.5, 4405.5, 4402.0, 4402.5, 180000), // retrace toward lock
      bar(4402.5, 4403.0, 4401.05, 4401.1, 240000), // lock hit (4400 + 0.35*7 = 4402.45)
    ],
  },
  // FIXTURE 2: SELL — TP1 hit, then retrace to lock → SL_AFTER_BE
  {
    name: 'SELL TP1 then lock retrace',
    entry: 4400.0, sl: 4407.0, tp1: 4395.1, tp2: 4392.6, tp3: 4390.2,
    isBuy: false,
    bars: [
      bar(4400.5, 4401.0, 4399.5, 4400.0, 60000),
      bar(4400.0, 4400.2, 4395.0, 4395.5, 120000),
      bar(4395.5, 4398.0, 4395.0, 4397.5, 180000),
      bar(4397.5, 4398.0, 4397.55, 4397.6, 240000), // lock hit (4400 - 0.35*7 = 4397.55)
    ],
  },
  // FIXTURE 3: BUY — TP1 + TP2 hit, then retrace to entry → PARTIAL_WIN_SL_HIT
  {
    name: 'BUY TP1+TP2 then entry retrace',
    entry: 4400.0, sl: 4393.0, tp1: 4404.9, tp2: 4407.4, tp3: 4409.8,
    isBuy: true,
    bars: [
      bar(4399.5, 4400.5, 4399.0, 4400.0, 60000),
      bar(4400.0, 4405.0, 4399.8, 4404.5, 120000), // TP1
      bar(4404.5, 4408.0, 4404.0, 4407.5, 180000), // TP2
      bar(4407.5, 4408.0, 4400.0, 4401.0, 240000), // retrace to entry
    ],
  },
  // FIXTURE 4: BUY — straight SL hit (no TP)
  {
    name: 'BUY straight SL',
    entry: 4400.0, sl: 4393.0, tp1: 4404.9, tp2: 4407.4, tp3: 4409.8,
    isBuy: true,
    bars: [
      bar(4399.5, 4400.5, 4399.0, 4400.0, 60000),
      bar(4400.0, 4400.5, 4392.5, 4393.5, 120000), // SL hit
    ],
  },
  // FIXTURE 5: BUY — all targets hit
  {
    name: 'BUY all targets',
    entry: 4400.0, sl: 4393.0, tp1: 4404.9, tp2: 4407.4, tp3: 4409.8,
    isBuy: true,
    bars: [
      bar(4399.5, 4400.5, 4399.0, 4400.0, 60000),
      bar(4400.0, 4405.0, 4399.8, 4404.5, 120000), // TP1
      bar(4404.5, 4408.0, 4404.0, 4407.5, 180000), // TP2
      bar(4407.5, 4410.0, 4407.0, 4410.0, 240000), // TP3
    ],
  },
  // FIXTURE 6: SELL — TP1+TP2 then retrace to entry → PARTIAL_WIN_SL_HIT
  {
    name: 'SELL TP1+TP2 then entry retrace',
    entry: 4400.0, sl: 4407.0, tp1: 4395.1, tp2: 4392.6, tp3: 4390.2,
    isBuy: false,
    bars: [
      bar(4400.5, 4401.0, 4399.5, 4400.0, 60000),
      bar(4400.0, 4400.2, 4395.0, 4395.5, 120000), // TP1
      bar(4395.5, 4395.8, 4392.5, 4392.7, 180000), // TP2
      bar(4392.7, 4400.5, 4392.5, 4400.0, 240000), // retrace to entry
    ],
  },
];

// ── Run parity test ────────────────────────────────────────────────────

function toTradingSignal(f: Fixture): TradingSignal {
  return {
    id: 'fixture_' + f.name.replace(/\s+/g, '_'),
    timestamp: new Date(T),
    createdAt: T,
    type: f.isBuy ? 'BUY' : 'SELL',
    entryPrice: f.entry,
    entryPriceWithSlippage: f.entry,
    tp1: f.tp1, tp2: f.tp2, tp3: f.tp3, sl: f.sl,
    confidence: 0.75,
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    slMultiplier: 1, atr: 3.0, regime: 'TRENDING', rsi: 50,
    sessionName: '', hourUtc: 0,
    srZonesSnapshot: null, attentionScores: null,
    htfTrend: 'NEUTRAL', ltfTrend: 'NEUTRAL',
    breakevenReached: false, breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

let passed = 0;
let failed = 0;

for (const f of fixtures) {
  const sig = toTradingSignal(f);
  const ohlcBars: OhlcBar[] = f.bars.map(b => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close }));

  // Canonical resolver
  const canonical = resolveSignalWithBars(sig, ohlcBars, { fromScratch: true, evalNowMs: T + 300000 });

  // Edge Function mirror
  const edge = edgeResolveFromBars(f.entry, f.sl, f.tp1, f.tp2, f.tp3, f.isBuy, f.bars);

  if (!edge) {
    console.log(`  ❌ FAIL ${f.name}: Edge resolver returned null`);
    failed++;
    continue;
  }

  const risk = Math.abs(f.entry - f.sl);
  const canonicalR = f.isBuy
    ? (canonical.exitPrice - f.entry) / risk - costInR(risk)
    : (f.entry - canonical.exitPrice) / risk - costInR(risk);

  const statusMatch = canonical.newStatus === edge.status;
  const rMatch = Math.abs(canonicalR - edge.realizedR) < 0.001;

  if (statusMatch && rMatch) {
    console.log(`  ✅ PASS ${f.name}: status=${canonical.newStatus} R_canon=${canonicalR.toFixed(4)} R_edge=${edge.realizedR.toFixed(4)}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL ${f.name}:`);
    console.log(`     canonical: status=${canonical.newStatus} exit=${canonical.exitPrice.toFixed(1)} R=${canonicalR.toFixed(6)}`);
    console.log(`     edge:      status=${edge.status} exit=${edge.exitPrice.toFixed(1)} R=${edge.realizedR.toFixed(6)}`);
    console.log(`     status_match=${statusMatch} r_match=${rMatch}`);
    failed++;
  }
}

console.log(`\n  PARITY TEST: ${passed}/${passed + failed} passed`);
if (failed > 0) {
  process.exit(1);
}
