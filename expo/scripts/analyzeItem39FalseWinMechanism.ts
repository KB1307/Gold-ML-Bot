/**
 * ITEM 39 — DIAGNOSE THE FALSE-WIN MECHANISM
 * ==========================================
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
 * DATA-SOURCE RULE: gold_m1_bars + trade_outcomes_v1 read DIRECT from Supabase
 * via anon key. READ-ONLY. No engine code touched. NO FIX APPLIED.
 *
 * WHAT THIS MEASURES (39a-39c):
 *  Item 37 found 7 signals the corpus labelled WIN that the bars say were LOSS
 *  (SL_HIT). Widening the audit window does NOT explain these — the SL event is
 *  INSIDE the 2h window. So a second, distinct mechanism banked a false WIN.
 *
 *  39a. FORENSIC PRICE TRACE. For each of the 7: reconstruct the full bar path
 *       and measure the Maximum Favourable Excursion (MFE) against TP1/TP2/TP3.
 *       If MFE never reached TP3 but the corpus says WIN with exit==TP3, then a
 *       price read existed that no bar corroborates => phantom tick.
 *  39b. EXIT-PRICE FINGERPRINTING. Each terminal branch in the live tick monitor
 *       writes a DETERMINISTIC exitPrice:
 *          ALL_TARGETS_HIT      -> exitPrice = signal.tp3            (exactly)
 *          PARTIAL_WIN_SL_HIT   -> exitPrice = (tp1+tp2+entry)/3     (exactly)
 *          SL_AFTER_BE          -> exitPrice = getPostTP1LockPrice() (exactly)
 *          SL_HIT               -> exitPrice = signal.sl             (exactly)
 *       Matching the corpus exit_price against these identifies WHICH branch
 *       fired, i.e. which code path banked the false WIN. This is provenance
 *       from the data, not from reading the code.
 *  39c. CURRENT-ACTIVITY CHECK. Is the responsible branch still ungated in the
 *       CURRENT code state, and has it changed in git history?
 *
 * PRE-REGISTERED GATES:
 *   G1. A signal is "phantom-TP confirmed" only if BOTH: (i) corpus result=WIN,
 *       (ii) no bar in the FULL 24h window reaches the TP level implied by the
 *       fingerprinted exit price. A single bar touching it disqualifies phantom.
 *   G2. The mechanism is "same bug class as the Path 3 defect" only if the
 *       responsible branch lacks a multi-read corroboration gate. If it HAS a
 *       gate, it is a different mechanism and must be named separately.
 *   G3. "Currently active" requires the ungated branch to be present in the
 *       working tree AND reachable (not behind a disabled flag).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, getPostTP1LockPrice } from '../services/signalResolver';
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
  exit: number | null;
  id: string;
  generatedMs: number;
}

interface CorpusRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  realized_r: number | null;
  is_scratch: boolean | null;
  confidence: number | null;
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

/** Local mirror of signalResolver's private getProtectedExitPrice, for fingerprinting only. */
function protectedExitPrice(sig: TradingSignal, targetsHit: number): number {
  const n = Math.max(0, Math.min(2, targetsHit));
  if (n >= 2) return Number(((sig.tp1 + sig.tp2 + sig.entryPrice) / 3).toFixed(1));
  if (n === 1) return getPostTP1LockPrice(sig);
  return sig.entryPrice;
}

/** Favourable excursion: how far price moved in the signal's favour, in price units. */
function favourableExtreme(bars: OhlcBar[], dir: 'BUY' | 'SELL'): number {
  if (bars.length === 0) return NaN;
  return dir === 'BUY'
    ? Math.max(...bars.map((b) => b.high))
    : Math.min(...bars.map((b) => b.low));
}

function adverseExtreme(bars: OhlcBar[], dir: 'BUY' | 'SELL'): number {
  if (bars.length === 0) return NaN;
  return dir === 'BUY'
    ? Math.min(...bars.map((b) => b.low))
    : Math.max(...bars.map((b) => b.high));
}

