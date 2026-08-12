/**
 * ITEM 62 — THREE DIFFERENT CORPUS SIZES: DURABLE vs LOCAL vs TRAINING.
 *
 * MINDSET: measure before building. This script is READ-ONLY against Supabase.
 *
 * SECTION 2 of the export reports three numbers:
 *   - durable Supabase 51 rows
 *   - local corpus 149 rows
 *   - corpus size at training 53
 *
 * (a) Explain each precisely.
 * (b) Report whether the 98 local-only rows are genuinely local-only (push failures,
 *     never attempted, or filtered) and whether they are recoverable.
 * (c) Confirm the 14-day TRAINING_WINDOW_DAYS accounts for 53 of 149.
 * (d) Report whether the local-only rows are systematically different from the 51
 *     that made it to Supabase. POWER first.
 *
 * DATA-SOURCE RULE: direct Supabase anon read of trade_outcomes_v1.
 * No writes. No engine mutation.
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
  } catch {
    // fall through to process.env
  }
  return env;
};

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

interface RemoteOutcomeRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  confidence: number | string | null;
  realized_r: number | string | null;
  is_scratch: boolean | null;
  signal_duration_ms: number | string | null;
  feature_schema_version: number | null;
  features: unknown;
}

interface FeatureBag {
  rsi?: number;
  atr?: number;
  volumeRatio?: number;
  marketRegime?: { type?: string; confidence?: number };
  sessionName?: string;
  htfTrend?: string;
  ltfTrend?: string;
  timeWindowFactor?: number;
  sentiment?: { score?: number };
  dxyChange?: number;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error('Missing Supabase env vars');
    process.exit(1);
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Pull the full durable corpus ──────────────────────────────────────────
  const collected: RemoteOutcomeRow[] = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const res = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, signal_duration_ms, feature_schema_version, features')
      .order('ts', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (res.error) {
      console.error('Supabase read error:', res.error.message);
      process.exit(1);
    }
    const rows = (res.data ?? []) as unknown as RemoteOutcomeRow[];
    collected.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  // Reverse to oldest-first
  collected.reverse();

  console.log('═'.repeat(80));
  console.log('ITEM 62 — THREE CORPUS SIZES: DURABLE vs LOCAL vs TRAINING');
  console.log('═'.repeat(80));
  console.log(`  durable corpus (trade_outcomes_v1): ${collected.length} rows`);
  console.log();

  // ── (a) Explain each number ───────────────────────────────────────────────
  // 1. Durable Supabase: rows actually in trade_outcomes_v1 (what we just pulled)
  // 2. Local corpus: the engine's this.tradeOutcomes array, loaded from SQLite.
  //    This is device-side AsyncStorage/SQLite, NOT queryable from here.
  // 3. Corpus at training: this.corpusSizeAtTraining = trainingData.length,
  //    where trainingData = tradeOutcomes.filter(age <= 14 days).
  //    Persisted in model_weights_v1 alongside the weight vector.
  console.log('  ── (a) What each number means ──');
  console.log(`     DURABLE (Supabase): ${collected.length} rows in trade_outcomes_v1.`);
  console.log(`       These are rows that were successfully upserted via pushOutcomesToRemote().`);
  console.log(`       The export reads this via fetchRemoteOutcomesDirect() → anon key.`);
  console.log();
  console.log(`     LOCAL (SQLite/memory): the engine's this.tradeOutcomes array.`);
  console.log(`       Loaded from learningStore (SQLite on native, in-memory on web).`);
  console.log(`       The export reports this via this.tradeOutcomes.length.`);
  console.log(`       This is the SUPERSET: local + durable merged by hydrateFromRemote().`);
  console.log(`       Cannot query from here — it lives on the device.`);
  console.log();
  console.log(`     TRAINING (corpusSizeAtTraining): trainingData.length at last retrain.`);
  console.log(`       trainingData = tradeOutcomes.filter(o => age <= TRAINING_WINDOW_DAYS=14).`);
  console.log(`       Persisted in model_weights_v1 AsyncStorage key.`);
  console.log(`       So training = local ∩ {age <= 14 days}.`);
  console.log();

  // ── (b) The 98 local-only rows ────────────────────────────────────────────
  // hydrateFromRemote() does: local.filter(o => !remoteIds.has(o.signalId)) → pushOutcomesToRemote
  // So local-only rows ARE pushed on every hydrate. If they persist as local-only,
  // it means pushOutcomesToRemote FAILED for them (queued in pendingRemotePush).
  // The push goes through trpcClient.learning.pushOutcomes.mutate → Rork backend
  // (service-role). If the backend is down/503, rows are queued and retried.
  // They are RECOVERABLE: the queue persists in pendingRemotePush[] and retries
  // on every subsequent push/hydrate.
  console.log('  ── (b) The 98 local-only rows ──');
  console.log(`     Durable rows: ${collected.length}`);
  console.log(`     Local rows (reported): 149 (from export SECTION 2)`);
  console.log(`     Local-only: 149 - ${collected.length} = ${149 - collected.length}`);
  console.log();
  console.log(`     PROVENANCE: hydrateFromRemote() pushes local-only rows upward via`);
  console.log(`     pushOutcomesToRemote() on every hydrate. If they remain local-only,`);
  console.log(`     the push FAILED (Rork backend 503/no-bundle). Rows are queued in`);
  console.log(`     pendingRemotePush[] (MAX_PENDING_REMOTE_PUSH=200) and retried.`);
  console.log(`     RECOVERABLE: yes, on the next successful backend push.`);
  console.log(`     However: pendingRemotePush is an in-memory array — if the app was`);
  console.log(`     reloaded before the next successful push, those queued rows are LOST.`);
  console.log(`     The local SQLite rows survive, but the push queue does not.`);
  console.log();

  // ── (c) 14-day window ─────────────────────────────────────────────────────
  const now = Date.now();
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(now - fourteenDaysMs);

  const durableWithinWindow = collected.filter(r => new Date(r.ts).getTime() >= cutoff.getTime());
  const durableOutsideWindow = collected.filter(r => new Date(r.ts).getTime() < cutoff.getTime());

  console.log('  ── (c) 14-day TRAINING_WINDOW_DAYS ──');
  console.log(`     now: ${new Date(now).toISOString()}`);
  console.log(`     14-day cutoff: ${cutoff.toISOString()}`);
  console.log(`     durable rows within 14 days: ${durableWithinWindow.length}`);
  console.log(`     durable rows older than 14 days: ${durableOutsideWindow.length}`);
  console.log();
  console.log(`     The export reported corpusSizeAtTraining = 53.`);
  console.log(`     trainingData = local ∩ {age <= 14 days}.`);
  console.log(`     If local = 149 and training = 53, then 96 local rows are OLDER than 14 days.`);
  console.log(`     These 96 are excluded from training by the window filter but retained`);
  console.log(`     in the local store (MAX_STORED_OUTCOMES=300).`);
  console.log();
  console.log(`     Cross-check: durable within 14 days = ${durableWithinWindow.length}.`);
  console.log(`     If training = 53 and durable-within-14 = ${durableWithinWindow.length},`);
  console.log(`     then training included ${53 - durableWithinWindow.length} local-only rows`);
  console.log(`     that were within the 14-day window but had not yet been pushed to Supabase.`);
  console.log();

  // ── (d) Systematic difference between durable and local-only ──────────────
  // We can only see the durable rows. The local-only rows are on the device.
  // What we CAN do: check whether the durable rows are systematically different
  // from what we'd expect — e.g., are durable rows biased toward certain sessions,
  // directions, or outcomes?
  console.log('  ── (d) Systematic differences (durable-only analysis) ──');
  console.log();
  console.log('  POWER STATEMENT:');
  console.log(`    n_durable = ${collected.length}.`);
  console.log(`    The 98 local-only rows are on the device and CANNOT be queried from here.`);
  console.log(`    We can only test whether the DURABLE subset is representative of the whole,`);
  console.log(`    but we have no ground truth for the whole.`);
  console.log(`    At n=51, MDE for two-proportion test (alpha=0.05, power=0.80) ≈ 25pp.`);
  console.log(`    Any comparison is UNDERPOWERED for a causal claim.`);
  console.log(`    The structural question (are 98 rows systematically excluded?) can only`);
  console.log(`    be answered by examining the device's local SQLite store.`);
  console.log();

  // Analyse durable rows for any obvious bias
  const durableParsed = collected.map(r => {
    const f = r.features as FeatureBag;
    return {
      signalId: r.signal_id,
      ts: new Date(r.ts).getTime(),
      direction: r.direction === 'BUY' || r.direction === 'SELL' ? r.direction : null,
      result: r.result === 'WIN' ? 'WIN' : 'LOSS',
      isScratch: r.is_scratch ?? false,
      realizedR: r.realized_r !== null ? Number(r.realized_r) : null,
      sessionName: f?.sessionName ?? null,
      regimeType: f?.marketRegime?.type ?? null,
      rsi: typeof f?.rsi === 'number' ? f.rsi : null,
      schemaVersion: r.feature_schema_version ?? null,
    };
  });

  const labelled = durableParsed.filter(p => !p.isScratch);
  const wins = labelled.filter(p => p.result === 'WIN').length;
  const losses = labelled.filter(p => p.result === 'LOSS').length;

  console.log(`  Durable labelled (non-scratch): ${labelled.length}`);
  console.log(`    Wins: ${wins}  ${pct(wins, labelled.length)}`);
  console.log(`    Losses: ${losses}  ${pct(losses, labelled.length)}`);
  console.log();

  // Direction split
  const buys = labelled.filter(p => p.direction === 'BUY');
  const sells = labelled.filter(p => p.direction === 'SELL');
  const noDir = labelled.filter(p => p.direction === null);

  console.log(`  Direction split:`);
  console.log(`    BUY:  ${buys.length}  WR ${pct(buys.filter(p => p.result === 'WIN').length, buys.length)}`);
  console.log(`    SELL: ${sells.length}  WR ${pct(sells.filter(p => p.result === 'WIN').length, sells.length)}`);
  console.log(`    null: ${noDir.length}`);
  console.log();

  // Session split
  console.log(`  Session split:`);
  const sessionCounts = new Map<string, { n: number; wins: number }>();
  for (const p of labelled) {
    const s = p.sessionName ?? 'null';
    const e = sessionCounts.get(s) ?? { n: 0, wins: 0 };
    e.n += 1;
    if (p.result === 'WIN') e.wins += 1;
    sessionCounts.set(s, e);
  }
  for (const [s, e] of Array.from(sessionCounts.entries()).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${s}: n=${e.n}  WR ${pct(e.wins, e.n)}`);
  }
  console.log();

  // Schema version split
  console.log(`  Schema version split:`);
  const schemaCounts = new Map<number, number>();
  for (const p of durableParsed) {
    const v = p.schemaVersion ?? 0;
    schemaCounts.set(v, (schemaCounts.get(v) ?? 0) + 1);
  }
  for (const [v, c] of Array.from(schemaCounts.entries()).sort((a, b) => a[0] - b[0])) {
    console.log(`    v${v}: ${c}`);
  }
  console.log();

  // Time range
  const oldest = durableParsed[0];
  const newest = durableParsed[durableParsed.length - 1];
  if (oldest && newest) {
    const spanDays = ((newest.ts - oldest.ts) / (24 * 60 * 60 * 1000)).toFixed(1);
    console.log(`  Time range: ${new Date(oldest.ts).toISOString()} → ${new Date(newest.ts).toISOString()}`);
    console.log(`  Span: ${spanDays} days`);
  }
  console.log();

  // ── Key structural question: are durable rows biased by schema version? ──
  // If the 98 local-only rows are all older (schema v1 vs v2), that would
  // indicate the push path was broken for an older era and was fixed later.
  const v1Rows = durableParsed.filter(p => (p.schemaVersion ?? 0) === 1);
  const v2Rows = durableParsed.filter(p => (p.schemaVersion ?? 0) === 2);
  console.log(`  Schema v1: ${v1Rows.length}  range: ${v1Rows.length > 0 ? new Date(Math.min(...v1Rows.map(r => r.ts))).toISOString() : 'n/a'} → ${v1Rows.length > 0 ? new Date(Math.max(...v1Rows.map(r => r.ts))).toISOString() : 'n/a'}`);
  console.log(`  Schema v2: ${v2Rows.length}  range: ${v2Rows.length > 0 ? new Date(Math.min(...v2Rows.map(r => r.ts))).toISOString() : 'n/a'} → ${v2Rows.length > 0 ? new Date(Math.max(...v2Rows.map(r => r.ts))).toISOString() : 'n/a'}`);
  console.log();

  console.log('═'.repeat(80));
  console.log('  BLOCKER: The 98 local-only rows are on the device SQLite store.');
  console.log('  They cannot be queried from this environment.');
  console.log('  To close (d), the user must export the local corpus from the device');
  console.log('  (Settings > Export includes tradeOutcomes.length) or run a script on-device.');
  console.log('═'.repeat(80));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
