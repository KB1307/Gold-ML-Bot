/**
 * ITEMS 2/3/5 (five-fix prompt, 2026-09-14) — headless measurement gates on the
 * REAL persisted data (anon key, read-only):
 *
 *   ITEM 2 — opposite-direction cooldown replay: every direction change in the
 *     emission history, its gap, and whether the new 15-min cooldown would have
 *     suppressed it (incl. today's 85-second BUY→SELL pair).
 *   ITEM 3 — SL-sizing table: for every emitted signal with ATR, the raw
 *     dynamic SL vs the OLD 90-pip clamp and the NEW 120-pip clamp (ceiling-bind
 *     counts before/after; no per-session device counter needed for the decision).
 *   ITEM 5 — directional-consensus-veto measurement gate: the last 50 emitted
 *     signals with their stored htf_trend / ltf_trend / rsi labels, joined to
 *     trade_outcomes_v1 — WR of the vetoed set vs the remaining set. SHIP GATE:
 *     if the vetoed set's WR is HIGHER than the remaining set's, Item 5 must
 *     NOT ship. (The stored labels come from the SAME detectHTFTrend /
 *     detectLTFTrend calls the gate reads — verified in the engine's
 *     pushEmittedSignalRecord.)
 *
 * Run: cd expo && bun scripts/verify_items2_3_5_gates.ts
 */
import { createClient } from "@supabase/supabase-js";

interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  atr: number | null;
  sl_multiplier: number | null;
  htf_trend: string | null;
  ltf_trend: string | null;
  rsi: number | null;
}

interface OutcomeRow {
  signal_id: string;
  result: string;
  realized_r: number | null;
}

const PIP_VALUE = 0.1;
const SL_PIPS = 70;
const MIN_SL_ATR_MULTIPLE = 1.2;
const OPPOSITE_COOLDOWN_MIN = 15;

