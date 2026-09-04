/** AJ readback — 3 rows (early/mid/recent of the AE-INCLUDED training population), all 7 feat_* values. */
import { filterTrainingCorpus } from "../expo/services/modelFitting";

const SUPABASE_URL = "https://tcbnqmnzsnjhqkyuhrch.supabase.co";
const KEY = "sb_publishable__uw7Qn3qPIARNPGPEDWWww_KzseiT8x";

interface Row {
  signal_id: string;
  ts: string;
  result: string;
  direction: string | null;
  features: Record<string, unknown> | null;
}

const rows: Row[] = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/trade_outcomes_v1?select=signal_id,ts,result,direction,features&order=ts.asc&limit=1000&offset=${offset}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const page = (await res.json()) as Row[];
  rows.push(...page);
  if (page.length < 1000) break;
}

const filter = filterTrainingCorpus(rows);
const included = filter.included as Row[];
console.log(`server rows: ${rows.length} | AE filter: excluded ${filter.excludedReconstruction} (marked ${filter.excludedReconstructionMarked} + fingerprint ${filter.excludedReconstructionFingerprint}) | included ${included.length}`);

const FEATS = [
  "feat_trend_aligned",
  "feat_rsi_aligned",
  "feat_ema_stack",
  "feat_session_level_count",
  "feat_at_day_extreme",
  "feat_zone_max_react",
  "feat_near_round50",
] as const;

const picks: Array<[string, Row]> = [
  ["EARLY (first included)", included[0]],
  ["MID (middle included)", included[Math.floor(included.length / 2)]],
  ["RECENT (last included)", included[included.length - 1]],
];

for (const [label, row] of picks) {
  const f = (row.features ?? {}) as Record<string, unknown>;
  const sent = f.sentiment as { score?: unknown; source?: unknown } | null | undefined;
  console.log(`\n${label}: ${row.signal_id.slice(-6)} ts=${row.ts} result=${row.result} direction=${row.direction}`);
  console.log(`  legacy: rsi=${String(f.rsi)} atr=${String(f.atr)} volumeRatio=${String(f.volumeRatio)} timeWindowFactor=${String(f.timeWindowFactor)} dxy=${String(f.dxyChange)} sentiment.score=${String(sent?.score)} sentiment.source=${String(sent?.source)}`);
  for (const k of FEATS) {
    console.log(`  ${k} = ${String(f[k])}`);
  }
}
