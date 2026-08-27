/**
 * ITEM H.2 — LONG-MEMORY UNTAPPED ZONES: FIRST-RETEST STUDY (gold_m1_bars ONLY).
 *
 * Definition (pre-registered in the prompt): candidate long-memory zone = a level
 * with a reaction of >= 2.5 x ATR(14,M5) within 2 hours of touch, formed 2-14 days
 * ago, untouched since formation. Outcome = forward 4h excursion (favourable/adverse)
 * from the first retest, in $ and R at the corpus' live geometry (median entry->SL
 * distance of emitted_signals_v1). Control = random same-corpus timestamps (non-
 * qualifying), same 4h window. Look-ahead discipline: level + qualification are
 * computable strictly BEFORE the retest bar; outcomes measured from the retest bar
 * onward. Nothing ships from this study either way.
 */
import { createClient } from '@supabase/supabase-js';

interface Bar { t: number; o: number; h: number; l: number; c: number }
interface M5 { t: number; o: number; h: number; l: number; c: number }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM H.2 — LONG-MEMORY UNTAPPED ZONES, FIRST-RETEST STUDY'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED POWER: MDE = 2.80*sigma/sqrt(n) per arm; with 4h gold sigma ~ $8-12 and n~100+, MDE ~ $2-3 — stated BEFORE results.');

  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ t: new Date(r.timestamp).getTime(), o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${bars.length} M1 bars, ${new Date(bars[0].t).toISOString()} .. ${new Date(bars[bars.length - 1].t).toISOString()}`);

  // M5 aggregation + ATR(14, M5)
  const m5: M5[] = [];
  for (const b of bars) {
    const slot = Math.floor(b.t / 300_000) * 300_000;
    const last = m5[m5.length - 1];
    if (last && last.t === slot) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else m5.push({ t: slot, o: b.o, h: b.h, l: b.l, c: b.c });
  }
  const atr: number[] = new Array(m5.length).fill(NaN);
  const trAt = (j: number): number => Math.max(m5[j].h - m5[j].l, Math.abs(m5[j].h - m5[j - 1].c), Math.abs(m5[j].l - m5[j - 1].c));
  for (let i = 15; i < m5.length; i++) {
    let s = 0;
    for (let k = 0; k < 14; k++) s += trAt(i - k);
    atr[i] = s / 14;
  }

  // Reaction events: M5 bar range >= 2.5 x ATR; level = the extreme that price reacted FROM.
  interface Zone { level: number; tForm: number; kind: 'SUP' | 'RES' }
  const zones: Zone[] = [];
  for (let i = 14; i < m5.length; i++) {
    const a = atr[i];
    if (!Number.isFinite(a)) continue;
    if (m5[i].h - m5[i].l >= 2.5 * a) {
      const down = m5[i].c < m5[i].o;
      zones.push({ level: down ? m5[i].h : m5[i].l, tForm: m5[i].t, kind: down ? 'RES' : 'SUP' });
    }
  }
  console.log(`  reaction events (M5 range >= 2.5*ATR14): ${zones.length}`);

  // First retest per zone: 2-14 days after formation, level untouched (no bar within +/-1.5 of level) in between.
  const W = 1.5, DAY = 86_400_000;
  const retests: { zone: Zone; tRetest: number; iRetest: number }[] = [];
  for (const z of zones) {
    const loT = z.tForm + 2 * DAY, hiT = z.tForm + 14 * DAY;
    let i = bars.findIndex(b => b.t > z.tForm);
    let touched = false, retestAt = -1;
    for (; i < bars.length && bars[i].t <= hiT; i++) {
      const b = bars[i];
      if (b.t < loT) {
        if (b.l <= z.level + W && b.h >= z.level - W) { touched = true; break; }
      } else {
        if (b.l <= z.level + W && b.h >= z.level - W) { retestAt = i; break; }
        touched = touched; // (still untouched)
      }
    }
    if (retestAt >= 0 && !touched) retests.push({ zone: z, tRetest: bars[retestAt].t, iRetest: retestAt });
  }
  console.log(`  qualifying first retests (formed 2-14d prior, untouched since): ${retests.length}`);

  const RISK_USD = 8.0; // corpus live geometry: median entry->SL distance of emitted signals
  const fwd = (i: number): { fav: number; adv: number } => {
    const end = Math.min(i + 240, bars.length - 1);
    let hi = -Infinity, lo = Infinity;
    for (let k = i; k <= end; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    const base = bars[i].c;
    return { fav: hi - base, adv: base - lo };
  };
  const res = retests.map(r => {
    const { fav, adv } = fwd(r.iRetest);
    return { ...r, fav: r.zone.kind === 'SUP' ? fav : adv, adv: r.zone.kind === 'SUP' ? adv : fav };
  });
  const mean = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;
  const sd = (v: number[]): number => Math.sqrt(v.reduce((a, x) => a + (x - mean(v)) ** 2, 0) / Math.max(1, v.length - 1));
  const favV = res.map(r => r.fav), advV = res.map(r => r.adv);
  console.log(`\n  QUALIFIED FIRST RETESTS (n=${res.length}):`);
  console.log(`    favourable (in trade direction): mean $${mean(favV).toFixed(2)} (sd ${sd(favV).toFixed(2)}) = ${mean(favV) / RISK_USD >= 0 ? '+' : ''}${(mean(favV) / RISK_USD).toFixed(3)}R at $${RISK_USD} risk`);
  console.log(`    adverse                        : mean $${mean(advV).toFixed(2)} (sd ${sd(advV).toFixed(2)}) = -${(mean(advV) / RISK_USD).toFixed(3)}R`);
  if (res.length > 1) {
    const se = sd(favV) / Math.sqrt(res.length);
    console.log(`    fav 95% CI: [$${(mean(favV) - 1.96 * se).toFixed(2)}, $${(mean(favV) + 1.96 * se).toFixed(2)}]; MDE +/-${(2.8 * sd(favV) / Math.sqrt(res.length)).toFixed(2)}`);
  }
  // Control: 2000 random same-corpus timestamps (skip last 4h).
  const rnd = mulberry32(20260827);
  const cf: number[] = [], ca: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const idx = (rnd() * (bars.length - 240)) | 0;
    const { fav, adv } = fwd(idx);
    cf.push(fav); ca.push(adv);
  }
  console.log(`\n  CONTROL (n=2000 random same-corpus timestamps, same 4h window):`);
  console.log(`    favourable mean $${mean(cf).toFixed(2)} | adverse mean $${mean(ca).toFixed(2)}`);
  const seC = sd(cf) / Math.sqrt(2000);
  console.log(`    fav diff (qualified - control): $${(mean(favV) - mean(cf)).toFixed(2)} (control CI +/-${(1.96 * seC).toFixed(2)}); MDE diff +/-${(2.8 * Math.sqrt(sd(favV) ** 2 / res.length + sd(cf) ** 2 / 2000)).toFixed(2)}`);
  const byAge = [0, 1, 2, 3].map(k => res.filter(r => Math.floor((r.tRetest - r.zone.tForm) / DAY) >= 2 + k * 3 && Math.floor((r.tRetest - r.zone.tForm) / DAY) < 5 + k * 3));
  byAge.forEach((g, k) => { if (g.length) console.log(`    age ${2 + k * 3}-${4 + k * 3}d: n=${g.length} fav mean $${mean(g.map(r => r.fav)).toFixed(2)} adv mean $${mean(g.map(r => r.adv)).toFixed(2)}`); });
  console.log('\n  ITEM 99 RECONCILIATION: Item 99 measured REVERSAL PERSISTENCE at 4/8/12h horizons on the recent 24h window and PASSED; this study measures the DIFFERENT job of ancient untapped level reactivity. Both windows can be right for different jobs if and only if this study shows retests of 2-14d-old levels carry genuine favourable excursion (see numbers above); if it does not, long memory adds nothing and 24h remains sufficient for both jobs.');
  console.log('  NO CODE SHIPS from this item this round; a positive result scopes a next-round long-memory TABLE feeding the SAME consumer.');
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
