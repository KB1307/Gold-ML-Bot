/**
 * ITEM FE — persistence shape for the last completed live drift cycle's
 * per-feature snapshot (detectConceptDrift's liveFeatureDrift). The snapshot
 * is what survives an app rebuild: without it, the diagnostics export's
 * LIVE WINDOW DRIFT block stays empty until the next 4h cycle completes —
 * and builds have been more frequent than the cycle, so it never rendered.
 *
 * Pure module: no React Native imports, so headless gates can test the
 * serialize/parse round-trip directly.
 */

export interface FeatureDriftSnapshotEntry {
  feature: string;
  recentMean: number;
  historicalMean: number;
  recentStd: number;
  historicalStd: number;
  meanShift: number;
  stdShift: number;
  drift: number;
  /** ITEM DE — set when the feature is excluded from the gating average. */
  skipped?: boolean;
  skipReason?: string;
}

export interface FeatureDriftSnapshot {
  /** ISO timestamp of the drift cycle that produced this snapshot. */
  cycleAt: string;
  entries: FeatureDriftSnapshotEntry[];
}

export function serializeFeatureDriftSnapshot(snapshot: FeatureDriftSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Defensive read: malformed JSON, wrong types, or entries with missing /
 * non-finite fields can never crash boot. Corrupt entries are dropped;
 * a snapshot with no valid cycleAt is treated as absent (null), leaving the
 * in-memory empty snapshot in place rather than hydrating silent garbage.
 */
export function parseFeatureDriftSnapshot(json: string | null | undefined): FeatureDriftSnapshot | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { cycleAt, entries } = parsed as Record<string, unknown>;
    if (typeof cycleAt !== "string" || Number.isNaN(Date.parse(cycleAt))) return null;
    if (!Array.isArray(entries)) return null;
    const valid: FeatureDriftSnapshotEntry[] = [];
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.feature !== "string") continue;
      const numeric = [e.recentMean, e.historicalMean, e.recentStd, e.historicalStd, e.meanShift, e.stdShift, e.drift];
      if (!numeric.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
      valid.push({
        feature: e.feature,
        recentMean: e.recentMean as number,
        historicalMean: e.historicalMean as number,
        recentStd: e.recentStd as number,
        historicalStd: e.historicalStd as number,
        meanShift: e.meanShift as number,
        stdShift: e.stdShift as number,
        drift: e.drift as number,
        ...(typeof e.skipped === "boolean" ? { skipped: e.skipped } : {}),
        ...(typeof e.skipReason === "string" ? { skipReason: e.skipReason } : {}),
      });
    }
    return { cycleAt, entries: valid };
  } catch {
    return null;
  }
}
