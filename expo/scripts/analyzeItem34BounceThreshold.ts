/**
 * ITEM 34 — bounceThreshold UNIT COUNTERFACTUAL
 * =============================================
 *
 * MINDSET 8 rules (restated verbatim):
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * The live `validateStructuralConditions` counter-trend branch has:
 *   const bounceThreshold = 10;  // line 8212
 *   ...Math.abs(z.price - currentPrice) < bounceThreshold...
 *
 * That 10 is in DOLLARS, not pips. The comment says "10 pips" and the user-
 * facing tip says "10 pips", but the comparison is bare dollars. At gold
 * $4,250, $10 = 100 pips (pipValue = $0.10). The gate is 10x looser than
 * documented.
 *
 * This script asks: under a TRUE 10-pip ($1.00) band, how many canonical
 * signals would have FAILED validateStructuralConditions? And at 2, 3, 5-pip
 * bands — is there a plateau or a knife-edge?
 *
 * METHOD: The counter-trend branch fires when isCounterTrend is true. It
 * requires a SUPPORT zone (for BUY) or RESISTANCE zone (for SELL) within
 * bounceThreshold dollars of currentPrice, with reactionStrength >= 0.3 and
 * touches >= 2. If none found, the signal is REJECTED. We replay this check
 * for each signal in the export using its srZones snapshot, at each threshold.
 *
 * IMPORTANT: we can only test the counter-trend branch. The primary-trend
 * branch (runway check) and the baseline opposing-zone veto are separate
 * gates. A signal that passes the bounce check may still be rejected by
 * another gate. This script isolates the bounceThreshold gate only.
 *
 * DATA-SOURCE RULE: export signals only (srZones snapshot per signal).
 * No Supabase reads needed — the snapshot has everything the gate needs.
 */

import { readFileSync, writeFileSync } from 'node:fs';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch { /* optional */ }
  }
  return out;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  status: string;
  exit: number | null;
  generated: string;
  generatedMs: number;
  htf: string | null;
  ltf: string | null;
  rsi: number | null;
  srZonesSnapshot: { price: number; type: 'SUPPORT' | 'RESISTANCE'; touches: number; reaction: number; tier: string }[];
  attentionScores: Map<string, number>;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const exit = block.match(/exit price: ([\d.]+)/);
    const gen = block.match(/generated: (\S+)/);
    const tel = block.match(/forward telemetry: rsi=(\S+)\s+regime=(\S+)\s+regimeStrength=(\S+)\s+atr=(\S+)\s+htf=(\S+)\s+adx=(\S+)/);

    const srZonesSnapshot: ParsedSignal['srZonesSnapshot'] = [];
    const srHeaderIdx = block.indexOf('srZones snapshot');
    if (srHeaderIdx >= 0) {
      const afterHeader = block.slice(srHeaderIdx);
      const srLines = afterHeader.split('\n').slice(1);
      for (const line of srLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('[')) break;
        const m = /(SUPPORT|RESISTANCE)\s+@\s+([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%.*tier=(\S+)/.exec(trimmed);
        if (m) {
          srZonesSnapshot.push({
            type: m[1] as 'SUPPORT' | 'RESISTANCE',
            price: parseFloat(m[2]),
            touches: parseInt(m[3], 10),
            reaction: parseInt(m[4], 10),
            tier: m[5],
          });
        }
      }
    }

    const features = new Map<string, number>();
    const fullBlock = block.match(/full attention scores \(\d+ total\):\n((?:\s{6}[^\n]+\n)+)/);
    if (fullBlock) {
      for (const line of fullBlock[1].split('\n')) {
        const m = line.match(/^\s{6}(.+?)=(-?[\d.]+)$/);
        if (m) features.set(m[1].trim(), parseFloat(m[2]));
      }
    }

    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
      sl: tpm ? parseFloat(tpm[4]) : NaN,
      tp1: tpm ? parseFloat(tpm[1]) : NaN,
      generated: gen?.[1] ?? 'unknown',
      generatedMs: gen ? new Date(gen[1]).getTime() : 0,
      htf: tel ? tel[5] : null,
      ltf: null, // not in forward telemetry line
      rsi: tel ? parseFloat(tel[1]) : null,
      srZonesSnapshot,
      attentionScores: features,
    });
  }
  return out;
}

