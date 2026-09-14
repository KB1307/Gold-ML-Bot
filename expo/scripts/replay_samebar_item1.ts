/**
 * ITEM 1 (five-fix prompt, 2026-09-14) — same-bar TP/SL disambiguation replay.
 *
 * Replays the failing 2026-09-14 SELL signals (#2 @ 4277.3, #4 @ 4277.1 — both
 * recorded targetsHit: 3 + status: SL_HIT at the original SL) through:
 *   (a) the PRE-FIX live monitor (SL checked before TPs — the defect),
 *   (b) the PATCHED live monitor (Part B hard TP3 guard + Part A proximity
 *       disambiguation — verbatim mirror of the TradingContext.tsx bar loop),
 *   (c) resolveSignalWithBars({fromScratch: true}) — the canonical resolver
 *       cross-check (it already has the disambiguation; if IT says SL_HIT, the
 *       bar data says SL truly was hit first and no fix should change that).
 *
 * Read-only — anon key, no writes anywhere.
 * Run: cd expo && bun scripts/replay_samebar_item1.ts
 */
import { createClient } from "@supabase/supabase-js";
import type { TradingSignal, SignalStatus, SignalType } from "../types/trading";
import {
  resolveSignalWithBars,
  getSignalBreakevenPolicy,
  getPostTP1LockPrice as computePostTP1LockPrice,
  getPostTP2StopPrice,
} from "../services/signalResolver";

type Bar = { timestamp: number; open: number; high: number; low: number; close: number };

interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number | null;
  sl_multiplier: number | null;
  atr: number | null;
  htf_trend: string | null;
  ltf_trend: string | null;
  rsi: number | null;
}

// ── VERBATIM mirror of TradingContext.tsx getProtectedExitPrice (@ item-1 patch) ──
function getProtectedExitPrice(signal: TradingSignal, targetsHit: number): number {
  const normalizedTargetsHit = Math.max(0, Math.min(2, targetsHit));
  if (normalizedTargetsHit >= 2) {
    if (signal.postTP2StopLevel === 'tp1') {
      return signal.tp1;
    }
    return Number(((signal.tp1 + signal.tp2 + signal.entryPrice) / 3).toFixed(1));
  }
  if (normalizedTargetsHit === 1) {
    return computePostTP1LockPrice(signal);
  }
  return signal.entryPrice;
}

interface MonitorResult {
  status: SignalStatus;
  targetsHit: number;
  exitPrice: number;
  outcome: 'WIN' | 'LOSS' | null;
  breakevenReached: boolean;
  events: string[];
}

/**
 * VERBATIM mirror of the TradingContext.tsx live-monitor bar loop
 * (analyzeSignalWithHistoricalData @ the ITEM 1 patch). patched=false runs the
 * PRE-FIX ordering (SL checked before TPs — the defect); patched=true runs the
 * shipped Part A disambiguation + Part B hard TP3 guard.
 */
