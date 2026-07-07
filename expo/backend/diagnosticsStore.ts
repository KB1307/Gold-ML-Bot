/**
 * Persistent store for the latest "Export Diagnostics" .txt payload generated
 * by the app (Settings > Export Diagnostics). Single-user personal app, so a
 * small JSON file on disk keyed by a fixed identifier ("latest") is sufficient —
 * no database, no auth, no external service. An in-memory cache sits in front
 * of the file so repeated GETs don't re-read from disk, but every write is
 * flushed to disk immediately so a backend restart no longer loses the export.
 */

import fs from "fs";
import path from "path";

interface StoredExport {
  content: string;
  createdAt: number;
}

const DATA_DIR = path.join(__dirname, ".data");
const DATA_FILE = path.join(DATA_DIR, "diagnostics-export.json");

let cachedExport: StoredExport | null | undefined = undefined;

function readFromDisk(): StoredExport | null {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as StoredExport;
    if (typeof parsed.content === "string" && typeof parsed.createdAt === "number") {
      return parsed;
    }
    return null;
  } catch (err) {
    return null;
  }
}

export function saveLatestExport(content: string): StoredExport {
  const stored: StoredExport = { content, createdAt: Date.now() };

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(stored), "utf-8");
  } catch (err) {
    console.error("[diagnosticsStore] Failed to persist export to disk:", err);
  }

  cachedExport = stored;
  return stored;
}

export function getLatestExport(): StoredExport | null {
  if (cachedExport === undefined) {
    cachedExport = readFromDisk();
  }
  return cachedExport;
}
