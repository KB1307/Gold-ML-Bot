/**
 * ITEM P.2 — FUNNEL COUNTER IN A REAL DIAGNOSTICS EXPORT.
 * Calls the REAL buildDiagnosticsExportText with the REAL getVetoFunnel() state,
 * after exercising the REAL evaluateBandProximityVeto logic with client=null so
 * the veto path runs WITHOUT touching production data (a null client skips the
 * shadow write — verified by the module's guard). This is a logic demonstration
 * of the funnel counters, NOT a market-produced suppression: the first REAL
 * suppressed row requires a real emission while the app runs this code.
 */
import { buildDiagnosticsExportText } from '../services/diagnosticsExport';
import { evaluateBandProximityVeto, getVetoFunnel } from '../services/bandProximityVeto';
import type { TradingSignal, RawModelWeights, ModelHealthMetrics, PerformanceMetrics } from '../types/trading';

async function main(): Promise<void> {
  console.log('===== ITEM P.2 — REAL EXPORT, REAL FUNNEL MODULE =====');

  // Case 1: band rule fires, fingerprint NOT active (rsi not stretched) ->
  // CONDITIONAL veto fires. client=null => shadow write is SKIPPED (no
  // production write; the module warns) — funnel.suppressed increments.
  const fire1 = await evaluateBandProximityVeto({
    client: null,
    direction: 'BUY',
    entry: 4600,
    sl: 4590,
    tp1: 4606,
    tp2: 4612,
    tp3: 4618,
    confidence: 0.92,
    rsi: 50,
    zones: [{ price: 4601, touches: 12, reactionStrength: 0.7, type: 'RESISTANCE' }],
    nowMs: Date.now(),
  });
  console.log(`case1: fires=${fire1.fires} mode=${fire1.mode} zone=${fire1.qualifyingZone?.price} fp=${fire1.fingerprintActive} id=${fire1.suppressedId}`);

  // Case 2: rule silent -> emitted normally.
  const fire2 = await evaluateBandProximityVeto({
    client: null, direction: 'SELL', entry: 4600, sl: 4610, tp1: 4594, tp2: 4588, tp3: 4582,
    confidence: 0.9, rsi: 55, zones: [], nowMs: Date.now(),
  });
  console.log(`case2: fires=${fire2.fires}`);

  const funnel = getVetoFunnel();
  console.log(`funnel: generated=${funnel.generated} emitted=${funnel.emitted} suppressed=${funnel.suppressed} (mutually exclusive: ${funnel.generated === funnel.emitted + funnel.suppressed ? 'INVARIANT HOLDS' : 'BROKEN'})`);

  const exportText = buildDiagnosticsExportText({
    signalHistory: [] as TradingSignal[],
    modelWeights: { weights: [], lastTrainingTime: null } as unknown as RawModelWeights,
    modelHealth: {
      modelHealthScore: 0,
      featureCorrelationStatus: "n/a (funnel-export stub)",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "n/a (funnel-export stub)",
      daysSinceRetrain: 0,
      retrainingRecommended: false,
      retrainScheduled: false,
    } as unknown as ModelHealthMetrics,
    performanceMetrics: {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
      sharpeRatio: 0, expectancy: 0, averageWin: 0, averageLoss: 0, totalProfit: 0,
      totalLoss: 0, maxDrawdown: 0, currentDrawdown: 0,
    } as unknown as PerformanceMetrics,
    vetoFunnel: funnel,
  });
  const start = exportText.indexOf('-- ITEM P: BAND-PROXIMITY VETO FUNNEL --');
  const end = exportText.indexOf('END OF EXPORT');
  console.log('\n----- REAL EXPORT, FUNNEL SECTION -----');
  console.log(exportText.slice(start, end).trimEnd());
  console.log('----- END SECTION -----');
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
