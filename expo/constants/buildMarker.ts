/**
 * ITEM 74(a) — BUILD PROVENANCE.
 *
 * WHY THIS EXISTS. Repo/production drift is PROVEN on this project: migration
 * 003 carries invalid `CREATE POLICY IF NOT EXISTS` syntax in the repo while the
 * corresponding policy is demonstrably live in the database (Item 70). The repo
 * is therefore NOT evidence of what runs. Every prior "is the fix deployed?"
 * argument on this project was made by grepping the repo, which is exactly the
 * mistake this constant removes.
 *
 * The SHA below is a BUILD-TIME CONSTANT set by hand at commit time, because the
 * Expo runtime has no access to git. It is only trustworthy in one direction: if
 * the export prints it, the bundle was built from a tree at or after that commit.
 * A stale bundle prints an OLDER marker, or — for any bundle predating Item 74 —
 * prints no build-provenance block at all, which is itself the discriminating
 * observation.
 */

/** Git SHA of the tree this bundle was built from. Update on every ship. */
export const BUILD_SHA = '43bf752';

/** ISO date the marker was last set. */
export const BUILD_MARKED_AT = '2026-08-14';

/**
 * Item numbers whose code is expected in this bundle. This list is a CLAIM, not
 * evidence — it is printed next to the runtime symbol probes so the two can be
 * compared. A mismatch between this list and the probes is the finding.
 */
export const BUILD_CLAIMED_ITEMS: readonly string[] = [
  '63 (S/R + QM mutual exclusion)',
  '64 (CONSUMED_MODEL_WEIGHTS 4-feature drift)',
  '66 (direct anon-key outcome push + durable queue)',
  '70 (migration SQL syntax fix)',
  '72 (deterministic replay harness)',
  '74 (build marker + outbound push telemetry)',
];
