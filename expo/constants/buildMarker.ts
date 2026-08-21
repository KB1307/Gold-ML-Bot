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

// MARKER_CACHE_BUSTER_V2 (2026-08-21T21:30Z): this comment intentionally
// changes the file's content hash. Metro's transform cache keys on file
// content, so a cached PRE-PLUGIN transform of this module (with the literal
// placeholders) survives dev-server restarts and is still served NEXT TO
// freshly-transformed modules — proven by the 2026-08-21T21:21Z export, which
// carried af7da4a-era runtime probe keys while still printing literal
// placeholders. Changing this file's content forces every cache — dev and CI
// alike — to re-transform it through the babel.config.js rork-build-marker
// plugin on the next build.

/** Git SHA of the tree this bundle was built from (babel-injected at build). */
export const BUILD_SHA = '__BUILD_SHA__';

/** ISO timestamp of the build (babel-injected at build). */
export const BUILD_MARKED_AT = '__BUILD_STAMP__';
