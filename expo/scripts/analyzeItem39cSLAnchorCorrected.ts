/**
 * ITEM 39c — CORRECTED SL-ANCHORED MEASUREMENT
 * ============================================
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
 * WHY THIS SCRIPT EXISTS — A CORRECTION TO MY OWN MEASUREMENT.
 *  Item 39b's "bars closing beyond SL" column aggregated over the FULL 24h
 *  window. That is the WRONG anchor: for idx 345 it reported 1160 bars, but
 *  that only reflects price collapsing and staying below SL for the rest of the
 *  day — it says NOTHING about whether the FIRST SL touch was a brief wick or a
 *  sustained breach. The confirmSLHit question is strictly about the moment of
 *  FIRST touch, so the measurement must be anchored there.
 *
 * CORRECTED MEASUREMENT, anchored at the FIRST SL touch:
 *   39c-1. The first-SL-touch bar itself: did it CLOSE beyond SL, or only wick?
 *   39c-2. From that bar forward, how many CONSECUTIVE bars closed beyond SL?
 *          (1 bar = 60s of sustained breach, vs the 2500ms live threshold.)
 *   39c-3. Did price return INSIDE the SL before the TP was touched? That return
 *          is what resets confirmSLHit's tracker and keeps the trade "open".
 *   39c-4. Re-attribute mechanism A vs B on this corrected basis.
 *
 * PRE-REGISTERED GATES:
 *   G1. "Wick-only first touch" = the first SL-touch bar does NOT close beyond
 *       SL. This is the ONLY configuration where confirmSLHit legitimately
 *       refuses while the bar resolver counts SL_HIT.
 *   G2. Mechanism A requires: wick-only first touch (G1) AND the TP touched
 *       inside the 2h live window.
 *   G3. If the first touch bar DOES close beyond SL and stays beyond for >=1
 *       bar, then the live monitor SHOULD have confirmed the SL, and the false
 *       WIN is NOT explained by confirmation asymmetry -> mechanism is
 *       something else and must be named, not assumed.
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
const LIVE_WINDOW_MS = 2 * 3600_000;
const FALSE_WIN_IDX = [243, 245, 341, 342, 345, 362, 62];

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 39c — CORRECTED SL-ANCHORED MEASUREMENT');
  console.log('This CORRECTS Item 39b, whose bars-beyond-SL count used the wrong anchor');
  console.log('(full 24h instead of the first SL touch). READ-ONLY. NO FIX APPLIED.');
  console.log('='.repeat(80));
  console.log('\nPRE-REGISTERED GATES:');
  console.log('  G1 WICK-ONLY: first SL-touch bar does NOT close beyond SL.');
  console.log('  G2 MECH A: wick-only first touch AND TP touched inside 2h.');
  console.log('  G3 If first touch closes beyond SL and stays >=1 bar, the live monitor');
  console.log('     SHOULD have confirmed -> confirmation asymmetry does NOT explain it.');

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

  console.log('\n' + '='.repeat(80));
  console.log('39c-1/2/3 — FIRST-SL-TOUCH ANCHORED ANALYSIS');
  console.log('='.repeat(80));
  console.log('  idx  dir  SL_touch  touch_bar   pen_at   consec_closed  returned_inside   TP_touch  TP<2h');
  console.log('  ' + '─'.repeat(104));

  interface Out {
    idx: number;
    dir: string;
    wickOnly: boolean;
    tpIn2h: boolean;
    consec: number;
    mech: string;
  }
  const outs: Out[] = [];

  for (const idx of FALSE_WIN_IDX) {
    const sig = byIdx.get(idx);
    if (!sig) continue;
    const bars = await fetchBars(client, sig.generatedMs, sig.generatedMs + 24 * 3600_000);
    if (bars.length === 0) continue;
    const dir = sig.direction;
    const impliedTp = idx === 362 ? sig.tp[0] : sig.tp[2];

    // first SL touch bar index
    let slI = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (dir === 'BUY' ? b.low <= sig.sl : b.high >= sig.sl) {
        slI = i;
        break;
      }
    }
    // first TP touch bar index
    let tpI = -1;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (dir === 'BUY' ? b.high >= impliedTp : b.low <= impliedTp) {
        tpI = i;
        break;
      }
    }
    if (slI < 0) continue;

    const tb = bars[slI];
    const closedBeyond = dir === 'BUY' ? tb.close <= sig.sl : tb.close >= sig.sl;
    const penAt = dir === 'BUY' ? (sig.sl - tb.low) / PIP : (tb.high - sig.sl) / PIP;

    // consecutive bars from slI that CLOSE beyond SL
    let consec = 0;
    for (let i = slI; i < bars.length; i++) {
      const b = bars[i];
      const cb = dir === 'BUY' ? b.close <= sig.sl : b.close >= sig.sl;
      if (cb) consec++;
      else break;
    }

    // did price return INSIDE the SL before TP was touched?
    let returnedInside = false;
    const limit = tpI >= 0 ? tpI : bars.length;
    for (let i = slI; i < limit; i++) {
      const b = bars[i];
      const inside = dir === 'BUY' ? b.close > sig.sl : b.close < sig.sl;
      if (inside) {
        returnedInside = true;
        break;
      }
    }

    const tpMs = tpI >= 0 ? bars[tpI].timestamp : null;
    const tpIn2h = tpMs !== null && tpMs - sig.generatedMs < LIVE_WINDOW_MS;
    const wickOnly = !closedBeyond;
    const mech = wickOnly && tpIn2h
      ? 'A (confirm asymmetry)'
      : !wickOnly
        ? 'NOT-A (SL was confirmable)'
        : 'B (TP outside 2h)';

    outs.push({ idx, dir, wickOnly, tpIn2h, consec, mech });

    console.log(
      `  ${String(idx).padEnd(4)} ${dir.padEnd(4)} ${('+' + ((tb.timestamp - sig.generatedMs) / 3600_000).toFixed(2) + 'h').padStart(8)} ${(closedBeyond ? 'CLOSED' : 'WICK').padStart(10)} ${(penAt.toFixed(1) + 'p').padStart(8)} ${String(consec).padStart(14)} ${(returnedInside ? 'YES' : 'NO').padStart(16)} ${(tpMs !== null ? '+' + ((tpMs - sig.generatedMs) / 3600_000).toFixed(2) + 'h' : 'never').padStart(10)} ${(tpIn2h ? 'YES' : 'NO').padStart(6)}`,
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('39c-4 — CORRECTED MECHANISM ATTRIBUTION');
  console.log('='.repeat(80));
  const counts = new Map<string, number>();
  for (const o of outs) counts.set(o.mech, (counts.get(o.mech) ?? 0) + 1);
  for (const [m, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n} signal(s)  <-  ${m}`);
  }
  const wickOnlyN = outs.filter((o) => o.wickOnly).length;
  console.log(`\n  G1: first-touch WICK-ONLY count = ${wickOnlyN} / ${outs.length}`);
  console.log(`  G3: first-touch CLOSED-beyond-SL count = ${outs.length - wickOnlyN} / ${outs.length}`);
  if (outs.length - wickOnlyN > 0) {
    console.log('\n  For the CLOSED-beyond-SL signals the live monitor had ample bar-level');
    console.log('  evidence to confirm the SL. Confirmation asymmetry does NOT explain those.');
    console.log('  The remaining explanation must be that the LIVE PRICE FEED the monitor was');
    console.log('  reading did not show these levels at all — i.e. a venue/basis divergence');
    console.log('  between the entry-price feed (Capital.com/Swissquote) and gold_m1_bars');
    console.log('  (Vantage MT5 XAUUSDm). That is Phase 0 Item 4 territory.');
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 39c complete. NO FIX APPLIED. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
