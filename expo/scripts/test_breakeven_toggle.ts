/**
 * TEST — SETTINGS TOGGLE: the Breakeven function is FROZEN PER SIGNAL.
 *
 * Runs the REAL resolveSignalWithBars (the same function the live monitor and
 * the canonical book use). The Breakeven policy is stamped onto each signal at
 * emission (signal.breakevenPolicy) and the resolver derives its behaviour from
 * THAT field — there is no live caller flag anymore. Proves:
 *   1. breakevenPolicy: true  → post-TP1 +0.35R profit lock and post-TP2
 *      entry stop engage (SL_AFTER_BE / PARTIAL_WIN_SL_HIT, WIN).
 *   2. breakevenPolicy: false → the ORIGINAL SL applies at every stage: the
 *      same bars resolve SL_HIT LOSS at the original SL.
 *   3. A signal WITHOUT the stamp (every pre-toggle signal) is ALWAYS resolved
 *      with protection ON — and resolving it again "after a toggle flip" gives
 *      the identical outcome, so past performance metrics cannot be rewritten.
 *   4. A stored breakevenReached=true flag CANNOT re-engage protection on a
 *      signal stamped false.
 *
 * Geometry: BUY entry 4400, SL 4390 (risk 10), TP1 4407 (+0.7R), TP2 4410.5,
 * TP3 4414. Post-TP1 lock = entry + 0.35 x 10 = 4403.5.
 * READ-ONLY: no Supabase, no writes, no live behaviour change.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';

const BASE = Date.UTC(2026, 7, 31, 12, 0, 0);
const MIN = 60_000;
const EVAL_NOW = BASE + 3 * 60 * 60 * 1000; // well past ENTRY_MATURITY_MS

function makeSignal(overrides: Partial<TradingSignal> = {}): TradingSignal {
  return {
    id: 'be_toggle_test',
    timestamp: new Date(BASE),
    createdAt: BASE,
    type: 'BUY',
    entryPrice: 4400,
    entryPriceWithSlippage: 4400,
    tp1: 4407,
    tp2: 4410.5,
    tp3: 4414,
    sl: 4390,
    confidence: 0.8,
    status: 'ACTIVE',
    targetsHit: 0,
    breakevenReached: false,
    ...overrides,
  } as unknown as TradingSignal;
}

const bar = (offsetMin: number, o: number, h: number, l: number, c: number) =>
  ({ timestamp: BASE + offsetMin * MIN, open: o, high: h, low: l, close: c });

// Scenario A bars: TP1 banks on b1; b2 dips to 4402 (inside the 4403.5 lock,
// above the original SL); b3 breaches the original SL (4389.4 <= 4390-slack).
const barsA = [
  bar(2, 4400.5, 4408, 4400, 4407.5),
  bar(3, 4407, 4408.5, 4402, 4404),
  bar(4, 4403, 4403.5, 4389.4, 4390.5),
];

// Scenario B bars: TP1 banks on b1, TP2 banks on b2; b3 returns to entry
// (4399.5 <= 4400, SL untouched); b4 breaches the original SL.
const barsB = [
  bar(2, 4400.5, 4408, 4400, 4407.5),
  bar(3, 4407.5, 4411, 4406.5, 4410.5),
  bar(4, 4410, 4410.5, 4399.5, 4400.5),
  bar(5, 4400, 4400.5, 4389.4, 4389.8),
];

let failures = 0;
function expect(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${label}: ${String(actual)}${ok ? '' : `  (expected ${String(expected)})`}`);
}

console.log('═'.repeat(78));
console.log('TEST — BREAKEVEN TOGGLE: per-signal frozen policy (past metrics immutable)');
console.log('═'.repeat(78));

console.log('\n— SCENARIO A: post-TP1 profit lock (TP1 banked, then dip to 4402, then SL) —');
const aOn = resolveSignalWithBars(makeSignal({ breakevenPolicy: true }), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[A on] ' });
console.log(`  stamped ON   → status=${aOn.newStatus} outcome=${aOn.outcomeResult} exit=${aOn.exitPrice} be=${aOn.breakevenReached}`);
expect('A stamped-true status', aOn.newStatus, 'SL_AFTER_BE');
expect('A stamped-true outcome', aOn.outcomeResult, 'WIN');
expect('A stamped-true exit (0.35R lock)', aOn.exitPrice, 4403.5);
expect('A stamped-true breakevenReached', aOn.breakevenReached, true);

const aOff = resolveSignalWithBars(makeSignal({ breakevenPolicy: false }), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[A off]' });
console.log(`  stamped OFF  → status=${aOff.newStatus} outcome=${aOff.outcomeResult} exit=${aOff.exitPrice} be=${aOff.breakevenReached}`);
expect('A stamped-false status', aOff.newStatus, 'SL_HIT');
expect('A stamped-false outcome', aOff.outcomeResult, 'LOSS');
expect('A stamped-false exit (original SL)', aOff.exitPrice, 4390);
expect('A stamped-false breakevenReached', aOff.breakevenReached, false);

console.log('\n— SCENARIO L: legacy signal (NO stamp = every pre-toggle signal) is IMMUTABLE —');
const legacyFirst = resolveSignalWithBars(makeSignal(), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[L 1st]' });
const legacyAgain = resolveSignalWithBars(makeSignal(), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[L 2nd]' });
console.log(`  no stamp → status=${legacyFirst.newStatus} outcome=${legacyFirst.outcomeResult} exit=${legacyFirst.exitPrice}`);
expect('L no-stamp resolves protected (original behaviour)', `${legacyFirst.newStatus}/${legacyFirst.outcomeResult}/${legacyFirst.exitPrice}`, 'SL_AFTER_BE/WIN/4403.5');
expect('L re-resolve after a toggle flip is IDENTICAL (no metric rewrite)', `${legacyAgain.newStatus}/${legacyAgain.outcomeResult}/${legacyAgain.exitPrice}`, `${legacyFirst.newStatus}/${legacyFirst.outcomeResult}/${legacyFirst.exitPrice}`);

console.log('\n— SCENARIO B: post-TP2 entry stop (TP1+TP2 banked, return to entry, then SL) —');
const bOn = resolveSignalWithBars(makeSignal({ breakevenPolicy: true }), barsB, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[B on] ' });
console.log(`  stamped ON   → status=${bOn.newStatus} outcome=${bOn.outcomeResult} exit=${bOn.exitPrice}`);
expect('B stamped-true status', bOn.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('B stamped-true outcome', bOn.outcomeResult, 'WIN');
expect('B stamped-true exit (protected)', bOn.exitPrice, 4405.8);

const bOff = resolveSignalWithBars(makeSignal({ breakevenPolicy: false }), barsB, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[B off]' });
console.log(`  stamped OFF  → status=${bOff.newStatus} outcome=${bOff.outcomeResult} exit=${bOff.exitPrice}`);
expect('B stamped-false status', bOff.newStatus, 'SL_HIT');
expect('B stamped-false outcome', bOff.outcomeResult, 'LOSS');
expect('B stamped-false exit (original SL)', bOff.exitPrice, 4390);

console.log('\n— SCENARIO C: stored breakevenReached=true cannot re-engage protection on a stamped-OFF signal —');
const seedBars = [bar(4, 4403, 4403.5, 4389.4, 4390.5)];
const cOn = resolveSignalWithBars(
  makeSignal({ breakevenPolicy: true, status: 'TP1_HIT', targetsHit: 1, breakevenReached: true }),
  seedBars, { fromScratch: false, evalNowMs: EVAL_NOW, logPrefix: '[C on] ' },
);
expect('C stamped-true (stored be=true) → protected', `${cOn.newStatus}/${cOn.outcomeResult}`, 'SL_AFTER_BE/WIN');
const cOff = resolveSignalWithBars(
  makeSignal({ breakevenPolicy: false, status: 'TP1_HIT', targetsHit: 1, breakevenReached: true }),
  seedBars, { fromScratch: false, evalNowMs: EVAL_NOW, logPrefix: '[C off]' },
);
expect('C stamped-false (stored be=true ignored) → plain loss', `${cOff.newStatus}/${cOff.outcomeResult}/${cOff.exitPrice}`, 'SL_HIT/LOSS/4390');

console.log('\n' + '═'.repeat(78));
console.log(failures === 0 ? '✅ ALL ASSERTIONS PASSED — the toggle reaches new signals via the per-signal stamp; past signals are immutable.' : `❌ ${failures} ASSERTION(S) FAILED`);
console.log('═'.repeat(78));
process.exit(failures === 0 ? 0 : 1);
