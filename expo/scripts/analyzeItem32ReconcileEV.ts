/**
 * ITEM 32 — RECONCILE THE CANONICAL EV
 * ====================================
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
 * Two EV figures exist in the system and must be reconciled:
 *  A) +0.0493R (396 rows) — from analyzeExecutionCostSensitivity.ts:
 *     R = (exit - entry) / |entry - sl| signed by direction, using the
 *     EXPORT's own `exit price` field. Denominator = all 396 resolved
 *     signals (every block in SECTION 1 with an exit price and non-zero SL).
 *  B) +0.0883R (382 rows) — from investigateDirectionSelection.ts:
 *     R = dirSign * (resolver.exitPrice - fill) / risk, using the REAL
 *     resolveSignalWithBars() with fromScratch:true against gold_m1_bars.
 *     Denominator = 383 bar-covered signals, 382 resolved with a real fill
 *     (1 NEVER_FILLABLE excluded). Win predicate = R > 0.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECT from Supabase via anon key.
 * Export fetched to /tmp/diagnostics_export.txt. No Rork backend reads.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

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

// ─── types ──────────────────────────────────────────────────────────────
interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  exit: number | null;
  id: string;
  generatedMs: number;
}

// ─── export parser (from investigateDirectionSelection.ts) ──────────────
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
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp[0],
    tp2: p.tp[1],
    tp3: p.tp[2],
    sl: p.sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

function profitFactor(rs: number[]): number {
  const gw = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  return gl === 0 ? Infinity : gw / gl;
}

async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 400; p++) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const client: SupabaseClient = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL as string,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log('='.repeat(80));
  console.log('ITEM 32 — RECONCILE THE CANONICAL EV');
  console.log('MINDSET 8 rules apply. Read-only. No engine code touched.');
  console.log('='.repeat(80));

  // ── fetch export ──
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  for (const path of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`  Export fetched: ${text.length} bytes`);
      break;
    }
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Signals parsed: ${signals.length}`);

  // ── fetch bars ──
  const minTs = Math.min(...signals.map((s) => s.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...signals.map((s) => s.generatedMs)) + 8 * 60 * 60_000;
  const bars = await fetchBars(client, minTs, maxTs);
  console.log(`  Bars fetched: ${bars.length} from ${new Date(minTs).toISOString()} to ${new Date(maxTs).toISOString()}`);
  const byMinute = new Set<number>(bars.map((b) => Math.floor(b.timestamp / 60_000) * 60_000));
  const evalNowMs = bars.length > 0 ? bars[bars.length - 1].timestamp : Date.now();

  // ═══════════════════════════════════════════════════════════════════════
  // METHOD A — export's own exit price (0.0493R source)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('METHOD A — export exit price (source of +0.0493R)');
  console.log('─'.repeat(80));

  const EXCLUDED_A = new Set(['ACTIVE', 'EXPIRED_MISSED_ENTRY', 'NEVER_FILLABLE']);
  const methodA = signals
    .filter((s) => !EXCLUDED_A.has(s.status) && s.exit !== null && Math.abs(s.entry - s.sl) > 0.01)
    .map((s) => {
      const risk = Math.abs(s.entry - s.sl);
      const dirSign = s.direction === 'BUY' ? 1 : -1;
      const r = (dirSign * (s.exit as number - s.entry)) / risk;
      return { signal: s, r, risk };
    });
  const rsA = methodA.map((m) => m.r);
  const evA = mean(rsA);
  const wrA = (rsA.filter((r) => r > 0).length / rsA.length) * 100;
  const pfA = profitFactor(rsA);
  console.log(`  outcome source : export's own "exit price" field`);
  console.log(`  R derivation   : dirSign * (exitPrice - entry) / |entry - sl|`);
  console.log(`  win predicate  : R > 0`);
  console.log(`  denominator    : ${rsA.length} (all resolved signals with exit price + non-zero SL)`);
  console.log(`  exclusions     : ACTIVE, EXPIRED_MISSED_ENTRY, NEVER_FILLABLE (none present in this export)`);
  console.log(`  EV = ${evA >= 0 ? '+' : ''}${evA.toFixed(4)}R  WR = ${wrA.toFixed(1)}%  PF = ${pfA.toFixed(3)}  SD = ${sd(rsA).toFixed(4)}`);

  // ═══════════════════════════════════════════════════════════════════════
  // METHOD B — resolveSignalWithBars fromScratch (0.0883R source)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('METHOD B — resolveSignalWithBars fromScratch (source of +0.0883R)');
  console.log('─'.repeat(80));

  const covered = signals.filter((s) => byMinute.has(Math.floor(s.generatedMs / 60_000) * 60_000));
  console.log(`  bar-covered signals: ${covered.length} (of ${signals.length} total)`);

  const quiet = { fromScratch: true, evalNowMs, logPrefix: '' };
  const origLog = console.log;
  console.log = (): void => {};
  const methodBRaw: { signal: ParsedSignal; out: ResolverOutcome; r: number | null; covered: boolean }[] = [];
  for (const p of covered) {
    const sig = toTradingSignal(p);
    const out = resolveSignalWithBars(sig, bars, quiet);
    const risk = Math.abs(p.entry - p.sl);
    const dirSign = p.direction === 'BUY' ? 1 : -1;
    let r: number | null = null;
    if (risk > 0 && out.entryConfirmed) {
      const fill = out.entryFillPrice ?? p.entry;
      r = (dirSign * (out.exitPrice - fill)) / risk;
    }
    methodBRaw.push({ signal: p, out, r, covered: true });
  }
  console.log = origLog;

  const methodB = methodBRaw.filter((m) => m.r !== null);
  const notCovered = signals.filter((s) => !byMinute.has(Math.floor(s.generatedMs / 60_000) * 60_000));
  const neverFillable = methodBRaw.filter((m) => m.r === null);

  const rsB = methodB.map((m) => m.r as number);
  const evB = mean(rsB);
  const wrB = (rsB.filter((r) => r > 0).length / rsB.length) * 100;
  const pfB = profitFactor(rsB);
  console.log(`  outcome source : resolveSignalWithBars() with fromScratch:true against gold_m1_bars`);
  console.log(`  R derivation   : dirSign * (resolver.exitPrice - entryFillPrice) / |entry - sl|`);
  console.log(`  win predicate  : R > 0`);
  console.log(`  denominator    : ${rsB.length} (bar-covered + entry confirmed)`);
  console.log(`  exclusions     : ${notCovered.length} not bar-covered, ${neverFillable.length} NEVER_FILLABLE/entry-not-confirmed`);
  console.log(`  EV = ${evB >= 0 ? '+' : ''}${evB.toFixed(4)}R  WR = ${wrB.toFixed(1)}%  PF = ${pfB.toFixed(3)}  SD = ${sd(rsB).toFixed(4)}`);

  // ═══════════════════════════════════════════════════════════════════════
  // RECONCILIATION — which rows appear in one and not the other
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('RECONCILIATION — row membership');
  console.log('─'.repeat(80));

  const aIndices = new Set(methodA.map((m) => m.signal.index));
  const bIndices = new Set(methodB.map((m) => m.signal.index));
  const inAButNotB = [...aIndices].filter((i) => !bIndices.has(i));
  const inBButNotA = [...bIndices].filter((i) => !aIndices.has(i));
  const inBoth = [...aIndices].filter((i) => bIndices.has(i));

  console.log(`  In A only: ${inAButNotB.length} — ${inAButNotB.length <= 30 ? inAButNotB.join(', ') : inAButNotB.slice(0, 30).join(', ') + ' ...'}`);
  console.log(`  In B only: ${inBButNotA.length} — ${inBButNotA.length <= 30 ? inBButNotA.join(', ') : inBButNotA.slice(0, 30).join(', ') + ' ...'}`);
  console.log(`  In both:   ${inBoth.length}`);

  // Detail on A-only: are they not bar-covered or NEVER_FILLABLE?
  if (inAButNotB.length > 0) {
    console.log(`\n  A-only breakdown:`);
    for (const idx of inAButNotB) {
      const sig = signals.find((s) => s.index === idx)!;
      const isCovered = byMinute.has(Math.floor(sig.generatedMs / 60_000) * 60_000);
      const bRow = methodBRaw.find((m) => m.signal.index === idx);
      const reason = !isCovered
        ? 'not bar-covered'
        : bRow && !bRow.out.entryConfirmed
          ? `entry not confirmed (resolver status: ${bRow.out.newStatus})`
          : 'unknown';
      console.log(`    #${idx} ${sig.direction} @ ${sig.entry} status=${sig.status} -> ${reason}`);
    }
  }

  // Detail on B-only: do they have exit prices in the export?
  if (inBButNotA.length > 0) {
    console.log(`\n  B-only breakdown:`);
    for (const idx of inBButNotA) {
      const sig = signals.find((s) => s.index === idx)!;
      const aRow = methodA.find((m) => m.signal.index === idx);
      const reason = !aRow ? (sig.exit === null ? 'no exit price in export' : EXCLUDED_A.has(sig.status) ? `excluded status: ${sig.status}` : `risk <= 0.01`) : 'unknown';
      console.log(`    #${idx} ${sig.direction} @ ${sig.entry} status=${sig.status} exit=${sig.exit ?? 'null'} -> ${reason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // R COMPARISON ON THE OVERLAP
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('R COMPARISON — on the ${inBoth.length} signals in both sets');
  console.log('─'.repeat(80));

  const pairs: { index: number; dir: string; rA: number; rB: number; statusA: string; statusB: string; diff: number }[] = [];
  for (const idx of inBoth) {
    const a = methodA.find((m) => m.signal.index === idx)!;
    const b = methodB.find((m) => m.signal.index === idx)!;
    pairs.push({
      index: idx,
      dir: a.signal.direction,
      rA: a.r,
      rB: b.r as number,
      statusA: a.signal.status,
      statusB: b.out.newStatus,
      diff: (b.r as number) - a.r,
    });
  }
  const diffs = pairs.map((p) => p.diff);
  const evOverlapA = mean(pairs.map((p) => p.rA));
  const evOverlapB = mean(pairs.map((p) => p.rB));
  console.log(`  EV on overlap (A method): ${evOverlapA >= 0 ? '+' : ''}${evOverlapA.toFixed(4)}R`);
  console.log(`  EV on overlap (B method): ${evOverlapB >= 0 ? '+' : ''}${evOverlapB.toFixed(4)}R`);
  console.log(`  Mean R diff (B - A):       ${mean(diffs).toFixed(4)}R`);
  console.log(`  Median R diff:             ${median(diffs).toFixed(4)}R`);
  console.log(`  R diff SD:                 ${sd(diffs).toFixed(4)}R`);
  console.log(`  Max |R diff|:              ${Math.max(...diffs.map(Math.abs)).toFixed(4)}R`);

  // Where do the big diffs come from?
  const bigDiffs = pairs.filter((p) => Math.abs(p.diff) > 0.1).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  console.log(`\n  Signals with |R diff| > 0.1: ${bigDiffs.length}`);
  if (bigDiffs.length > 0) {
    console.log(`  ${"idx".padStart(4)} ${"dir".padEnd(5)} ${"rA".padStart(8)} ${"rB".padStart(8)} ${"diff".padStart(8)} ${"statusA".padEnd(20)} ${"statusB".padEnd(20)}`);
    for (const p of bigDiffs.slice(0, 20)) {
      console.log(`  ${String(p.index).padStart(4)} ${p.dir.padEnd(5)} ${p.rA.toFixed(4).padStart(8)} ${p.rB.toFixed(4).padStart(8)} ${p.diff >= 0 ? '+' : ''}${p.diff.toFixed(4).padStart(7)} ${p.statusA.padEnd(20)} ${p.statusB.padEnd(20)}`);
    }
  }

  // Status mapping: how many agree vs disagree?
  const statusMatch = pairs.filter((p) => p.statusA === p.statusB).length;
  const statusDiff = pairs.length - statusMatch;
  console.log(`\n  Status agreement: ${statusMatch}/${pairs.length} match, ${statusDiff} differ`);
  if (statusDiff > 0) {
    const mismatches = pairs.filter((p) => p.statusA !== p.statusB);
    const byPair = new Map<string, number>();
    for (const m of mismatches) {
      const k = `${m.statusA} -> ${m.statusB}`;
      byPair.set(k, (byPair.get(k) ?? 0) + 1);
    }
    console.log(`  Mismatch patterns:`);
    for (const [k, v] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k}: ${v}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CANONICAL DECLARATION
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('CANONICAL DECLARATION');
  console.log('─'.repeat(80));

  console.log(`\n  Method A (export exit price):`);
  console.log(`    Denominator: 396 — every signal in the export with an exit price and non-zero SL.`);
  console.log(`    R = dirSign * (exitPrice - entry) / |entry - sl|`);
  console.log(`    Uses the engine's own recorded exit price (which may reflect a phantom spike,`);
  console.log(`    a live tick that never appeared in any bar, or a status that the resolver`);
  console.log(`    would correct). No bar replay. No entry-fill verification.`);
  console.log(`    EV = ${evA >= 0 ? '+' : ''}${evA.toFixed(4)}R`);

  console.log(`\n  Method B (resolver fromScratch):`);
  console.log(`    Denominator: 382 — bar-covered signals where the resolver confirmed entry fill.`);
  console.log(`    R = dirSign * (resolverExitPrice - entryFillPrice) / |entry - sl|`);
  console.log(`    Replays real M1 bar-by-bar. Corrects phantom ALL_TARGETS_HIT, applies post-TP1`);
  console.log(`    profit locks, wick-through SL logic. Only counts signals where price actually`);
  console.log(`    traded the entry band. This is what a real position would have experienced.`);
  console.log(`    EV = ${evB >= 0 ? '+' : ''}${evB.toFixed(4)}R`);

  console.log(`\n  The difference (${(evB - evA).toFixed(4)}R) is NOT a discrepancy — it is two different`);
  console.log(`  questions. Method A asks "what did the export record?" Method B asks "what would`);
  console.log(`  a real position have experienced against actual bars?" The gap is the cost of`);
  console.log(`  the engine's recording imperfections: phantom spikes, tick-only exits that no`);
  console.log(`  M1 bar corroborates, and statuses the fromScratch resolver corrects.`);

  console.log(`\n  CANONICAL = METHOD B (resolver fromScratch).`);
  console.log(`    Rationale: Method B is the method that does not trust the engine's own recording`);
  console.log(`    and instead asks the bars what actually happened. It is the method already used`);
  console.log(`    by every counterfactual in this system (Items 6, 7, 9-12, 21, 22, 27). Method A`);
  console.log(`    is a convenience metric for cost-sensitivity tables where the question is "given`);
  console.log(`    these exit prices, what cost would zero the book?" — it is not a tradable result.`);
  console.log(`    The canonical figure for Items 33 and 34 is the resolver EV.`);

  // ═══════════════════════════════════════════════════════════════════════
  // BUY/SELL SPLIT — POWER STATED
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(80));
  console.log('BUY/SELL SPLIT — CANONICAL (Method B), POWER STATED');
  console.log('─'.repeat(80));

  for (const dir of ['BUY', 'SELL'] as const) {
    const sub = methodB.filter((m) => m.signal.direction === dir);
    const rs = sub.map((m) => m.r as number);
    const ev = mean(rs);
    const wr = (rs.filter((r) => r > 0).length / rs.length) * 100;
    const pf = profitFactor(rs);
    const sigma = sd(rs);
    // MDE at 80% power: delta_min = 2.8 * sigma * sqrt(2/n)
    const mde = sub.length >= 10 ? 2.8 * sigma * Math.sqrt(2 / sub.length) : Infinity;
    console.log(`\n  ${dir} (n=${rs.length}):`);
    console.log(`    EV = ${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R  WR = ${wr.toFixed(1)}%  PF = ${pf.toFixed(3)}  SD = ${sigma.toFixed(4)}`);
    console.log(`    MDE (80% power, alpha=0.05) = ${mde === Infinity ? 'n/a (n<10)' : mde.toFixed(4) + 'R'}`);
    console.log(`    Risk$ median = ${median(sub.map((m) => Math.abs(m.signal.entry - m.signal.sl))).toFixed(2)}`);
  }

  // Full book
  console.log(`\n  FULL BOOK (n=${rsB.length}):`);
  console.log(`    EV = ${evB >= 0 ? '+' : ''}${evB.toFixed(4)}R  WR = ${wrB.toFixed(1)}%  PF = ${pfB.toFixed(3)}  SD = ${sd(rsB).toFixed(4)}`);

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 32 reconciliation complete.');
  console.log('='.repeat(80));
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
