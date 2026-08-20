/**
 * ITEM 168(a) — build-marker derivation probe. Transforms
 * constants/buildMarker.ts through the PROJECT babel config (the same plugin
 * Metro runs) and prints the injected BUILD_SHA / BUILD_STAMP. Run before and
 * after a commit to demonstrate the marker changing with the tree.
 */
import { transformFileSync } from '@babel/core';

const out = transformFileSync('constants/buildMarker.ts', { configFile: './babel.config.js' });
if (!out) throw new Error('transform failed');
const code = out.code ?? '';
const sha = code.match(/BUILD_SHA\s*=\s*["']([^"']*)["']/);
const stamp = code.match(/BUILD_MARKED_AT\s*=\s*["']([^"']*)["']/);
console.log(`injected BUILD_SHA     = ${sha ? sha[1] : 'NOT FOUND'}`);
console.log(`injected BUILD_STAMP   = ${stamp ? stamp[1] : 'NOT FOUND'}`);
console.log(`git rev-parse --short HEAD = ${require('child_process').execSync('git rev-parse --short HEAD').toString().trim()}`);
if (!sha || sha[1] === '__BUILD_SHA__') {
  console.error('FAIL: placeholder was not replaced — injection not running');
  process.exit(1);
}
