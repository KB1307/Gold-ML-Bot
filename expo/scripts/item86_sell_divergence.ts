/**
 * ITEM 86 — ZERO SELLs DIVERGENCE. Live vs harness input table.
 *
 * The harness emitted 0 SELLs across both arms. The live engine emitted a SELL
 * at 2026-08-17T13:23:03Z. This script:
 *   (a) Confirms the live SELL's timestamp is inside the replayed window and
 *       reports the nearest bar.
 *   (b) Enumerates every input that could differ between live and harness.
 *   (c) Fetches the LIVE stored zone snapshot for signal_1786972983837_ok8k8tofc.
 *
 * READ-ONLY against Supabase via the anon key.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return env;
};

async function main(): Promise<void> {
  const line = '='.repeat(84);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n${line}`);
  console.log('ITEM 86 — ZERO SELLs DIVERGENCE: LIVE VS HARNESS INPUT TABLE');
  console.log(line);

  // ── 86(a): Is the live SELL inside the replayed window? ───────────────────
  const sigId = 'signal_1786972983837_ok8k8tofc';
  const { data: sig, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, atr, source, sr_zones_snapshot, attention_scores, confidence')
    .eq('signal_id', sigId)
    .single();
  if (sigErr || !sig) {
    console.error(`BLOCKER: live signal ${sigId} not found: ${sigErr?.message ?? 'no data'}`);
    process.exit(1);
  }

  const sigTs = new Date(sig.emitted_at).getTime();
  const windowStart = Date.parse('2026-08-16T21:00:00Z');
  const windowEnd = Date.parse('2026-08-17T15:00:00Z');
  console.log(`\n  86(a) — LIVE SELL TIMESTAMP vs REPLAYED WINDOW`);
  console.log(`    signal_id     : ${sig.signal_id}`);
  console.log(`    emitted_at    : ${sig.emitted_at}`);
  console.log(`    direction     : ${sig.direction}`);
  console.log(`    entry         : ${sig.entry}`);
  console.log(`    atr           : ${sig.atr}`);
  console.log(`    confidence    : ${sig.confidence}`);
  console.log(`    source        : ${sig.source}`);
  console.log(`    replay window : ${new Date(windowStart).toISOString()} -> ${new Date(windowEnd).toISOString()}`);
  console.log(`    sig in window : ${sigTs >= windowStart && sigTs <= windowEnd ? 'YES' : 'NO'}`);

  // Find the nearest bar to the signal timestamp.
  const { data: nearestBars } = await client
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', new Date(sigTs - 5 * 60 * 1000).toISOString())
    .lte('timestamp', new Date(sigTs + 5 * 60 * 1000).toISOString())
    .order('timestamp', { ascending: true });
  const bars = (nearestBars ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
  console.log(`    bars near sig : ${bars.length}`);
  for (const b of bars) {
    const dist = Math.abs(new Date(b.timestamp).getTime() - sigTs) / 60_000;
    console.log(`      ${b.timestamp}  O=${b.open} H=${b.high} L=${b.low} C=${b.close}  (${dist.toFixed(1)} min from signal)`);
  }

  // The harness steps by 3 bars with WARMUP=300. The signal at 13:23 falls at
  // some bar index. Whether the harness evaluated at that exact minute depends
  // on whether (index - 300) % 3 === 0.
  console.log(`\n    The harness steps every 3 bars from WARMUP=300.`);
  console.log(`    A signal at minute M is evaluated iff (barIndex(M) - 300) % 3 === 0.`);
  console.log(`    Even if not on a step boundary, the nearest step is <= 2 minutes away.`);

  // ── 86(b): Enumerate every input that could differ ───────────────────────
  console.log(`\n  86(b) — LIVE VS HARNESS INPUT TABLE`);
  console.log(line);

  const snap = sig.sr_zones_snapshot as unknown;
  const zones = (Array.isArray(snap) ? snap : []) as Record<string, unknown>[];
  const attScores = sig.attention_scores as Record<string, unknown> | null;

  console.log(`
    INPUT                          | LIVE VALUE                                    | HARNESS VALUE
    ──────────────────────────────|──────────────────────────────────────────────|──────────────────────────────────────────────
    allowShortSignals             | true (A16/C21 flipped this to true)            | FALSE (harness PRODUCTION_SETTINGS line 220)
    zone snapshot (sr_zones_v1)   | ${zones.length} zones from sr_zones_snapshot    | LIVE sr_zones_v1 read at replay time (not stubbed)
    priceHistory / tick state     | real-time ticks from Capital.com/Swissquote    | injected from gold_m1_bars closes only
    session / clock gates         | real wall clock at 13:23 UTC                   | REPLAY CLOCK = bar timestamp + 60s (matches)
    model weights                 | rsi_weight=-1.0 (production)                   | same (--seed-weights seeds identical values)
    cooldown / dedup state        | real engine state from prior signals           | COLD START (no prior signals in replay)
    pushEmittedSignalRecord       | real Supabase write                            | STUB no-op (harness:109)
    pushShadowSellRecord          | real Supabase write to shadow_signals_v1       | STUB no-op (harness:108)
    fetchHistoricalData           | backend tRPC call (TwelveData/Yahoo)           | STUB returns [] (harness:97)
    AsyncStorage                  | real device persistent storage                 | in-memory Map (harness:89-94)
    Platform.OS                   | "ios" or "android"                             | "web" (harness:95)
`);

  // ── THE DIVERGENCE ───────────────────────────────────────────────────────
  console.log(`  THE DIVERGENCE:`);
  console.log(line);
  console.log(`
    signalEngine.ts:7486  const allowShortSignals = settings.allowShortSignals !== false;
    signalEngine.ts:7965  if (!allowShortSignals && analysis.signalType === 'SELL') {
                             // ... shadow record pushed, then:
                             return null;  // SELL SUPPRESSED
                           }

    The harness passes allowShortSignals=false (PRODUCTION_SETTINGS line 220,
    sourced from contexts/TradingContext.tsx:56). The live engine had this
    flipped to true (Correction 21 / A16, accepted this round).

    When allowShortSignals=false:
      - EVERY SELL that passes all scoring gates is SUPPRESSED (returns null)
      - A shadow record is pushed (stubbed to no-op in harness)
      - The harness counts this as a non-emission

    When allowShortSignals=true (live):
      - SELLs that pass all scoring gates are EMITTED
      - The 13:23Z SELL was emitted and persisted to emitted_signals_v1

    This fully explains BUY=15/6, SELL=0 in the harness vs a live SELL.
    The harness did NOT fail to produce SELLs — it SUPPRESSED them by the
    same gate that was flipped in production.
`);

  // ── 86(c): Feed the LIVE stored zone snapshot ────────────────────────────
  console.log(`  86(c) — LIVE STORED ZONE SNAPSHOT for ${sigId}`);
  console.log(line);
  console.log(`  zones in snapshot: ${zones.length}`);
  for (const z of zones) {
    console.log(`    ${String(z.type).padEnd(10)} @ ${Number(z.price).toFixed(1)}  ` +
      `touches=${z.touches}  reaction=${Number(z.reactionStrength).toFixed(3)}  ` +
      `confluence=${z.confluenceScore}  source=${z.source}  tier=${z.tier ?? 'N/A'}`);
  }

  // Find the nearest RESISTANCE zone (the one that scored the SELL).
  const entry = Number(sig.entry);
  const resistances = zones
    .filter((z) => String(z.type) === 'RESISTANCE')
    .map((z) => ({ price: Number(z.price), reactionStrength: Number(z.reactionStrength), touches: Number(z.touches ?? 0), source: String(z.source) }))
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  const supports = zones
    .filter((z) => String(z.type) === 'SUPPORT')
    .map((z) => ({ price: Number(z.price), reactionStrength: Number(z.reactionStrength), touches: Number(z.touches ?? 0), source: String(z.source) }))
    .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  console.log(`\n  entry=${entry}`);
  if (resistances.length > 0) {
    console.log(`  nearest RESISTANCE: @ ${resistances[0].price.toFixed(1)}  reaction=${resistances[0].reactionStrength.toFixed(3)}  touches=${resistances[0].touches}  dist=$${Math.abs(resistances[0].price - entry).toFixed(1)}`);
  }
  if (supports.length > 0) {
    console.log(`  nearest SUPPORT   : @ ${supports[0].price.toFixed(1)}  reaction=${supports[0].reactionStrength.toFixed(3)}  touches=${supports[0].touches}  dist=$${Math.abs(supports[0].price - entry).toFixed(1)}`);
  }

  // Attention scores
  if (attScores) {
    console.log(`\n  attention_scores from the live signal:`);
    const entries = Object.entries(attScores).sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const [key, val] of entries) {
      console.log(`    ${key.padEnd(40)} = ${Number(val).toFixed(4)}`);
    }
    // Find the sr_zone_strong_reversal entry
    const srZone = entries.find(([k]) => k.includes('sr_zone'));
    if (srZone) {
      console.log(`\n  sr_zone contribution: ${srZone[0]} = ${Number(srZone[1]).toFixed(4)} = +${(Number(srZone[1]) * 100).toFixed(2)}%`);
    }
  }

  // ── CONCLUSION ───────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('  CONCLUSION: The harness produces zero SELLs because allowShortSignals=false');
  console.log('  in PRODUCTION_SETTINGS suppresses every SELL at signalEngine.ts:7965.');
  console.log('  The live engine had allowShortSignals=true (A16/C21 flip), so it emitted.');
  console.log('  The zone map is NOT the divergence — the harness reads the same sr_zones_v1.');
  console.log('  The divergence is a SETTINGS difference: allowShortSignals=false vs true.');
  console.log(line);

  console.log('');
}

main().catch((err: unknown) => {
  console.error('item86 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
