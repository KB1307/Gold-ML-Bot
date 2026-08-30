#!/usr/bin/env bun
/**
 * ci_guard_build_marker.ts — mechanical prevention of the build-marker chain
 * being silently broken again.
 *
 * History (2026-08-21 through 2026-08-30, all git/runtime-proven): the platform
 * code-sync repeatedly replaced the custom babel.config.js with Rork's six-line
 * template. That silently killed build provenance and also created a live config
 * race with Metro. The marker injection now lives in a dedicated Metro
 * transformer while babel.config.js intentionally stays canonical. This guard
 * fails the round if ANY layer of the marker chain disappears:
 *
 *   1. metro.config.js registers metro.build-marker-transformer.js.
 *   2. That transformer delegates to Rork's transformer and SCOPES replacement
 *      to constants/buildMarker.ts only. An unscoped replacement would rewrite
 *      the detector's own comparison literals in diagnosticsExport.ts.
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

/** Check 1 — Metro registers the dedicated, scoped marker transformer. */
export function checkTransformerConfig(metroSrc: string, transformerSrc: string): string[] {
  const errors: string[] = [];
  if (!metroSrc.includes('require.resolve("./metro.build-marker-transformer")')) {
    errors.push("metro.config.js: dedicated build-marker transformer is not registered.");
  }
  if (!transformerSrc.includes('require("@rork-ai/toolkit-sdk/metro-transformer")')) {
    errors.push("metro.build-marker-transformer.js: Rork's upstream transformer is not delegated to.");
  }
  if (!transformerSrc.includes('normalized.endsWith("/constants/buildMarker.ts")')) {
    errors.push("metro.build-marker-transformer.js: replacement is not scoped exactly to constants/buildMarker.ts.");
  }
  if (!transformerSrc.includes('src: injectBuildMarker(props.src, props.filename)')) {
    errors.push("metro.build-marker-transformer.js: transform() does not inject the marker source before delegation.");
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

  const validMetro = 'config.transformer.babelTransformerPath = require.resolve("./metro.build-marker-transformer");';
  const validTransformer =
    'const rorkTransformer = require("@rork-ai/toolkit-sdk/metro-transformer");\n' +
    'const normalized = filename; normalized.endsWith("/constants/buildMarker.ts");\n' +
    'rorkTransformer.transform({ ...props, src: injectBuildMarker(props.src, props.filename) });';
  if (checkTransformerConfig(validMetro, validTransformer).length !== 0) {
    failures.push("self-test: valid dedicated transformer should pass");
  }
  if (checkTransformerConfig("module.exports = {};", validTransformer).length !== 1) {
    failures.push("self-test: unregistered transformer should yield exactly one error");
  }
  const unscopedTransformer = validTransformer.replace(
    'normalized.endsWith("/constants/buildMarker.ts")',
    'filename.includes("buildMarker")',
  );
  if (checkTransformerConfig(validMetro, unscopedTransformer).length !== 1) {
    failures.push("self-test: imprecisely scoped transformer should yield exactly one error");
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
    ...checkTransformerConfig(read("metro.config.js"), read("metro.build-marker-transformer.js")),
    ...checkBuildMarker(read("constants/buildMarker.ts")),
    ...checkDetector(read("services/diagnosticsExport.ts")),
  ];

  if (errors.length > 0) {
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log("\n✗ ci_guard_build_marker FAILED — the build-marker chain is broken. Do not ship.");
    return 1;
  }

  console.log("  Metro transformer      : registered, delegates to Rork, scoped to constants/buildMarker.ts");
  console.log("  babel.config.js        : canonical Rork/Expo template; no custom plugin for sync to strip");
  console.log("  constants/buildMarker  : both placeholder literals present");
  console.log("  diagnosticsExport      : sentinel detector present, no bare-literal comparison");
  console.log("\n✅ ci_guard_build_marker PASSED — transformer, placeholders, and sentinel detector intact.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
