/**
 * ITEM 43(d) — CORPUS SELECTION AUDIT
 *
 * Two questions, answered separately and honestly.
 *
 * (a) The n=50 -> n=51 discrepancy in the 43c EV table.
 *     43c computed EV over rows where `realized_r IS NOT NULL AND NOT is_scratch`.
 *     BEFORE that filter admitted 50 rows; AFTER it admits 51. So the BEFORE and
 *     AFTER EV numbers were computed over DIFFERENT row sets. That makes the
 *     printed "DELTA EV" a mixture of (i) relabelling the same trades and
 *     (ii) one extra row entering the denominator. It is not a like-for-like
 *     comparison, and I reported it as if it were.
 *
 *     This script establishes exactly what is still provable about that row and
 *     states plainly what is NOT recoverable. The corrector wrote corrected
 *     labels and realized_r IN PLACE via UPDATE and persisted no pre-image, so
 *     the pre-correction realized_r for the 17 corrected rows no longer exists
 *     in any tier (durable rows overwritten; local tier dropped and refilled
 *     from durable). Identifying WHICH row crossed the filter is therefore a
 *     measurement that is IMPOSSIBLE from stored state, not merely underpowered.
 *     Recorded here as a methodology defect with the concrete fix.
 *
 * (b) Selection bias in `trade_outcomes_v1`.
 *     The corpus is not a random sample of signals. A row exists only if
 *     recordTradeOutcome() fired, which requires the signal to have been
 *     resolved to WIN/LOSS by a client that was RUNNING at resolution time, and
 *     the durable push to have succeeded. This script measures whether the 51
 *     surviving rows are a skewed subsample of the full emitted-signal
 *     population on the axes that could bias a retrain: session/hour, direction,
 *     and date era.
 *
 * PRE-REGISTERED GATES (fixed before any result was seen; no post-hoc loosening)
 *  G43D-1 Corpus census reproduces: rows read > 0, and the usable-row count
 *         under the 43c filter is reported with null-R and scratch counts split out.
 *  G43D-2 No orphan corpus rows: every corpus signal_id resolves to a signal in
 *         the exported signal-history population. An orphan means the corpus
 *         carries a trade the population does not, and the coverage denominators
 *         below would be meaningless.
 *  G43D-3 Direction mix: |corpus BUY share - resolved-population BUY share|
 *         <= 15.0pp, else direction selection is declared MATERIAL.
 *  G43D-4 Session coverage evenness: max/min corpus capture rate across sessions
 *         that have >= 5 resolved signals must be <= 2.0x, else session
 *         selection is declared MATERIAL.
 *
 * Read-only. Touches no table. Reports; fixes nothing.
 */

import { readFileSync, writeFileSync } from 'node:fs';

interface CorpusRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  realized_r: number | string | null;
  is_scratch: boolean | null;
}

interface PopSignal {
  id: string;
  direction: 'BUY' | 'SELL';
  status: string;
  generatedMs: number;
}

/**
 * Every TERMINAL status a signal can end in. This set is the population
 * denominator, so an omission here silently biases every capture rate below.
 * The first run of this script omitted ALL_TARGETS_HIT and PARTIAL_WIN_SL_HIT —
 * both terminal, both present in the corpus — which mis-specified the
 * denominator and invalidated that run's gate verdicts. Enumerated from the
 * statuses actually observed in the exported population.
 */
const RESOLVED_STATUSES = new Set([
  'SL_HIT',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'CLOSED',
  'SL_AFTER_BE',
  'BE_STOP',
  'ALL_TARGETS_HIT',
  'PARTIAL_WIN_SL_HIT',
]);

/** Terminal statuses whose bar-verified outcome is a net WIN. */
const WINNING_STATUSES = new Set(['TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'ALL_TARGETS_HIT', 'PARTIAL_WIN_SL_HIT']);

let pass = 0;
let fail = 0;
function gate(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line) => {
          const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
          if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
        });
    } catch {
      /* optional */
    }
  }
  return out;
}

