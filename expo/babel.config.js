// ITEM 168(a) — BUILD-TIME-DERIVED build marker.
//
// babel.config.js runs in every Metro process, so the git SHA and build
// timestamp are read from the working tree at BUNDLE time and injected into
// constants/buildMarker.ts by replacing the placeholder string literals
// '__BUILD_SHA__' and '__BUILD_STAMP__'. The marker changes when the bundle
// changes, without hand edits. api.cache(false) forces the SHA to be re-read
// at every Metro process start (after `expo start -c` following a commit).
const { execSync } = require("child_process");

let BUILD_SHA = "unknown";
try {
  BUILD_SHA = execSync("git rev-parse --short HEAD", {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  // git unavailable (packaged environment) — "unknown" is honest.
}
const BUILD_STAMP = new Date().toISOString();

module.exports = function (api) {
  api.cache(false);
  return {
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins: [
      function injectBuildMarker() {
        return {
          visitor: {
            StringLiteral(path) {
              if (path.node.value === "__BUILD_SHA__") {
                path.node.value = BUILD_SHA;
              } else if (path.node.value === "__BUILD_STAMP__") {
                path.node.value = BUILD_STAMP;
              }
            },
          },
        };
      },
    ],
  };
};
