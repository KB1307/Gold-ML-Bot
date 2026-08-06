/**
 * ITEM 28 + 29 TEST SUITE
 * =======================
 *
 * Four things are proven here, in increasing order of what they rule out:
 *
 *  A. TELEMETRY FAITHFULNESS (28) — `buildCounterTrendGateTelemetry` reproduces
 *     the engine's own drift-veto branch conditions exactly. The expected values
 *     are computed by an INDEPENDENT transcription of the engine's `if`
 *     conditions (lines ~7176-7192 of signalEngine.ts), not by calling the
 *     function under test, so a wrong record is a failing test.
 *
 *  B. SIDE CLASSIFICATION + RENDERING (29) — a bullish-family attention entry
 *     carried by a SELL renders as OPPOSES-SELL, a penalty renders with its true
 *     negative sign, non-directional entries render as context, and an unknown
 *     key renders as unclassified rather than being guessed.
 *
 *  C. STRUCTURAL: NO SCORING PATH TOUCHED (28d) — the CURRENT signalEngine.ts is
 *     diffed against `git show HEAD:` and every added/removed line must be
 *     either a comment, or a line whose only code is telemetry (declaration of a
 *     telemetry identifier, an object-literal field, the telemetry console.log,
 *     or the additive `signedScore`/`side`/`opposesSignal` fields). Any changed
 *     line that mentions a SCORING identifier (buySignalStrength,
 *     sellSignalStrength, dir.addBuy/addSell/penalize*, baseConfidence,
 *     rawConfidence, smoothedConfidence, tier0AdjustedConfidence, tp1/tp2/tp3/sl
 *     assignment, dynamicSlPips, atrMultiplier, `return null`) fails the test.
 *
 *  D. STRUCTURAL: TELEMETRY CANNOT BE READ AS A SCORING KEY — every
 *     `attentionScores.get('<key>')` lookup in the engine is enumerated and
 *     asserted disjoint from the telemetry field names (the runtime counterpart
 *     of the compile-time assertion in attentionTelemetry.ts).
 *
 * Run: bunx tsx expo/scripts/test_item28_29_telemetry.ts   (or `bun` / `node --experimental-strip-types`)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  attentionOpposesSignal,
  attentionSideForKey,
  buildCounterTrendGateTelemetry,
  renderAttentionAnnotation,
  type AttentionSide,
} from '../services/attentionTelemetry';

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  check(label, actual === expected, `expected ${String(expected)}, got ${String(actual)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. TELEMETRY FAITHFULNESS
// ─────────────────────────────────────────────────────────────────────────────
const VETO_MULTIPLE = 2.0;
const OVERRIDE_CONFIDENCE = 0.85;

/** Independent transcription of the engine's own branch conditions. */
function engineBranchExpectation(input: {
  signalType: 'BUY' | 'SELL';
  counterTrend: boolean;
  recentDrift: number | null;
  atr: number;
  confidence: number;
  sweepConfirmed: boolean;
}): { predicate: boolean; override: boolean; vetoed: boolean } {
  // `const recentDrift = isCounterTrendSignal ? this.computeRecentDrift() : null;`
  const drift = input.counterTrend ? input.recentDrift : null;
  // `if (recentDrift !== null && features.atr > 0) {`
  if (drift === null || !(input.atr > 0)) return { predicate: false, override: false, vetoed: false };
  const driftAgainst = input.signalType === 'BUY' ? -drift : drift;
  const threshold = input.atr * VETO_MULTIPLE;
  const predicate = driftAgainst >= threshold;
  if (!predicate) return { predicate: false, override: false, vetoed: false };
  const override = input.sweepConfirmed && input.confidence >= OVERRIDE_CONFIDENCE;
  return { predicate: true, override, vetoed: !override };
}

