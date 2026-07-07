/**
 * In-memory store for the latest "Export Diagnostics" .txt payload generated
 * by the app (Settings > Export Diagnostics). Single-user personal app, so an
 * in-memory store keyed by a fixed identifier ("latest") is sufficient — no
 * database, no auth, no external service. A backend restart clears it, which
 * is an acceptable tradeoff over adding infrastructure for a single-user tool.
 */

interface StoredExport {
  content: string;
  createdAt: number;
}

let latestExport: StoredExport | null = null;

export function saveLatestExport(content: string): StoredExport {
  latestExport = { content, createdAt: Date.now() };
  return latestExport;
}

export function getLatestExport(): StoredExport | null {
  return latestExport;
}