/**
 * Classify a signal as the engine's validateStructuralConditions would.
 * We need htf and ltf. htf is in the export; ltf is NOT exported.
 * The engine's detectLTFTrend is not observable from the export.
 * However, the COUNTER-TREND classification also includes htf-neutral cases
 * that depend on ltf. Since ltf is not available, we can only classify
 * signals where htf alone determines the classification:
 *   - BUY + htf=BEARISH → counter-trend (regardless of ltf)
 *   - SELL + htf=BULLISH → counter-trend (regardless of ltf)
 *   - BUY + htf=BULLISH → primary trend (regardless of ltf)
 *   - SELL + htf=BEARISH → primary trend (regardless of ltf)
 *   - htf=NEUTRAL or htf=n/a → classification depends on ltf → UNKNOWN
 */
function classifySignal(signal: ParsedSignal): 'PRIMARY' | 'COUNTER' | 'NEUTRAL' | 'UNKNOWN' {
  const htf = signal.htf;
  if (!htf || htf === 'n/a') return 'UNKNOWN';
  if (signal.direction === 'BUY' && htf === 'BULLISH') return 'PRIMARY';
  if (signal.direction === 'SELL' && htf === 'BEARISH') return 'PRIMARY';
  if (signal.direction === 'BUY' && htf === 'BEARISH') return 'COUNTER';
  if (signal.direction === 'SELL' && htf === 'BULLISH') return 'COUNTER';
  return 'NEUTRAL'; // htf=NEUTRAL, ltf-dependent
}

/**
 * Replay the counter-trend bounce check at a given threshold (in dollars).
 * Returns true if the signal PASSES (qualifying zone found), false if BLOCKED.
 */
function bounceCheckPasses(signal: ParsedSignal, thresholdDollars: number): boolean {
  const desiredType = signal.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
  // The engine also checks order blocks, but those are not in the export.
  // We check srZones only: type match, within threshold, reaction >= 30%, touches >= 2.
  const qualifying = signal.srZonesSnapshot.find(
    (z) =>
      z.type === desiredType &&
      Math.abs(z.price - signal.entry) < thresholdDollars &&
      z.reaction >= 30 &&
      z.touches >= 2,
  );
  return qualifying !== undefined;
}

function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

function profitFactor(rs: number[]): number {
  const gw = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  return gl === 0 ? Infinity : gw / gl;
}

function pooledSd(vals1: number[], vals2: number[]): number {
  const all = [...vals1, ...vals2];
  if (all.length < 2) return 0;
  const m = mean(all);
  return Math.sqrt(all.reduce((s, v) => s + (v - m) ** 2, 0) / (all.length - 1));
}

const EXCLUDED = new Set(['ACTIVE', 'EXPIRED_MISSED_ENTRY', 'NEVER_FILLABLE']);