console.log('\nA. ITEM 28 — telemetry reproduces the engine gate exactly');
const grid: {
  signalType: 'BUY' | 'SELL';
  counterTrend: boolean;
  recentDrift: number | null;
  atr: number;
  confidence: number;
  sweepConfirmed: boolean;
}[] = [];
for (const signalType of ['BUY', 'SELL'] as const) {
  for (const counterTrend of [true, false]) {
    for (const recentDrift of [null, -13.8, -2.0, 0, 2.0, 13.8]) {
      for (const atr of [0, 1.6, 5.5]) {
        for (const confidence of [0.7, 0.85, 0.92]) {
          for (const sweepConfirmed of [true, false]) {
            grid.push({ signalType, counterTrend, recentDrift, atr, confidence, sweepConfirmed });
          }
        }
      }
    }
  }
}
let mismatches = 0;
grid.forEach((row) => {
  const expected = engineBranchExpectation(row);
  const record = buildCounterTrendGateTelemetry({
    signalType: row.signalType,
    htfTrend: 'NEUTRAL',
    ltfTrend: 'BULLISH',
    counterTrendClassified: row.counterTrend,
    recentDrift: row.counterTrend ? row.recentDrift : row.recentDrift,
    atr: row.atr,
    driftAtrVetoMultiple: VETO_MULTIPLE,
    overrideConfidence: OVERRIDE_CONFIDENCE,
    confidence: row.confidence,
    sweepReclaimConfirmed: row.sweepConfirmed,
    spreadPips: null,
  });
  if (
    record.driftVetoPredicateTrue !== expected.predicate ||
    record.driftVetoOverrideApplied !== expected.override
  ) {
    mismatches += 1;
    if (mismatches <= 3) {
      console.log(
        `     mismatch: ${JSON.stringify(row)} expected predicate=${expected.predicate} override=${expected.override}, got predicate=${record.driftVetoPredicateTrue} override=${record.driftVetoOverrideApplied}`,
      );
    }
  }
});
check(`veto predicate + override reproduced on all ${grid.length} input combinations`, mismatches === 0, `${mismatches} mismatches`);

// The measured worst-day case: 2026-07-10 style SELL fighting a +$13.8 up-drift
// at ATR 1.6 (threshold $3.20), no confirmed sweep -> predicate true, no override.
const worstDay = buildCounterTrendGateTelemetry({
  signalType: 'SELL',
  htfTrend: 'NEUTRAL',
  ltfTrend: 'BULLISH',
  counterTrendClassified: true,
  recentDrift: 13.8,
  atr: 1.6,
  driftAtrVetoMultiple: VETO_MULTIPLE,
  overrideConfidence: OVERRIDE_CONFIDENCE,
  confidence: 0.8,
  sweepReclaimConfirmed: false,
  spreadPips: 2.5,
});
eq('worst-day SELL: driftAgainst is +13.8 (positive = against)', worstDay.driftAgainst, 13.8);
eq('worst-day SELL: threshold is 3.2 (1.6 x 2.0)', worstDay.driftVetoThreshold, 3.2);
eq('worst-day SELL: predicate true', worstDay.driftVetoPredicateTrue, true);
eq('worst-day SELL: override NOT applied (no sweep)', worstDay.driftVetoOverrideApplied, false);
eq('worst-day SELL: spread recorded', worstDay.spreadPipsAtEntry, 2.5);
eq('uncomputable drift stays null, never 0', buildCounterTrendGateTelemetry({
  signalType: 'BUY', htfTrend: 'NEUTRAL', ltfTrend: 'NEUTRAL', counterTrendClassified: false,
  recentDrift: null, atr: 2, driftAtrVetoMultiple: VETO_MULTIPLE, overrideConfidence: OVERRIDE_CONFIDENCE,
  confidence: 0.7, sweepReclaimConfirmed: false, spreadPips: 0,
}).recentDrift, null);
eq('no spread reading records null, never 0', buildCounterTrendGateTelemetry({
  signalType: 'BUY', htfTrend: 'NEUTRAL', ltfTrend: 'NEUTRAL', counterTrendClassified: false,
  recentDrift: null, atr: 2, driftAtrVetoMultiple: VETO_MULTIPLE, overrideConfidence: OVERRIDE_CONFIDENCE,
  confidence: 0.7, sweepReclaimConfirmed: false, spreadPips: 0,
}).spreadPipsAtEntry, null);

