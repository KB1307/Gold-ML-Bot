import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 9 — THE DIAGNOSTICS EXPORT ARTIFACT IS OFF THE RORK BACKEND.
//
// Previously: the export was POSTed to `diagnostics.saveExport` (Rork Hono/tRPC)
// which stored it in a PROCESS-LIFETIME in-memory variable, and pulled back via
// `GET /api/export/latest` on the same backend. That backend flaps 503, so BOTH
// the write and the read of the artifact that every measurement in this project
// depends on rode a path that can silently deny us the evidence base itself.
// The in-memory store also lost the artifact on every backend restart.
//
// Now:  client --(anon key)--> Supabase Storage bucket `diagnostics`
//       reader --(public object URL)--> the exact bytes, text/plain
//
// DATA-SOURCE RULE: no Rork backend anywhere on this path.
//
// DESIGN CHOICE — STORAGE OBJECT, NOT A TABLE ROW.
// A table row would have to be read back through PostgREST, which returns the
// content wrapped in JSON (escaped newlines, quoted string). The artifact is a
// plain-text file that is read by humans and parsed by `forwardMonitor.ts`, so a
// JSON-wrapped read would either not render byte-identically or would need a
// second service to unwrap it. A Storage object serves the exact bytes with
// `Content-Type: text/plain`, which is what the retired backend route did.
//
// STALENESS IS ELIMINATED STRUCTURALLY, not by cache headers. Every export is
// written to an IMMUTABLE timestamped object (`exports/<iso>.txt`) and that is
// the URL handed back to the user, so a CDN cache can never serve a previous
// export under it. `latest.txt` is additionally updated as a stable pointer for
// tooling, and is the only object anon is permitted to overwrite.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

export const DIAGNOSTICS_BUCKET = "diagnostics";
export const DIAGNOSTICS_LATEST_OBJECT = "latest.txt";
const CONTENT_TYPE = "text/plain";

let storageClient: SupabaseClient | null = null;

function getStorageClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  if (!storageClient) {
    storageClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return storageClient;
}

/** Public read URL for a Storage object in the diagnostics bucket. */
export function publicObjectUrl(objectPath: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${DIAGNOSTICS_BUCKET}/${objectPath}`;
}

/** `exports/2026-08-04T18-22-05-123Z.txt` — filesystem/URL-safe, sorts chronologically. */
export function buildArchiveObjectPath(now: number = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return `exports/${stamp}.txt`;
}

export interface PublishDiagnosticsResult {
  /** Immutable URL for THIS export. Never serves a different export. */
  url: string;
  /** Stable pointer URL, overwritten on every export. */
  latestUrl: string;
  archivePath: string;
  /** False when the archive object landed but the `latest.txt` pointer did not. */
  latestPointerUpdated: boolean;
  byteLength: number;
}

function encode(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

/**
 * Publishes the diagnostics export to Supabase Storage via the anon key.
 *
 * Order matters: the IMMUTABLE archive object is written first and its failure
 * is fatal, because that object is the artifact. The `latest.txt` pointer is
 * best-effort — a failed pointer update must not lose an export that already
 * landed, so it is reported rather than thrown.
 */
export async function publishDiagnosticsExport(
  content: string,
  now: number = Date.now(),
): Promise<PublishDiagnosticsResult> {
  const client = getStorageClient();
  if (!client) {
    throw new Error(
      "Supabase URL / anon key are not configured — cannot publish the diagnostics export.",
    );
  }

  const bytes = encode(content);
  const archivePath = buildArchiveObjectPath(now);

  const archiveUpload = await client.storage
    .from(DIAGNOSTICS_BUCKET)
    .upload(archivePath, bytes, {
      contentType: CONTENT_TYPE,
      cacheControl: "0",
      upsert: false,
    });

  if (archiveUpload.error) {
    throw new Error(`Diagnostics export upload failed: ${archiveUpload.error.message}`);
  }

  let latestPointerUpdated = true;
  const latestUpload = await client.storage
    .from(DIAGNOSTICS_BUCKET)
    .upload(DIAGNOSTICS_LATEST_OBJECT, bytes, {
      contentType: CONTENT_TYPE,
      cacheControl: "0",
      upsert: true,
    });

  if (latestUpload.error) {
    latestPointerUpdated = false;
    console.warn(
      `[DiagnosticsExport] Archive object ${archivePath} landed but the latest.txt pointer failed: ${latestUpload.error.message}`,
    );
  }

  return {
    url: publicObjectUrl(archivePath),
    latestUrl: publicObjectUrl(DIAGNOSTICS_LATEST_OBJECT),
    archivePath,
    latestPointerUpdated,
    byteLength: bytes.byteLength,
  };
}
