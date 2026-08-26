// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ GUARD COMMENT — THIS FILE CONTAINS THE BUILD-MARKER PLUGIN. DO NOT STRIP.
// ═══════════════════════════════════════════════════════════════════════════
// rorkBuildMarkerPlugin has been removed from this file THREE times before
// (b1c7ca8 and af7da4a on 2026-08-21 were two of them), each time silently
// killing build-provenance substitution: every export then prints the literal
// __BUILD_SHA__ / __BUILD_STAMP__ and NO export can be attributed to a git
// tree — which invalidates every line-level claim every report depends on.
//
// This is NOT decorative config. Removing this plugin is treated by
// scripts/ci_guard_build_marker.ts as shipping a broken build-marker chain.
// See expo/scripts/item184a_babel_marker_proof.cjs for the mechanical proof
// that substitution works through THIS exact transform.
//
// Restored for ITEM 231 / CHECKPOINT H (third restoration). If you are removing
// this because it "looks unused": it runs inside Metro's Babel pipeline; it will
// never show up in app code. Run the CI guard instead of trusting that feeling.
// NOTE: this file must stay PLAIN JavaScript — node loads it directly during
// transform bootstrap, so no TypeScript annotations are allowed here.
// ═══════════════════════════════════════════════════════════════════════════

/** Cached once per Metro process so we don't shell out per-file. */
let _buildSha = null;

function getBuildSha() {
  if (_buildSha === null) {
    try {
      _buildSha = require("child_process")
        .execSync("git rev-parse --short HEAD", { cwd: __dirname })
        .toString()
        .trim();
    } catch (e) {
      // No git available in the transform environment — make it LOUD, never fake it.
      _buildSha = "SHA_UNAVAILABLE";
    }
  }
  return _buildSha;
}

/**
 * ITEM 168(a)/ITEM 231 — substitutes the placeholder literals in
 * constants/buildMarker.ts at TRANSFORM time with the real git SHA and a fresh
 * ISO stamp.
 *
 * SCOPING IS LOAD-BEARING: the visitor rewrites ONLY files whose path includes
 * "buildMarker". An unscoped rewriter would also rewrite the failure detector's
 * own comparison literals inside diagnosticsExport.ts — the self-defusing-
 * detector bug that let one earlier export print a literal placeholder with NO
 * warning at all. ci_guard_build_marker.ts enforces this scoping mechanically.
 */
const rorkBuildMarkerPlugin = {
  name: "rork-build-marker",
  visitor: {
    StringLiteral(path, state) {
      const file = (state && state.file && state.file.opts && state.file.opts.filename) || "";
      if (!file.includes("buildMarker")) return;
      if (path.node.value === "__BUILD_SHA__") {
        path.node.value = getBuildSha();
      } else if (path.node.value === "__BUILD_STAMP__") {
        path.node.value = new Date().toISOString();
      }
    },
  },
};

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: [rorkBuildMarkerPlugin],
  };
};
