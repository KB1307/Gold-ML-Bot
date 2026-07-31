/**
 * Forces a REAL shadow-write failure through the actual pushShadowSellRecord
 * code path, and proves the failure counter increments + the greppable warning
 * fires. Uses a BAD Supabase URL so the insert genuinely fails.
 *
 * Must run in a FRESH process (the module's shadowClient is a singleton).
 *
 * Usage: bunx tsx scripts/verifyShadowFailure.ts
 */

// Set a BAD URL BEFORE importing the module — so getShadowClient() creates
// a client pointed at an unreachable endpoint, and the insert fails.
process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://nonexistent-host-12345.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake-anon-key-for-failure-test';

// Capture console.warn output
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  warnings.push(msg);
  originalWarn(...args);
};

async function main() {
  // Import AFTER setting bad env vars
  const { pushShadowSellRecord, getShadowWriteFailures, getShadowWriteSuccesses } = await import('../services/shadowSignalService');

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  REAL SHADOW-WRITE FAILURE TEST (through pushShadowSellRecord)');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log('Before push:');
  console.log(`  failures=${getShadowWriteFailures()}, successes=${getShadowWriteSuccesses()}`);
  console.log('');

  console.log('Calling pushShadowSellRecord with bad URL...');
  const testRecord = {
    signalId: `fail-test-${Date.now()}`,
    createdAt: Date.now(),
    direction: 'SELL' as const,
    entry: 4050.0, sl: 3980.0, tp1: 4020.0, tp2: 3990.0, tp3: 3960.0,
    confidence: 0.75,
    entryShifted: 4090.0, slShifted: 4020.0, tp1Shifted: 4060.0, tp2Shifted: 4030.0, tp3Shifted: 4000.0,
    slMultiplier: 1.4, atr: 1.2, regime: 'TRENDING', sessionName: 'LONDON', hourUtc: 0,
    srZonesSnapshot: {}, attentionScores: {}, htfTrend: null, ltfTrend: null, rsi: null,
  };
  pushShadowSellRecord(testRecord);

  // Wait for the fire-and-forget async insert to fail
  console.log('Waiting 5s for fire-and-forget insert to fail...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('');
  console.log('After push:');
  console.log(`  failures=${getShadowWriteFailures()}, successes=${getShadowWriteSuccesses()}`);
  console.log('');

  console.log('Console.warn output captured:');
  if (warnings.length === 0) {
    console.log('  (none — warning did NOT fire!)');
  } else {
    for (const w of warnings) {
      console.log(`  ${w}`);
    }
  }

  console.log('');
  const failureIncremented = getShadowWriteFailures() > 0;
  const warningFired = warnings.some(w => w.includes('[ShadowSell]') && (w.includes('SHADOW_WRITE_FAILED') || w.includes('SHADOW_WRITE_ERROR')));

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  FAILURE COUNTER INCREMENTED: ${failureIncremented ? '✅ YES' : '❌ NO'}`);
  console.log(`  GREPPABLE WARNING FIRED:     ${warningFired ? '✅ YES' : '❌ NO'}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  if (!failureIncremented || !warningFired) {
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
