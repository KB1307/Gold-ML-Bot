const { execFileSync } = require("node:child_process");
const path = require("node:path");

const rorkTransformer = require("@rork-ai/toolkit-sdk/metro-transformer");

let buildSha;
let buildStamp;

function getBuildSha() {
  if (buildSha !== undefined) {
    return buildSha;
  }

  try {
    buildSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
    }).trim();
  } catch {
    buildSha = "SHA_UNAVAILABLE";
  }

  return buildSha;
}

function getBuildStamp() {
  if (buildStamp === undefined) {
    buildStamp = new Date().toISOString();
  }
  return buildStamp;
}

function isBuildMarkerModule(filename) {
  const normalized = path.normalize(filename).replaceAll("\\", "/");
  return normalized === "constants/buildMarker.ts" || normalized.endsWith("/constants/buildMarker.ts");
}

function injectBuildMarker(source, filename) {
  if (!isBuildMarkerModule(filename)) {
    return source;
  }

  return source
    .replaceAll("'__BUILD_SHA__'", JSON.stringify(getBuildSha()))
    .replaceAll('"__BUILD_SHA__"', JSON.stringify(getBuildSha()))
    .replaceAll("'__BUILD_STAMP__'", JSON.stringify(getBuildStamp()))
    .replaceAll('"__BUILD_STAMP__"', JSON.stringify(getBuildStamp()));
}

async function transform(props) {
  return rorkTransformer.transform({
    ...props,
    src: injectBuildMarker(props.src, props.filename),
  });
}

module.exports = {
  getBuildSha,
  getBuildStamp,
  injectBuildMarker,
  isBuildMarkerModule,
  transform,
};
