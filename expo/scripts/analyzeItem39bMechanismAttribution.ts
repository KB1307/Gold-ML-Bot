/**
 * ITEM 39b — FALSE-WIN MECHANISM ATTRIBUTION (follow-up to Item 39)
 * ================================================================
 *
 * MINDSET (restated verbatim):
 *  Senior Lead Quantitative Trading Engineer / Senior Institutional Gold
 *  (XAU/USD) Elite Portfolio Manager.
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
 * WHY THIS SCRIPT EXISTS:
 *  Item 39's gate G1 REJECTED the phantom-tick hypothesis. 0 of 7 false WINs
 *  lacked a real bar reaching the banked TP — all 7 genuinely touched their TP,
 *  but the SL was touched FIRST in all 7 cases. So the mechanism is NOT a bad
 *  price read. It is an ORDERING / CONFIRMATION-ASYMMETRY defect.
 *
 *  Two candidate mechanisms remain, and they have DIFFERENT signatures:
 *
 *  MECHANISM A — SL-confirmation asymmetry inside the live tick monitor.
 *    The live monitor gates SL through confirmSLHit() (needs >=1.5 pips
 *    penetration AND >=2500ms sustained AND >=2 ticks). A brief SL wick that
 *    recovers resets the tracker and never confirms. The TP branches at
 *    TradingContext.tsx:2882 (BUY) / :2930 (SELL) have NO gate at all — a
 *    single read at/through TP banks ALL_TARGETS_HIT instantly. So: SL wicks
 *    (unconfirmed, trade stays open) -> price later reaches TP -> false WIN.
 *    SIGNATURE: both the SL touch AND the TP touch fall inside the live
 *    monitor's reachable window (signal age < 2h, since :2773 marks CLOSED
 *    beyond that), and the SL penetration is shallow/brief.
 *
 *  MECHANISM B — the TP was only reachable OUTSIDE the live 2h window.
 *    If the TP is first touched at +19h, the live monitor could not have seen
 *    it (:2773 forces CLOSED past 2h). Something else banked it, OR the bars
 *    we read TODAY differ from what the app saw THEN (venue basis / bar gaps /
 *    later backfill). SIGNATURE: TP first touch > 2h.
 *
 * THIS SCRIPT MEASURES THE DISCRIMINATING FACTS:
 *   39b-1. SL penetration depth + sustained duration (consecutive bars beyond
 *          SL) -> would confirmSLHit() have confirmed on this bar evidence?
 *   39b-2. TP first-touch inside vs outside the live 2h window -> A vs B.
 *   39b-3. Bar coverage / largest gap in the first 24h -> is the resolver's own
 *          label trustworthy, or are bars missing (MINDSET rule 5)?
 *   39b-4. Attribution table: each of the 7 assigned to A, B, or UNRESOLVED.
 *
 * PRE-REGISTERED GATES:
 *   G1. Mechanism A is assigned ONLY if SL-touch AND TP-touch are both < 2h.
 *   G2. Mechanism B is assigned ONLY if TP-touch >= 2h.
 *   G3. A signal's resolver label is flagged UNTRUSTWORTHY if the largest bar
 *       gap inside its first 2h exceeds 15 minutes (the TP/SL could have been
 *       hit inside the gap and we would never see it).
 *
 * READ-ONLY. NO FIX APPLIED. Nothing ships.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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
    } catch {
      /* optional */
    }
  }
  return out;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  id: string;
  generatedMs: number;
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
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 600; p++) {
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

const PIP = 0.1;
// Live monitor's SL confirmation thresholds (TradingContext.tsx:196-198).
const SL_MIN_PENETRATION_PIPS = 1.5;
const SL_MIN_DURATION_MS = 2500;
const SL_MIN_TICKS = 2;
const LIVE_WINDOW_MS = 2 * 3600_000;

/** The 7 false-WIN signal indices established by Item 39 (re-verified there). */
const FALSE_WIN_IDX = [243, 245, 341, 342, 345, 362, 62];

function firstTouch(bars: OhlcBar[], favourDir: 'BUY' | 'SELL', level: number): number | null {
  for (const b of bars) {
    if (favourDir === 'BUY' ? b.high >= level : b.low <= level) return b.timestamp;
  }
  return null;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 39b — FALSE-WIN MECHANISM ATTRIBUTION (A vs B)');
  console.log('MINDSET 8 rules apply. READ-ONLY. NO FIX APPLIED. Nothing ships.');
  console.log('='.repeat(80));
  console.log('\nItem 39 gate G1 REJECTED the phantom-tick hypothesis: all 7 false WINs');
  console.log('genuinely touched their TP, but SL was touched FIRST in all 7.');
  console.log('\nPRE-REGISTERED GATES:');
  console.log('  G1 MECH A (SL-confirmation asymmetry): SL-touch AND TP-touch both < 2h.');
  console.log('  G2 MECH B (TP outside live window):   TP-touch >= 2h.');
  console.log('  G3 UNTRUSTWORTHY LABEL: largest bar gap inside first 2h > 15 min.');
  console.log(`\nLive monitor SL confirmation thresholds (TradingContext.tsx:196-198):`);
  console.log(`  min penetration = ${SL_MIN_PENETRATION_PIPS} pips (= ${(SL_MIN_PENETRATION_PIPS * PIP).toFixed(2)} price)`);
  console.log(`  min duration    = ${SL_MIN_DURATION_MS} ms`);
  console.log(`  min ticks       = ${SL_MIN_TICKS}`);

  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let ok = false;
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${p}`, { headers: h });
    if (res.ok) {
      writeFileSync('/tmp/diagnostics_export.txt', await res.text());
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log('\n  BLOCKER: export unavailable. STOP.');
    return;
  }
  const signals = parseExport('/tmp/diagnostics_export.txt');
  const byIdx = new Map<number, ParsedSignal>();
  for (const s of signals) byIdx.set(s.index, s);

  interface Row {
    sig: ParsedSignal;
    slTouchMs: number | null;
    tpTouchMs: number | null;
    impliedTp: number;
    maxPenetrationPips: number;
    consecutiveBarsBeyondSl: number;
    minutesBeyondSl: number;
    barsIn2h: number;
    largestGapMin2h: number;
    barsIn24h: number;
    largestGapMin24h: number;
    mechanism: string;
    labelTrust: string;
  }
  const rows: Row[] = [];

  for (const idx of FALSE_WIN_IDX) {
    const sig = byIdx.get(idx);
    if (!sig) continue;
    const bars24 = await fetchBars(client, sig.generatedMs, sig.generatedMs + 24 * 3600_000);
    if (bars24.length === 0) continue;
    const bars2h = bars24.filter((b) => b.timestamp <= sig.generatedMs + LIVE_WINDOW_MS);

    const dir = sig.direction;
    const advDir: 'BUY' | 'SELL' = dir === 'BUY' ? 'SELL' : 'BUY';
    const slTouchMs = firstTouch(bars24, advDir, sig.sl);

    // Implied TP from Item 39's fingerprint: 6 of 7 were TP3, idx 362 was TP1.
    const impliedTp = idx === 362 ? sig.tp[0] : sig.tp[2];
    const tpTouchMs = firstTouch(bars24, dir, impliedTp);

    // SL penetration analysis: how deep and for how long did bars stay beyond SL?
    let maxPen = 0;
    let consec = 0;
    let bestConsec = 0;
    let minutesBeyond = 0;
    for (const b of bars24) {
      const beyond = dir === 'BUY' ? b.low <= sig.sl : b.high >= sig.sl;
      const pen = dir === 'BUY' ? (sig.sl - b.low) / PIP : (b.high - sig.sl) / PIP;
      if (beyond) {
        maxPen = Math.max(maxPen, pen);
        // A bar CLOSING beyond SL is the only bar-level proxy for "sustained".
        const closedBeyond = dir === 'BUY' ? b.close <= sig.sl : b.close >= sig.sl;
        if (closedBeyond) {
          consec++;
          bestConsec = Math.max(bestConsec, consec);
          minutesBeyond++;
        } else {
          consec = 0;
        }
      } else {
        consec = 0;
      }
    }

    const gap = (bs: OhlcBar[]): number => {
      let g = 0;
      for (let i = 1; i < bs.length; i++) {
        g = Math.max(g, (bs[i].timestamp - bs[i - 1].timestamp) / 60000);
      }
      return g;
    };

    const slIn2h = slTouchMs !== null && slTouchMs - sig.generatedMs < LIVE_WINDOW_MS;
    const tpIn2h = tpTouchMs !== null && tpTouchMs - sig.generatedMs < LIVE_WINDOW_MS;
    let mechanism = 'UNRESOLVED';
    if (slIn2h && tpIn2h) mechanism = 'A (SL-confirm asymmetry)';
    else if (tpTouchMs !== null && !tpIn2h) mechanism = 'B (TP outside 2h window)';

    const g2 = gap(bars2h);
    const labelTrust = g2 > 15 ? `UNTRUSTWORTHY (gap ${g2.toFixed(0)}min)` : 'TRUSTWORTHY';

    rows.push({
      sig,
      slTouchMs,
      tpTouchMs,
      impliedTp,
      maxPenetrationPips: maxPen,
      consecutiveBarsBeyondSl: bestConsec,
      minutesBeyondSl: minutesBeyond,
      barsIn2h: bars2h.length,
      largestGapMin2h: g2,
      barsIn24h: bars24.length,
      largestGapMin24h: gap(bars24),
      mechanism,
      labelTrust,
    });
  }

  // ── 39b-1: SL confirmation analysis ──
  console.log('\n' + '='.repeat(80));
  console.log('39b-1 — WOULD confirmSLHit() HAVE CONFIRMED THE SL, ON BAR EVIDENCE?');
  console.log('='.repeat(80));
  console.log('  A bar CLOSING beyond SL is the bar-level proxy for a sustained breach.');
  console.log('  A bar that only WICKS through SL and closes back inside is exactly the');
  console.log('  case confirmSLHit() is designed to reject (and the resolver to accept).\n');
  console.log('  idx  dir   SL      max_pen   bars_CLOSING_beyond_SL   min_pen_met?   verdict');
  console.log('  ' + '─'.repeat(96));
  let wickOnly = 0;
  for (const r of rows) {
    const penMet = r.maxPenetrationPips >= SL_MIN_PENETRATION_PIPS;
    const sustained = r.consecutiveBarsBeyondSl >= 1;
    const verdict = !sustained
      ? 'WICK ONLY -> live SL never confirms'
      : penMet
        ? 'would confirm (sustained + deep)'
        : 'sustained but shallow';
    if (!sustained) wickOnly++;
    console.log(
      `  ${String(r.sig.index).padEnd(4)} ${r.sig.direction.padEnd(5)} ${r.sig.sl.toFixed(1).padStart(7)} ${(r.maxPenetrationPips.toFixed(1) + 'p').padStart(9)} ${String(r.consecutiveBarsBeyondSl).padStart(22)}   ${(penMet ? 'YES' : 'NO').padStart(12)}   ${verdict}`,
    );
  }
  console.log(`\n  SL touches that were WICK-ONLY (never closed beyond SL): ${wickOnly} / ${rows.length}`);
  console.log('  For those, the resolver counts SL_HIT (wick-through) while the live monitor');
  console.log('  correctly refuses to confirm -> the two are structurally guaranteed to disagree.');

  // ── 39b-2: timing attribution ──
  console.log('\n' + '='.repeat(80));
  console.log('39b-2 — TIMING: is the banked TP even reachable by the live monitor (<2h)?');
  console.log('='.repeat(80));
  console.log('  idx  dir   SL_touch    TP_touch   SL<2h?  TP<2h?   => MECHANISM');
  console.log('  ' + '─'.repeat(84));
  for (const r of rows) {
    const slH = r.slTouchMs !== null ? (r.slTouchMs - r.sig.generatedMs) / 3600_000 : NaN;
    const tpH = r.tpTouchMs !== null ? (r.tpTouchMs - r.sig.generatedMs) / 3600_000 : NaN;
    console.log(
      `  ${String(r.sig.index).padEnd(4)} ${r.sig.direction.padEnd(5)} ${(Number.isFinite(slH) ? '+' + slH.toFixed(2) + 'h' : 'never').padStart(9)} ${(Number.isFinite(tpH) ? '+' + tpH.toFixed(2) + 'h' : 'never').padStart(11)} ${(slH < 2 ? 'YES' : 'NO').padStart(7)} ${(tpH < 2 ? 'YES' : 'NO').padStart(7)}   => ${r.mechanism}`,
    );
  }
  const mechCounts = new Map<string, number>();
  for (const r of rows) mechCounts.set(r.mechanism, (mechCounts.get(r.mechanism) ?? 0) + 1);
  console.log('\n  Mechanism attribution:');
  for (const [m, n] of [...mechCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n} signal(s)  <-  ${m}`);
  }

  // ── 39b-3: bar coverage / label trust ──
  console.log('\n' + '='.repeat(80));
  console.log('39b-3 — BAR COVERAGE: is the RESOLVER label itself trustworthy? (MINDSET rule 5)');
  console.log('='.repeat(80));
  console.log('  idx   bars_2h  largest_gap_2h   bars_24h  largest_gap_24h   label_trust');
  console.log('  ' + '─'.repeat(88));
  for (const r of rows) {
    console.log(
      `  ${String(r.sig.index).padEnd(5)} ${String(r.barsIn2h).padStart(8)} ${(r.largestGapMin2h.toFixed(0) + 'min').padStart(15)} ${String(r.barsIn24h).padStart(10)} ${(r.largestGapMin24h.toFixed(0) + 'min').padStart(16)}   ${r.labelTrust}`,
    );
  }
  const untrusted = rows.filter((r) => r.labelTrust !== 'TRUSTWORTHY').length;
  console.log(`\n  G3 verdict: ${untrusted} of ${rows.length} have an untrustworthy 2h bar window.`);

  // ── 39b-4: final attribution ──
  console.log('\n' + '='.repeat(80));
  console.log('39b-4 — FINAL ATTRIBUTION TABLE');
  console.log('='.repeat(80));
  console.log('  idx  dir   mechanism                      SL_evidence            label_trust');
  console.log('  ' + '─'.repeat(96));
  for (const r of rows) {
    const slEv = r.consecutiveBarsBeyondSl >= 1 ? `closed beyond SL x${r.consecutiveBarsBeyondSl}` : 'wick only';
    console.log(
      `  ${String(r.sig.index).padEnd(4)} ${r.sig.direction.padEnd(5)} ${r.mechanism.padEnd(30)} ${slEv.padEnd(22)} ${r.labelTrust}`,
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 39b complete. NO FIX APPLIED. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
