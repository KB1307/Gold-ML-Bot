/**
 * PHASE A / A4 — CLOSE F-34: 48h ZONE-MAP STALENESS REPORT (checkpoint evidence).
 *
 * F-34 (2026-08-18): the zone map was 20.9 HOURS old at signal time — the 4h cron
 * had failed silently five times. Item 136(d) moved the cron to 15 minutes and
 * 136(g) added zone_map_age_minutes to every emission, but the 48h report that
 * 136(f) conditioned its decision on ("max age < 20 min over 48h") was never
 * produced. This script produces it from LIVE data.
 *
 * DATA SOURCES (both live, service role):
 *   1. pipeline_health_v1 — the persisted 15-minute health check (migration 007).
 *      cron.job_run_details itself is NOT exposed via PostgREST (measured,
 *      artifacts/ddl_access_probe_2026-08-19.txt §2), so the health check's
 *      cron_lag_minutes + zone_lag_minutes ARE the live cron history — they are
 *      derived from cron.job / net._http_response server-side by the check
 *      itself, which is a strictly better provenance than a client re-derivation.
 *   2. emitted_signals_v1.zone_map_age_minutes — the age the ENGINE actually
 *      saw at emission time (null = TIER_1 fallback, the failure mode itself).
 *
 * Run: bunx tsx scripts/reportZoneMapAge.ts   (from expo/)
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnv(): void {
  try {
    const env = readFileSync('.env', 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    console.error('Could not read expo/.env — run from the expo/ directory.');
    process.exit(1);
  }
}
loadEnv();

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

interface HealthRow {
  checked_at: string;
  status: string;
  cron_lag_minutes: number | null;
  detail: Record<string, unknown> | null;
}

interface EmittedRow {
  emitted_at: string;
  zone_map_age_minutes: number | null;
  source: string;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function main(): Promise<void> {
  console.log('='.repeat(80));
  console.log('PHASE A / A4 — F-34 ZONE-MAP STALENESS REPORT (48h, LIVE)');
  console.log('='.repeat(80));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  const since = new Date(Date.now() - 48 * 3_600_000).toISOString();
  console.log(`Window:    ${since} → now\n`);

  const svc = createClient(URL, SVC, { auth: { autoRefreshToken: false, persistSession: false } });

  // ── 1. Health-check history over 48h (the persisted cron record) ───────────
  const { data: health, error: healthErr } = (await svc
    .from('pipeline_health_v1')
    .select('checked_at, status, cron_lag_minutes, detail')
    .gte('checked_at', since)
    .order('checked_at', { ascending: true })) as { data: HealthRow[] | null; error: { message: string } | null };

  console.log('── 1. pipeline_health_v1 (15-min checks, live cron record) ──');
  if (healthErr || !health) {
    console.log(`  ❌ read error: ${healthErr?.message ?? 'no data'}`);
  } else {
    const byStatus: Record<string, number> = {};
    for (const row of health) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    console.log(`  checks in 48h: ${health.length}`);
    console.log(`  status counts: ${JSON.stringify(byStatus)}`);

    // Split by check type — pipeline_health_v1 carries BOTH the main 15-min
    // pipeline check AND the 5-min bar-freshness alarm (migration 009); a
    // blanket status count would attribute a stalled BAR FEED to the zone
    // cron (or vice versa). Labels before conclusions (rule 5).
    const byCheck: Record<string, { n: number; statuses: Record<string, number> }> = {};
    for (const row of health) {
      const ck = String(row.detail?.['check'] ?? 'pipeline_main');
      byCheck[ck] ??= { n: 0, statuses: {} };
      byCheck[ck].n += 1;
      byCheck[ck].statuses[row.status] = (byCheck[ck].statuses[row.status] ?? 0) + 1;
    }
    for (const [ck, v] of Object.entries(byCheck)) {
      console.log(`  check='${ck}': n=${v.n} statuses=${JSON.stringify(v.statuses)}`);
    }
    const downRows = health.filter((r) => r.status === 'DOWN' || r.status === 'DEGRADED');
    if (downRows.length > 0) {
      console.log(`  unhealthy window: ${downRows[0].checked_at} → ${downRows[downRows.length - 1].checked_at}`);
    }

    // zone-lag distribution restricted to the MAIN pipeline check only.
    const mainChecks = health.filter((r) => !r.detail?.['check']);
    const cronLagsMain = mainChecks
      .map((r) => r.cron_lag_minutes)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (cronLagsMain.length > 0) {
      console.log(`  [main check] cron_lag_minutes (n=${cronLagsMain.length}): min=${cronLagsMain[0].toFixed(2)} p50=${(quantile(cronLagsMain, 0.5) ?? 0).toFixed(2)} p95=${(quantile(cronLagsMain, 0.95) ?? 0).toFixed(2)} max=${cronLagsMain[cronLagsMain.length - 1].toFixed(2)}`);
    }

    // zone lag lives in the detail JSONB (zone_lag_minutes / zone_last_write)
    const zoneLags = mainChecks
      .map((r) => r.detail?.['zone_lag_minutes'])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (zoneLags.length > 0) {
      console.log(`  zone_lag_minutes (n=${zoneLags.length}, from detail JSONB): min=${zoneLags[0].toFixed(2)} p50=${(quantile(zoneLags, 0.5) ?? 0).toFixed(2)} p95=${(quantile(zoneLags, 0.95) ?? 0).toFixed(2)} max=${zoneLags[zoneLags.length - 1].toFixed(2)}`);
      console.log(`  136(f) criterion (max age < 20 min over 48h): ${zoneLags[zoneLags.length - 1] < 20 ? '✅ MET' : '❌ NOT MET'}`);
    } else {
      console.log('  ⚠️ no zone_lag_minutes values in detail JSONB over the window');
    }

    // WEEKEND-LABEL CUT: gold OTC is closed Sat/Sun (UTC). The unhealthy window
    // 2026-08-22T20:45 → 2026-08-23T23:00 is exactly the weekend closure — bars
    // stop printing, zones legitimately stop updating, and the MAIN check (unlike
    // the bar-freshness check's weekend guard in migration 009) reports DOWN for
    // a closed market. The 136(f) criterion as literally written can NEVER pass on
    // a 48h window containing a weekend; the honest measurement is the open-market
    // stretch — rows since the last transition back to HEALTHY.
    let lastUnhealthyIdx = -1;
    for (let i = mainChecks.length - 1; i >= 0; i--) {
      if (mainChecks[i].status !== 'HEALTHY') { lastUnhealthyIdx = i; break; }
    }
    const openStretch = mainChecks.slice(lastUnhealthyIdx + 1);
    if (lastUnhealthyIdx >= 0 && openStretch.length > 0) {
      console.log(`  [open-market stretch since ${mainChecks[lastUnhealthyIdx].checked_at}]: n=${openStretch.length} checks, all HEALTHY=${openStretch.every(r => r.status === 'HEALTHY')}`);
      const openLags = openStretch
        .map((r) => r.detail?.['zone_lag_minutes'])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
        .sort((a, b) => a - b);
      if (openLags.length > 0) {
        console.log(`  [open-market] zone_lag_minutes: min=${openLags[0].toFixed(2)} p50=${(quantile(openLags, 0.5) ?? 0).toFixed(2)} p95=${(quantile(openLags, 0.95) ?? 0).toFixed(2)} max=${openLags[openLags.length - 1].toFixed(2)}`);
        console.log(`  [open-market] 136(f) criterion (max age < 20 min): ${openLags[openLags.length - 1] < 20 ? '✅ MET' : '❌ NOT MET'}`);
      }
    } else if (lastUnhealthyIdx === -1) {
      console.log('  [open-market] entire 48h window HEALTHY');
    }
    const last = health[health.length - 1];
    if (last) {
      console.log(`  latest check: ${last.checked_at} status=${last.status} detail.zone_last_write=${String(last.detail?.['zone_last_write'] ?? 'n/a')}`);
    }
  }
  console.log('');

  // ── 2. What the ENGINE actually saw at emission time ───────────────────────
  const { data: emitted, error: emittedErr } = (await svc
    .from('emitted_signals_v1')
    .select('emitted_at, zone_map_age_minutes, source')
    .gte('emitted_at', since)
    .order('emitted_at', { ascending: true })) as { data: EmittedRow[] | null; error: { message: string } | null };

  console.log("── 2. emitted_signals_v1.zone_map_age_minutes (engine's view, 48h) ──");
  if (emittedErr || !emitted) {
    console.log(`  ❌ read error: ${emittedErr?.message ?? 'no data'}`);
  } else {
    console.log(`  emissions in 48h: ${emitted.length}`);
    const withAge = emitted.filter((r) => typeof r.zone_map_age_minutes === 'number');
    const nullAge = emitted.length - withAge.length;
    console.log(`  zone_map_age_minutes present: ${withAge.length}, NULL (TIER_1 fallback): ${nullAge}`);
    if (withAge.length > 0) {
      const ages = withAge
        .map((r) => r.zone_map_age_minutes as number)
        .sort((a, b) => a - b);
      console.log(`  age minutes: min=${ages[0]} p50=${quantile(ages, 0.5)} p95=${quantile(ages, 0.95)} max=${ages[ages.length - 1]}`);
      const over20 = ages.filter((a) => a >= 20).length;
      console.log(`  emissions with map age >= 20 min: ${over20}/${ages.length}`);
    }
  }
  console.log('');

  // ── 3. Current freshness of the zone cache itself ──────────────────────────
  console.log('── 3. sr_zones_v1 cache freshness (now) ──');
  const { data: zoneFresh, error: zoneErr } = await svc
    .from('sr_zones_v1')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (zoneErr || !zoneFresh || zoneFresh.length === 0) {
    console.log(`  ❌ ${zoneErr?.message ?? 'no rows'}`);
  } else {
    const ageMin = (Date.now() - new Date(zoneFresh[0].updated_at).getTime()) / 60_000;
    console.log(`  newest updated_at: ${zoneFresh[0].updated_at} (${ageMin.toFixed(1)} min ago)`);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
