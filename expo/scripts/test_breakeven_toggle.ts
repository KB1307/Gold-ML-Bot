/**
 * TEST — SETTINGS TOGGLE: the Breakeven function ON vs OFF.
 *
 * Runs the REAL resolveSignalWithBars (the same function the live monitor and
 * the canonical book use) on IDENTICAL bars, differing ONLY by
 * opts.breakevenEnabled. Proves:
 *   1. breakevenEnabled: true  → post-TP1 +0.35R profit lock and post-TP2
 *      entry stop engage (SL_AFTER_BE / PARTIAL_WIN_SL_HIT, WIN).
 *   2. breakevenEnabled: false → the ORIGINAL SL applies at every stage: the
 *      same bars resolve SL_HIT LOSS at the original SL.
 *   3. Omitting the opt (default) behaves exactly like enabled.
 *   4. A stored breakevenReached=true flag CANNOT re-engage protection while
 *      the toggle is off.
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
console.log('TEST — BREAKEVEN TOGGLE: settings flag → resolveSignalWithBars behaviour');
console.log('═'.repeat(78));

console.log('\n— SCENARIO A: post-TP1 profit lock (TP1 banked, then dip to 4402, then SL) —');
const aOn = resolveSignalWithBars(makeSignal(), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[A on] ', breakevenEnabled: true });
console.log(`  enabled  → status=${aOn.newStatus} outcome=${aOn.outcomeResult} exit=${aOn.exitPrice} be=${aOn.breakevenReached}`);
expect('A enabled status', aOn.newStatus, 'SL_AFTER_BE');
expect('A enabled outcome', aOn.outcomeResult, 'WIN');
expect('A enabled exit (0.35R lock)', aOn.exitPrice, 4403.5);
expect('A enabled breakevenReached', aOn.breakevenReached, true);

const aDefault = resolveSignalWithBars(makeSignal(), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[A def]' });
expect('A default(no opt) == enabled', `${aDefault.newStatus}/${aDefault.outcomeResult}/${aDefault.exitPrice}`, `${aOn.newStatus}/${aOn.outcomeResult}/${aOn.exitPrice}`);

const aOff = resolveSignalWithBars(makeSignal(), barsA, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[A off]', breakevenEnabled: false });
console.log(`  disabled → status=${aOff.newStatus} outcome=${aOff.outcomeResult} exit=${aOff.exitPrice} be=${aOff.breakevenReached}`);
expect('A disabled status', aOff.newStatus, 'SL_HIT');
expect('A disabled outcome', aOff.outcomeResult, 'LOSS');
expect('A disabled exit (original SL)', aOff.exitPrice, 4390);
expect('A disabled breakevenReached', aOff.breakevenReached, false);

console.log('\n— SCENARIO B: post-TP2 entry stop (TP1+TP2 banked, return to entry, then SL) —');
const bOn = resolveSignalWithBars(makeSignal(), barsB, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[B on] ', breakevenEnabled: true });
console.log(`  enabled  → status=${bOn.newStatus} outcome=${bOn.outcomeResult} exit=${bOn.exitPrice}`);
expect('B enabled status', bOn.newStatus, 'PARTIAL_WIN_SL_HIT');
expect('B enabled outcome', bOn.outcomeResult, 'WIN');
expect('B enabled exit (protected)', bOn.exitPrice, 4405.8);

const bOff = resolveSignalWithBars(makeSignal(), barsB, { fromScratch: true, evalNowMs: EVAL_NOW, logPrefix: '[B off]', breakevenEnabled: false });
console.log(`  disabled → status=${bOff.newStatus} outcome=${bOff.outcomeResult} exit=${bOff.exitPrice}`);
expect('B disabled status', bOff.newStatus, 'SL_HIT');
expect('B disabled outcome', bOff.outcomeResult, 'LOSS');
expect('B disabled exit (original SL)', bOff.exitPrice, 4390);

console.log('\n— SCENARIO C: stored breakevenReached=true cannot re-engage protection while OFF —');
const seedBars = [bar(4, 4403, 4403.5, 4389.4, 4390.5)];
const cOn = resolveSignalWithBars(
  makeSignal({ status: 'TP1_HIT', targetsHit: 1, breakevenReached: true }),
  seedBars, { fromScratch: false, evalNowMs: EVAL_NOW, logPrefix: '[C on] ', breakevenEnabled: true },
);
expect('C enabled (stored be=true) → protected', `${cOn.newStatus}/${cOn.outcomeResult}`, 'SL_AFTER_BE/WIN');
const cOff = resolveSignalWithBars(
  makeSignal({ status: 'TP1_HIT', targetsHit: 1, breakevenReached: true }),
  seedBars, { fromScratch: false, evalNowMs: EVAL_NOW, logPrefix: '[C off]', breakevenEnabled: false },
);
expect('C disabled (stored be=true ignored) → plain loss', `${cOff.newStatus}/${cOff.outcomeResult}/${cOff.exitPrice}`, 'SL_HIT/LOSS/4390');

console.log('\n' + '═'.repeat(78));
console.log(failures === 0 ? `✅ ALL ASSERTIONS PASSED — the toggle reaches the resolver and changes its outcome.` : `❌ ${failures} ASSERTION(S) FAILED`);
console.log('═'.repeat(78));
process.exit(failures === 0 ? 0 : 1);
