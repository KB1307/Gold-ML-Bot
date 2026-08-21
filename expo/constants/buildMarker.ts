/**
 * ITEM 168(a) — BUILD PROVENANCE, DERIVED AT BUILD TIME.
 *
 * The Item 74 marker was a hand-edited constant and sat six days stale
 * ("43bf752, set 2026-08-14") while the running bundle contained Item 109+.
 * These two exports are PLACEHOLDER string literals that babel.config.js
 * replaces at TRANSFORM time with the git SHA of the working tree and the
 * build timestamp. The marker now changes whenever the bundle is rebuilt from
 * a different tree, with nobody remembering to edit anything.
 *
 * Caveat, stated honestly: Metro's transform cache keys on file content, so
 * the first build after a new commit should clear the cache (`expo start -c`)
 * or the previously injected value can be served from cache. The stamped
 * timestamp tells you instantly whether the injection ran fresh.
 *
 * ITEM 168(c): the claimed-items list is DELETED. A stale list of claims is
 * worse than none — it invited exactly the false confidence that cost a day
 * on the zone freeze. The runtime symbol probes + runtime configuration probe
 * in the diagnostics export are the ONLY evidence of what the bundle contains.
 */

// MARKER_CACHE_BUSTER_V3 (2026-08-21T22:05Z): v2 mis-attributed the 21:21Z
// export's literal placeholders to Metro transform-cache staleness. The
// git-proven root cause: the rork-build-marker plugin was absent from
// babel.config.js entirely — removed a second time that day by af7da4a
// (17:44Z) — so no transform could substitute at all. The plugin is now
// restored SCOPED to this module only (it no longer rewrites the failure
// detector's own comparison literals in diagnosticsExport.ts), enforced
// mechanically by expo/scripts/ci_guard_build_marker.ts. This comment still
// changes the file's content hash, forcing any older cached transform of
// this module to be re-created through the restored, scoped plugin.

/** Git SHA of the tree this bundle was built from (babel-injected at build). */
export const BUILD_SHA = '__BUILD_SHA__';

/** ISO timestamp of the build (babel-injected at build). */
export const BUILD_MARKED_AT = '__BUILD_STAMP__';