function isVetoed(row: EmittedRow): boolean {
  if (row.direction === 'BUY') {
    return row.htf_trend === 'BEARISH' && row.ltf_trend === 'BEARISH' && (row.rsi === null || row.rsi >= 30);
  }
  if (row.direction === 'SELL') {
    return row.htf_trend === 'BULLISH' && row.ltf_trend === 'BULLISH' && (row.rsi === null || row.rsi <= 70);
  }
  return false;
}

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // ── Fetch ALL emissions (paginated) once — feeds Items 2, 3 and 5. ─────────
  const rows: EmittedRow[] = [];
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const { data, error } = await client
      .from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, atr, sl_multiplier, htf_trend, ltf_trend, rsi')
      .order('emitted_at', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`emission fetch: ${error.message}`);
    const page = (data ?? []) as EmittedRow[];
    rows.push(...page);
    if (page.length < 1000) break;
  }
  console.log(`emitted_signals_v1: ${rows.length} rows (${rows[0]?.emitted_at ?? '—'} → ${rows[rows.length - 1]?.emitted_at ?? '—'})`);

  // ══ ITEM 2 — opposite-direction cooldown replay ════════════════════════════
  console.log(`\n${'='.repeat(76)}`);
  console.log('ITEM 2 — OPPOSITE-DIRECTION COOLDOWN REPLAY (15-min window)');
  let changes = 0;
  let wouldSuppress = 0;
  const suppressedPairs: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev.direction !== cur.direction) {
      changes += 1;
      const gapMin = (Date.parse(cur.emitted_at) - Date.parse(prev.emitted_at)) / 60_000;
      const suppressed = gapMin < OPPOSITE_COOLDOWN_MIN;
      if (suppressed) {
        wouldSuppress += 1;
        suppressedPairs.push(`${prev.emitted_at} ${prev.direction} → ${cur.emitted_at} ${cur.direction} @ ${Number(cur.entry).toFixed(1)} (gap ${gapMin.toFixed(1)} min)`);
      }
    }
  }
  console.log(`direction changes total: ${changes}`);
  console.log(`would be SUPPRESSED by the cooldown (< 15 min): ${wouldSuppress}`);
  for (const p of suppressedPairs) console.log(`   ${p}`);
  console.log(`legitimately pass (gap >= 15 min): ${changes - wouldSuppress}`);
  const todayPair = rows.find(r => r.direction === 'BUY' && r.emitted_at.startsWith('2026-09-14T13:52'));
  const todaySell = rows.find(r => r.direction === 'SELL' && r.emitted_at.startsWith('2026-09-14T13:53'));
  if (todayPair && todaySell) {
    const gap = (Date.parse(todaySell.emitted_at) - Date.parse(todayPair.emitted_at)) / 1000;
    console.log(`TODAY'S PAIR: BUY @ ${Number(todayPair.entry).toFixed(1)} ${todayPair.emitted_at} → SELL @ ${Number(todaySell.entry).toFixed(1)} ${todaySell.emitted_at} — gap ${gap.toFixed(0)}s → ${gap < OPPOSITE_COOLDOWN_MIN * 60 ? 'SUPPRESSED ✓' : 'NOT suppressed ✗'}`);
  } else {
    console.log(`TODAY'S PAIR: not both found in emission rows (BUY ${!!todayPair}, SELL ${!!todaySell})`);
  }

  // ══ ITEM 3 — SL sizing: old 90-pip clamp vs new 120-pip clamp ═════════════
  console.log(`\n${'='.repeat(76)}`);
  console.log('ITEM 3 — SL SIZING vs CEILING (raw dynamic SL = max(slPips × mult, 1.2×ATR/pipValue))');
  const withAtr = rows.filter(r => r.atr !== null && r.sl_multiplier !== null && r.entry !== null && r.sl !== null);
  let bindOld = 0;
  let bindNew = 0;
  const table: string[] = [];
  for (const r of withAtr) {
    const atr = Number(r.atr);
    const mult = Number(r.sl_multiplier);
    const configured = SL_PIPS * mult;
    const floor = (atr * MIN_SL_ATR_MULTIPLE) / PIP_VALUE;
    const raw = Math.max(configured, floor);
    const oldClamped = Math.min(raw, 90);
    const newClamped = Math.min(raw, 120);
    const storedPips = Math.abs(Number(r.entry) - Number(r.sl)) / PIP_VALUE;
    if (raw > 90) bindOld += 1;
    if (raw > 120) bindNew += 1;
    table.push(`${r.emitted_at.slice(0, 16)} ${r.direction} ATR ${atr.toFixed(2)} mult ${mult.toFixed(2)} → configured ${configured.toFixed(1)} floor ${floor.toFixed(1)} raw ${raw.toFixed(1)} | old ${oldClamped.toFixed(1)}${raw > 90 ? ' ⛔capped' : ''} new ${newClamped.toFixed(1)}${raw > 120 ? ' ⛔capped' : ''} | stored SL ${storedPips.toFixed(1)}p`);
  }
  console.log(`signals with ATR recorded: ${withAtr.length}`);
  console.log(`ceiling BIND count: OLD 90-pip = ${bindOld} (${((bindOld / Math.max(1, withAtr.length)) * 100).toFixed(1)}%)  NEW 120-pip = ${bindNew} (${((bindNew / Math.max(1, withAtr.length)) * 100).toFixed(1)}%)`);
  console.log(`last 12 rows (most recent last):`);
  for (const t of table.slice(-12)) console.log(`   ${t}`);
  console.log(`NOTE: stored settings.maxSLPips on device is 90 until the user raises it — the DEFAULT change (120) alone does not lift a persisted value (sanitizeSettings keeps persisted). settings.tsx save-clamp raised to 120 so the user CAN set it.`);

  // ══ ITEM 5 — directional consensus veto: SHIP/NO-SHIP measurement ═════════
  console.log(`\n${'='.repeat(76)}`);
  console.log('ITEM 5 — DIRECTIONAL CONSENSUS VETO MEASUREMENT (last 50 signals)');
  const last50 = rows.slice(-50);
  const ids = last50.map(r => r.signal_id);
  const outcomeMap = new Map<string, OutcomeRow>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, result, realized_r')
      .in('signal_id', chunk);
    if (error) throw new Error(`outcome fetch: ${error.message}`);
    for (const o of (data ?? []) as OutcomeRow[]) outcomeMap.set(o.signal_id, o); // last write wins
  }
  const vetoed: { row: EmittedRow; outcome?: OutcomeRow }[] = [];
  const remaining: { row: EmittedRow; outcome?: OutcomeRow }[] = [];
  for (const row of last50) {
    const outcome = outcomeMap.get(row.signal_id);
    if (isVetoed(row)) vetoed.push({ row, outcome });
    else remaining.push({ row, outcome });
  }
  const wr = (arr: { outcome?: OutcomeRow }[]) => {
    const decided = arr.filter(x => x.outcome && (x.outcome.result === 'WIN' || x.outcome.result === 'LOSS'));
    const wins = decided.filter(x => x.outcome!.result === 'WIN').length;
    const ev = decided.reduce((s, x) => s + (x.outcome!.realized_r ?? 0), 0);
    return { decided: decided.length, wins, wr: decided.length ? (wins / decided.length) * 100 : NaN, evR: decided.length ? ev / decided.length : NaN };
  };
  const v = wr(vetoed);
  const rem = wr(remaining);
  console.log(`last 50 signals: ${last50.length} | with stored htf/ltf labels: ${last50.filter(r => r.htf_trend !== null && r.ltf_trend !== null).length}`);
  console.log(`VETOED set (HTF+LTF consensus against, RSI not extreme): n=${vetoed.length}, decided=${v.decided}, WR=${Number.isNaN(v.wr) ? '—' : v.wr.toFixed(1) + '%'}, EV=${Number.isNaN(v.evR) ? '—' : v.evR.toFixed(3) + 'R'}`);
  for (const x of vetoed) {
    console.log(`   ${x.row.emitted_at.slice(0, 16)} ${x.row.direction} @ ${Number(x.row.entry).toFixed(1)} htf=${x.row.htf_trend} ltf=${x.row.ltf_trend} rsi=${x.row.rsi ?? '—'} → ${x.outcome ? `${x.outcome.result} (${x.outcome.realized_r ?? '—'}R)` : 'no outcome row (still open)'}`);
  }
  console.log(`REMAINING set: n=${remaining.length}, decided=${rem.decided}, WR=${Number.isNaN(rem.wr) ? '—' : rem.wr.toFixed(1) + '%'}, EV=${Number.isNaN(rem.evR) ? '—' : rem.evR.toFixed(3) + 'R'}`);
  const s3 = last50.find(r => r.direction === 'BUY' && Math.abs(Number(r.entry) - 4275.4) < 0.05);
  const s1 = last50.find(r => r.direction === 'SELL' && Math.abs(Number(r.entry) - 4309.6) < 0.05);
  if (s3) console.log(`VERIFY #3 (BUY @ 4275.4): htf=${s3.htf_trend} ltf=${s3.ltf_trend} rsi=${s3.rsi} → vetoed=${isVetoed(s3)} (expected TRUE)`);
  if (s1) console.log(`VERIFY #1 (SELL @ 4309.6): htf=${s1.htf_trend} ltf=${s1.ltf_trend} → vetoed=${isVetoed(s1)} (expected FALSE — HTF/LTF disagree)`);
  if (!Number.isNaN(v.wr) && !Number.isNaN(rem.wr)) {
    const ship = v.wr > rem.wr;
    console.log(`\nSHIP GATE: vetoed WR ${v.wr.toFixed(1)}% vs remaining WR ${rem.wr.toFixed(1)}% → ${ship ? 'VETOED SET IS BETTER — ITEM 5 MUST NOT SHIP' : 'vetoed set worse or equal — gate PASSES, Item 5 ships'}`);
  } else {
    console.log(`\nSHIP GATE: UNDECIDABLE — decided counts vetoed=${v.decided} remaining=${rem.decided} (power statement: both WRs need decided outcomes; open signals excluded)`);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