function realisedR(s: ParsedSignal): number | null {
  if (EXCLUDED.has(s.status) || s.exit === null || Math.abs(s.entry - s.sl) < 0.01) return null;
  const risk = Math.abs(s.entry - s.sl);
  const dir = s.direction === 'BUY' ? 1 : -1;
  return (dir * (s.exit - s.entry)) / risk;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };

  console.log('='.repeat(80));
  console.log('ITEM 34 — bounceThreshold UNIT COUNTERFACTUAL');
  console.log('MINDSET 8 rules apply. Read-only. No engine code touched.');
  console.log('='.repeat(80));

  // Fetch export
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${p}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`  Export fetched: ${text.length} bytes`);
      break;
    }
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Signals parsed: ${signals.length}`);

  // ── Classify every signal ──
  const classifications = signals.map((s) => ({
    signal: s,
    classification: classifySignal(s),
    r: realisedR(s),
  }));

  const primary = classifications.filter((c) => c.classification === 'PRIMARY');
  const counter = classifications.filter((c) => c.classification === 'COUNTER');
  const neutral = classifications.filter((c) => c.classification === 'NEUTRAL');
  const unknown = classifications.filter((c) => c.classification === 'UNKNOWN');

  console.log('\n── CLASSIFICATION (from htf label only) ──');
  console.log(`  PRIMARY trend:   ${primary.length}`);
  console.log(`  COUNTER-trend:   ${counter.length}`);
  console.log(`  NEUTRAL (htf=NEUTRAL, ltf-dependent): ${neutral.length}`);
  console.log(`  UNKNOWN (htf=n/a or missing):         ${unknown.length}`);
  console.log(`  => bounceThreshold gate is only testable on the ${counter.length} COUNTER-trend signals.`);
  console.log(`     The ${unknown.length} UNKNOWN signals may also be counter-trend, but their htf label is absent.`);

  // ── Run bounce check at each threshold ──
  // Thresholds in DOLLARS. 10 pips = $1.00, 2 pips = $0.20, 3 pips = $0.30, 5 pips = $0.50
  // The live gate uses $10 (100 pips).
  const thresholds: { label: string; dollars: number; pips: number }[] = [
    { label: 'LIVE ($10 = 100 pips)', dollars: 10.0, pips: 100 },
    { label: '5 pips ($0.50)', dollars: 0.50, pips: 5 },
    { label: '3 pips ($0.30)', dollars: 0.30, pips: 3 },
    { label: '2 pips ($0.20)', dollars: 0.20, pips: 2 },
    { label: '10 pips ($1.00)', dollars: 1.00, pips: 10 },
  ];

  console.log('\n' + '='.repeat(80));
  console.log('COUNTERFACTUAL — counter-trend bounce check at each threshold');
  console.log('='.repeat(80));
  console.log(`\n  Population: ${counter.length} counter-trend signals (htf-labelled only)`);
  console.log(`  Gate: SUPPORT (for BUY) / RESISTANCE (for SELL) within threshold of entry,`);
  console.log(`        reaction >= 30%, touches >= 2. If none found → REJECTED.\n`);

  console.log(`  ${"threshold".padEnd(22)} ${"pass".padStart(6)} ${"block".padStart(6)} ${"%block".padStart(7)}  blocked EV   passed EV   delta`);
  console.log(`  ${'─'.repeat(80)}`);

  const results: { label: string; dollars: number; pips: number; pass: number; block: number; blockedR: number[]; passedR: number[] }[] = [];

  for (const t of thresholds) {
    const blocked: ParsedSignal[] = [];
    const passed: ParsedSignal[] = [];
    for (const c of counter) {
      if (bounceCheckPasses(c.signal, t.dollars)) {
        passed.push(c.signal);
      } else {
        blocked.push(c.signal);
      }
    }
    const blockedR = blocked.map(realisedR).filter((r): r is number => r !== null);
    const passedR = passed.map(realisedR).filter((r): r is number => r !== null);
    const blockedEv = blockedR.length > 0 ? mean(blockedR) : NaN;
    const passedEv = passedR.length > 0 ? mean(passedR) : NaN;
    const delta = !isNaN(blockedEv) && !isNaN(passedEv) ? blockedEv - passedEv : NaN;
    const pctBlock = ((blocked.length / counter.length) * 100).toFixed(1);

    console.log(
      `  ${t.label.padEnd(22)} ${String(passed.length).padStart(6)} ${String(blocked.length).padStart(6)} ${pctBlock.padStart(6)}%  ` +
      `${isNaN(blockedEv) ? '   n/a' : `${blockedEv >= 0 ? '+' : ''}${blockedEv.toFixed(4)}`}R  ` +
      `${isNaN(passedEv) ? '   n/a' : `${passedEv >= 0 ? '+' : ''}${passedEv.toFixed(4)}`}R  ` +
      `${isNaN(delta) ? '  n/a' : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`}`,
    );

    results.push({ ...t, pass: passed.length, block: blocked.length, blockedR, passedR });
  }

  // ── Plateau vs knife-edge analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('PLATEAU vs KNIFE-EDGE');
  console.log('='.repeat(80));

  const liveBlock = results.find((r) => r.pips === 100)!;
  const pip10Block = results.find((r) => r.pips === 10)!;
  const pip5Block = results.find((r) => r.pips === 5)!;
  const pip3Block = results.find((r) => r.pips === 3)!;
  const pip2Block = results.find((r) => r.pips === 2)!;

  console.log(`\n  Block counts:  100p=${liveBlock.block}  10p=${pip10Block.block}  5p=${pip5Block.block}  3p=${pip3Block.block}  2p=${pip2Block.block}`);
  console.log(`  Deltas:        100→10: ${liveBlock.block - pip10Block.block} newly blocked`);
  console.log(`                10→5:   ${pip10Block.block - pip5Block.block} newly blocked`);
  console.log(`                5→3:    ${pip5Block.block - pip3Block.block} newly blocked`);
  console.log(`                3→2:    ${pip3Block.block - pip2Block.block} newly blocked`);

  // Is there a plateau?
  const deltas = [
    liveBlock.block - pip10Block.block,
    pip10Block.block - pip5Block.block,
    pip5Block.block - pip3Block.block,
    pip3Block.block - pip2Block.block,
  ];
  const maxDelta = Math.max(...deltas);
  const minDelta = Math.min(...deltas);
  if (maxDelta === 0) {
    console.log(`\n  => PLATEAU: zero signals are blocked at any tighter threshold. The gate is`);
    console.log(`     not load-bearing on this sample — every counter-trend signal has a qualifying`);
    console.log(`     zone within $0.20 (2 pips) of entry.`);
  } else if (maxDelta === minDelta && maxDelta > 0) {
    console.log(`\n  => UNIFORM: each threshold step blocks the same number. No knife-edge.`);
  } else {
    const stepWithJump = deltas.indexOf(maxDelta);
    const labels = ['100→10p', '10→5p', '5→3p', '3→2p'];
    console.log(`\n  => Largest jump at ${labels[stepWithJump]} (${maxDelta} newly blocked).`);
    if (maxDelta > deltas.reduce((a, b) => a + b, 0) * 0.5) {
      console.log(`     This is a KNIFE-EDGE: most of the blocking happens at one threshold step.`);
    } else {
      console.log(`     Gradual change — no single knife-edge.`);
    }
  }

  // ── POWER on the 10-pip split (the documented threshold) ──
  console.log('\n' + '='.repeat(80));
  console.log('POWER — 10-pip ($1.00) threshold, the documented value');
  console.log('='.repeat(80));

  const r10 = results.find((r) => r.pips === 10)!;
  if (r10.block === 0 || r10.pass === 0) {
    console.log(`  One side is empty (blocked=${r10.block}, passed=${r10.pass}). Split is IMPOSSIBLE, not underpowered (rule 8).`);
    console.log(`  The gate either blocks nothing or everything at this threshold — no contrast exists.`);
  } else {
    const sd = pooledSd(r10.blockedR, r10.passedR);
    const nAvg = (r10.blockedR.length + r10.passedR.length) / 2;
    const mde = 2.8 * sd * Math.sqrt(2 / nAvg);
    const observedDelta = Math.abs(mean(r10.blockedR) - mean(r10.passedR));
    console.log(`  Blocked: n=${r10.blockedR.length}, EV=${mean(r10.blockedR) >= 0 ? '+' : ''}${mean(r10.blockedR).toFixed(4)}R`);
    console.log(`  Passed:  n=${r10.passedR.length}, EV=${mean(r10.passedR) >= 0 ? '+' : ''}${mean(r10.passedR).toFixed(4)}R`);
    console.log(`  MDE: ${mde.toFixed(4)}R  Observed delta: ${observedDelta.toFixed(4)}R  ${observedDelta >= mde ? 'POWERED' : 'UNDERPOWERED'}`);
  }

  // ── Also check the UNKNOWN signals (htf=n/a) ──
  console.log('\n' + '='.repeat(80));
  console.log('UNKNOWN signals (htf=n/a) — would they pass at 10 pips?');
  console.log('='.repeat(80));
  console.log(`  ${unknown.length} signals have no htf label. Their classification (primary vs counter)`);
  console.log(`  depends on ltf, which is not exported. If any are counter-trend, the bounce`);
  console.log(`  gate would apply. We test whether they would pass at 10 pips IF they are counter-trend:`);

  let unknownPass10 = 0;
  let unknownBlock10 = 0;
  for (const u of unknown) {
    if (bounceCheckPasses(u.signal, 1.0)) {
      unknownPass10++;
    } else {
      unknownBlock10++;
    }
  }
  console.log(`  Would pass at 10p: ${unknownPass10}`);
  console.log(`  Would block at 10p: ${unknownBlock10}`);
  console.log(`  (These are upper/lower bounds — some may be primary-trend and not subject to the gate at all.)`);

  // ── Detail on blocked signals at 10 pips ──
  console.log('\n' + '='.repeat(80));
  console.log('DETAIL — counter-trend signals blocked at 10 pips ($1.00)');
  console.log('='.repeat(80));

  const blocked10 = counter.filter((c) => !bounceCheckPasses(c.signal, 1.0));
  if (blocked10.length === 0) {
    console.log(`  None. Every counter-trend signal has a qualifying zone within $1.00 of entry.`);
  } else {
    console.log(`  ${"idx".padStart(4)} ${"dir".padEnd(5)} ${"entry".padStart(8)} ${"htf".padEnd(8)} ${"nearest_zone".padStart(12)} ${"zone_type".padEnd(11)} ${"dist$".padStart(7)} ${"reaction".padStart(8)} ${"touches".padStart(7)}  ${"status".padEnd(20)}`);
    for (const c of blocked10) {
      const s = c.signal;
      const desiredType = s.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
      const zones = s.srZonesSnapshot.filter((z) => z.type === desiredType);
      let nearest = zones[0];
      let nearestDist = nearest ? Math.abs(nearest.price - s.entry) : Infinity;
      for (const z of zones) {
        const d = Math.abs(z.price - s.entry);
        if (d < nearestDist) {
          nearest = z;
          nearestDist = d;
        }
      }
      if (nearest) {
        console.log(
          `  ${String(s.index).padStart(4)} ${s.direction.padEnd(5)} ${s.entry.toFixed(1).padStart(8)} ${(s.htf ?? 'n/a').padEnd(8)} ` +
          `${nearest.price.toFixed(1).padStart(12)} ${nearest.type.padEnd(11)} ${nearestDist.toFixed(2).padStart(7)} ` +
          `${(nearest.reaction + '%').padStart(8)} ${String(nearest.touches).padStart(7)}  ${s.status.padEnd(20)}`,
        );
      } else {
        console.log(
          `  ${String(s.index).padStart(4)} ${s.direction.padEnd(5)} ${s.entry.toFixed(1).padStart(8)} ${(s.htf ?? 'n/a').padEnd(8)} ` +
          `${'NONE'.padStart(12)} ${'—'.padEnd(11)} ${'∞'.padStart(7)} ${'—'.padStart(8)} ${'—'.padStart(7)}  ${s.status.padEnd(20)}`,
        );
      }
    }
  }

  // ── Also show nearest-zone distance distribution for ALL counter-trend signals ──
  console.log('\n' + '='.repeat(80));
  console.log('NEAREST-ZONE DISTANCE distribution (all counter-trend signals)');
  console.log('='.repeat(80));
  const distances = counter.map((c) => {
    const s = c.signal;
    const desiredType = s.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const zones = s.srZonesSnapshot.filter((z) => z.type === desiredType && z.reaction >= 30 && z.touches >= 2);
    if (zones.length === 0) return Infinity;
    return Math.min(...zones.map((z) => Math.abs(z.price - s.entry)));
  });
  const finiteDists = distances.filter((d) => d !== Infinity).sort((a, b) => a - b);
  const noZone = distances.filter((d) => d === Infinity).length;
  console.log(`  Counter-trend signals with a qualifying zone: ${finiteDists.length} / ${counter.length}`);
  console.log(`  No qualifying zone at any distance: ${noZone}`);
  if (finiteDists.length > 0) {
    const p10 = finiteDists[Math.floor(finiteDists.length * 0.1)];
    const p25 = finiteDists[Math.floor(finiteDists.length * 0.25)];
    const p50 = finiteDists[Math.floor(finiteDists.length * 0.5)];
    const p75 = finiteDists[Math.floor(finiteDists.length * 0.75)];
    const p90 = finiteDists[Math.floor(finiteDists.length * 0.9)];
    console.log(`  Distance to nearest qualifying zone ($):`);
    console.log(`    p10=$${p10.toFixed(2)} (${(p10 / 0.1).toFixed(0)}p)  p25=$${p25.toFixed(2)} (${(p25 / 0.1).toFixed(0)}p)  p50=$${p50.toFixed(2)} (${(p50 / 0.1).toFixed(0)}p)  p75=$${p75.toFixed(2)} (${(p75 / 0.1).toFixed(0)}p)  p90=$${p90.toFixed(2)} (${(p90 / 0.1).toFixed(0)}p)`);
    console.log(`    min=$${finiteDists[0].toFixed(3)} (${(finiteDists[0] / 0.1).toFixed(1)}p)  max=$${finiteDists[finiteDists.length - 1].toFixed(2)} (${(finiteDists[finiteDists.length - 1] / 0.1).toFixed(0)}p)`);

    // How many fall in each band?
    const bands = [0.20, 0.30, 0.50, 1.00, 2.00, 5.00, 10.00];
    console.log(`\n  Cumulative pass rate at each threshold:`);
    for (const b of bands) {
      const pass = finiteDists.filter((d) => d < b).length;
      console.log(`    < $${b.toFixed(2)} (${(b / 0.1).toFixed(0)}p): ${pass}/${counter.length} pass (${((pass / counter.length) * 100).toFixed(1)}%)`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 34 counterfactual complete. Nothing was written. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
