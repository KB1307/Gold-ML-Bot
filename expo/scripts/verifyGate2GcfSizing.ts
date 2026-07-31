/**
 * GATE 2 — GC=F futures vs Vantage sizing delta (the quota-exhaustion fallback case).
 * This is the case the user specifically flagged: when TwelveData quota exhausts,
 * the OLD path sizes risk on GC=F futures volatility, not spot XAU/USD.
 *
 * Usage: bunx tsx expo/scripts/verifyGate2GcfSizing.ts
 */
import { createClient } from '@supabase/supabase-js';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; source?: string; }

function computeATR(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) return 10;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close)));
  }
  return trs.slice(-period).reduce((s, tr) => s + tr, 0) / period;
}

const PIP = 0.10, SLM = 1.4;

async function main(): Promise<void> {
  const toTime = Date.now() - 5*60*1000;
  const fromTime = toTime - 120*60*1000;

  // Fetch Vantage bars
  const sc = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: vData } = await sc.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(fromTime).toISOString()).lte('timestamp', new Date(toTime).toISOString()).order('timestamp', { ascending: true });
  const vBars: Bar[] = (vData ?? []).map((r: { timestamp: string; open: number; high: number; low: number; close: number }) => ({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close, source: 'vantage' }));

  // Fetch Yahoo GC=F
  const p1 = Math.floor(fromTime/1000), p2 = Math.floor(toTime/1000)+120;
  let yBars: Bar[] = [];
  for (const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']) {
    try {
      const r = await fetch(`https://${host}/v8/finance/chart/GC=F?interval=1m&period1=${p1}&period2=${p2}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const d = await r.json() as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: number[]; high?: number[]; low?: number[]; close?: number[] }> } }> } };
      const res = d?.chart?.result?.[0]; if (!res?.timestamp) continue;
      const q = res.indicators?.quote?.[0]; if (!q) continue;
      for (let i = 0; i < res.timestamp.length; i++) {
        const bt = res.timestamp[i]*1000;
        if (bt >= fromTime && bt <= toTime && q.open?.[i]!=null && q.high?.[i]!=null && q.low?.[i]!=null && q.close?.[i]!=null) {
          yBars.push({ timestamp: bt, open: q.open[i]!, high: q.high[i]!, low: q.low[i]!, close: q.close[i]!, source: 'yahoo-gcf' });
        }
      }
      if (yBars.length > 0) break;
    } catch { continue; }
  }

  // Match by timestamp
  const vMap = new Map(vBars.map(b => [b.timestamp, b]));
  const matched: { v: Bar; y: Bar }[] = [];
  for (const yb of yBars) { const vb = vMap.get(yb.timestamp); if (vb) matched.push({ v: vb, y: yb }); }

  const vAtr = computeATR(vBars, 14);
  const yAtr = computeATR(yBars, 14);
  const vSl = vAtr * SLM / PIP;
  const ySl = yAtr * SLM / PIP;

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 2 — GC=F FUTURES vs VANTAGE (quota-exhaustion fallback case)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log();
  console.log('  This is the case the user specifically flagged: when TwelveData');
  console.log('  quota exhausts (~44% of the day per Phase 0), the OLD path sizes');
  console.log('  risk on GC=F futures volatility, not spot XAU/USD.');
  console.log();
  console.log(`  Vantage bars: ${vBars.length}  |  Yahoo GC=F bars: ${yBars.length}  |  Matched: ${matched.length}`);
  console.log();
  console.log('  ┌──────────────────────┬────────────────┬────────────────┬────────────────┐');
  console.log('  │ Metric               │ Vantage (NEW)  │ GC=F (OLD fb)  │ Delta (pips)   │');
  console.log('  ├──────────────────────┼────────────────┼────────────────┼────────────────┤');
  console.log(`  │ ATR(14) ($)          │ $${vAtr.toFixed(4).padEnd(13)} │ $${yAtr.toFixed(4).padEnd(13)} │ ${Math.abs(vAtr-yAtr).toFixed(4).padEnd(15)} │`);
  console.log(`  │ ATR(14) (pips)       │ ${(vAtr/PIP).toFixed(1).padEnd(14)} │ ${(yAtr/PIP).toFixed(1).padEnd(14)} │ ${Math.abs(vAtr/PIP-yAtr/PIP).toFixed(1).padEnd(15)} │`);
  console.log(`  │ SL distance (pips)   │ ${vSl.toFixed(1).padEnd(14)} │ ${ySl.toFixed(1).padEnd(14)} │ ${Math.abs(vSl-ySl).toFixed(1).padEnd(15)} │`);
  console.log(`  │ TP1 (pips)           │ ${(vSl*0.6).toFixed(1).padEnd(14)} │ ${(ySl*0.6).toFixed(1).padEnd(14)} │ ${Math.abs(vSl*0.6-ySl*0.6).toFixed(1).padEnd(15)} │`);
  console.log(`  │ TP2 (pips)           │ ${(vSl*1.0).toFixed(1).padEnd(14)} │ ${(ySl*1.0).toFixed(1).padEnd(14)} │ ${Math.abs(vSl*1.0-ySl*1.0).toFixed(1).padEnd(15)} │`);
  console.log(`  │ TP3 (pips)           │ ${(vSl*1.4).toFixed(1).padEnd(14)} │ ${(ySl*1.4).toFixed(1).padEnd(14)} │ ${Math.abs(vSl*1.4-ySl*1.4).toFixed(1).padEnd(15)} │`);
  console.log('  └──────────────────────┴────────────────┴────────────────┴────────────────┘');

  // Basis
  if (matched.length > 0) {
    const bases = matched.map(m => Math.abs(m.v.close - m.y.close)).sort((a,b)=>a-b);
    console.log(`\n  Price basis (GC=F vs Vantage, n=${bases.length}):`);
    console.log(`    Median |Δclose| = $${bases[Math.floor(bases.length/2)].toFixed(2)} (${(bases[Math.floor(bases.length/2)]/PIP).toFixed(1)} pips)`);
    console.log(`    Mean   |Δclose| = $${(bases.reduce((s,d)=>s+d,0)/bases.length).toFixed(2)} (${(bases.reduce((s,d)=>s+d,0)/bases.length/PIP).toFixed(1)} pips)`);
    console.log(`    Max    |Δclose| = $${bases[bases.length-1].toFixed(2)} (${(bases[bases.length-1]/PIP).toFixed(1)} pips)`);
  }

  // Rolling ATR delta
  const deltas: number[] = [];
  for (let i = 15; i < matched.length; i++) {
    const vs = matched.slice(Math.max(0,i-15),i+1).map(m=>m.v);
    const ys = matched.slice(Math.max(0,i-15),i+1).map(m=>m.y);
    if (vs.length >= 15) deltas.push(Math.abs(computeATR(vs,14)-computeATR(ys,14))/PIP);
  }
  if (deltas.length > 0) {
    deltas.sort((a,b)=>a-b);
    console.log(`\n  Rolling ATR delta (n=${deltas.length}):`);
    console.log(`    Median = ${deltas[Math.floor(deltas.length/2)].toFixed(2)} pips → SL delta = ${(deltas[Math.floor(deltas.length/2)]*SLM).toFixed(2)} pips`);
    console.log(`    Max    = ${deltas[deltas.length-1].toFixed(2)} pips → SL delta = ${(deltas[deltas.length-1]*SLM).toFixed(2)} pips`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  GATE 2: GC=F FALLBACK SIZING DELTA MEASURED');
  console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