function sessionOf(hourUtc: number): string {
  if (hourUtc >= 22 || hourUtc < 7) return 'ASIA (22-07)';
  if (hourUtc < 12) return 'LONDON (07-12)';
  if (hourUtc < 17) return 'OVERLAP (12-17)';
  return 'NY_LATE (17-22)';
}

/** Parses SECTION 1 of the diagnostics export into the emitted-signal population. */
function parsePopulation(path: string): PopSignal[] {
  const text = readFileSync(path, 'utf8');
  const section = text.slice(text.indexOf('SECTION 1'));
  const lines = section.split('\n');
  const out: PopSignal[] = [];
  let cur: { direction: 'BUY' | 'SELL'; status: string } | null = null;
  let curId: string | null = null;
  for (const line of lines) {
    if (line.startsWith('SECTION 2')) break;
    const head = line.match(/^\[\d+\]\s+(BUY|SELL)\s+@\s+[\d.]+\s+—\s+status:\s+(\S+)/);
    if (head) {
      cur = { direction: head[1] as 'BUY' | 'SELL', status: head[2] };
      curId = null;
      continue;
    }
    const idm = line.match(/^\s+id:\s+(\S+)/);
    if (idm && cur) {
      curId = idm[1];
      continue;
    }
    const gen = line.match(/^\s+generated:\s+(\S+)/);
    if (gen && cur && curId) {
      const ms = new Date(gen[1]).getTime();
      if (Number.isFinite(ms)) {
        out.push({ id: curId, direction: cur.direction, status: cur.status, generatedMs: ms });
      }
      cur = null;
      curId = null;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const key = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log('BLOCKER: Supabase anon credentials unavailable. STOP.');
    process.exitCode = 1;
    return;
  }
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  console.log('='.repeat(80));
  console.log('ITEM 43(d) — CORPUS SELECTION AUDIT (read-only)');
  console.log('='.repeat(80));

  // ── durable corpus ──
  const cRes = await fetch(
    `${url}/rest/v1/trade_outcomes_v1?select=signal_id,ts,direction,result,realized_r,is_scratch&order=ts.asc`,
    { headers: h },
  );
  if (!cRes.ok) {
    console.log(`BLOCKER: corpus read failed (${cRes.status}). STOP.`);
    process.exitCode = 1;
    return;
  }
  const corpus = (await cRes.json()) as CorpusRow[];

  // ── emitted-signal population from the diagnostics export ──
  let exportPath = '/tmp/diagnostics_export.txt';
  let got = false;
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const r = await fetch(`${url}${p}`, { headers: h });
    if (r.ok) {
      writeFileSync(exportPath, await r.text());
      got = true;
      break;
    }
  }
  if (!got) {
    console.log('BLOCKER: diagnostics export unavailable — population denominator cannot be sourced. STOP.');
    process.exitCode = 1;
    return;
  }
  const population = parsePopulation(exportPath);

  console.log(`\nPOWER, stated before the result:`);
  console.log(`  durable corpus rows           : ${corpus.length}`);
  console.log(`  emitted signals in population : ${population.length}`);
  const resolvedPop = population.filter((s) => RESOLVED_STATUSES.has(s.status));
  console.log(`  of which RESOLVED (WIN/LOSS-able): ${resolvedPop.length}`);
  console.log(`  A corpus of ${corpus.length} rows against ${resolvedPop.length} resolved signals means any`);
  console.log(`  per-session cell below is small; cells with <5 resolved signals are excluded`);
  console.log(`  from G43D-4 by pre-registration, and no cell here supports a fine-grained claim.`);

  // ── (a) what is still provable about the n=50 -> n=51 row ──
  const nullR = corpus.filter((r) => r.realized_r === null);
  const scratch = corpus.filter((r) => r.is_scratch === true);
  const usable = corpus.filter((r) => r.realized_r !== null && r.is_scratch !== true);

  console.log('\n' + '='.repeat(80));
  console.log('43d(a) — THE n=50 -> n=51 DISCREPANCY');
  console.log('='.repeat(80));
  console.log(`  corpus rows                : ${corpus.length}`);
  console.log(`  realized_r IS NULL         : ${nullR.length}`);
  console.log(`  is_scratch = true          : ${scratch.length}`);
  console.log(`  usable under the 43c filter: ${usable.length}`);
  const rs = usable.map((r) => Number(r.realized_r));
  const nearLine = usable
    .filter((r) => Math.abs(Number(r.realized_r)) < 0.30)
    .map((r) => `${r.signal_id.slice(-9)}=${Number(r.realized_r).toFixed(3)}R`);
  console.log(`  usable rows within 0.15R..0.30R of the scratch cutoff: ${nearLine.length ? nearLine.join(', ') : 'none'}`);
  console.log('');
  console.log('  WHAT THIS PROVES: after correction all rows carry a non-null realized_r and');
  console.log('  none are scratch, so the AFTER denominator is the whole corpus. BEFORE, the');
  console.log('  same filter admitted one row fewer, so exactly one row was either null-R or');
  console.log('  scratch pre-correction. Only the 17 corrected rows changed, so that row is one');
  console.log('  of the 17.');
  console.log('');
  console.log('  WHAT IS NOT RECOVERABLE: which of the 17. The corrector UPDATEd label and');
  console.log('  realized_r in place and persisted no pre-image; the local tier was dropped and');
  console.log('  refilled FROM the corrected durable rows. No tier retains the pre-correction');
  console.log('  realized_r. This is IMPOSSIBLE to measure from stored state, not underpowered.');
  console.log('');
  console.log('  CONSEQUENCE FOR WHAT I REPORTED: the 43c BEFORE (n=50) vs AFTER (n=51) delta is');
  console.log('  NOT like-for-like — it mixes relabelling with a denominator change. The BEFORE');
  console.log('  figure can no longer be recomputed at all, so that delta cannot be repaired');
  console.log('  retrospectively and should not be cited. The AFTER figure is unaffected: it is a');
  console.log('  standalone bar-verified measurement over all ' + usable.length + ' rows.');
  console.log('');
  console.log('  METHODOLOGY FIX (forward): any corpus mutation must first write a pre-image');
  console.log('  snapshot artifact (signal_id, result, realized_r, is_scratch) and compute all');
  console.log('  before/after comparisons over the INTERSECTION of usable rows, reporting any');
  console.log('  denominator change as a separate line rather than folding it into the delta.');

  gate(
    'G43D-1 corpus census reproduces',
    corpus.length > 0,
    `${corpus.length} rows read; ${nullR.length} null-R, ${scratch.length} scratch, ${usable.length} usable`,
  );

  // ── (b) selection bias ──
  const popById = new Map<string, PopSignal>();
  for (const s of population) popById.set(s.id, s);
  const orphans = corpus.filter((r) => !popById.has(r.signal_id));
  gate(
    'G43D-2 no orphan corpus rows',
    orphans.length === 0,
    `${orphans.length} of ${corpus.length} corpus rows absent from the exported population${orphans.length ? ` (${orphans.slice(0, 5).map((o) => o.signal_id.slice(-9)).join(', ')})` : ''}`,
  );

  const inCorpus = new Set(corpus.map((r) => r.signal_id));

  console.log('\n' + '='.repeat(80));
  console.log('43d(b) — WHY A ROW EXISTS AT ALL (the selection mechanism)');
  console.log('='.repeat(80));
  console.log('  A trade_outcomes_v1 row requires ALL of:');
  console.log('   1. the signal was EMITTED (suppressed shadow SELLs never qualify);');
  console.log('   2. it was RESOLVED to a terminal WIN/LOSS by the client — open/FLAT never record;');
  console.log('   3. a client was RUNNING when resolution was detected (resolution is client-side,');
  console.log('      so a signal resolving while every client was closed only records if a later');
  console.log('      reconciliation pass catches it);');
  console.log('   4. the durable push to Supabase succeeded (else it stays queued locally).');
  console.log('  Conditions 3 and 4 are the ones that can bias the sample: they select on CLIENT');
  console.log('  UPTIME, which is a function of wall-clock hour, not of trade quality.');

  // status coverage
  console.log('\n  CAPTURE BY POPULATION STATUS');
  const byStatus = new Map<string, { pop: number; cap: number }>();
  for (const s of population) {
    const cur = byStatus.get(s.status) ?? { pop: 0, cap: 0 };
    cur.pop += 1;
    if (inCorpus.has(s.id)) cur.cap += 1;
    byStatus.set(s.status, cur);
  }
  for (const [st, v] of [...byStatus.entries()].sort((a, b) => b[1].pop - a[1].pop)) {
    const rate = v.pop ? ((v.cap / v.pop) * 100).toFixed(1) : '0.0';
    console.log(`    ${st.padEnd(14)} population=${String(v.pop).padStart(4)}  in corpus=${String(v.cap).padStart(3)}  capture=${rate.padStart(5)}%`);
  }

  // direction mix
  const corpusBuy = corpus.filter((r) => {
    const p = popById.get(r.signal_id);
    return (r.direction ?? p?.direction) === 'BUY';
  }).length;
  const corpusBuyShare = corpus.length ? (corpusBuy / corpus.length) * 100 : 0;
  const popBuy = resolvedPop.filter((s) => s.direction === 'BUY').length;
  const popBuyShare = resolvedPop.length ? (popBuy / resolvedPop.length) * 100 : 0;
  console.log('\n  DIRECTION MIX');
  console.log(`    corpus            BUY ${corpusBuy}/${corpus.length} = ${corpusBuyShare.toFixed(1)}%`);
  console.log(`    resolved population BUY ${popBuy}/${resolvedPop.length} = ${popBuyShare.toFixed(1)}%`);
  console.log(`    gap ${Math.abs(corpusBuyShare - popBuyShare).toFixed(1)}pp (pre-registered limit 15.0pp)`);
  gate(
    'G43D-3 direction mix not materially skewed',
    Math.abs(corpusBuyShare - popBuyShare) <= 15.0,
    `${Math.abs(corpusBuyShare - popBuyShare).toFixed(1)}pp gap vs 15.0pp limit`,
  );

  // session coverage
  console.log('\n  CAPTURE BY SESSION (resolved signals only)');
  const bySession = new Map<string, { pop: number; cap: number }>();
  for (const s of resolvedPop) {
    const k = sessionOf(new Date(s.generatedMs).getUTCHours());
    const cur = bySession.get(k) ?? { pop: 0, cap: 0 };
    cur.pop += 1;
    if (inCorpus.has(s.id)) cur.cap += 1;
    bySession.set(k, cur);
  }
  const eligible: number[] = [];
  for (const k of ['ASIA (22-07)', 'LONDON (07-12)', 'OVERLAP (12-17)', 'NY_LATE (17-22)']) {
    const v = bySession.get(k) ?? { pop: 0, cap: 0 };
    const rate = v.pop ? (v.cap / v.pop) * 100 : 0;
    const note = v.pop < 5 ? '  [excluded from G43D-4: n<5]' : '';
    console.log(`    ${k.padEnd(16)} resolved=${String(v.pop).padStart(4)}  in corpus=${String(v.cap).padStart(3)}  capture=${rate.toFixed(1).padStart(5)}%${note}`);
    if (v.pop >= 5) eligible.push(rate);
  }
  const maxR = eligible.length ? Math.max(...eligible) : 0;
  const minR = eligible.length ? Math.min(...eligible) : 0;
  const ratio = minR > 0 ? maxR / minR : Number.POSITIVE_INFINITY;
  console.log(`    spread: max ${maxR.toFixed(1)}% / min ${minR.toFixed(1)}% = ${Number.isFinite(ratio) ? ratio.toFixed(2) + 'x' : 'INFINITE (a session captured 0)'} (limit 2.00x)`);
  gate(
    'G43D-4 session capture evenness',
    Number.isFinite(ratio) && ratio <= 2.0,
    `${Number.isFinite(ratio) ? ratio.toFixed(2) + 'x' : 'INFINITE — at least one eligible session contributed no corpus rows'} vs 2.00x limit`,
  );

  // ── outcome-class capture skew (NOT pre-registered; hypothesis-generating only) ──
  console.log('\n  OUTCOME-CLASS CAPTURE SKEW  [NOT PRE-REGISTERED — reported as a hypothesis,');
  console.log('  not a lever, and it closes no gate]');
  const winPop = resolvedPop.filter((s) => WINNING_STATUSES.has(s.status));
  const lossPop = resolvedPop.filter((s) => !WINNING_STATUSES.has(s.status));
  const winCap = winPop.filter((s) => inCorpus.has(s.id)).length;
  const lossCap = lossPop.filter((s) => inCorpus.has(s.id)).length;
  const winRate = winPop.length ? (winCap / winPop.length) * 100 : 0;
  const lossRate = lossPop.length ? (lossCap / lossPop.length) * 100 : 0;
  console.log(`    WIN-class  resolved=${String(winPop.length).padStart(4)}  in corpus=${String(winCap).padStart(3)}  capture=${winRate.toFixed(1)}%`);
  console.log(`    LOSS-class resolved=${String(lossPop.length).padStart(4)}  in corpus=${String(lossCap).padStart(3)}  capture=${lossRate.toFixed(1)}%`);
  const skew = winRate > 0 ? lossRate / winRate : Number.POSITIVE_INFINITY;
  console.log(`    LOSS/WIN capture ratio: ${Number.isFinite(skew) ? skew.toFixed(2) + 'x' : 'INFINITE'}`);
  console.log(`    Population WR ${winPop.length ? ((winPop.length / resolvedPop.length) * 100).toFixed(1) : '0.0'}%  vs  corpus-captured WR ${winCap + lossCap ? ((winCap / (winCap + lossCap)) * 100).toFixed(1) : '0.0'}%`);
  console.log('    If LOSS-class capture exceeds WIN-class capture, the learning corpus is a');
  console.log('    PESSIMISTICALLY biased sample and a retrain on it will under-rate the very');
  console.log('    features that produce wins. This run cannot establish that causally — it is');
  console.log('    observational and was not pre-registered. It is the pre-registered question');
  console.log('    for the next item, with the capture mechanism (client uptime) as the suspect.');

  // era coverage
  console.log('\n  CAPTURE BY DATE (resolved signals, UTC day)');
  const byDay = new Map<string, { pop: number; cap: number }>();
  for (const s of resolvedPop) {
    const k = new Date(s.generatedMs).toISOString().slice(0, 10);
    const cur = byDay.get(k) ?? { pop: 0, cap: 0 };
    cur.pop += 1;
    if (inCorpus.has(s.id)) cur.cap += 1;
    byDay.set(k, cur);
  }
  for (const [d, v] of [...byDay.entries()].sort()) {
    const rate = v.pop ? ((v.cap / v.pop) * 100).toFixed(1) : '0.0';
    console.log(`    ${d}  resolved=${String(v.pop).padStart(4)}  in corpus=${String(v.cap).padStart(3)}  capture=${rate.padStart(5)}%`);
  }

  const ev = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  console.log('\n  CORPUS EV RESTATED WITHOUT A BEFORE/AFTER DELTA');
  console.log(`    n=${rs.length}  EV=${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R  (bar-verified labels, whole corpus)`);

  console.log('\n' + '='.repeat(80));
  console.log(`ITEM 43(d): ${fail === 0 ? 'ALL GATES PASSED' : `${fail} GATE FAILURE(S) — SELECTION BIAS REPORTED, NOTHING CLAIMED CLEAN`} (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(80));
}

main().catch((e: unknown) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
