const { execSync } = require("child_process");

/**
 * ITEM 184(a) — BUILD MARKER SUBSTITUTION, ACTUALLY WIRED.
 *
 * Item 168a's buildMarker.ts claimed "babel.config.js replaces these
 * placeholders at TRANSFORM time" — but babel.config.js contained ONLY the
 * preset, no plugin. The substitution NEVER ran, which is exactly why the
 * 21 Aug 06:01 export printed literal __BUILD_SHA__/__BUILD_STAMP__. This
 * plugin performs the replacement that was always claimed.
 *
 * Failure is LOUD, not silent: diagnosticsExport flags a surviving placeholder
 * at runtime (Item 184a), so a stale Metro transform cache (the documented
 * caveat in buildMarker.ts) can never masquerade as a stamped build again.
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
      StringLiteral(path) {
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
