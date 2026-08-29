/**
 * MECHANICAL TRANSFORM DELTA PROOF (bisect support) — diagnostic only.
 *
 * Transforms constants/buildMarker.ts through the SAME babel pipeline metro
 * uses, three ways:
 *   1. WITH rorkBuildMarkerPlugin (process 1 — "cold")
 *   2. WITH rorkBuildMarkerPlugin (process 2 — "warm", separate process)
 *   3. WITHOUT the plugin
 * and prints a unified diff of the outputs plus byte sizes. Purpose: bound the
 * plugin's effect on transform output — if the delta is confined to the two
 * placeholder literals inside the buildMarker module, the plugin cannot change
 * any other module's output, and cold-vs-warm variation is limited to the
 * timestamp string. Run: bun scripts/bisect_transform_delta.ts
 */
import { transformSync } from "@babel/core";
import { readFileSync } from "fs";
import { join } from "path";

const target = join(__dirname, "..", "constants", "buildMarker.ts");

interface RunResult {
  label: string;
  code: string;
}

function run(withPlugin: boolean, label: string): RunResult {
  // Requiring babel.config.js here mirrors metro's config load; the plugin
  // object is exported from the config file itself.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require(join(__dirname, "..", "babel.config.js"));
  const api = { cache: (): boolean => true };
  const resolved = typeof cfg === "function" ? cfg(api) : cfg;
  const plugins = withPlugin ? resolved.plugins ?? [] : [];
  const out = transformSync(readFileSync(target, "utf8"), {
    filename: target,
    presets: [["babel-preset-expo", { unstable_transformImportMeta: true }]],
    plugins,
    configFile: false,
    babelrc: false,
  });
  return { label, code: out?.code ?? "" };
}

const a = run(true, "plugin-process-1");
const b = run(true, "plugin-process-2");
const c = run(false, "no-plugin");

function diffLines(x: string, y: string): string[] {
  const xl = x.split("\n");
  const yl = y.split("\n");
  const out: string[] = [];
  const max = Math.max(xl.length, yl.length);
  for (let i = 0; i < max; i++) {
    if (xl[i] !== yl[i]) {
      out.push(`- L${i + 1}: ${(xl[i] ?? "<absent>").trim()}`);
      out.push(`+ L${i + 1}: ${(yl[i] ?? "<absent>").trim()}`);
    }
  }
  return out;
}

console.log("=== WITH plugin: process-1 vs process-2 (cold vs warm) ===");
console.log(diffLines(a.code, b.code).join("\n") || "(identical)");
console.log("");
console.log("=== WITH plugin vs WITHOUT plugin ===");
console.log(diffLines(a.code, c.code).join("\n") || "(identical)");
console.log("");
console.log(`sizes: with=${a.code.length} with2=${b.code.length} without=${c.code.length}`);
const onlyLiterals =
  diffLines(a.code, c.code).every((l) =>
    /__BUILD_SHA__|__BUILD_STAMP__|[0-9a-f]{7}|\d{4}-\d{2}-\d{2}T/.test(l),
  ) && diffLines(a.code, c.code).length > 0;
console.log(`DELTA_CONFINED_TO_MARKER_LITERALS: ${onlyLiterals}`);
