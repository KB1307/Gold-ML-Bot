/**
 * ITEMS 167 / 169 / 171 — measurement round.
 *
 * 167(b) gold_m1_bars freshness: newest bar, age, bars in last hour, largest
 *       intra-24h gap (the stall fingerprint).
 * 169(a) per-feature coverage across the latest 450 trade_outcomes_v1 rows:
 *       rsi, atr, volumeRatio, timeWindowFactor, sentiment.score, dxyChange —
 *       absent vs default-fallback (50/10/1/1/0/0) vs real.
 * 169(d) refit the retrainModel() centroid math on CLEAN rows only (all six
 *       present, not all defaults). Report n honestly.
 * 171(a) LIVE signals emitted with ZERO opposing zones in snapshot vs >=1,
 *       canonical outcome split. POWER stated first (n is small).
 * 171(c) entry-to-nearest-zone distance (any type) vs canonical realised R.
 *
 * MEASUREMENT ONLY — anon key, Supabase DIRECT.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv() {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

const DEFAULTS = { rsi: 50, atr: 10, volumeRatio: 1, dxyChange: 0, timeWindowFactor: 1, sentimentScore: 0 };

interface Zone { type?: string; price?: number }

async function main() {
  /* ---------- 167(b) BAR FRESHNESS ---------- */
  const now = Date.now();
  const { data: newestBar } = await supabase.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const newestMs = newestBar && newestBar[0] ? new Date(newestBar[0].timestamp).getTime() : null;
  const ageMin = newestMs !== null ? (now - newestMs) / 60000 : null;
  const since = new Date(now - 24 * 3600e3).toISOString();
  const { data: last24 } = await supabase.from('gold_m1_bars').select('timestamp').gte('timestamp', since).order('timestamp', { ascending: true });
  const bars24 = (last24 ?? []).map((r: { timestamp: string }) => new Date(r.timestamp).getTime());
  let maxGapMin: number | null = null;
  let gapAt = '';
  for (let i = 1; i < bars24.length; i++) {
    const g = (bars24[i] - bars24[i - 1]) / 60000;
    if (maxGapMin === null || g > maxGapMin) { maxGapMin = g; gapAt = new Date(bars24[i - 1]).toISOString(); }
  }
  const lastHourFrom = new Date(now - 3600e3).toISOString();
  const { count: barsLastHour } = await supabase.from('gold_m1_bars').select('timestamp', { count: 'exact', head: true }).gte('timestamp', lastHourFrom);
  console.log('=== 167(b) gold_m1_bars FRESHNESS ===');
  console.log(`now=${new Date(now).toISOString()}`);
  console.log(`newest bar=${newestMs !== null ? new Date(newestMs).toISOString() : 'NONE'} | age=${ageMin !== null ? ageMin.toFixed(1) : 'n/a'} min`);
  console.log(`bars in last 60 min=${barsLastHour ?? 0} | bars in last 24h=${bars24.length}`);
  console.log(`largest intra-24h gap=${maxGapMin !== null ? maxGapMin.toFixed(1) : 'n/a'} min ending ${gapAt || 'n/a'}`);
  console.log(`verdict: ${ageMin === null ? 'STALE — no bars' : ageMin <= 5 ? 'SYNC RESUMED (age <= 5 min)' : ageMin <= 15 ? 'MARGINAL (5-15 min — engine M5 staleness threshold is 15 min)' : 'STALE (> 15 min — engine stands aside)'}`);

  /* ---------- 169(a) FEATURE COVERAGE ---------- */
  const { data: outcomesRaw } = await supabase.from('trade_outcomes_v1').select('*').order('signal_id', { ascending: false }).limit(450);
  const outcomes = (outcomesRaw ?? []) as Array<Record<string, unknown>>;
  console.log('\n=== 169(a) FEATURE COVERAGE over latest ' + outcomes.length + ' trade_outcomes_v1 rows ===');
  const feat = (o: Record<string, unknown>): Record<string, unknown> => (o.features && typeof o.features === 'object' ? (o.features as Record<string, unknown>) : {});
  const emptyObj = outcomes.filter((o) => Object.keys(feat(o)).length === 0).length;
  const nullFeat = outcomes.filter((o) => o.features === null || o.features === undefined).length;
  console.log(`features object EMPTY {}: ${emptyObj}/${outcomes.length} (${((100 * emptyObj) / Math.max(1, outcomes.length)).toFixed(1)}%) | null: ${nullFeat}`);
  const rows: Array<[string, (f: Record<string, unknown>) => unknown, number]> = [
    ['rsi', (f) => f.rsi, DEFAULTS.rsi],
    ['atr', (f) => f.atr, DEFAULTS.atr],
    ['volumeRatio', (f) => f.volumeRatio, DEFAULTS.volumeRatio],
    ['timeWindowFactor', (f) => f.timeWindowFactor, DEFAULTS.timeWindowFactor],
    ['sentiment.score', (f) => (f.sentiment && typeof f.sentiment === 'object' ? (f.sentiment as Record<string, unknown>).score : undefined), DEFAULTS.sentimentScore],
    ['dxyChange', (f) => f.dxyChange, DEFAULTS.dxyChange],
  ];
  for (const [name, get, def] of rows) {
    let present = 0, atDefault = 0;
    for (const o of outcomes) {
      const v = get(feat(o));
      if (typeof v === 'number' && Number.isFinite(v)) { present++; if (Math.abs(v - def) < 1e-9) atDefault++; }
    }
    const n = outcomes.length || 1;
    console.log(`${name.padEnd(18)} present=${present}/${outcomes.length} (${((100 * present) / n).toFixed(1)}%)  of-present-at-default=${atDefault} (${((100 * atDefault) / n).toFixed(1)}% of all rows)`);
  }

  /* ---------- 169(d) REFIT ON CLEAN ROWS ---------- */
  const clean = outcomes.filter((o) => {
    const f = feat(o);
    const vals = rows.map(([, get]) => get(f));
    if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
    return vals.some((v, i) => Math.abs((v as number) - rows[i][2]) > 1e-9);
  });
  console.log(`\n=== 169(d) REFIT on clean rows (all six present, >=1 non-default) ===`);
  console.log(`clean n=${clean.length}`);
  if (clean.length >= 20) {
    const nowMs = Date.now();
    const weighted = clean.map((o) => {
      const ts = o.timestamp ? new Date(o.timestamp as string).getTime() : (o.created_at ? new Date(o.created_at as string).getTime() : nowMs);
      const days = (nowMs - ts) / 86400e3;
      return { o, w: Math.pow(0.75, days) };
    });
    const totW = weighted.reduce((s, d) => s + d.w, 0);
    weighted.forEach((d) => (d.w /= totW));
    const label = (o: Record<string, unknown>) => (o.is_scratch === true ? 'SCRATCH' : (o.result === 'WIN' ? 'WIN' : o.result === 'LOSS' ? 'LOSS' : '?'));
    const win = weighted.filter((d) => label(d.o) === 'WIN');
    const loss = weighted.filter((d) => label(d.o) === 'LOSS');
    console.log(`labelled: WIN=${win.length} LOSS=${loss.length} (scratch/other excluded: ${clean.length - win.length - loss.length})`);
    if (win.length > 0 && loss.length > 0) {
      const avg = (arr: typeof weighted, get: (f: Record<string, unknown>) => number) => {
        const wsum = arr.reduce((s, d) => s + d.w, 0);
        return arr.reduce((s, d) => s + get(feat(d.o)) * d.w, 0) / wsum;
      };
      const g = (k: string) => (f: Record<string, unknown>) => {
        if (k === 'sentiment') { const s = f.sentiment as Record<string, unknown> | undefined; return typeof s?.score === 'number' ? s.score : 0; }
        return f[k] as number;
      };
      const raw: Record<string, number> = {
        rsi_weight: (avg(win, g('rsi')) - avg(loss, g('rsi'))) / 100,
        timeWindow_weight: (avg(win, g('timeWindowFactor')) - avg(loss, g('timeWindowFactor'))) * 0.5,
        volume_weight: avg(win, g('volumeRatio')) - avg(loss, g('volumeRatio')),
        sentiment_weight: (avg(win, g('sentiment')) - avg(loss, g('sentiment'))) * 2,
        atr_weight: (avg(win, g('atr')) - avg(loss, g('atr'))) / 10,
        dxy_weight: (avg(win, g('dxyChange')) - avg(loss, g('dxyChange'))) * 2,
      };
      const absSum = Object.values(raw).reduce((s, v) => s + Math.abs(v), 0);
      console.log('raw centroid-difference weights (engine math):');
      for (const [k, v] of Object.entries(raw)) console.log(`  ${k.padEnd(18)} ${v >= 0 ? '+' : ''}${v.toFixed(4)}`);
      if (absSum > 0) {
        // ITEM 183(b) FIX — SIGN PRESERVED. The previous print divided |w| by
        // sum|w|, DROPPING THE SIGN: loss-predicting features (timeWindow
        // -0.1238, volume -0.0523) displayed as the LARGEST POSITIVE weights
        // (0.315, 0.133). Production retrainModel() divides the SIGNED value
        // by sum|w| (signalEngine.ts:7713) and always preserved the sign — the
        // defect was in THIS display line only, never in the engine.
        console.log('normalised (w/sum|w|, SIGN PRESERVED — matches retrainModel signalEngine.ts:7713):');
        for (const [k, v] of Object.entries(raw)) console.log(`  ${k.padEnd(18)} ${(v / absSum).toFixed(4)}`);
      } else console.log('all raw weights ZERO even on clean rows — centroids identical');
    } else console.log('INSUFFICIENT class diversity on clean rows — no vector reported');
  } else console.log('n < 20 — TOO SMALL to fit six weights. No vector reported (honest).');

  /* ---------- 171(a)/(c) ZERO-OPPOSING + ENTRY DISTANCE ---------- */
  const { data: sigsRaw } = await supabase.from('emitted_signals_v1').select('signal_id, emitted_at, direction, entry, atr, source, sr_zones_snapshot').order('emitted_at', { ascending: true });
  const sigs = (sigsRaw ?? []) as Array<{ signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL'; entry: number; atr: number | null; source: string; sr_zones_snapshot: unknown }>;
  const rById = new Map<string, number | null>();
  for (const o of outcomes) rById.set(o.signal_id as string, typeof o.realized_r === 'number' ? (o.realized_r as number) : null);
  const live = sigs.filter((s) => s.source === 'LIVE');
  console.log(`\n=== 171(a) LIVE signals: ZERO opposing zones in snapshot (POWER FIRST: LIVE resolved n<=18, any split is underpowered — CIs will be wide) ===`);
  const cohort = live.map((s) => {
    const zones = Array.isArray(s.sr_zones_snapshot) ? (s.sr_zones_snapshot as Zone[]) : [];
    const opposingType = s.direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const opposing = zones.filter((z) => z.type === opposingType);
    const nearest = zones.length ? Math.min(...zones.map((z) => Math.abs((z.price ?? NaN) - s.entry))) : null;
    return { s, opposingCount: opposing.length, nearestDist: nearest && Number.isFinite(nearest) ? nearest : null, r: rById.get(s.signal_id) ?? null };
  });
  for (const [label, arr] of [['zero-opposing', cohort.filter((c) => c.opposingCount === 0)], ['>=1 opposing', cohort.filter((c) => c.opposingCount > 0)]] as const) {
    const resolved = arr.filter((c) => c.r !== null) as Array<{ r: number }>;
    const wr = resolved.length ? (resolved.filter((c) => c.r > 0).length / resolved.length) * 100 : NaN;
    const meanR = resolved.length ? resolved.reduce((s, c) => s + c.r, 0) / resolved.length : NaN;
    console.log(`${label.padEnd(15)} emitted=${arr.length} resolved=${resolved.length}${resolved.length ? ` WR=${wr.toFixed(1)}% meanR=${meanR >= 0 ? '+' : ''}${meanR.toFixed(4)}R` : ' (no resolved outcomes)'}`);
  }
  console.log(`\n=== 171(c) entry-to-nearest-zone distance (any type, $) vs canonical R (LIVE resolved) ===`);
  const pts = cohort.filter((c) => c.r !== null && c.nearestDist !== null) as Array<{ nearestDist: number; r: number; s: { signal_id: string; atr: number | null } }>;
  for (const p of pts) console.log(`  ${p.s.signal_id.slice(-6)} nearest=${p.nearestDist.toFixed(1)}$ atr=${p.s.atr !== null && p.s.atr !== undefined ? (p.nearestDist / p.s.atr).toFixed(2) + 'ATR' : 'n/a'} R=${p.r >= 0 ? '+' : ''}${p.r.toFixed(3)}`);
  if (pts.length >= 3) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.nearestDist, 0) / n;
    const my = pts.reduce((s, p) => s + p.r, 0) / n;
    const num = pts.reduce((s, p) => s + (p.nearestDist - mx) * (p.r - my), 0);
    const den = Math.sqrt(pts.reduce((s, p) => s + (p.nearestDist - mx) ** 2, 0) * pts.reduce((s, p) => s + (p.r - my) ** 2, 0));
    console.log(`n=${n} Pearson r(distance, R)=${den > 0 ? (num / den).toFixed(3) : 'undefined'} (n=${n} — indicative only, CI spans most of [-1,1] at this n)`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
