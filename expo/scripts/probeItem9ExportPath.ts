/**
 * ITEM 9(c)(d) — LIVE PROBE of the new diagnostics-export publish path.
 *
 * Exercises the REAL `publishDiagnosticsExport` (imported, not reimplemented)
 * against the LIVE Supabase project, then reads the artifact back over the
 * public object URL and compares bytes. Also sweeps availability and proves the
 * RLS surface empirically (anon may not delete, may not overwrite an archive).
 *
 * A passing unit test is necessary but is not the proof — this is the proof.
 *
 * Usage: bun run scripts/probeItem9ExportPath.ts
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import {
  publishDiagnosticsExport,
  publicObjectUrl,
  DIAGNOSTICS_BUCKET,
  DIAGNOSTICS_LATEST_OBJECT,
} from '../services/diagnosticsExportStore';

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

function sha256(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label} — ${detail}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label} — ${detail}`);
  }
}

/** A realistic export payload: multi-KB, unicode, CRLF-free, trailing newline. */
function buildProbePayload(tag: string): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════',
    `  ITEM 9 PROBE EXPORT — ${tag}`,
    '═══════════════════════════════════════════════════════════════════',
    '',
    'SECTION 1 — canonical: n=369 WR=63.1% PF=1.16 EV=+0.0605R',
    'unicode probe: ✅ ⚠ → ± $4,036.90 «tp1» 🟢🔴',
    'tab\tseparated\tvalues',
    'trailing spaces preserved   ',
  ];
  for (let i = 0; i < 400; i += 1) {
    lines.push(`signal=${i.toString(36).padStart(6, '0')} adx=${(9 + (i % 30)).toFixed(1)} regime=RANGING(0.78) atr=1.2`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ITEM 9 — LIVE PROBE: DIAGNOSTICS EXPORT VIA SUPABASE STORAGE');
  console.log(`  project: ${URL_}`);
  console.log(`  bucket:  ${DIAGNOSTICS_BUCKET}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── 1. OLD PATH: is the Rork backend actually flapping right now? ──────────
  const apiOrigin = (process.env.EXPO_PUBLIC_RORK_API_BASE_URL ?? '').replace(/\/$/, '');
  console.log(`── 1. OLD PATH sweep (Rork backend) — ${apiOrigin}/api/export/latest ──`);
  const oldStatuses: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    try {
      const r = await fetch(`${apiOrigin}/api/export/latest`, { method: 'GET' });
      oldStatuses.push(r.status);
    } catch {
      oldStatuses.push(0);
    }
  }
  console.log(`  statuses: ${oldStatuses.join(' ')}`);
  const oldOk = oldStatuses.filter((s) => s === 200 || s === 404).length;
  console.log(`  reachable(200|404): ${oldOk}/10   5xx/0: ${10 - oldOk}/10\n`);

  // ── 2. NEW PATH: publish through the REAL function ─────────────────────────
  console.log('── 2. NEW PATH: publishDiagnosticsExport (REAL function, anon key) ──');
  const payload = buildProbePayload(`run-${Date.now()}`);
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadHash = sha256(payloadBytes);
  console.log(`  payload: ${payloadBytes.byteLength} bytes  sha256=${payloadHash.slice(0, 16)}…`);

  const t0 = Date.now();
  const published = await publishDiagnosticsExport(payload);
  const publishMs = Date.now() - t0;
  console.log(`  published in ${publishMs}ms`);
  console.log(`  archive: ${published.url}`);
  console.log(`  latest:  ${published.latestUrl}`);
  assert('archive object written', published.archivePath.startsWith('exports/'), published.archivePath);
  assert('latest.txt pointer updated', published.latestPointerUpdated, `latestPointerUpdated=${published.latestPointerUpdated}`);
  assert('byteLength reported', published.byteLength === payloadBytes.byteLength, `${published.byteLength} === ${payloadBytes.byteLength}`);

  // ── 3. BYTE-IDENTICAL READ-BACK (Item 9d) ─────────────────────────────────
  console.log('\n── 3. BYTE-IDENTICAL read-back over the public URL (Item 9d) ──');
  for (const [label, url] of [['archive', published.url], ['latest.txt', published.latestUrl]] as const) {
    const res = await fetch(url, { cache: 'no-store' });
    const buf = new Uint8Array(await res.arrayBuffer());
    const hash = sha256(buf);
    const text = new TextDecoder().decode(buf);
    console.log(`  ${label}: HTTP ${res.status}  content-type="${res.headers.get('content-type')}"  ${buf.byteLength} bytes  sha256=${hash.slice(0, 16)}…`);
    assert(`${label} HTTP 200`, res.status === 200, `status ${res.status}`);
    assert(`${label} sha256 identical`, hash === payloadHash, `${hash.slice(0, 16)}… vs ${payloadHash.slice(0, 16)}…`);
    assert(`${label} string identical`, text === payload, `length ${text.length} vs ${payload.length}`);
    assert(`${label} content-type text/plain`, (res.headers.get('content-type') ?? '').includes('text/plain'), res.headers.get('content-type') ?? 'null');
  }

  // ── 4. AVAILABILITY SWEEP of the new path ─────────────────────────────────
  console.log('\n── 4. AVAILABILITY sweep: 12 reads of the archive URL ──');
  const newStatuses: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    try {
      const r = await fetch(published.url, { cache: 'no-store' });
      newStatuses.push(r.status);
      await r.arrayBuffer();
    } catch {
      newStatuses.push(0);
    }
  }
  console.log(`  statuses: ${newStatuses.join(' ')}`);
  assert('12/12 reads HTTP 200', newStatuses.every((s) => s === 200), `${newStatuses.filter((s) => s === 200).length}/12`);

  // ── 5. STALENESS: a second export must not change the first URL ───────────
  console.log('\n── 5. STALENESS: publish a SECOND export, re-read the FIRST URL ──');
  const payload2 = buildProbePayload(`second-${Date.now()}`);
  const published2 = await publishDiagnosticsExport(payload2);
  const reread = await fetch(published.url, { cache: 'no-store' });
  const rereadText = await reread.text();
  assert('first archive URL unchanged by a later export', rereadText === payload, `sha256=${sha256(rereadText).slice(0, 16)}… (expected ${payloadHash.slice(0, 16)}…)`);
  const latestAfter = await fetch(`${published2.latestUrl}?t=${Date.now()}`, { cache: 'no-store' });
  const latestText = await latestAfter.text();
  assert('latest.txt now serves the SECOND export', latestText === payload2, `matches second payload = ${latestText === payload2}`);

  // ── 6. RLS SURFACE, empirically ───────────────────────────────────────────
  console.log('\n── 6. RLS surface (anon), measured not asserted ──');
  const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });

  const del = await anon.storage.from(DIAGNOSTICS_BUCKET).remove([published.archivePath]);
  const delBlocked = (del.data ?? []).length === 0;
  console.log(`  anon DELETE archive -> removed ${(del.data ?? []).length} object(s), error=${del.error?.message ?? 'none'}`);
  const stillThere = await fetch(published.url, { cache: 'no-store' });
  assert('anon DELETE blocked', delBlocked && stillThere.status === 200, `removed=${(del.data ?? []).length}, object still HTTP ${stillThere.status}`);

  const overwrite = await anon.storage
    .from(DIAGNOSTICS_BUCKET)
    .upload(published.archivePath, new TextEncoder().encode('TAMPERED'), {
      contentType: 'text/plain',
      upsert: true,
    });
  const afterTamper = await fetch(published.url, { cache: 'no-store' });
  const afterTamperText = await afterTamper.text();
  console.log(`  anon UPSERT over archive -> error=${overwrite.error?.message ?? 'none'}`);
  assert('anon cannot overwrite an ARCHIVE object', afterTamperText === payload, `content preserved = ${afterTamperText === payload}`);

  const latestOverwrite = await anon.storage
    .from(DIAGNOSTICS_BUCKET)
    .upload(DIAGNOSTICS_LATEST_OBJECT, new TextEncoder().encode(payload2), {
      contentType: 'text/plain',
      upsert: true,
    });
  assert('anon CAN overwrite latest.txt (required for the pointer)', latestOverwrite.error === null, latestOverwrite.error?.message ?? 'no error');

  // ── 7. SERVICE-KEY RECONCILIATION ─────────────────────────────────────────
  console.log('\n── 7. Service-key reconciliation of bucket contents ──');
  const svc = createClient(URL_, SVC, { auth: { autoRefreshToken: false, persistSession: false } });
  const listed = await svc.storage.from(DIAGNOSTICS_BUCKET).list('exports', { limit: 100, sortBy: { column: 'name', order: 'desc' } });
  console.log(`  exports/ objects (service key): ${(listed.data ?? []).length}`);
  for (const o of (listed.data ?? []).slice(0, 5)) {
    console.log(`    ${o.name}  ${(o.metadata as { size?: number } | null)?.size ?? '?'} bytes  ${o.created_at ?? ''}`);
  }
  const names = (listed.data ?? []).map((o) => `exports/${o.name}`);
  assert('both probe archives present via service key', names.includes(published.archivePath) && names.includes(published2.archivePath), `${published.archivePath}, ${published2.archivePath}`);

  const rootListed = await svc.storage.from(DIAGNOSTICS_BUCKET).list('', { limit: 100 });
  console.log(`  bucket root objects: ${(rootListed.data ?? []).map((o) => o.name).join(', ')}`);

  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(`  RESULT: ${pass} PASS / ${fail} FAIL`);
  console.log(`  publicObjectUrl(latest) = ${publicObjectUrl(DIAGNOSTICS_LATEST_OBJECT)}`);
  console.log('═══════════════════════════════════════════════════════════════════');
  if (fail > 0) process.exitCode = 1;
}

void main();
