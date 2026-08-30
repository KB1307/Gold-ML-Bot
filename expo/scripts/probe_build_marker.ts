#!/usr/bin/env bun
/**
 * Build-marker derivation probe. Runs the same dedicated source injection that
 * Metro registers in metro.config.js and prints the injected SHA/stamp.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const transformer = require("../metro.build-marker-transformer.js") as {
  injectBuildMarker(source: string, filename: string): string;
};

const markerPath = join(import.meta.dir, "..", "constants", "buildMarker.ts");
const source = readFileSync(markerPath, "utf8");
const code = transformer.injectBuildMarker(source, markerPath);
const sha = code.match(/BUILD_SHA\s*=\s*["']([^"']*)["']/);
const stamp = code.match(/BUILD_MARKED_AT\s*=\s*["']([^"']*)["']/);
const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: join(import.meta.dir, ".."),
  encoding: "utf8",
}).trim();

console.log(`injected BUILD_SHA          = ${sha?.[1] ?? "NOT FOUND"}`);
console.log(`injected BUILD_STAMP        = ${stamp?.[1] ?? "NOT FOUND"}`);
console.log(`git rev-parse --short HEAD  = ${gitSha}`);

if (!sha || sha[1] === "__BUILD_SHA__" || sha[1] !== gitSha) {
  console.error("FAIL: dedicated Metro marker injection did not produce the current SHA");
  process.exit(1);
}
