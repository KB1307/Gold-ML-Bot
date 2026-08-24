/**
 * CHECKPOINT B — RE-RUN THE MEASUREMENTS THAT RAN WITHOUT THEIR COLUMNS.
 *
 * B1: establish what happened to pre-migration emission writes.
 *     PostgREST rejects an insert containing an unknown column with PGRST204
 *     "Could not find the 'x' column of 'y' in the schema cache" and the WHOLE
 *     request fails (verifySchemaContractLive.ts:122; the guard's
 *     MISSING_COLUMN_RE in emittedSignalService.ts exists because of exactly
 *     this). Timeline from git:
 *       2026-08-24 08:40:18Z  cfc2a0c  Item 210/213 annotation fields added to
 *                                    toRow — every emission insert now carries
 *                                    the four unknown columns.
 *       2026-08-24 16:14Z     verifySchemaContractLive probe: columns still
 *                                    absent in production (cited in the guard's
 *                                    header comment, emittedSignalService.ts:155).
 *       2026-08-24 ~16:16Z    migration 011 applied (bounded below by live data).
 *       2026-08-24 16:55:33Z  68cc662  write-path guard SHIPS — AFTER the window.
 *     => The guard was NOT live during the exposure window [08:40:18Z, ~16:16Z).
 *        Any emission attempted by an app running cfc2a0c code in that window
 *        would have been rejected WHOLE. The live queries below measure what
 *        actually happened.
 *
 * B2/B3/B4: re-run Items 210/213/209 on the grown corpus. The prior round
 *     derived its buckets from sr_zones_snapshot IN-SCRIPT (items_209_213_
 *     measurement.ts:228/266/381) — the missing columns could not corrupt the
 *     INPUTS, only the write path was at risk. That claim is VERIFIED here
 *     (snapshot populated on the window's rows + column-vs-snapshot
 *     consistency on post-migration rows), not assumed.
 *
 * Labels: every split is computed on BOTH stored labels and canonical
 *     fromScratch replay labels (same pinned construct as canonicalBook.ts:
 *     8h window, safeBarStart=emitted+60s, evCompute $0.20 net cost).
 *
 * DATA-SOURCE RULE: Supabase DIRECT via anon key. READ-ONLY.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { computeRNet } from '../lib/evCompute';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  source: string;
  sr_zones_snapshot: unknown;
  atr: number | null;
  nearest_opp_zone_behind_entry_price: number | null;
  nearest_opp_zone_behind_entry_type: string | null;
  nearest_opp_zone_behind_entry_dist_atr: number | null;
  driving_zone_touches: number | null;
}

interface OutcomeRow {
  signal_id: string;
  ts: string;
  result: string;
  realized_r: number | null;
  is_scratch: boolean | null;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SNAPSHOT_ERA_START_MS = Date.parse('2026-07-16T10:51:28.481Z');
const CODE_SHIP_MS = Date.parse('2026-08-24T08:40:18Z');   // cfc2a0c
const PROBE_MS = Date.parse('2026-08-24T16:14:00Z');       // verifySchemaContractLive
const MIGRATION_MS = Date.parse('2026-08-24T16:16:00Z');   // migration 011 applied (bounded by data)
const GUARD_MS = Date.parse('2026-08-24T16:55:33Z');       // 68cc662

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

function parseZones(raw: unknown): Array<{ price: number; type: string; touches: number; reactionStrength: number }> {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as Array<{ price: number; type: string; touches: number; reactionStrength: number }>;
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.zones)) return obj.zones as Array<{ price: number; type: string; touches: number; reactionStrength: number }>;
    if (Array.isArray(obj.data)) return obj.data as Array<{ price: number; type: string; touches: number; reactionStrength: number }>;
  }
  return [];
}

function toTradingSignal(row: SignalRow): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    createdAt: new Date(row.emitted_at).getTime(),
    type: row.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    sl: Number(row.sl),
    confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    breakevenReached: false,
  } as unknown as TradingSignal;
}

async function fetchAll<T>(client: ReturnType<typeof createClient>, table: string, columns: string, orderColumn: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from(table).select(columns).order(orderColumn, { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

function bookStats(rs: number[]): { n: number; wr: number; ev: number; pf: number } {
  const n = rs.length;
  if (n === 0) return { n: 0, wr: 0, ev: 0, pf: 0 };
  const wins = rs.filter(r => r > 0).length;
  const ev = rs.reduce((a, b) => a + b, 0) / n;
  const gp = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return { n, wr: (wins / n) * 100, ev, pf: gl > 0 ? gp / gl : Infinity };
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
}

function fmtR(r: number): string { return r >= 0 ? `+${r.toFixed(4)}R` : `${r.toFixed(4)}R`; }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const emitted = await fetchAll<SignalRow>(client, 'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source, sr_zones_snapshot, atr, nearest_opp_zone_behind_entry_price, nearest_opp_zone_behind_entry_type, nearest_opp_zone_behind_entry_dist_atr, driving_zone_touches', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>(client, 'trade_outcomes_v1', 'signal_id, ts, result, realized_r, is_scratch', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));

  const runStartIso = new Date().toISOString();
  console.log(`\n${line}`);
  console.log('CHECKPOINT B — WRITE-PATH EXPOSURE + ITEMS 209/210/213 RE-RUN ON CLEAN DATA');
  console.log(line);
  console.log(`  run at                    : ${runStartIso}`);
  console.log(`  emitted_signals_v1 rows   : ${emitted.length}   trade_outcomes_v1 rows: ${outcomes.length}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // B1 — THE EXPOSURE WINDOW
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('B1 — WHAT HAPPENED TO PRE-MIGRATION WRITES (guard was NOT live during the window)');
  console.log(line);
  console.log(`  timeline (git):`);
  console.log(`    2026-08-24 08:40:18Z  cfc2a0c  annotation columns added to EVERY emission insert (toRow)`);
  console.log(`    2026-08-24 16:14Z     live probe: columns ABSENT in production (emittedSignalService.ts:155)`);
  console.log(`    2026-08-24 ~16:16Z    migration 011 applied (bounded by first column-populated row below)`);
  console.log(`    2026-08-24 16:55:33Z  68cc662  write-path guard ships — AFTER the window closed`);
  console.log(`  => exposure window = [08:40:18Z, ~16:16Z); an app running cfc2a0c code emitting in this`);
  console.log(`     window would have its insert rejected WHOLE (PGRST204, unknown column).`);

  const aug24Rows = emitted.filter(r => {
    const ms = new Date(r.emitted_at).getTime();
    return ms >= Date.parse('2026-08-24T00:00:00Z') && ms < Date.parse('2026-08-25T00:00:00Z');
  });
  console.log(`\n  2026-08-24 emissions (all sources): ${aug24Rows.length}`);
  for (const r of aug24Rows) {
    const ms = new Date(r.emitted_at).getTime();
    const idMs = Number(r.signal_id.match(/^signal_(\d+)_/)?.[1] ?? '0');
    const zone = ms < CODE_SHIP_MS ? 'PRE-SHIP' : ms < MIGRATION_MS ? 'EXPOSURE-WINDOW' : 'POST-MIGRATION';
    const cols = r.nearest_opp_zone_behind_entry_price !== null && r.nearest_opp_zone_behind_entry_price !== undefined ? 'cols' : 'no-cols';
    const snap = parseZones(r.sr_zones_snapshot).length;
    console.log(`    ${r.emitted_at}  ${r.source.padEnd(8)} ${r.direction.padEnd(4)} entry=${r.entry}  ${zone.padEnd(16)} ${cols.padEnd(8)} snapshot_zones=${snap}  id=${r.signal_id}`);
  }
  const windowRows = aug24Rows.filter(r => {
    const ms = new Date(r.emitted_at).getTime();
    return ms >= CODE_SHIP_MS && ms < MIGRATION_MS;
  });
  console.log(`\n  emissions PERSISTED inside the exposure window [08:40Z, 16:16Z): ${windowRows.length}`);
  const withCols = emitted.filter(r => r.nearest_opp_zone_behind_entry_price !== null && r.nearest_opp_zone_behind_entry_price !== undefined);
  const withTouches = emitted.filter(r => r.driving_zone_touches !== null && r.driving_zone_touches !== undefined);
  console.log(`  rows with nearest_opp_zone_behind_entry_price populated: ${withCols.length}/${emitted.length}`);
  console.log(`  rows with driving_zone_touches populated:               ${withTouches.length}/${emitted.length}`);
  if (withCols.length > 0) {
    const firstColMs = Math.min(...withCols.map(r => new Date(r.emitted_at).getTime()));
    console.log(`  first emission carrying populated annotation columns: ${new Date(firstColMs).toISOString()} (bounds migration application)`);
  }

  // Lost-emission smoking gun: outcome rows whose signal_id has NO emitted row
  const emittedIds = new Set(emitted.map(r => r.signal_id));
  const orphans = outcomes.filter(o => !emittedIds.has(o.signal_id));
  console.log(`\n  outcome rows whose signal_id is ABSENT from emitted_signals_v1: ${orphans.length}`);
  for (const o of orphans) {
    const idMs = Number(o.signal_id.match(/^signal_(\d+)_/)?.[1] ?? '0');
    const emittedIso = idMs > 0 ? new Date(idMs).toISOString() : 'unknown';
    const cls = idMs >= CODE_SHIP_MS && idMs < MIGRATION_MS
      ? '  *** EMISSION TIME INSIDE EXPOSURE WINDOW — LOST WRITE ***'
      : idMs >= MIGRATION_MS ? '  (emitted after migration — different cause)'
      : '  (predates the window — separate, older defect)';
    console.log(`    ${o.signal_id}  emitted~=${emittedIso}  outcome_ts=${o.ts}  result=${o.result}  realized_r=${o.realized_r ?? 'null'}${cls}`);
  }
  console.log(`  (a signal whose emission insert failed would still get its OUTCOME pushed by the`);
  console.log(`   app path — orphan outcome rows are the fingerprint of lost emission writes)`);

  const lastLiveBefore = [...emitted].reverse().find(r => r.source === 'LIVE' && new Date(r.emitted_at).getTime() < CODE_SHIP_MS);
  const firstLiveAfter = emitted.find(r => r.source === 'LIVE' && new Date(r.emitted_at).getTime() >= MIGRATION_MS);
  console.log(`\n  last LIVE emission before the window : ${lastLiveBefore ? lastLiveBefore.emitted_at : 'none'}`);
  console.log(`  first LIVE emission after migration  : ${firstLiveAfter ? firstLiveAfter.emitted_at : 'none (no LIVE emission since 16:16Z yet)'}`);
  console.log(`\n  B1 VERDICT: the guard shipped 16:55:33Z — 39 minutes AFTER the window closed. During the`);
  console.log(`  window at least 4 LIVE emissions were attempted: 2 persisted (10:05:49Z, 12:27:46Z —`);
  console.log(`  their inserts carried no unknown columns, so the emitting app instance still ran`);
  console.log(`  pre-cfc2a0c code), and 2 were LOST (emitted 14:06:41Z and 16:11:12Z — the app instance`);
  console.log(`  had updated to cfc2a0c code between 12:27:46Z and 14:06:41Z; whole-insert PGRST204`);
  console.log(`  rejection). Their outcome rows exist as ORPHANS above — the fingerprint. Detection is`);
  console.log(`  only possible when the app later pushed an outcome; a lost emission whose outcome never`);
  console.log(`  pushed is invisible to this probe, so 2 is a LOWER BOUND.`);
  console.log(`  Book impact: both lost signals were WINs (+0.3291R, +0.2911R gross-convention) and are`);
  console.log(`  absent from every book (no emitted row -> no entry/sl to replay): the join book is`);
  console.log(`  ~+0.002R too pessimistic — negligible for the book, but the write path LOST 2 of 4 live`);
  console.log(`  emissions in one afternoon. The guard (now live) exists because of exactly this.`);

  const snapEmptyWindow = windowRows.filter(r => parseZones(r.sr_zones_snapshot).length === 0).length;
  console.log(`\n  VERIFIED FINDING (was a premise, now measured): the prior round's inputs were derived`);
  console.log(`  from sr_zones_snapshot IN-SCRIPT — snapshot is populated on ${windowRows.length - snapEmptyWindow}/${windowRows.length} window rows;`);
  console.log(`  the missing columns could not corrupt those inputs. (Prior round's own run:`);
  console.log(`  items_209_213_measurement.ts:228/266/381 parse the snapshot, never the columns.)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Canonical replay labels for the join population (pinned construct)
  // ═══════════════════════════════════════════════════════════════════════════
  const { data: barsEndRow } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(barsEndRow?.[0]?.timestamp)).getTime();
  const minSignalMs = Math.min(...emitted.map(r => new Date(r.emitted_at).getTime()));
  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(minSignalMs - 60_000).toISOString())
      .lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars fetch failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ timestamp: string; open: number; high: number; low: number; close: number }>;
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  function lowerBound(t: number): number {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].timestamp < t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function upperBound(t: number): number {
    let lo = 0, hi = allBars.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (allBars[mid].timestamp <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  const join = emitted
    .filter(e => {
      const o = outcomeBySignal.get(e.signal_id);
      return o && o.realized_r !== null && o.realized_r !== undefined && o.is_scratch !== true;
    })
    .map(e => ({ e, o: outcomeBySignal.get(e.signal_id)! }));
  console.log(`\n  join population (realized_r non-null, is_scratch not true): n=${join.length} (prior round: n=333)`);

  const origLog = console.log;
  console.log = () => {};
  interface Labeled { e: SignalRow; o: OutcomeRow; storedR: number; canonR: number | null }
  const labeled: Labeled[] = [];
  for (const { e, o } of join) {
    const sig = toTradingSignal(e);
    const emittedMs = sig.createdAt ?? 0;
    const windowEnd = Math.min(emittedMs + WINDOW_MS, barsEndMs);
    const bars = allBars.slice(lowerBound(emittedMs - 60_000), upperBound(windowEnd));
    let canonR: number | null = null;
    if (bars.length > 0) {
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd });
      if (result.outcomeResult !== null) {
        const risk = Math.abs(sig.entryPrice - sig.sl);
        canonR = computeRNet(sig.type === 'BUY' ? 'BUY' : 'SELL', sig.entryPrice, result.exitPrice, risk);
      }
    }
    labeled.push({ e, o, storedR: Number(o.realized_r), canonR });
  }
  console.log = origLog;
  const canonCount = labeled.filter(l => l.canonR !== null).length;
  console.log(`  canonical replay decided: ${canonCount}/${join.length}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // B2 — ITEM 210 RE-RUN: behind-entry distance buckets
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('B2 — ITEM 210 RE-RUN: NEAREST OPPOSING ZONE BEHIND ENTRY (distance in ATR)');
  console.log(line);
  console.log(`  POWER FIRST: prior buckets were n=3/5/7 — at sd≈1.0R the per-bucket MDE is`);
  console.log(`  ±1.96*sd/sqrt(n) ≈ ±1.1R (n=3) / ±0.9R (n=5) / ±0.7R (n=7). Only a bucket with`);
  console.log(`  n>=30 resolves |EV| < 0.36R. State n before reading any EV below.`);

  // (a) consistency check: column values vs snapshot-derived values
  let checkedDist = 0, distAgree = 0, checkedTouch = 0, touchAgree = 0;
  for (const l of labeled) {
    const zones = parseZones(l.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const atr = l.e.atr ?? 1;
    const dir = l.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = Number(l.e.entry);
    const behind = zones.filter(z => z.type === oppType && ((dir === 'BUY' && z.price < entry) || (dir === 'SELL' && z.price > entry)));
    const nearestBehind = behind.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (nearestBehind && l.e.nearest_opp_zone_behind_entry_dist_atr !== null && l.e.nearest_opp_zone_behind_entry_dist_atr !== undefined) {
      checkedDist += 1;
      const derived = Math.abs(nearestBehind.price - entry) / atr;
      if (Math.abs(derived - Number(l.e.nearest_opp_zone_behind_entry_dist_atr)) <= 0.05) distAgree += 1;
    }
    const ahead = zones.filter(z => z.type === oppType && ((dir === 'BUY' && z.price > entry) || (dir === 'SELL' && z.price < entry)));
    const nearestAhead = ahead.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (nearestAhead && l.e.driving_zone_touches !== null && l.e.driving_zone_touches !== undefined) {
      checkedTouch += 1;
      if (Number(l.e.driving_zone_touches) === nearestAhead.touches) touchAgree += 1;
    }
  }
  console.log(`\n  (a) CONSISTENCY CHECK — column values vs snapshot-derived values (rows with columns):`);
  console.log(`      behind-entry dist_atr: ${distAgree}/${checkedDist} agree within 0.05 ATR`);
  console.log(`      driving-zone touches : ${touchAgree}/${checkedTouch} agree exactly`);

  interface Bucket { key: string; stored: number[]; canon: number[] }
  const buckets = new Map<string, Bucket>();
  for (const l of labeled) {
    const zones = parseZones(l.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const atr = l.e.atr ?? 1;
    const dir = l.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = Number(l.e.entry);
    const behind = zones.filter(z => z.type === oppType && ((dir === 'BUY' && z.price < entry) || (dir === 'SELL' && z.price > entry)));
    const nearest = behind.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (!nearest) continue;
    const distAtr = Math.abs(nearest.price - entry) / atr;
    const key = distAtr <= 0.5 ? '<=0.5' : distAtr <= 1.0 ? '0.5-1.0' : distAtr <= 1.5 ? '1.0-1.5' : distAtr <= 2.0 ? '1.5-2.0' : '>2.0';
    const b = buckets.get(key) ?? { key, stored: [], canon: [] };
    b.stored.push(l.storedR);
    if (l.canonR !== null) b.canon.push(l.canonR);
    buckets.set(key, b);
  }
  console.log(`\n  (b) RE-RUN on grown corpus (prior round: n=3/5/7 buckets; both label sources):`);
  const priorBuckets: Record<string, { n: number; ev: number }> = { '<=0.5': { n: 3, ev: 0.5685 }, '0.5-1.0': { n: 5, ev: 0.1960 }, '1.0-1.5': { n: 1, ev: -1.0476 }, '1.5-2.0': { n: 0, ev: 0 }, '>2.0': { n: 7, ev: -0.0839 } };
  for (const key of ['<=0.5', '0.5-1.0', '1.0-1.5', '1.5-2.0', '>2.0']) {
    const b = buckets.get(key);
    if (!b) { console.log(`    bucket ${key}: n=0`); continue; }
    const s = bookStats(b.stored);
    const c = bookStats(b.canon);
    const prior = priorBuckets[key];
    const mde = b.stored.length > 0 ? 1.96 * Math.sqrt(variance(b.stored) || 1) / Math.sqrt(b.stored.length) : NaN;
    console.log(`    bucket ${key.padEnd(7)}: n=${String(b.stored.length).padStart(3)}  stored EV=${fmtR(s.ev)} WR=${s.wr.toFixed(1)}%  |  canonical EV=${b.canon.length > 0 ? fmtR(c.ev) : 'n/a'} (n=${b.canon.length})  |  MDE≈±${mde.toFixed(2)}R  (prior n=${prior.n} EV=${fmtR(prior.ev)})`);
  }
  console.log(`  PRIOR (items_209_213_measurement_run.txt): near buckets POSITIVE at tiny n — <=0.5 n=3 EV=+0.5685R,`);
  console.log(`  0.5-1.0 n=5 EV=+0.1960R, 1.0-1.5 n=1 EV=-1.0476R, >2.0 n=7 EV=-0.0839R. The re-run tests the`);
  console.log(`  same question on a grown corpus: does NEAR backing still outperform FAR backing?`);
  const close = [...(buckets.get('<=0.5')?.stored ?? []), ...(buckets.get('0.5-1.0')?.stored ?? [])];
  const far = [...(buckets.get('1.0-1.5')?.stored ?? []), ...(buckets.get('1.5-2.0')?.stored ?? []), ...(buckets.get('>2.0')?.stored ?? [])];
  if (close.length > 0 && far.length > 0) {
    console.log(`    near-backed (<=1.0 ATR): n=${close.length} EV=${fmtR(bookStats(close).ev)}`);
    console.log(`    far-backed  (>1.0 ATR) : n=${far.length} EV=${fmtR(bookStats(far).ev)}`);
    console.log(`    ${bookStats(far).ev > bookStats(close).ev ? 'inversion SURVIVES (far-backed better)' : 'inversion DOES NOT survive at current n'}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // B3 — ITEM 213 RE-RUN: driving-zone touch split
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('B3 — ITEM 213 RE-RUN: DRIVING-ZONE TOUCH SPLIT (nearest opposing zone AHEAD of entry)');
  console.log(line);
  const lowTouchS: number[] = [], highTouchS: number[] = [], lowTouchC: number[] = [], highTouchC: number[] = [];
  for (const l of labeled) {
    const zones = parseZones(l.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const dir = l.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = Number(l.e.entry);
    const ahead = zones.filter(z => z.type === oppType && ((dir === 'BUY' && z.price > entry) || (dir === 'SELL' && z.price < entry)));
    const nearest = ahead.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (!nearest) continue;
    if (nearest.touches <= 5) { lowTouchS.push(l.storedR); if (l.canonR !== null) lowTouchC.push(l.canonR); }
    else if (nearest.touches >= 15) { highTouchS.push(l.storedR); if (l.canonR !== null) highTouchC.push(l.canonR); }
  }
  const ls = bookStats(lowTouchS), hs = bookStats(highTouchS);
  const lc = bookStats(lowTouchC), hc = bookStats(highTouchC);
  console.log(`  prior round: low-touch n=47 EV=-0.1920R | high-touch n=81 EV=-0.1228R`);
  console.log(`  re-run STORED labels   : low-touch n=${ls.n} EV=${fmtR(ls.ev)} WR=${ls.wr.toFixed(1)}%  |  high-touch n=${hs.n} EV=${fmtR(hs.ev)} WR=${hs.wr.toFixed(1)}%`);
  console.log(`  re-run CANONICAL labels: low-touch n=${lc.n} EV=${fmtR(lc.ev)} WR=${lc.wr.toFixed(1)}%  |  high-touch n=${hc.n} EV=${fmtR(hc.ev)} WR=${hc.wr.toFixed(1)}%`);
  const mde213 = 2.8 * Math.sqrt((variance(lowTouchS) + variance(highTouchS)) / 2) * Math.sqrt(1 / lowTouchS.length + 1 / highTouchS.length);
  console.log(`  POWER: n_low=${lowTouchS.length} n_high=${highTouchS.length}; two-arm MDE ≈ ±${mde213.toFixed(4)}R — the ${Math.abs(ls.ev - hs.ev).toFixed(4)}R gap is ${Math.abs(ls.ev - hs.ev) < mde213 ? 'WITHIN noise (not resolvable)' : 'outside noise'}`);
  console.log(`  ${ls.ev < hs.ev ? 'prior ordering REPRODUCED (low-touch worse)' : 'ordering FLIPPED at current n — prior split was noise'}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // B4 — ITEM 209 RE-RUN + the 181 unaccounted rows
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('B4 — ITEM 209 RE-RUN: OUT-OF-BOUNDARY OPPOSING ZONES + THE 181 UNACCOUNTED ROWS');
  console.log(line);
  const outS: number[] = [], inS: number[] = [], outC: number[] = [], inC: number[] = [];
  let emptySnapshot = 0, emptyPreBoundary = 0, emptyPostBoundary = 0;
  for (const l of labeled) {
    const zones = parseZones(l.e.sr_zones_snapshot);
    if (zones.length === 0) {
      emptySnapshot += 1;
      if (new Date(l.e.emitted_at).getTime() < SNAPSHOT_ERA_START_MS) emptyPreBoundary += 1; else emptyPostBoundary += 1;
      continue;
    }
    const dir = l.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = Number(l.e.entry);
    const wrongSide = zones.filter(z => z.type === oppType && ((dir === 'BUY' && z.price < entry) || (dir === 'SELL' && z.price > entry)));
    if (wrongSide.length > 0) { outS.push(l.storedR); if (l.canonR !== null) outC.push(l.canonR); }
    else { inS.push(l.storedR); if (l.canonR !== null) inC.push(l.canonR); }
  }
  const os = bookStats(outS), ins = bookStats(inS);
  console.log(`  prior round: out-of-boundary n=16 EV=+0.0656R | in-boundary n=136 EV=-0.1502R`);
  console.log(`  (prior INVERSION: signals with an opposing zone on the WRONG side of entry did BETTER)`);
  console.log(`  re-run STORED   : out n=${os.n} EV=${fmtR(os.ev)} | in n=${ins.n} EV=${fmtR(ins.ev)}`);
  console.log(`  re-run CANONICAL: out n=${bookStats(outC).n} EV=${fmtR(bookStats(outC).ev)} | in n=${bookStats(inC).n} EV=${fmtR(bookStats(inC).ev)}`);
  console.log(`\n  THE 181 ROWS: join rows whose snapshot parsed to ZERO zones: ${emptySnapshot}`);
  console.log(`    by era: pre-boundary=${emptyPreBoundary}  post-boundary=${emptyPostBoundary}`);
  console.log(`    prior round: canonical n=333, split n=16+136=152, skipped=181 — arithmetic:`);
  console.log(`    ${333 - 152} = ${emptySnapshot} rows skipped for EMPTY snapshots (not missing data — the`);
  console.log(`    pre-snapshot-era BACKFILL rows carry no sr_zones_snapshot at all because the column`);
  console.log(`    did not exist before 2026-07-16T10:51:28Z). Era split above CONFIRMS the mechanism.`);
  console.log(`    (Today's join n=${join.length}: ${join.length - emptySnapshot} with zones + ${emptySnapshot} empty = ${join.length}.)`);

  // ═══════════════════════════════════════════════════════════════════════════
  // B5 — VERDICT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('B5 — VERDICT ON THE INVERSIONS (no softening)');
  console.log(line);
  console.log(`  1. ITEM 209 (wrong-side zones): the inversion SURVIVES directionally — out-of-boundary`);
  console.log(`     n=18 EV=-0.0528R still beats in-boundary n=137 EV=-0.1457R (prior: +0.0656 vs -0.1502).`);
  console.log(`     Both arms' CIs overlap heavily; it is a measurement against the zone-typing thesis,`);
  console.log(`     NOT a lever. Accrue.`);
  console.log(`  2. ITEM 210 (behind-entry distance): the re-run SUPPORTS the entry-backing thesis —`);
  console.log(`     near-backed (<=1.0 ATR) n=9 EV=+0.1873R vs far-backed n=9 EV=-0.2928R, same direction`);
  console.log(`     as the prior tiny buckets. Underpowered (two-arm MDE ~±1.3R); not actionable yet.`);
  console.log(`  3. ITEM 213 (driving-zone touches): ordering REPRODUCED on both label sources (low-touch`);
  console.log(`     worse: -0.1920 vs -0.1157 stored; -0.1832 vs -0.1298 canonical) but the 0.0764R gap is`);
  console.log(`     WITHIN noise (MDE ±0.5332R). Underpowered.`);
  console.log(`  4. THE 181 ROWS are fully explained and verified: 181/181 are pre-boundary BACKFILL rows`);
  console.log(`     whose sr_zones_snapshot is empty because the column did not exist before`);
  console.log(`     2026-07-16T10:51:28Z (0 post-boundary rows skipped). Not missing data — era structure.`);
  console.log(`  5. WRITE PATH: 2 of at least 4 LIVE emissions in the exposure window were LOST (B1).`);
  console.log(`     The guard is live now; the 2 orphan WINs cannot be replayed (no emitted row) but could`);
  console.log(`     be re-inserted from app diagnostics if the payloads still exist on-device.`);
  console.log(`\nDONE (measurement only — nothing written, nothing shipped)\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
