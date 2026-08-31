/**
 * TEST — POST-TP2 STOP LEVEL: the stop sits at TP1 for stamped signals.
 *
 * Runs the REAL resolveSignalWithBars (the same function the live monitor and
 * the canonical book use). The post-TP2 stop level is FROZEN onto each signal
 * at emission (signal.postTP2StopLevel = 'tp1', stamped by TradingContext next
 * to breakevenPolicy). A signal WITHOUT the stamp — every signal emitted
 * before this change — resolves with the ORIGINAL entry-level stop and the
 * ORIGINAL breakeven-weighted exit, byte-identically. Proves:
 *   1. Stamped 'tp1': a post-TP2 retrace that touches TP1 (but never entry)
 *      closes the runner as PARTIAL_WIN_SL_HIT @ TP1 — the stop moved further
 *      into the trade.
 *   2. Stamped 'tp1': a deep retrace THROUGH entry exits at TP1 (better than
 *      the legacy breakeven-weighted exit).
 *   3. Same-bar TP2-bank + retrace, and the same-bar SL-closer (TP3 vs stop)
 *      branches both honour the TP1 stop.
 *   4. breakevenPolicy:false dominates — a 'tp1' stamp CANNOT protect a signal
 *      whose Breakeven policy is OFF (original SL applies).
 *   5. No-stamp (ALL pre-change history): the same bars resolve exactly the
 *      legacy way (entry-level stop, breakeven-weighted exit) — past outcomes
 *      are never rewritten.
 *
 * Geometry (BUY): entry 4400, SL 4390 (risk 10), TP1 4410 (+1R), TP2 4430,
 * TP3 4445. Legacy post-TP2 weighted exit = (4410+4430+4400)/3 = 4413.3.
 * Post-TP1 lock = 4403.5.
 * Geometry (SELL): entry 4400, SL 4410, TP1 4390, TP2 4375, TP3 4360.
 * Legacy weighted exit = (4390+4375+4400)/3 = 4388.3.
 * READ-ONLY: no Supabase, no writes, no live behaviour change.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';

const BASE = Date.UTC(2026, 7, 31, 12, 0, 0);
const MIN = 60_000;

function makeSignal(type: 'BUY' | 'SELL', overrides: Partial<TradingSignal> = {}): TradingSignal {
  const buy = type === 'BUY';
  return {
    id: 'post_tp2_stop_test',
    timestamp: new Date(BASE),
    createdAt: BASE,
    type,
    entryPrice: 4400,
    entryPriceWithSlippage: 4400,
    tp1: buy ? 4410 : 4390,
    tp2: buy ? 4430 : 4375,
    tp3: buy ? 4445 : 4360,
    sl: buy ? 4390 : 4410,
    confidence: 0.8,
    status: 'ACTIVE',
    targetsHit: 0,
    breakevenReached: false,
    ...overrides,
  } as unknown as TradingSignal;
}

const bar = (offsetMin: number, o: number, h: number, l: number, c: number) =>
  ({ timestamp: BASE + offsetMin * MIN, open: o, high: h, low: l, close: c });

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`);
}

console.log('═'.repeat(78));
console.log('TEST — POST-TP2 STOP LEVEL: stop sits at TP1 for stamped signals (past immutable)');
console.log('═'.repeat(78));

// — S1: shallow post-TP2 retrace touches TP1 but never entry —
console.log('\n— S1 BUY, runner after TP2: retrace touches 4409 (TP1 4410, entry 4400 untouched) —');
const s1Stamped = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4420, 4425, 4409, 4412)]);
expect('S1 stamped status', s1Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S1 stamped outcome', s1Stamped.outcomeResult, 'WIN');
expect('S1 stamped exit = TP1', s1Stamped.exitPrice, 4410);

const s1Legacy = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), [bar(4, 4420, 4425, 4409, 4412)]);
expect('S1 legacy stays open (entry never touched)', `${s1Legacy.newStatus}/${s1Legacy.outcomeResult}`, 'TP2_HIT/null');

// — S2: deep retrace THROUGH entry —
console.log('\n— S2 BUY, retrace through entry (low 4398): stamped exits at TP1, legacy at weighted 4413.3 —');
const s2Stamped = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4415, 4420, 4398, 4400)]);
expect('S2 stamped status', s2Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S2 stamped exit = TP1 (further into the trade)', s2Stamped.exitPrice, 4410);

const s2Legacy = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), [bar(4, 4415, 4420, 4398, 4400)]);
expect('S2 legacy status', s2Legacy.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S2 legacy outcome', s2Legacy.outcomeResult, 'WIN');
expect('S2 legacy exit = breakeven-weighted (unchanged)', s2Legacy.exitPrice, 4413.3);

// — S3: same bar banks TP2 and retraces through the stop —
console.log('\n— S3 BUY, one bar banks TP2 (4431) and retraces to 4399 —');
const s3Stamped = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP1_HIT', targetsHit: 1, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4425, 4431, 4399, 4410)]);
expect('S3 stamped status', s3Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S3 stamped exit = TP1', s3Stamped.exitPrice, 4410);

const s3Legacy = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP1_HIT', targetsHit: 1, breakevenReached: true,
}), [bar(4, 4425, 4431, 4399, 4410)]);
expect('S3 legacy status', s3Legacy.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S3 legacy exit = breakeven-weighted (unchanged)', s3Legacy.exitPrice, 4413.3);

// — S4: same-bar SL-closer branch (TP3 vs the post-TP2 stop) —
console.log('\n— S4 BUY, bar spans TP3 (4446) and the stop (4409); stop side closer to open —');
const s4Stamped = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4415, 4446, 4409, 4420)]);
expect('S4 stamped status', s4Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S4 stamped exit = TP1', s4Stamped.exitPrice, 4410);

const s4Legacy = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), [bar(4, 4415, 4446, 4409, 4420)]);
// Legacy: the entry-level stop (4400) is never touched (low 4409), so NO
// protection fires and the bar's TP3 banks exactly as it always did.
expect('S4 legacy status (no breach at entry — runs to TP3)', s4Legacy.newStatus, 'ALL_TARGETS_HIT');
expect('S4 legacy exit = TP3 (unchanged)', s4Legacy.exitPrice, 4445);

// — S5: the tp1 stamp CANNOT protect a signal whose Breakeven policy is OFF —
console.log('\n— S5 BUY, breakevenPolicy:false + postTP2StopLevel:\'tp1\': original SL applies —');
const s5 = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
  breakevenPolicy: false, postTP2StopLevel: 'tp1',
}), [bar(4, 4415, 4420, 4409, 4412), bar(5, 4400, 4401, 4389.4, 4390)]);
expect('S5 status (no protection despite the tp1 stamp)', s5.newStatus, 'SL_HIT');
expect('S5 outcome', s5.outcomeResult, 'LOSS');
expect('S5 exit = original SL', s5.exitPrice, 4390);

// — S6/S7: SELL mirror —
console.log('\n— S6 SELL, runner after TP2: retrace touches 4391 (TP1 4390, entry 4400 untouched) —');
const s6Stamped = resolveSignalWithBars(makeSignal('SELL', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4385, 4391, 4380, 4385)]);
expect('S6 stamped status', s6Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S6 stamped exit = TP1', s6Stamped.exitPrice, 4390);

const s6Legacy = resolveSignalWithBars(makeSignal('SELL', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), [bar(4, 4385, 4391, 4380, 4385)]);
expect('S6 legacy stays open (entry never touched)', `${s6Legacy.newStatus}/${s6Legacy.outcomeResult}`, 'TP2_HIT/null');

console.log('\n— S7 SELL, deep retrace through entry (high 4402): stamped 4390, legacy 4388.3 —');
const s7Stamped = resolveSignalWithBars(makeSignal('SELL', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true, postTP2StopLevel: 'tp1',
}), [bar(4, 4395, 4402, 4390, 4398)]);
expect('S7 stamped status', s7Stamped.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S7 stamped exit = TP1', s7Stamped.exitPrice, 4390);

const s7Legacy = resolveSignalWithBars(makeSignal('SELL', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), [bar(4, 4395, 4402, 4390, 4398)]);
expect('S7 legacy status', s7Legacy.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('S7 legacy outcome', s7Legacy.outcomeResult, 'WIN');
expect('S7 legacy exit = breakeven-weighted (unchanged)', s7Legacy.exitPrice, 4388.3);

// — S8: SCENARIO L — legacy re-resolve is byte-identical (immutability) —
console.log('\n— S8 BUY no-stamp: resolving twice is byte-identical (past outcomes immutable) —');
const s8Bars = [bar(4, 4415, 4420, 4398, 4400), bar(5, 4395, 4396, 4389.4, 4390)];
const s8First = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), s8Bars);
const s8Second = resolveSignalWithBars(makeSignal('BUY', {
  status: 'TP2_HIT', targetsHit: 2, breakevenReached: true,
}), s8Bars);
expect('S8 byte-identical re-resolve',
  JSON.stringify({ s: s8First.newStatus, o: s8First.outcomeResult, e: s8First.exitPrice }),
  JSON.stringify({ s: s8Second.newStatus, o: s8Second.outcomeResult, e: s8Second.exitPrice }));
expect('S8 legacy resolves the legacy way', `${s8First.newStatus}/${s8First.outcomeResult}`, 'PARTIAL_WIN_SL_HIT/WIN');

console.log('\n' + '═'.repeat(78));
console.log(failures === 0 ? '✅ ALL ASSERTIONS PASSED' : `❌ ${failures} ASSERTION(S) FAILED`);
console.log('═'.repeat(78));
process.exit(failures === 0 ? 0 : 1);