function monitorResolve(signal: TradingSignal, allBars: Bar[], patched: boolean): MonitorResult {
  let currentStatus = signal.status;
  let currentTargetsHit = signal.targetsHit;
  let exitPrice = signal.entryPrice;
  let outcomeResult: 'WIN' | 'LOSS' | null = null;
  let entryConfirmed = false;
  let breakevenReached = signal.breakevenReached || false;
  const breakevenActive = getSignalBreakevenPolicy(signal);
  const postTP2StopPrice = getPostTP2StopPrice(signal);
  const events: string[] = [];

  const signalCreatedAtMs = signal.createdAt ?? new Date(signal.timestamp).getTime();
  const safeBarStart = signalCreatedAtMs + 60_000;
  const historicalBars = allBars.filter(b => b.timestamp >= safeBarStart);

  const entryMin = Math.min(signal.entryPrice, signal.entryPriceWithSlippage);
  const entryMax = Math.max(signal.entryPrice, signal.entryPriceWithSlippage);
  const ENTRY_TOLERANCE = 1.0;
  const EXTENDED_ENTRY_TOLERANCE = 3.0;

  if (signal.targetsHit >= 1 || signal.status === "TP1_HIT" || signal.status === "TP2_HIT" || signal.status === "TP3_HIT" || signal.status === "ALL_TARGETS_HIT") {
    entryConfirmed = true;
  }

  for (let i = 0; i < historicalBars.length; i++) {
    const bar = historicalBars[i];
    if (!entryConfirmed) {
      const touchedEntryZone = signal.type === "BUY"
        ? bar.low <= (entryMax + ENTRY_TOLERANCE) && bar.high >= (entryMin - ENTRY_TOLERANCE)
        : bar.high >= (entryMin - ENTRY_TOLERANCE) && bar.low <= (entryMax + ENTRY_TOLERANCE);
      const tpReachedFromEntry = signal.type === "BUY" ? bar.high >= signal.tp1 : bar.low <= signal.tp1;
      const slReachedFromEntry = signal.type === "BUY" ? bar.low <= signal.sl : bar.high >= signal.sl;
      const crossedEntryByExtendedZone = signal.type === "BUY"
        ? bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE) && bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE)
        : bar.high >= (entryMin - EXTENDED_ENTRY_TOLERANCE) && bar.low <= (entryMax + EXTENDED_ENTRY_TOLERANCE);
      if (touchedEntryZone) entryConfirmed = true;
      else if (tpReachedFromEntry || slReachedFromEntry) entryConfirmed = true;
      else if (crossedEntryByExtendedZone) entryConfirmed = true;
      else continue;
    }

    if (signal.type === "BUY") {
      if (patched) {
        if (currentTargetsHit === 3) {
          currentStatus = "ALL_TARGETS_HIT"; exitPrice = signal.tp3; outcomeResult = 'WIN';
          events.push(`PART B @ bar ${i + 1}: TP3 already banked → ALL_TARGETS_HIT (no SL check)`);
          break;
        }
        const origSlHitThisBar = bar.low <= signal.sl;
        const tp3HitThisBar = bar.high >= signal.tp3 && currentTargetsHit < 3;
        const tp2HitThisBar = bar.high >= signal.tp2 && currentTargetsHit < 2;
        const tp1HitThisBar = bar.high >= signal.tp1 && currentTargetsHit < 1;
        const newTargetLevelThisBar = tp3HitThisBar ? signal.tp3 : tp2HitThisBar ? signal.tp2 : tp1HitThisBar ? signal.tp1 : null;
        if (origSlHitThisBar && newTargetLevelThisBar !== null) {
          const slBreachLevel = breakevenActive
            ? (currentTargetsHit >= 2 ? postTP2StopPrice : currentTargetsHit >= 1 ? computePostTP1LockPrice(signal) : signal.sl)
            : signal.sl;
          const targetDist = Math.abs(bar.open - newTargetLevelThisBar);
          const slDist = Math.abs(bar.open - slBreachLevel);
          events.push(`PART A @ bar ${i + 1} ${new Date(bar.timestamp).toISOString()}: SL-side ${slBreachLevel.toFixed(1)} (${slDist.toFixed(2)} from open) vs target ${newTargetLevelThisBar.toFixed(1)} (${targetDist.toFixed(2)} from open)`);
          if (slDist <= targetDist) {
            events.push(`  → SL-first`);
            if (breakevenActive && currentTargetsHit >= 2) {
              currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
              exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
            } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
              currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
              exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
            } else {
              currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
            }
            break;
          }
          events.push(`  → target-first`);
          if (tp3HitThisBar) {
            currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
            break;
          }
          if (tp2HitThisBar) {
            currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
            const postSlLevelAfterTp2 = breakevenActive ? postTP2StopPrice : signal.sl;
            if (bar.low <= postSlLevelAfterTp2) {
              if (breakevenActive) {
                currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
                exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
              } else {
                currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
              }
              break;
            }
          } else if (tp1HitThisBar) {
            currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
            if (breakevenActive) breakevenReached = true;
            const postSlLevelAfterTp1 = breakevenActive ? computePostTP1LockPrice(signal) : signal.sl;
            if (bar.low <= postSlLevelAfterTp1) {
              if (breakevenActive) {
                currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
                exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
              } else {
                currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
              }
              break;
            }
          }
        } else if (origSlHitThisBar) {
          if (breakevenActive && currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
            currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else {
            currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
          }
          events.push(`SL (no same-bar target) @ bar ${i + 1} → ${currentStatus}`);
          break;
        } else if (tp3HitThisBar) {
          currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
          break;
        } else if (tp2HitThisBar) {
          currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
        } else if (tp1HitThisBar) {
          currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
          if (breakevenActive) breakevenReached = true;
        }
        if (breakevenActive && currentTargetsHit >= 2 && bar.low <= postTP2StopPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          break;
        }
      } else {
        // PRE-FIX ordering: SL checked FIRST, unconditionally.
        if (bar.low <= signal.sl) {
          if (breakevenActive && currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
            currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else {
            currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
          }
          events.push(`PRE-FIX SL-first @ bar ${i + 1} ${new Date(bar.timestamp).toISOString()} → ${currentStatus}`);
          break;
        }
        if (bar.high >= signal.tp3 && currentTargetsHit < 3) {
          currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
          break;
        } else if (bar.high >= signal.tp2 && currentTargetsHit < 2) {
          currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
        } else if (bar.high >= signal.tp1 && currentTargetsHit < 1) {
          currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
          if (breakevenActive) breakevenReached = true;
        }
        if (breakevenActive && currentTargetsHit >= 2 && bar.low <= postTP2StopPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          break;
        }
      }
    } else {
      // SELL
      if (patched) {
        if (currentTargetsHit === 3) {
          currentStatus = "ALL_TARGETS_HIT"; exitPrice = signal.tp3; outcomeResult = 'WIN';
          events.push(`PART B @ bar ${i + 1}: TP3 already banked → ALL_TARGETS_HIT (no SL check)`);
          break;
        }
        const origSlHitThisBar = bar.high >= signal.sl;
        const tp3HitThisBar = bar.low <= signal.tp3 && currentTargetsHit < 3;
        const tp2HitThisBar = bar.low <= signal.tp2 && currentTargetsHit < 2;
        const tp1HitThisBar = bar.low <= signal.tp1 && currentTargetsHit < 1;
        const newTargetLevelThisBar = tp3HitThisBar ? signal.tp3 : tp2HitThisBar ? signal.tp2 : tp1HitThisBar ? signal.tp1 : null;
        if (origSlHitThisBar && newTargetLevelThisBar !== null) {
          const slBreachLevel = breakevenActive
            ? (currentTargetsHit >= 2 ? postTP2StopPrice : currentTargetsHit >= 1 ? computePostTP1LockPrice(signal) : signal.sl)
            : signal.sl;
          const targetDist = Math.abs(bar.open - newTargetLevelThisBar);
          const slDist = Math.abs(bar.open - slBreachLevel);
          events.push(`PART A @ bar ${i + 1} ${new Date(bar.timestamp).toISOString()}: SL-side ${slBreachLevel.toFixed(1)} (${slDist.toFixed(2)} from open) vs target ${newTargetLevelThisBar.toFixed(1)} (${targetDist.toFixed(2)} from open)`);
          if (slDist <= targetDist) {
            events.push(`  → SL-first`);
            if (breakevenActive && currentTargetsHit >= 2) {
              currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
              exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
            } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
              currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
              exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
            } else {
              currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
            }
            break;
          }
          events.push(`  → target-first`);
          if (tp3HitThisBar) {
            currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
            break;
          }
          if (tp2HitThisBar) {
            currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
            const postSlLevelAfterTp2 = breakevenActive ? postTP2StopPrice : signal.sl;
            if (bar.high >= postSlLevelAfterTp2) {
              if (breakevenActive) {
                currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
                exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
              } else {
                currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
              }
              break;
            }
          } else if (tp1HitThisBar) {
            currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
            if (breakevenActive) breakevenReached = true;
            const postSlLevelAfterTp1 = breakevenActive ? computePostTP1LockPrice(signal) : signal.sl;
            if (bar.high >= postSlLevelAfterTp1) {
              if (breakevenActive) {
                currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
                exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
              } else {
                currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
              }
              break;
            }
          }
        } else if (origSlHitThisBar) {
          if (breakevenActive && currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
            currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else {
            currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
          }
          events.push(`SL (no same-bar target) @ bar ${i + 1} → ${currentStatus}`);
          break;
        } else if (tp3HitThisBar) {
          currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
          break;
        } else if (tp2HitThisBar) {
          currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
        } else if (tp1HitThisBar) {
          currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
          if (breakevenActive) breakevenReached = true;
        }
        if (breakevenActive && currentTargetsHit >= 2 && bar.high >= postTP2StopPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          break;
        }
      } else {
        if (bar.high >= signal.sl) {
          if (breakevenActive && currentTargetsHit >= 2) {
            currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else if (breakevenActive && (breakevenReached || currentTargetsHit >= 1)) {
            currentStatus = "SL_AFTER_BE"; currentTargetsHit = Math.max(currentTargetsHit, 1);
            exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          } else {
            currentStatus = "SL_HIT"; exitPrice = signal.sl; outcomeResult = 'LOSS';
          }
          events.push(`PRE-FIX SL-first @ bar ${i + 1} ${new Date(bar.timestamp).toISOString()} → ${currentStatus}`);
          break;
        }
        if (bar.low <= signal.tp3 && currentTargetsHit < 3) {
          currentStatus = "ALL_TARGETS_HIT"; currentTargetsHit = 3; exitPrice = signal.tp3; outcomeResult = 'WIN';
          break;
        } else if (bar.low <= signal.tp2 && currentTargetsHit < 2) {
          currentStatus = "TP2_HIT"; currentTargetsHit = 2; exitPrice = signal.tp2;
        } else if (bar.low <= signal.tp1 && currentTargetsHit < 1) {
          currentStatus = "TP1_HIT"; currentTargetsHit = 1; exitPrice = signal.tp1;
          if (breakevenActive) breakevenReached = true;
        }
        if (breakevenActive && currentTargetsHit >= 2 && bar.high >= postTP2StopPrice && currentTargetsHit < 3) {
          currentStatus = "PARTIAL_WIN_SL_HIT"; currentTargetsHit = Math.max(currentTargetsHit, 2);
          exitPrice = getProtectedExitPrice(signal, currentTargetsHit); outcomeResult = 'WIN';
          break;
        }
      }
    }
  }

  return { status: currentStatus, targetsHit: currentTargetsHit, exitPrice, outcome: outcomeResult, breakevenReached, events };
}

