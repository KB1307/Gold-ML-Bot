/**
 * In-memory store for the latest "Export Diagnostics" .txt payload generated
 * by the app (Settings > Export Diagnostics). Single-user personal app, so
 * keeping the most recent export keyed by a fixed identifier ("latest") in
 * memory is sufficient — no database, no auth, no external service.
 *
 * NOTE: this backend runs in a Worker-style runtime with no Node `fs`/`path`/
 * `__dirname` and no persistent local disk between requests/restarts — a
 * prior version of this file tried to persist to disk via `fs`, which threw
 * `ReferenceError: __dirname is not defined` on every request and crashed
 * the whole backend in a restart loop. Keep this file Worker-safe (no Node
 * built-ins) — if durable persistence across restarts is needed later, back
 * it with the project's real storage (e.g. Supabase), not local disk.
 */

interface StoredExport {
  content: string;
  createdAt: number;
}

let cachedExport: StoredExport | null = null;

export function saveLatestExport(content: string): StoredExport {
  const stored: StoredExport = { content, createdAt: Date.now() };
  cachedExport = stored;
  return stored;
}

export function getLatestExport(): StoredExport | null {
  return cachedExport;
}