/** Did price reach `level` in the signal's favour at any point? Returns bar ts or null. */
function firstTouch(bars: OhlcBar[], dir: 'BUY' | 'SELL', level: number): number | null {
  for (const b of bars) {
    if (dir === 'BUY' ? b.high >= level : b.low <= level) return b.timestamp;
  }
  return null;
}

const PIP = 0.1;

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 39 — DIAGNOSE THE FALSE-WIN MECHANISM (distinct from Item 35)');
  console.log('MINDSET 8 rules apply. READ-ONLY. NO FIX APPLIED. Nothing ships.');
  console.log('='.repeat(80));
  console.log('\nPRE-REGISTERED GATES:');
  console.log('  G1 PHANTOM: corpus=WIN AND no bar in the full 24h window reaches the implied TP level.');
  console.log('  G2 BUG CLASS: "same class as Path 3 defect" only if the responsible branch has NO');
  console.log('     multi-read corroboration gate. If gated, it is a different mechanism, named separately.');
  console.log('  G3 ACTIVE: ungated branch present in working tree AND reachable (not flag-disabled).');

  // ── export ──
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
  const byId = new Map<string, ParsedSignal>();
  for (const s of signals) if (s.id) byId.set(s.id, s);
  console.log(`\n  Export signals parsed: ${signals.length}`);

  // ── corpus ──
  const corpus: CorpusRow[] = [];
  for (let page = 0; page < 40; page++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch, confidence')
      .order('ts', { ascending: true })
      .range(page * 500, (page + 1) * 500 - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    corpus.push(...(data as CorpusRow[]));
    if (data.length < 500) break;
  }
  console.log(`  Corpus rows: ${corpus.length}`);

  // ── re-identify the false-WIN set from scratch (do not hardcode Item 37's list) ──
  console.log('\n' + '='.repeat(80));
  console.log('RE-IDENTIFYING THE FALSE-WIN SET (independent of Item 37 hardcoding)');
  console.log('='.repeat(80));

  interface Case {
    row: CorpusRow;
    sig: ParsedSignal;
    bars24: OhlcBar[];
    resolverStatus: string;
    resolverExit: number;
  }
  const falseWins: Case[] = [];
  const day = 24 * 3600_000;

  for (const row of corpus) {
    const sig = byId.get(row.signal_id);
    if (!sig || sig.tp.length < 3 || !(sig.sl > 0)) continue;
    if (row.result !== 'WIN') continue;
    const bars24 = await fetchBars(client, sig.generatedMs, sig.generatedMs + day);
    if (bars24.length === 0) continue;
    // Canonical 8h resolution (Method B) — the same basis Item 37 used.
    const bars8 = bars24.filter((b) => b.timestamp <= sig.generatedMs + 8 * 3600_000);
    const outcome = resolveSignalWithBars(toTradingSignal(sig), bars8, {
      fromScratch: true,
      evalNowMs: sig.generatedMs + 8 * 3600_000,
    });
    if (outcome.outcomeResult === 'LOSS' || outcome.newStatus === 'SL_HIT') {
      falseWins.push({
        row,
        sig,
        bars24,
        resolverStatus: outcome.newStatus,
        resolverExit: outcome.exitPrice,
      });
    }
  }
  console.log(`  Corpus rows with result=WIN that resolve to LOSS on bars: ${falseWins.length}`);

  // ── 39b: exit-price fingerprinting ──
  console.log('\n' + '='.repeat(80));
  console.log('39b — EXIT-PRICE FINGERPRINT: which code branch banked each false WIN?');
  console.log('='.repeat(80));
  console.log('  Each live-monitor terminal branch writes a deterministic exitPrice.');
  console.log('  Matching corpus exit_price against them identifies the responsible branch.\n');
  console.log('  idx  dir   corpus_exit    tp3   partial(tp1+tp2+e)/3   sl_after_be_lock      sl   => BRANCH');
  console.log('  ' + '─'.repeat(108));

  const branchCounts = new Map<string, number>();
  const fingerprints: { c: Case; branch: string; impliedTp: number | null }[] = [];

  for (const c of falseWins) {
    const ts = toTradingSignal(c.sig);
    const fpTp3 = c.sig.tp[2];
    const fpPartial = protectedExitPrice(ts, 2);
    const fpAfterBe = protectedExitPrice(ts, 1);
    const fpSl = c.sig.sl;
    const e = c.row.exit_price;
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.051;

    let branch = 'UNMATCHED';
    let impliedTp: number | null = null;
    if (near(e, fpTp3)) {
      branch = 'ALL_TARGETS_HIT (live monitor, TP3 branch)';
      impliedTp = fpTp3;
    } else if (near(e, fpPartial)) {
      branch = 'PARTIAL_WIN_SL_HIT (post-TP2 retrace)';
      impliedTp = c.sig.tp[1];
    } else if (near(e, fpAfterBe)) {
      branch = 'SL_AFTER_BE (post-TP1 lock)';
      impliedTp = c.sig.tp[0];
    } else if (near(e, fpSl)) {
      branch = 'SL_HIT (but recorded WIN?! inconsistent)';
    }
    branchCounts.set(branch, (branchCounts.get(branch) ?? 0) + 1);
    fingerprints.push({ c, branch, impliedTp });

    console.log(
      `  ${String(c.sig.index).padEnd(4)} ${c.sig.direction.padEnd(5)} ${e.toFixed(1).padStart(11)} ${fpTp3.toFixed(1).padStart(6)} ${fpPartial.toFixed(1).padStart(21)} ${fpAfterBe.toFixed(1).padStart(18)} ${fpSl.toFixed(1).padStart(7)}   => ${branch}`,
    );
  }

  console.log('\n  Branch attribution summary:');
  for (const [b, n] of [...branchCounts].sort((x, y) => y[1] - x[1])) {
    console.log(`    ${n} signal(s)  <-  ${b}`);
  }

  // ── 39a: forensic bar trace / MFE ──
  console.log('\n' + '='.repeat(80));
  console.log('39a — FORENSIC BAR TRACE: did price EVER reach the TP the corpus banked?');
  console.log('='.repeat(80));
  console.log('  MFE = maximum favourable excursion over the FULL 24h window (generous to the corpus).');
  console.log('  If MFE never reaches the implied TP, no real bar supports the WIN => phantom read.\n');
  console.log('  idx  dir   entry  implied_TP   MFE_24h   MFE_short_of_TP   TP_touched?   SL_touched_at');
  console.log('  ' + '─'.repeat(104));

  let phantomConfirmed = 0;
  let tpGenuinelyTouched = 0;

  for (const f of fingerprints) {
    const { c, impliedTp } = f;
    const dir = c.sig.direction;
    const mfe = favourableExtreme(c.bars24, dir);
    const slTouch = firstTouch(c.bars24, dir === 'BUY' ? 'SELL' : 'BUY', c.sig.sl);
    const tpTouch = impliedTp !== null ? firstTouch(c.bars24, dir, impliedTp) : null;
    const shortBy =
      impliedTp !== null
        ? dir === 'BUY'
          ? (impliedTp - mfe) / PIP
          : (mfe - impliedTp) / PIP
        : NaN;
    if (impliedTp !== null) {
      if (tpTouch === null) phantomConfirmed++;
      else tpGenuinelyTouched++;
    }
    const slAt = slTouch !== null ? `+${((slTouch - c.sig.generatedMs) / 3600_000).toFixed(2)}h` : 'never';
    console.log(
      `  ${String(c.sig.index).padEnd(4)} ${dir.padEnd(5)} ${c.sig.entry.toFixed(1).padStart(6)} ${(impliedTp ?? NaN).toFixed(1).padStart(11)} ${mfe.toFixed(1).padStart(9)} ${(Number.isFinite(shortBy) ? shortBy.toFixed(1) + 'p' : 'n/a').padStart(17)} ${(tpTouch === null ? 'NO' : 'YES').padStart(13)} ${slAt.padStart(15)}`,
    );
  }

  console.log(`\n  G1 PHANTOM GATE: ${phantomConfirmed} of ${fingerprints.length} false WINs have NO bar reaching the banked TP.`);
  console.log(`  ${tpGenuinelyTouched} did genuinely touch the TP (so those are a DIFFERENT sub-mechanism —`);
  console.log('  the TP was real but the SL that came later was not honoured / ordering was wrong).');

  // ── ordering analysis for the genuinely-touched subset ──
  console.log('\n' + '='.repeat(80));
  console.log('39a(ii) — EVENT ORDERING for false WINs where the TP WAS genuinely touched');
  console.log('='.repeat(80));
  console.log('  If SL was touched BEFORE the TP, the live monitor banked a TP that the');
  console.log('  bar sequence says came too late — an ordering defect, not a phantom price.\n');
  console.log('  idx  dir   TP_touched_at   SL_touched_at   which_came_FIRST');
  console.log('  ' + '─'.repeat(72));
  let slFirstCount = 0;
  for (const f of fingerprints) {
    const { c, impliedTp } = f;
    if (impliedTp === null) continue;
    const dir = c.sig.direction;
    const tpTouch = firstTouch(c.bars24, dir, impliedTp);
    if (tpTouch === null) continue;
    const slTouch = firstTouch(c.bars24, dir === 'BUY' ? 'SELL' : 'BUY', c.sig.sl);
    const first = slTouch === null ? 'TP' : slTouch < tpTouch ? 'SL' : 'TP';
    if (first === 'SL') slFirstCount++;
    console.log(
      `  ${String(c.sig.index).padEnd(4)} ${dir.padEnd(5)} ${('+' + ((tpTouch - c.sig.generatedMs) / 3600_000).toFixed(2) + 'h').padStart(13)} ${(slTouch === null ? 'never' : '+' + ((slTouch - c.sig.generatedMs) / 3600_000).toFixed(2) + 'h').padStart(15)}   ${first} first`,
    );
  }
  console.log(`\n  SL-came-first count: ${slFirstCount}`);

  // ── per-signal detail dump ──
  console.log('\n' + '='.repeat(80));
  console.log('PER-SIGNAL FULL DETAIL (geometry, corpus record, resolver verdict)');
  console.log('='.repeat(80));
  for (const f of fingerprints) {
    const { c, branch, impliedTp } = f;
    const dir = c.sig.direction;
    console.log(`\n  ── idx ${c.sig.index} (${dir}) id=${c.row.signal_id.slice(-8)} ──`);
    console.log(`     generated:      ${new Date(c.sig.generatedMs).toISOString()}`);
    console.log(`     geometry:       entry=${c.sig.entry.toFixed(1)} sl=${c.sig.sl.toFixed(1)} tp1=${c.sig.tp[0].toFixed(1)} tp2=${c.sig.tp[1].toFixed(1)} tp3=${c.sig.tp[2].toFixed(1)}`);
    console.log(`     export status:  ${c.sig.status}  export exit=${c.sig.exit !== null ? c.sig.exit.toFixed(1) : 'n/a'}`);
    console.log(`     CORPUS says:    result=${c.row.result} exit=${c.row.exit_price.toFixed(1)} pnl=${c.row.pnl.toFixed(2)} realized_r=${c.row.realized_r ?? 'n/a'}`);
    console.log(`     fingerprint:    ${branch}${impliedTp !== null ? ` (implies TP level ${impliedTp.toFixed(1)})` : ''}`);
    console.log(`     RESOLVER says:  status=${c.resolverStatus} exit=${c.resolverExit.toFixed(1)}`);
    console.log(`     bars in 24h:    ${c.bars24.length}`);
    console.log(`     MFE (favour):   ${favourableExtreme(c.bars24, dir).toFixed(1)}`);
    console.log(`     MAE (adverse):  ${adverseExtreme(c.bars24, dir).toFixed(1)}`);
    if (impliedTp !== null) {
      const t = firstTouch(c.bars24, dir, impliedTp);
      console.log(`     implied TP touched: ${t === null ? 'NEVER (phantom price — no bar supports this WIN)' : new Date(t).toISOString()}`);
    }
    const slT = firstTouch(c.bars24, dir === 'BUY' ? 'SELL' : 'BUY', c.sig.sl);
    console.log(`     SL touched:     ${slT === null ? 'never' : new Date(slT).toISOString()}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 39 measurement complete. NO FIX APPLIED. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