function toTradingSignal(row: EmittedRow, breakevenPolicy: boolean, overrides?: { targetsHit?: number; status?: SignalStatus }): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    type: row.direction as SignalType,
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    sl: Number(row.sl),
    slMultiplier: row.sl_multiplier ?? 1,
    confidence: row.confidence ?? 0.8,
    status: overrides?.status ?? 'ACTIVE',
    targetsHit: overrides?.targetsHit ?? 0,
    entryTime: row.emitted_at,
    topFeatures: [],
    riskJustification: '',
    createdAt: Date.parse(row.emitted_at),
    breakevenPolicy,
  };
}

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log('── ITEM 1 REPLAY — same-bar TP/SL disambiguation (read-only) ──');

  // 1. The failing signals (2026-09-14 emissions).
  const { data: sigRows, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, sl_multiplier, atr, htf_trend, ltf_trend, rsi')
    .gte('emitted_at', '2026-09-14T00:00:00Z')
    .lt('emitted_at', '2026-09-15T00:00:00Z')
    .order('emitted_at', { ascending: true });
  if (sigErr) throw new Error(`signal fetch: ${sigErr.message}`);
  const signals = (sigRows ?? []) as EmittedRow[];
  console.log(`\n2026-09-14 emissions (${signals.length}):`);
  for (const s of signals) {
    console.log(`  ${s.emitted_at} ${s.direction} @ ${Number(s.entry).toFixed(1)} sl ${Number(s.sl).toFixed(1)} tp3 ${Number(s.tp3).toFixed(1)} | htf ${s.htf_trend ?? '—'} ltf ${s.ltf_trend ?? '—'} rsi ${s.rsi ?? '—'}`);
  }

  // The prompt's #2 is cited as SELL @ 4277.3; the persisted row is 4277.2
  // (13:53:25.246Z, sl 4286.2, tp3 4269.2 — prices match #2's SL/TP3 exactly).
  // Replay EVERY 2026-09-14 SELL so no entry-price guess can drop one.
  const replayTargets = signals.filter(s => s.direction === 'SELL');
  if (replayTargets.length === 0) {
    console.log('No matching SELL signals found — nothing to replay.');
    return;
  }

  // 2. Bars covering the replay window.
  const { data: barRows, error: barErr } = await client
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', '2026-09-14T13:00:00Z')
    .lt('timestamp', '2026-09-15T00:00:00Z')
    .order('timestamp', { ascending: true })
    .limit(2000);
  if (barErr) throw new Error(`bar fetch: ${barErr.message}`);
  const bars: Bar[] = (barRows ?? []).map(r => ({
    timestamp: Date.parse(r.timestamp),
    open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
  }));
  console.log(`\nBars: ${bars.length} M1 (${new Date(bars[0]?.timestamp ?? 0).toISOString()} → ${new Date(bars[bars.length - 1]?.timestamp ?? 0).toISOString()})`);

  // 3. Replay each failing signal through all three instruments, both policies.
  for (const row of replayTargets) {
    console.log(`\n${'='.repeat(76)}`);
    console.log(`SIGNAL ${row.signal_id.slice(-9)} — ${row.direction} @ ${Number(row.entry).toFixed(1)} (${row.emitted_at})`);
    console.log(`  tp1 ${Number(row.tp1).toFixed(1)} | tp2 ${Number(row.tp2).toFixed(1)} | tp3 ${Number(row.tp3).toFixed(1)} | sl ${Number(row.sl).toFixed(1)}`);
    for (const policy of [false, true] as const) {
      const label = policy ? 'breakevenPolicy TRUE (protected)' : 'breakevenPolicy FALSE (off — production-evidence state: SL_HIT requires it)';
      console.log(`\n  ── policy: ${label}`);
      const sig = toTradingSignal(row, policy);
      const pre = monitorResolve(sig, bars, false);
      const patched = monitorResolve(sig, bars, true);
      const resolver = resolveSignalWithBars(toTradingSignal(row, policy), bars, { fromScratch: true });
      const recorded = monitorResolve(toTradingSignal(row, policy, { targetsHit: 3, status: 'TP2_HIT' }), bars, true);
      console.log(`  PRE-FIX monitor (SL-first):        ${pre.status} targets=${pre.targetsHit} exit=${pre.exitPrice.toFixed(1)} outcome=${pre.outcome}`);
      for (const e of pre.events) console.log(`     ${e}`);
      console.log(`  PATCHED monitor (Part A + Part B): ${patched.status} targets=${patched.targetsHit} exit=${patched.exitPrice.toFixed(1)} outcome=${patched.outcome}`);
      for (const e of patched.events) console.log(`     ${e}`);
      console.log(`  PATCHED, entering targetsHit=3 (production recorded state): ${recorded.status} exit=${recorded.exitPrice.toFixed(1)} outcome=${recorded.outcome}`);
      console.log(`  Resolver fromScratch cross-check:  ${resolver.newStatus} targets=${resolver.targetsHit} exit=${resolver.exitPrice.toFixed(1)} outcome=${resolver.outcomeResult}`);
    }
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
