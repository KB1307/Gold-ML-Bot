/**
 * P-1 BAR-EVIDENCE CORRECTION GATE + P-3 support — proof with the REAL resolver.
 *
 * Proves (signalResolver.shouldApplyBarEvidenceCorrection + resolveSignalWithBars):
 *   G1. corruption fingerprint (stored SL_HIT / 0 targets) + tape-disagreeing WIN
 *       replay  -> correction fires
 *   G2. honest SL-first loss (the tape agrees)  -> NO correction, byte-identical
 *   G3. already-ruled stamp  -> never fires again (one-shot per signal)
 *   G4. any stored state with banked targets or a non-SL_HIT status  -> never fires
 *   G5. replay without a concrete WIN (null outcome / SL_HIT status)  -> never fires
 *   R1/R2. the real resolver reproduces both scenarios end-to-end.
 * READ-ONLY; no DB access.
 */
import { resolveSignalWithBars, shouldApplyBarEvidenceCorrection } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

let pass = 0; let fail = 0;
function expect(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  ✅ ${name}: ${JSON.stringify(actual)}`); }
  else { fail += 1; console.log(`  ❌ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function makeSignal(type: 'BUY' | 'SELL', overrides: Partial<TradingSignal> = {}): TradingSignal {
  const createdAt = Date.parse('2026-09-01T10:00:00Z');
  return {
    id: 'test_bar_evidence',
    timestamp: new Date(createdAt),
    createdAt,
    type,
    entryPrice: 4400,
    entryPriceWithSlippage: 4400,
    tp1: 4410,
    tp2: 4430,
    tp3: 4445,
    sl: 4390,
    confidence: 0.75,
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    breakevenReached: false,
    ...overrides,
  } as unknown as TradingSignal;
}

function bar(minOffset: number, open: number, high: number, low: number, close: number): Bar {
  return { timestamp: Date.parse('2026-09-01T10:00:00Z') + minOffset * 60_000, open, high, low, close };
}

console.log('— G-series: gate helper, synthetic states —');
const winReplay = { newStatus: 'SL_AFTER_BE' as SignalStatus, outcomeResult: 'WIN' as const, exitPrice: 4403.5 };
const lossReplay = { newStatus: 'SL_HIT' as SignalStatus, outcomeResult: 'LOSS' as const, exitPrice: 4390 };
const fingerprint = { status: 'SL_HIT' as SignalStatus, targetsHit: 0 };
expect('G1 fingerprint + disagreeing WIN replay -> fires', shouldApplyBarEvidenceCorrection(fingerprint, winReplay), true);
expect('G2 honest loss (tape agrees) -> no correction', shouldApplyBarEvidenceCorrection(fingerprint, lossReplay), false);
expect('G3 already ruled -> never fires again', shouldApplyBarEvidenceCorrection({ ...fingerprint, barEvidenceCorrectedAt: Date.now() }, winReplay), false);
expect('G4a banked targets stored -> never fires', shouldApplyBarEvidenceCorrection({ status: 'SL_HIT' as SignalStatus, targetsHit: 1 }, winReplay), false);
expect('G4b non-SL_HIT stored -> never fires', shouldApplyBarEvidenceCorrection({ status: 'PARTIAL_WIN_SL_HIT' as SignalStatus, targetsHit: 0 }, winReplay), false);
expect('G5a null-outcome replay -> never fires', shouldApplyBarEvidenceCorrection(fingerprint, { newStatus: 'CLOSED' as SignalStatus, outcomeResult: null, exitPrice: 4400 }), false);
expect('G5b WIN result on an SL_HIT replay status -> never fires', shouldApplyBarEvidenceCorrection(fingerprint, { newStatus: 'SL_HIT' as SignalStatus, outcomeResult: 'WIN' as const, exitPrice: 4390 }), false);

console.log('\n— R1: REAL resolver, corruption geometry (TP1 banked first, SL later) —');
const corruptionBars = [
  bar(3, 4402, 4416, 4398, 4414), // entry 4400 touched, TP1 4410 touched, SL untouched
  bar(8, 4402, 4405, 4388, 4389), // deep breach through the 0.35R lock (4403.5)
];
const corruptionReplay = resolveSignalWithBars(makeSignal('BUY'), corruptionBars, { fromScratch: true, evalNowMs: Date.parse('2026-09-01T18:00:00Z') });
expect('R1 replay status', corruptionReplay.newStatus, 'SL_AFTER_BE');
expect('R1 replay outcome', corruptionReplay.outcomeResult, 'WIN');
expect('R1 replay exit = 0.35R lock', corruptionReplay.exitPrice, 4403.5);
expect('R1 gate fires for stored SL_HIT/0-TP', shouldApplyBarEvidenceCorrection({ status: 'SL_HIT' as SignalStatus, targetsHit: 0 }, corruptionReplay), true);

console.log('\n— R2: REAL resolver, honest SL-first geometry (904 class) —');
const honestBars = [
  bar(3, 4398, 4401, 4388, 4392), // entry touched AND SL breached first (conservative same-bar rule)
  bar(12, 4408, 4412, 4405, 4410), // TP1 only touched AFTER the stop — irrelevant, trade dead
];
const honestReplay = resolveSignalWithBars(makeSignal('BUY'), honestBars, { fromScratch: true, evalNowMs: Date.parse('2026-09-01T18:00:00Z') });
expect('R2 replay status (SL first)', honestReplay.newStatus, 'SL_HIT');
expect('R2 replay outcome', honestReplay.outcomeResult, 'LOSS');
expect('R2 replay exit = original SL', honestReplay.exitPrice, 4390);
expect('R2 gate refuses to correct an honest loss', shouldApplyBarEvidenceCorrection({ status: 'SL_HIT' as SignalStatus, targetsHit: 0 }, honestReplay), false);

console.log(`\n${'='.repeat(78)}`);
console.log(fail === 0 ? `✅ ALL ${pass} ASSERTIONS PASSED` : `❌ ${fail} FAILED / ${pass} passed`);
console.log('='.repeat(78));
if (fail > 0) process.exit(1);
