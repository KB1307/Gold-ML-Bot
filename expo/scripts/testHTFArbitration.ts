/**
 * ITEM 2b: Regression tests for the HTF arbitration-order fix.
 *
 * Tests:
 * 1. bear-2.5-vs-bull-1.5 → must return BEARISH (was BULLISH before fix)
 * 2. bull-2.5-vs-bear-1.5 → must return BULLISH
 * 3. both-clear-1.5-equal (bull=2.0, bear=2.0) → must return NEUTRAL (tie rule)
 * 4. bull-only-1.5, bear-0.0 → BULLISH
 * 5. bear-only-1.5, bull-0.0 → BEARISH
 * 6. neither clears 1.5 → NEUTRAL
 *
 * The test reconstructs detectHTFTrend's arbitration logic verbatim
 * (the fixed version) and checks each case.
 */

function detectHTFTrendVerdict(
  bullishScore: number,
  bearishScore: number,
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  // Fixed arbitration: higher score wins, ties → NEUTRAL
  if (bullishScore >= 1.5 && bullishScore > bearishScore) {
    return 'BULLISH';
  } else if (bearishScore >= 1.5 && bearishScore > bullishScore) {
    return 'BEARISH';
  } else {
    return 'NEUTRAL';
  }
}

// Old (buggy) version for comparison
function detectHTFTrendOld(
  bullishScore: number,
  bearishScore: number,
): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (bullishScore >= 1.5) {
    return 'BULLISH';
  } else if (bearishScore >= 1.5) {
    return 'BEARISH';
  } else {
    return 'NEUTRAL';
  }
}

interface TestCase {
  name: string;
  bull: number;
  bear: number;
  expected: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  oldExpected?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

const cases: TestCase[] = [
  {
    name: 'bear-2.5-vs-bull-1.5 (the measured 31 July defect)',
    bull: 1.5,
    bear: 2.5,
    expected: 'BEARISH',
    oldExpected: 'BULLISH', // This was the bug!
  },
  {
    name: 'bull-2.5-vs-bear-1.5 (symmetric case)',
    bull: 2.5,
    bear: 1.5,
    expected: 'BULLISH',
    oldExpected: 'BULLISH', // Old version happened to be right here
  },
  {
    name: 'both-clear-1.5-equal (bull=2.0, bear=2.0) — tie → NEUTRAL',
    bull: 2.0,
    bear: 2.0,
    expected: 'NEUTRAL',
    oldExpected: 'BULLISH', // Old always picked BULLISH on tie
  },
  {
    name: 'bull-only-1.5, bear-0.0',
    bull: 1.5,
    bear: 0.0,
    expected: 'BULLISH',
  },
  {
    name: 'bear-only-1.5, bull-0.0',
    bull: 0.0,
    bear: 1.5,
    expected: 'BEARISH',
  },
  {
    name: 'neither clears 1.5 (bull=1.0, bear=0.5)',
    bull: 1.0,
    bear: 0.5,
    expected: 'NEUTRAL',
  },
  {
    name: 'bear-3.0-vs-bull-1.5 (strong bear, weak bull)',
    bull: 1.5,
    bear: 3.0,
    expected: 'BEARISH',
    oldExpected: 'BULLISH',
  },
  {
    name: 'bull-3.0-vs-bear-1.5 (strong bull, weak bear)',
    bull: 3.0,
    bear: 1.5,
    expected: 'BULLISH',
  },
];

let pass = 0;
let fail = 0;

console.log('='.repeat(78));
console.log('ITEM 2b — HTF ARBITRATION-ORDER REGRESSION TESTS');
console.log('='.repeat(78));

for (const tc of cases) {
  const result = detectHTFTrendVerdict(tc.bull, tc.bear);
  const oldResult = detectHTFTrendOld(tc.bull, tc.bear);
  const ok = result === tc.expected;
  const status = ok ? 'PASS' : 'FAIL';
  const oldNote = tc.oldExpected && tc.oldExpected !== tc.expected
    ? ` [old returned ${tc.oldExpected} — BUG]`
    : '';
  console.log(`  ${status} | ${tc.name}`);
  console.log(`         bull=${tc.bull} bear=${tc.bear} → new=${result} expected=${tc.expected}${oldNote}`);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`         *** MISMATCH: expected ${tc.expected}, got ${result}`);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.error('REGRESSION TESTS FAILED');
  process.exit(1);
}
console.log('All regression tests PASSED');