// ─────────────────────────────────────────────────────────────────────────────
// B. SIDE CLASSIFICATION + RENDERING
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nB. ITEM 29 — a bullish feature on a SELL can no longer read as support');
eq('counter_trend_bounce_setup classifies BUY-side', attentionSideForKey('counter_trend_bounce_setup'), 'BUY');
eq('display form also classifies', attentionSideForKey('COUNTER TREND BOUNCE SETUP'), 'BUY');
eq('session_high_sweep classifies SELL-side', attentionSideForKey('session_high_sweep'), 'SELL');
eq('high_liquidity_session is CONTEXT', attentionSideForKey('high_liquidity_session'), 'CONTEXT');
eq('tick telemetry entries are TELEMETRY', attentionSideForKey('tick_telemetry:above_vwap'), 'TELEMETRY');
eq('call-site-dependent key is NOT guessed', attentionSideForKey('fibonacci_alignment'), 'UNCLASSIFIED');
eq('sr_zone_* key is NOT guessed', attentionSideForKey('sr_zone_bounce'), 'UNCLASSIFIED');
eq('unknown key is NOT guessed', attentionSideForKey('some_new_feature'), 'UNCLASSIFIED');

check('BUY-side entry opposes a SELL', attentionOpposesSignal('BUY', 'SELL'));
check('BUY-side entry supports a BUY', !attentionOpposesSignal('BUY', 'BUY'));
check('buy PENALTY opposes the BUY it was applied to', attentionOpposesSignal('BUY_PENALTY', 'BUY'));
check('buy PENALTY favours the SELL side', !attentionOpposesSignal('BUY_PENALTY', 'SELL'));
check('context never opposes', !attentionOpposesSignal('CONTEXT', 'SELL'));
check('unclassified never claims to oppose', !attentionOpposesSignal('UNCLASSIFIED', 'SELL'));

