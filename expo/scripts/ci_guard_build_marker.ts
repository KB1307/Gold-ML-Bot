#!/usr/bin/env bun
/**
 * ci_guard_build_marker.ts — mechanical prevention of the build-marker chain
 * being silently broken again.
 *
 * History (2026-08-21, all git-proven): the rork-build-marker babel plugin
 * was accidentally deleted from babel.config.js TWICE in one day — b1c7ca8
 * (14:48Z; restored by 58a08f1 at 15:00Z) and af7da4a (17:44Z; undetected
 * until the 21:21Z export printed literal __BUILD_SHA__ alongside that same
 * commit's runtime probe keys). Nothing validated babel.config.js, so both
 * deletions shipped silently. This guard fails the round if ANY layer of the
 * marker chain disappears:
 *
 *   1. babel.config.js defines rorkBuildMarkerPlugin, registers it in the
 *      plugins array, and SCOPES replacement to the buildMarker module only.
 *      (An unscoped visitor rewrites the failure detector's own comparison
 *      strings in diagnosticsExport.ts — the self-defusing-detector bug that
 *      let the 21:21Z export show a literal placeholder with NO warning.)
 *   2. constants/buildMarker.ts still exports both placeholder literals.
 *   3. services/diagnosticsExport.ts detects substitution via sentinels built
 *      by RUNTIME CONCATENATION, with no direct comparison against a bare
 *      placeholder StringLiteral.
 *
 * Built-in regression self-test: every check must FAIL on mutated fixtures
 * before the real files are checked.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Check 1 — the babel plugin exists, is registered, and is scoped. */
export function checkBabelConfig(src: string): string[] {
  const errors: string[] = [];
  if (!src.includes("rorkBuildMarkerPlugin")) {
    errors.push(
      "babel.config.js: rorkBuildMarkerPlugin is gone — the plugin was removed again (cf. b1c7ca8, af7da4a on 2026-08-21).",
    );
  }
  if (!/plugins\s*:\s*\[[^\]]*rorkBuildMarkerPlugin[^\]]*\]/.test(src)) {
    errors.push(
      "babel.config.js: rorkBuildMarkerPlugin is not REGISTERED in the plugins array — a defined-but-unregistered plugin substitutes nothing.",
    );
  }
  if (!src.includes('file.includes("buildMarker")')) {
    errors.push(
      "babel.config.js: plugin is not SCOPED to the buildMarker module — an unscoped visitor rewrites the failure detector's own comparison literals in diagnosticsExport.ts (self-defusing detector).",
    );
  }
  return errors;
}

/** Check 2 — both placeholders still exist for the plugin to substitute. */
export function checkBuildMarker(src: string): string[] {
  const errors: string[] = [];
  if (!src.includes("'__BUILD_SHA__'")) {
    errors.push("constants/buildMarker.ts: the BUILD_SHA placeholder literal is missing.");
  }
  if (!src.includes("'__BUILD_STAMP__'")) {
    errors.push("constants/buildMarker.ts: the BUILD_MARKED_AT placeholder literal is missing.");
  }
  return errors;
}

/** Check 3 — the detector uses runtime-concatenated sentinels, never bare literals. */
export function checkDetector(src: string): string[] {
  const errors: string[] = [];
  const hasShaSentinel =
    src.includes('"__BUILD_" + "SHA__"') || src.includes("'__BUILD_' + 'SHA__'");
  const hasStampSentinel =
    src.includes('"__BUILD_" + "STAMP__"') || src.includes("'__BUILD_' + 'STAMP__'");
  if (!hasShaSentinel) {
    errors.push(
      "diagnosticsExport.ts: PLACEHOLDER_SHA is not built by concatenation — a bare placeholder StringLiteral can be rewritten by an unscoped plugin, defusing the detector.",
    );
  }
  if (!hasStampSentinel) {
    errors.push("diagnosticsExport.ts: PLACEHOLDER_STAMP is not built by concatenation.");
  }
  if (/p\.buildSha\s*(?:!==|===)\s*"__BUILD_SHA__"/.test(src)) {
    errors.push(
      "diagnosticsExport.ts: direct comparison against the placeholder literal — rewrite it against the concatenated sentinel.",
    );
  }
  return errors;
}

