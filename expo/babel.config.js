const { execSync } = require("child_process");

/**
 * ITEM 201(a) v2 — BUILD MARKER SUBSTITUTION, SCOPED AND GUARDED.
 *
 * Git-proven history of this plugin on 2026-08-21:
 *   ec79a20 13:44Z — added (Item 184a).
 *   b1c7ca8 14:48Z — accidentally removed.
 *   58a08f1 15:00Z — restored, re-proven on a fresh `expo start -c` transform.
 *   af7da4a 17:44Z — accidentally removed AGAIN (the deletion rode along in
 *     the items 191-196 commit via the platform sync). This — not Metro cache
 *     staleness — is why the 21:21Z export printed literal __BUILD_SHA__
 *     while carrying that same commit's runtime probe keys.
 *   1aacb36 21:29Z — still absent (the "cache buster" edited file content,
 *     the wrong layer, while the config itself had no plugin at all).
 *
 * Two defects of the original plugin are fixed here:
 *   1. SELF-DEFUSING DETECTOR. The original visitor replaced the placeholder
 *      literals in EVERY module — including the failure detector's own
 *      comparison strings in diagnosticsExport.ts. Any plugin-era transform
 *      of that file compiled its check to `p.buildSha === "<sha>"`, unable to
 *      ever match a literal placeholder (and a fully-substituted build would
 *      FALSELY report FAILED when both sides substitute to the same SHA).
 *      The visitor now scopes replacement to constants/buildMarker.ts only,
 *      and the detector builds its sentinels by runtime concatenation.
 *   2. NO MECHANICAL CHECK. Two accidental removals shipped silently because
 *      nothing validated babel.config.js. expo/scripts/ci_guard_build_marker.ts
 *      now fails the round if this plugin, its registration, its scoping, the
 *      placeholders, or the sentinel detector disappear.
 */
function rorkBuildMarkerPlugin() {
  let sha = "GIT_SHA_UNAVAILABLE";
  try {
    const out = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (out) sha = out;
  } catch {
    // keep the loud fallback marker — the runtime warning in the export
    // surfaces it rather than hiding it.
  }
  const stamp = new Date().toISOString();
  return {
    name: "rork-build-marker",
    visitor: {
      StringLiteral(path, state) {
        // SCOPE: only the buildMarker module's placeholder exports are
        // rewritten. Every other module — especially the failure detector in
        // diagnosticsExport.ts — keeps its literals untouched.
        const file = (state && state.file && state.file.opts && state.file.opts.filename) || "";
        if (!file.includes("buildMarker")) return;
        if (path.node.value === "__BUILD_SHA__") {
          path.node.value = sha;
        } else if (path.node.value === "__BUILD_STAMP__") {
          path.node.value = stamp;
        }
      },
    },
  };
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: [rorkBuildMarkerPlugin],
  };
};