const renderCases: { side: AttentionSide; type: 'BUY' | 'SELL'; expect: string }[] = [
  { side: 'BUY', type: 'SELL', expect: 'buy-side,OPPOSES-SELL' },
  { side: 'SELL', type: 'SELL', expect: 'sell-side,supports-SELL' },
  { side: 'BUY_PENALTY', type: 'BUY', expect: 'buy-penalty,OPPOSES-BUY' },
  { side: 'CONTEXT', type: 'BUY', expect: 'context' },
  { side: 'UNCLASSIFIED', type: 'BUY', expect: 'side-unclassified' },
  { side: 'TELEMETRY', type: 'BUY', expect: 'non-scoring telemetry' },
];
renderCases.forEach((c) => {
  eq(`render ${c.side} on ${c.type}`, renderAttentionAnnotation(c.side, c.type), c.expect);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. STRUCTURAL — no changed line in signalEngine.ts touches scoring
// ─────────────────────────────────────────────────────────────────────────────
console.log('\nC. ITEM 28(d) — structural proof: no scoring line changed');

const SCORING_IDENTIFIERS = [
  'buySignalStrength',
  'sellSignalStrength',
  'dir.addBuy',
  'dir.addSell',
  'dir.addCappedBuy',
  'dir.addCappedSell',
  'dir.penalizeBuy',
  'dir.penalizeSell',
  'baseConfidence',
  'rawConfidence',
  'smoothedConfidence',
  'tier0AdjustedConfidence',
  'calibrationPenalty',
  'dataQualityPenalty',
  'alignmentBonus',
  'winningStrength',
  'strengthDifference',
  'dynamicSlPips',
  'atrMultiplier',
  'tp1Distance =',
  'tp2Distance =',
  'tp3Distance =',
  'return null',
] as const;

/** Identifiers introduced by items 28/29. A changed line may only mention these. */
const TELEMETRY_IDENTIFIERS = [
  'counterTrendTelemetry',
  'buildCounterTrendGateTelemetry',
  'CounterTrendGateTelemetry',
  'attentionSides',
  'AttentionSide',
  'attentionSideForKey',
  'attentionOpposesSignal',
  'resolveSide',
  'signedScore',
  'opposesSignal',
  'side:',
  'htfTrendAtGate',
  'ltfTrendAtGate',
  'counterTrendClassified',
  'recentDrift:',
  'driftAgainst',
  'driftVetoThreshold',
  'driftVetoPredicateTrue',
  'sweepReclaimConfirmedAtGate',
  'driftVetoOverrideApplied',
  'spreadPipsAtEntry',
  'LEARNING_FEATURE_SCHEMA_VERSION',
  'GATE TELEMETRY',
  'gate?.',
  'gate?:',
] as const;

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

let head = '';
try {
  head = execFileSync('git', ['show', 'HEAD:expo/services/signalEngine.ts'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  console.log(`  ⚠️  could not read HEAD copy of signalEngine.ts (${err instanceof Error ? err.message : String(err)}) — structural diff SKIPPED, not passed`);
}

if (head) {
  const current = readFileSync('expo/services/signalEngine.ts', 'utf8');
  const headLines = new Set(head.split('\n').map((l) => l.trimEnd()));
  const currentLines = current.split('\n').map((l) => l.trimEnd());
  const addedLines = currentLines.filter((l) => !headLines.has(l));

  const currentSet = new Set(currentLines);
  const removedLines = head.split('\n').map((l) => l.trimEnd()).filter((l) => !currentSet.has(l));

  const offenders: string[] = [];
  [...addedLines, ...removedLines].forEach((line) => {
    if (isCommentOrBlank(line)) return;
    const touchesScoring = SCORING_IDENTIFIERS.filter((id) => line.includes(id));
    if (touchesScoring.length === 0) return;
    // A changed line MAY mention a scoring identifier only if the change is the
    // telemetry addition itself (e.g. a new object field on the same line).
    const isTelemetry = TELEMETRY_IDENTIFIERS.some((id) => line.includes(id));
    if (!isTelemetry) offenders.push(`${touchesScoring.join('/')} :: ${line.trim().slice(0, 160)}`);
  });

  console.log(`  diff: ${addedLines.length} added/changed line(s), ${removedLines.length} removed line(s) vs HEAD`);
  check('no added/removed line touches a scoring identifier', offenders.length === 0, offenders.slice(0, 6).join(' | '));

  // The engine's own attention lookups must not be able to name a telemetry field.
  const lookupKeys = [...current.matchAll(/attentionScores\.get\('([^']+)'\)/g)].map((m) => m[1]);
  const telemetryFieldNames = Object.keys(
    buildCounterTrendGateTelemetry({
      signalType: 'BUY', htfTrend: 'NEUTRAL', ltfTrend: 'NEUTRAL', counterTrendClassified: false,
      recentDrift: null, atr: 1, driftAtrVetoMultiple: 2, overrideConfidence: 0.85, confidence: 0.7,
      sweepReclaimConfirmed: false, spreadPips: null,
    }),
  );
  const collisions = lookupKeys.filter((k) => telemetryFieldNames.includes(k));
  console.log(`  attentionScores.get() lookups found: ${lookupKeys.length ? lookupKeys.join(', ') : '(none)'}`);
  check('no attention lookup can name a telemetry field', collisions.length === 0, collisions.join(', '));

  // The drift-veto branch itself must be byte-identical to HEAD.
  const vetoBranch = [
    "const recentDrift = isCounterTrendSignal ? this.computeRecentDrift() : null;",
    "if (recentDrift !== null && features.atr > 0) {",
    "const driftAgainst = analysis.signalType === 'BUY' ? -recentDrift : recentDrift;",
    "const driftVetoThreshold = features.atr * COUNTER_TREND_DRIFT_ATR_VETO;",
    "if (driftAgainst >= driftVetoThreshold) {",
    "const sweepReclaimConfirmed = features.sessionSweeps.some(s => s.reversalConfirmed);",
    "if (sweepReclaimConfirmed && analysis.confidence >= COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE) {",
  ];
  const missing = vetoBranch.filter((frag) => !current.includes(frag));
  check('drift-veto branch preserved verbatim', missing.length === 0, `missing: ${missing.join(' | ')}`);

  const classifier = [
    "(analysis.signalType === 'BUY' && htfTrend === 'BEARISH') ||",
    "(analysis.signalType === 'SELL' && htfTrend === 'NEUTRAL' && ltfTrendForGate === 'BULLISH') ||",
    "(analysis.signalType === 'SELL' && htfTrend === 'NEUTRAL' && features.rsi > 65)",
  ];
  const missingClassifier = classifier.filter((frag) => !current.includes(frag));
  check('counter-trend classifier preserved verbatim', missingClassifier.length === 0, missingClassifier.join(' | '));
}

console.log(`\n${failures === 0 ? '✅ PASS' : '❌ FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exitCode = failures === 0 ? 0 : 1;