/**
 * Regression self-test: each check must FAIL on a mutated fixture that
 * reproduces one of the historical breakages. Returns self-test failures
 * (empty means the guard itself is working).
 */
export function selfTest(): string[] {
  const failures: string[] = [];

  const configNoPlugin =
    'module.exports = function (api) { api.cache(true); return { presets: [["babel-preset-expo", {}]] }; };';
  const errNoPlugin = checkBabelConfig(configNoPlugin);
  if (errNoPlugin.length !== 3) {
    failures.push(`self-test: config without plugin should yield 3 errors, got ${errNoPlugin.length}`);
  }

  const configUnregistered =
    "function rorkBuildMarkerPlugin() {\n" +
    '  return { name: "rork-build-marker", visitor: { StringLiteral(path, state) {\n' +
    '    const file = (state && state.file && state.file.opts && state.file.opts.filename) || "";\n' +
    '    if (!file.includes("buildMarker")) return;\n' +
    "  } } };\n" +
    "}\n" +
    "module.exports = function (api) { api.cache(true); return { presets: [], plugins: [] }; };";
  const errUnregistered = checkBabelConfig(configUnregistered);
  if (errUnregistered.length !== 1 || !errUnregistered[0].includes("not REGISTERED")) {
    failures.push("self-test: defined-but-unregistered plugin should yield exactly the registration error");
  }

  const configUnscoped =
    "function rorkBuildMarkerPlugin() {\n" +
    '  return { name: "rork-build-marker", visitor: { StringLiteral(path) {\n' +
    '    if (path.node.value === "__BUILD_SHA__") { path.node.value = "x"; }\n' +
    "  } } };\n" +
    "}\n" +
    "module.exports = function (api) { api.cache(true); return { presets: [], plugins: [rorkBuildMarkerPlugin] }; };";
  const errUnscoped = checkBabelConfig(configUnscoped);
  if (errUnscoped.length !== 1 || !errUnscoped[0].includes("not SCOPED")) {
    failures.push("self-test: unscoped plugin should yield exactly the scoping error");
  }

  const markerNoPlaceholders = "export const BUILD_SHA = 'x';\nexport const BUILD_MARKED_AT = 'y';\n";
  if (checkBuildMarker(markerNoPlaceholders).length !== 2) {
    failures.push("self-test: buildMarker without placeholders should yield 2 errors");
  }

  const detectorBareLiteral =
    'const markerSubstituted = p.buildSha !== "__BUILD_SHA__" && p.markedAt !== "__BUILD_STAMP__";\n';
  const errBare = checkDetector(detectorBareLiteral);
  if (errBare.length !== 3) {
    failures.push(`self-test: bare-literal detector should yield 3 errors, got ${errBare.length}`);
  }

  return failures;
}

function main(): number {
  console.log("ci_guard_build_marker — build-marker chain integrity check\n");

  const selfFailures = selfTest();
  for (const f of selfFailures) console.log(`  ✗ ${f}`);
  if (selfFailures.length > 0) {
    console.log("\n✗ ci_guard_build_marker FAILED — the guard's own regression self-test is broken.");
    return 1;
  }
  console.log("  self-test: all mutated fixtures correctly rejected (5/5)\n");

  const errors: string[] = [
    ...checkBabelConfig(read("babel.config.js")),
    ...checkBuildMarker(read("constants/buildMarker.ts")),
    ...checkDetector(read("services/diagnosticsExport.ts")),
  ];

  if (errors.length > 0) {
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log("\n✗ ci_guard_build_marker FAILED — the build-marker chain is broken. Do not ship.");
    return 1;
  }

  console.log("  babel.config.js        : plugin defined, registered, scoped to buildMarker");
  console.log("  constants/buildMarker  : both placeholder literals present");
  console.log("  diagnosticsExport      : sentinel detector present, no bare-literal comparison");
  console.log("\n✅ ci_guard_build_marker PASSED — plugin, placeholders, and sentinel detector intact.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
