/**
 * PHASE B / B2 — ITEM 122 / C-2: ATTENTION-SCORE KEY MAP + HELD-OUT VALIDATION.
 *
 * 8+ rounds skipped. attention_scores rows store DISPLAY names ("SR ZONE STRONG
 * REVERSAL") while the engine's internal map uses snake_case keys
 * ('sr_zone_strong_reversal'); the conversion is mechanical —
 * signalEngine.ts:9026/9038 do `key.replace(/_/g,' ').toUpperCase()`. Without the
 * inverse map, the stored data (100% capture in the snapshot era, Item 215)
 * cannot be joined back to engine features — so confidence can never be
 * re-derived (B3).
 *
 * PART 1 — THE MAP: engine keys are extracted from the engine source itself
 * (`attentionScores.set('key', ...)` calls — provenance is the source system,
 * not a hand-copied list), and every distinct display name in the live data is
 * inverted. Any display name with NO engine key is DRIFT and is reported.
 *
 * PART 2 — TEN-FEATURE HELD-OUT VALIDATION: for the 10 features with the
 * highest signal coverage, per-signal signedScore is joined to canonical R and
 * correlated on a held-out half (fit half unused — this is a SCREENING
 * correlation, not a model; Item 161's held-out validation remains the
 * authoritative one at n=242).
 *
 * POWER (stated BEFORE results): canonical n≈335; per-feature coverage varies;
 * at n=300 a |r| of 0.11 is the 95% significance floor — anything smaller is
 * noise. The purpose is a LABEL AUDIT, not a discovery claim (rule 6).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

const env = loadEnv();
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface AttentionEntry {
  side?: string;
  score?: number;
  feature?: string;
  signedScore?: number;
  opposesSignal?: boolean;
}

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  source: string;
  confidence: number;
  attention_scores: AttentionEntry[] | Record<string, unknown> | null;
}

interface OutcomeRow {
  signal_id: string;
  realized_r: number | null;
  is_scratch: boolean | null;
}

async function fetchAll<T>(table: string, columns: string, orderColumn: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

function parseAttention(raw: SignalRow['attention_scores']): AttentionEntry[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as AttentionEntry[];
  return [];
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('PHASE B / B2 — ITEM 122 / C-2: ATTENTION KEY MAP + HELD-OUT VALIDATION — ' + new Date().toISOString());
  console.log('='.repeat(100));

  // ── PART 1: the map, extracted from the ENGINE SOURCE ──────────────────────
  const engineSource = readFileSync('services/signalEngine.ts', 'utf8');
  const engineKeys = new Set<string>();
  for (const m of engineSource.matchAll(/attentionScores\.set\('([a-z0-9_]+)'/g)) {
    engineKeys.add(m[1]);
  }
  // DirectionalScoreAccumulator-style setters may use variables; also capture
  // the dir.addBuy('key', ...) / dir.addSell('key', ...) pattern — the
  // DirectionalScoreAccumulator path produces most high-coverage features
  // (verified: strong_support_proximity, multi_touch_sr_confirmation, etc.).
  for (const m of engineSource.matchAll(/dir\.add(?:Buy|Sell)\(\s*'([a-z0-9_]+)'/g)) {
    engineKeys.add(m[1]);
  }
  for (const m of engineSource.matchAll(/attentionScores\.set\(\s*`?([a-z0-9_]+)`?/g)) {
    engineKeys.add(m[1]);
  }
  console.log(`\n── PART 1: DISPLAY-NAME ↔ ENGINE-KEY MAP ──`);
  console.log(`engine keys extracted from source: ${engineKeys.size}`);
  const toDisplay = (key: string): string => key.replace(/_/g, ' ').toUpperCase();
  const toEngine = (display: string): string => display.toLowerCase().replace(/ /g, '_');

  const emitted = await fetchAll<SignalRow>('emitted_signals_v1', 'signal_id, emitted_at, source, confidence, attention_scores', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, realized_r, is_scratch', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));

  const displayCounts: Record<string, number> = {};
  let signalsWithAttention = 0;
  for (const row of emitted) {
    const entries = parseAttention(row.attention_scores);
    if (entries.length === 0) continue;
    signalsWithAttention++;
    for (const e of entries) {
      if (typeof e.feature === 'string') displayCounts[e.feature] = (displayCounts[e.feature] ?? 0) + 1;
    }
  }
  console.log(`signals with attention data: ${signalsWithAttention}/${emitted.length}`);
  console.log(`distinct display names in live data: ${Object.keys(displayCounts).length}\n`);

  const mapped: { display: string; engineKey: string; count: number }[] = [];
  const drift: { display: string; count: number }[] = [];
  for (const [display, count] of Object.entries(displayCounts)) {
    const key = toEngine(display);
    if (engineKeys.has(key)) {
      mapped.push({ display, engineKey: key, count });
    } else {
      drift.push({ display, count });
    }
  }
  mapped.sort((a, b) => b.count - a.count);
  console.log('MAP (display → engine key, by coverage):');
  for (const m of mapped) {
    console.log(`  ${m.display.padEnd(34)} → ${m.engineKey.padEnd(34)} n=${m.count}`);
  }
  if (drift.length > 0) {
    console.log('\n⚠️ DRIFT — display names with NO engine key (stored data the engine can no longer produce):');
    for (const d of drift.sort((a, b) => b.count - a.count)) console.log(`  ${d.display} (n=${d.count})`);
  } else {
    console.log('\n✅ ZERO DRIFT — every stored display name inverts to a live engine key.');
  }

  // ── PART 2: ten-feature held-out validation ────────────────────────────────
  console.log(`\n── PART 2: TEN-FEATURE HELD-OUT VALIDATION ──`);
  const canonical = emitted
    .filter(e => {
      const o = outcomeBySignal.get(e.signal_id);
      return o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false);
    })
    .map(e => ({ signalId: e.signal_id, r: Number(outcomeBySignal.get(e.signal_id)!.realized_r), entries: parseAttention(e.attention_scores) }));
  console.log(`canonical joined rows with attention data: ${canonical.filter(c => c.entries.length > 0).length}/${canonical.length}`);
  console.log(`POWER: at n≈300, |r| ≥ 0.11 is the 95% significance floor; smaller values are noise.`);
  console.log(`This is a LABEL AUDIT joining stored display names back to canonical R — not a discovery claim (rule 6).\n`);

  const top10 = mapped.slice(0, 10);
  // Chronological 50/50 split: first half fit, second half held-out.
  const withR = canonical.filter(c => c.entries.length > 0);
  const cut = Math.floor(withR.length / 2);
  const heldOut = withR.slice(cut);
  console.log(`held-out half: n=${heldOut.length} (chronological split at row ${cut})\n`);
  console.log('feature                          coverage  held-out n   r (signedScore vs R)');
  for (const feat of top10) {
    const pairs = heldOut
      .map(c => {
        const e = c.entries.find(x => x.feature === feat.display);
        return e && typeof e.signedScore === 'number' ? { x: e.signedScore, y: c.r } : null;
      })
      .filter((p): p is { x: number; y: number } => p !== null);
    if (pairs.length < 10) {
      console.log(`${feat.display.padEnd(34)}${String(feat.count).padStart(8)}  ${String(pairs.length).padStart(10)}   (insufficient held-out n)`);
      continue;
    }
    const n = pairs.length;
    const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
    const my = pairs.reduce((a, p) => a + p.y, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (const p of pairs) {
      num += (p.x - mx) * (p.y - my);
      dx += (p.x - mx) ** 2;
      dy += (p.y - my) ** 2;
    }
    const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
    const se = 1 / Math.sqrt(Math.max(1, n - 3));
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const lo = Math.tanh(z - 1.96 * se);
    const hi = Math.tanh(z + 1.96 * se);
    const significant = lo > 0 || hi < 0;
    console.log(`${feat.display.padEnd(34)}${String(feat.count).padStart(8)}  ${String(n).padStart(10)}   r=${r >= 0 ? '+' : ''}${r.toFixed(3)}  CI[${lo.toFixed(3)}, ${hi.toFixed(3)}]${significant ? ' *' : ''}`);
  }
  console.log('\n* = CI excludes zero. Given the multiple-comparison count (10 features),');
  console.log('  a single marginal * is NOT a lever — it is a candidate for the next');
  console.log('  pre-registered validation, exactly as Item 161 treated its findings.');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
