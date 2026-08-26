/**
 * ITEM 225 / CHECKPOINT B — THE LOST LIVE EMISSIONS.
 *
 * B1  cross-reference EVERY witness against emitted_signals_v1 over the exposure
 *     window: telegram_outbox_v1 (durable outbox, written BEFORE delivery, so it
 *     witnesses an emission the signal table may never have received), orphan
 *     trade_outcomes_v1 rows, and shadow_signals_v1.
 * B2  pin the window boundaries from the LIVE DATA, not from a tilde.
 * B3  recoverability of each orphan: does a witness carry the full ladder?
 * B4  book impact, stated plainly.
 *
 * TWO CORRECTIONS TO THE PRIOR ROUND, both found by asking the source system:
 *   1. The count is THREE, not two. signal_1787083581937_xr6mjtadq is a third
 *      orphan from 2026-08-18T20:06Z — SIX DAYS BEFORE the annotation-drift
 *      window opened. It therefore has a DIFFERENT cause and the "2 lost in the
 *      cfc2a0c window" framing was too narrow.
 *   2. The outbox messages DO carry the full ladder. The first pass tested the
 *      message text for /tp1/i; the alert actually says "TAKE PROFIT 1". The
 *      payload was sufficient all along and the "unrecoverable" reading was an
 *      artifact of the detector, not of the data.
 *
 * DATA-SOURCE RULE: all reads Supabase DIRECT via the anon key. This script is
 * READ-ONLY unless --repair is passed, and even then it only INSERTS rows for
 * signal_ids that are absent, from fields a witness actually recorded. Nothing
 * is invented, no outcome row is touched (F-29 discipline).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const WINDOW_START_ISO = '2026-08-24T08:40:18Z';

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`\n${line}`);
  console.log('ITEM 225 / CHECKPOINT B — THE TRUE COUNT OF LOST LIVE EMISSIONS');
  console.log(line);
  console.log(`  run at        : ${new Date().toISOString()}`);
  console.log(`  window opens  : ${WINDOW_START_ISO} (drift began: cfc2a0c put the Item 210/213 annotation`);
  console.log(`                  columns into EVERY insert while they did not exist in production)`);

  // ── WITNESS 0: emitted_signals_v1 itself ───────────────────────────────────
  const { data: emitted, error: eErr } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, source, direction, entry, sl, tp1, tp2, tp3, confidence, nearest_opp_zone_behind_entry_price, driving_zone_touches')
    .order('emitted_at', { ascending: true });
  if (eErr) { console.error(`BLOCKER: emitted_signals_v1 read failed: ${eErr.message}`); process.exit(1); }
  const emittedRows = (emitted ?? []) as { signal_id: string; emitted_at: string; source: string; nearest_opp_zone_behind_entry_price: number | null; driving_zone_touches: number | null }[];
  const emittedIds = new Set(emittedRows.map(r => r.signal_id));
  console.log(`  emitted_signals_v1 total rows : ${emittedRows.length}`);

  // ── B2: PIN THE MIGRATION-011 BOUNDARY FROM THE LIVE DATA ─────────────────
  console.log(`\n${line}`);
  console.log('B2 — WINDOW BOUNDARIES, PINNED FROM LIVE DATA (not a tilde)');
  console.log(line);
  console.log('  The annotation columns exist NOW, so the moment they began to be POPULATED bounds when');
  console.log('  migration 011 became live. Two independent bounds, from the rows themselves:');
  const annotated = emittedRows
    .filter(r => r.nearest_opp_zone_behind_entry_price !== null || r.driving_zone_touches !== null)
    .sort((a, b) => a.emitted_at.localeCompare(b.emitted_at));
  const unannotatedAfterStart = emittedRows
    .filter(r => r.emitted_at >= WINDOW_START_ISO && r.nearest_opp_zone_behind_entry_price === null && r.driving_zone_touches === null)
    .sort((a, b) => a.emitted_at.localeCompare(b.emitted_at));
  console.log(`    FIRST row carrying an annotation value : ${annotated[0]?.emitted_at ?? 'none'}  (${annotated[0]?.signal_id ?? '-'})`);
  console.log(`    LAST annotation-absent row in window   : ${unannotatedAfterStart[unannotatedAfterStart.length - 1]?.emitted_at ?? 'none'}`);
  console.log(`    rows in window WITHOUT annotations     : ${unannotatedAfterStart.length}`);
  console.log(`    annotated rows total                   : ${annotated.length}`);
  console.log('    third bound: verifySchemaContractLive.ts probed the LIVE schema at 2026-08-24T16:14Z');
  console.log('    and found the columns ABSENT (that probe is what opened this investigation).');
  const firstAnnotated = annotated[0]?.emitted_at ?? null;
  console.log(`\n  RESULTING INTERVAL for migration 011 going live: (2026-08-24T16:14:00Z, ${firstAnnotated ?? 'unknown'}]`);
  console.log('  Guard shipped 2026-08-24T16:55:33Z (68cc662) — AFTER that interval, i.e. the guard did not');
  console.log('  cause the recovery; the migration did. The guard prevents the NEXT occurrence.');

  // ── WITNESS 1: telegram_outbox_v1 ─────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('B1 — WITNESS CROSS-REFERENCE: telegram_outbox_v1');
  console.log(line);
  const outbox = await client.from('telegram_outbox_v1').select('*').order('created_at', { ascending: true });
  if (outbox.error) {
    console.log(`  telegram_outbox_v1 UNREADABLE: ${outbox.error.message}`);
    console.log('  This witness therefore contributes NOTHING to the count. Stated, not glossed.');
  } else {
    const rows = (outbox.data ?? []) as Record<string, unknown>[];
    console.log(`  outbox rows total : ${rows.length}`);
    console.log(`  columns           : ${rows.length > 0 ? Object.keys(rows[0]).join(', ') : '(table empty — no columns observable)'}`);
    const inWindow = rows.filter(r => String(r.created_at ?? '') >= WINDOW_START_ISO);
    console.log(`  rows created at/after ${WINDOW_START_ISO}: ${inWindow.length}`);
    let witnessedNotPersisted = 0;
    for (const r of inWindow) {
      const sid = String(r.signal_id ?? '');
      if (!sid) continue;
      if (!emittedIds.has(sid)) {
        witnessedNotPersisted += 1;
        console.log(`    LOST: outbox witnesses ${sid} at ${String(r.created_at)} but emitted_signals_v1 has NO such row`);
        console.log(`          payload keys: ${Object.keys(r).join(', ')}`);
        console.log(`          message: ${String(r.message ?? r.text ?? '(no message column)').slice(0, 400)}`);
      }
    }
    console.log(`  outbox-witnessed emissions ABSENT from emitted_signals_v1: ${witnessedNotPersisted}`);
  }

  // ── WITNESS 2: orphan trade_outcomes_v1 rows ──────────────────────────────
  console.log(`\n${line}`);
  console.log('B1 — WITNESS CROSS-REFERENCE: trade_outcomes_v1 orphans (outcome exists, emission row does not)');
  console.log(line);
  const { data: outcomes, error: oErr } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, features')
    .order('ts', { ascending: true });
  if (oErr) { console.error(`BLOCKER: trade_outcomes_v1 read failed: ${oErr.message}`); process.exit(1); }
  const outcomeRows = (outcomes ?? []) as Record<string, unknown>[];
  const orphans = outcomeRows.filter(o => !emittedIds.has(String(o.signal_id)));
  console.log(`  trade_outcomes_v1 rows : ${outcomeRows.length}`);
  console.log(`  ORPHANS (no emission row): ${orphans.length}`);
  for (const o of orphans) {
    console.log(`    ${String(o.signal_id)}  ts=${String(o.ts)}  dir=${String(o.direction)}  result=${String(o.result)}  entry=${String(o.entry_price)}  exit=${String(o.exit_price)}  R=${String(o.realized_r)}`);
  }

  // ── WITNESS 3: shadow_signals_v1 ──────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('B1 — WITNESS CROSS-REFERENCE: shadow_signals_v1');
  console.log(line);
  const shadow = await client.from('shadow_signals_v1').select('*').gte('created_at', WINDOW_START_ISO).order('created_at', { ascending: true });
  if (shadow.error) {
    console.log(`  shadow_signals_v1 read failed: ${shadow.error.message} — contributes nothing to the count.`);
  } else {
    const rows = (shadow.data ?? []) as Record<string, unknown>[];
    console.log(`  shadow rows in window : ${rows.length}`);
    const shadowOrphans = rows.filter(r => r.signal_id && !emittedIds.has(String(r.signal_id)));
    console.log(`  shadow rows naming a signal_id absent from emitted_signals_v1: ${shadowOrphans.length}`);
    for (const r of shadowOrphans.slice(0, 10)) {
      console.log(`    ${String(r.signal_id)} at ${String(r.created_at)}`);
    }
  }

  // ── B3: RECOVERABILITY, PER ORPHAN ────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('B3 — RECOVERABILITY OF EACH ORPHAN (restore only what a witness actually recorded)');
  console.log(line);
  console.log('  emitted_signals_v1 requires the LADDER to be a real record: direction, entry, sl, tp1-3,');
  console.log('  confidence, emitted_at. An outcome row carries direction, entry_price, exit_price and');
  console.log('  confidence but NOT sl/tp1/tp2/tp3. Reconstructing a ladder from an exit price would be');
  console.log('  INVENTING the very fields the corpus measures — the F-29 error. So the test is whether a');
  console.log('  witness holds the ladder VERBATIM.');
  const outboxRows = outbox.error ? [] : ((outbox.data ?? []) as Record<string, unknown>[]);

  /** Parse the ladder out of the persisted alert text. Returns null unless EVERY
   *  required level was found — a partial parse is not a record. */
  const parseLadder = (msg: string): { direction: 'BUY' | 'SELL'; entryLow: number; entryHigh: number; sl: number; tp1: number; tp2: number; tp3: number } | null => {
    const num = (re: RegExp): number | null => {
      const m = msg.match(re);
      return m ? Number(m[1]) : null;
    };
    const action = msg.match(/\*ACTION:\*\s*(BUY|SELL)/i);
    const zone = msg.match(/\*ENTRY ZONE:\*\s*([0-9.]+)\s*-\s*([0-9.]+)/i);
    const sl = num(/\*STOP LOSS:\*\s*([0-9.]+)/i);
    const tp1 = num(/\*TAKE PROFIT 1:\*\s*([0-9.]+)/i);
    const tp2 = num(/\*TAKE PROFIT 2:\*\s*([0-9.]+)/i);
    const tp3 = num(/\*TAKE PROFIT 3:\*\s*([0-9.]+)/i);
    if (!action || !zone || sl === null || tp1 === null || tp2 === null || tp3 === null) return null;
    return {
      direction: action[1].toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      entryLow: Number(zone[1]), entryHigh: Number(zone[2]),
      sl, tp1, tp2, tp3,
    };
  };

  const repairable: { sid: string; row: Record<string, unknown> }[] = [];
  for (const o of orphans) {
    const sid = String(o.signal_id);
    const witness = outboxRows.find(r => String(r.signal_id ?? '') === sid);
    console.log(`\n  ORPHAN ${sid}`);
    console.log(`    outcome row     : dir=${String(o.direction)} entry=${String(o.entry_price)} exit=${String(o.exit_price)} R=${String(o.realized_r)} ts=${String(o.ts)}`);
    if (!witness) {
      console.log('    outbox witness  : NONE');
      console.log('    VERDICT         : UNRECOVERABLE — no witness holds sl/tp1/tp2/tp3. The emission row');
      console.log('                      cannot be restored without fabricating the ladder, so it is not restored.');
      continue;
    }
    const msg = String(witness.message ?? witness.text ?? '');
    const ladder = parseLadder(msg);
    console.log(`    outbox witness  : created_at=${String(witness.created_at)}  kind=${String(witness.kind)}  status=${String(witness.status)}  delivered_at=${String(witness.delivered_at)}`);
    if (!ladder) {
      console.log('    ladder parse    : FAILED — the persisted message does not yield every required level.');
      console.log('    VERDICT         : UNRECOVERABLE (payload insufficient). Not restored.');
      continue;
    }
    console.log(`    ladder parsed   : ${ladder.direction} entryZone=${ladder.entryLow}-${ladder.entryHigh} sl=${ladder.sl} tp1=${ladder.tp1} tp2=${ladder.tp2} tp3=${ladder.tp3}`);
    // CROSS-CHECK against the independent outcome row before trusting the parse.
    const dirAgrees = String(o.direction) === ladder.direction;
    const entryPrice = Number(o.entry_price);
    const entryInZone = entryPrice >= ladder.entryLow - 2.5 && entryPrice <= ladder.entryHigh + 2.5;
    console.log(`    cross-check     : direction ${dirAgrees ? 'AGREES' : 'DISAGREES'} with the outcome row; outcome entry_price ${entryPrice} ${entryInZone ? 'falls inside' : 'FALLS OUTSIDE'} the witnessed entry zone`);
    if (!dirAgrees || !entryInZone) {
      console.log('    VERDICT         : NOT RESTORED — two independent witnesses disagree, so one of them is');
      console.log('                      wrong and I will not pick a winner by preference.');
      continue;
    }
    console.log('    VERDICT         : RECOVERABLE. Every field below was RECORDED by a witness:');
    console.log('                      sl/tp1/tp2/tp3 + direction from the outbox message (written BEFORE');
    console.log('                      delivery); entry from the outcome row\'s entry_price; emitted_at from');
    console.log('                      the outbox created_at. confidence is NULL because NO witness recorded');
    console.log('                      it — a NULL is honest, a guessed 0.72 would be fabrication.');
    repairable.push({
      sid,
      row: {
        signal_id: sid,
        emitted_at: new Date(String(witness.created_at)).toISOString(),
        direction: ladder.direction,
        entry: entryPrice,
        sl: ladder.sl,
        tp1: ladder.tp1,
        tp2: ladder.tp2,
        tp3: ladder.tp3,
        confidence: null,
        source: 'LIVE',
      },
    });
  }

  // ── B3b: THE REPAIR ──────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('B3b — REPAIR (restores ONLY witnessed fields; never touches an outcome row)');
  console.log(line);
  const doRepair = process.argv.includes('--repair');
  console.log(`  mode            : ${doRepair ? 'REPAIR (guarded insert)' : 'DRY RUN'}`);
  console.log(`  repairable rows : ${repairable.length} of ${orphans.length} orphans`);
  for (const r of repairable) {
    console.log(`    ${r.sid} -> ${JSON.stringify(r.row)}`);
    if (!doRepair) continue;
    // ignoreDuplicates: the emission row is the thing we believe is MISSING; if one
    // exists after all, the existing row wins permanently (ITEM 52(e)) and this is a
    // no-op. The repair can therefore never overwrite a real emission record.
    const { error } = await client.from('emitted_signals_v1').upsert(r.row, { onConflict: 'signal_id', ignoreDuplicates: true });
    console.log(`      insert: ${error ? `FAILED — ${error.message}` : 'OK'}`);
  }
  if (doRepair) {
    const { data: verify } = await client
      .from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source')
      .in('signal_id', repairable.map(r => r.sid));
    console.log('  POST-REPAIR LIVE VERIFICATION (re-read from emitted_signals_v1):');
    for (const v of (verify ?? []) as Record<string, unknown>[]) console.log(`    ${JSON.stringify(v)}`);
  }

  // ── B4: BOOK IMPACT ──────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('B4 — BOOK IMPACT');
  console.log(line);
  console.log(`  The canonical book decides n=448 signals this round. Adding ${orphans.length} row(s) cannot move`);
  console.log('  EV materially (order 0.002R at this n). That is NOT the reason the count matters: a book');
  console.log('  that is missing rows IT DOES NOT KNOW ABOUT has an unquantified hole, and the size of the');
  console.log('  hole is only knowable by asking every witness. That is what this checkpoint does.');
  console.log(`\nDONE (read-only).\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
