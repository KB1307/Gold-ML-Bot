/** AE supplementary decomposition — fingerprint rows grouped by sentiment.source (label quality). */
const SUPABASE_URL = "https://tcbnqmnzsnjhqkyuhrch.supabase.co";
const KEY = "sb_publishable__uw7Qn3qPIARNPGPEDWWww_KzseiT8x";

interface Row { signal_id: string; ts: string; features: Record<string, unknown> | null }

const rows: Row[] = [];
for (let offset = 0; ; offset += 1000) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/trade_outcomes_v1?select=signal_id,ts,features&order=ts.asc&limit=1000&offset=${offset}`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } },
  );
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const page = (await res.json()) as Row[];
  rows.push(...page);
  if (page.length < 1000) break;
}

const bySource = new Map<string, number>();
const sourcesNoSentiment = { absent: 0, scoreUndefined: 0 };
let fingerprint = 0;
for (const r of rows) {
  const f = (r.features ?? {}) as Record<string, unknown>;
  const vr = f.volumeRatio, tw = f.timeWindowFactor, dxy = f.dxyChange;
  const sent = f.sentiment as { score?: unknown; source?: unknown } | null | undefined;
  const sentDef = sent === null || sent === undefined || sent.score === 0;
  if (vr === 1 && tw === 1 && dxy === 0 && sentDef) {
    fingerprint += 1;
    if (sent === null || sent === undefined) sourcesNoSentiment.absent += 1;
    else if (sent.score === undefined) sourcesNoSentiment.scoreUndefined += 1;
    else {
      const src = String(sent.source ?? "undefined-source");
      bySource.set(src, (bySource.get(src) ?? 0) + 1);
    }
  }
}
console.log(`total rows: ${rows.length}`);
console.log(`fingerprint rows: ${fingerprint}`);
console.log(`  sentiment ABSENT: ${sourcesNoSentiment.absent}`);
console.log(`  sentiment present, score undefined: ${sourcesNoSentiment.scoreUndefined}`);
console.log(`  sentiment present, score===0, by source:`);
for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${src}: ${n}`);
}
