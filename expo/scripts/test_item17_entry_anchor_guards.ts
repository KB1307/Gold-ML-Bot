/**
 * ITEM 17b / 17c — guard tests.
 *
 * STRUCTURAL ONLY, and that limitation is stated rather than papered over.
 * `services/signalEngine.ts` transitively imports react-native, which cannot be
 * loaded in a bare Node/Bun process, so the guards CANNOT be driven in-process
 * here. Every assertion below therefore reads the SHIPPED SOURCE with comments
 * stripped first, so a commented-out or deleted guard fails the test.
 *
 * What this test does NOT establish (rule 3 — no proxy for the real claim):
 *   - that a live stale anchor was actually rejected in production;
 *   - that the 60s cap never fires on a healthy feed.
 * Both are FORWARD evidence, readable from the [EntryAnchorStale] /
 * [GeometryUnwinnable] tags and the gate counters. A passing run here is
 * necessary but never sufficient.
 */
import { readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail: string): void {
  if (cond) { passed++; console.log(`  PASS  ${name}  ${detail}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SRC = stripComments(readFileSync(new URL('../services/signalEngine.ts', import.meta.url), 'utf8'));

console.log('\nITEM 17b/17c — ENTRY-ANCHOR FRESHNESS + GEOMETRY SANITY GUARDS\n');

console.log('STRUCTURAL (shipped source, comments stripped):');

ok('the gate-stats getter reports numerators AND denominators, and age as null-not-zero',
  /getEntryAnchorGateStats\(\)/.test(SRC)
  && /anchorChecks: this\.entryAnchorChecks/.test(SRC)
  && /anchorStaleRejections: this\.entryAnchorStaleRejections/.test(SRC)
  && /geometryChecks: this\.geometrySanityChecks/.test(SRC)
  && /anchorAgeMsNow: lastRealPriceObservedAt > 0 \? Date\.now\(\) - lastRealPriceObservedAt : null/.test(SRC),
  'both counts per gate; unobserved age is null, never 0');

ok('a tick rejected as invalid cannot refresh the observation instant',
  /pushExternalPrice: Invalid price[\s\S]{0,120}?return;/.test(SRC)
  && /setExternalPrice: Invalid price[\s\S]{0,120}?return;/.test(SRC),
  'both public tick entry points return before any assignment');

ok('lastRealPriceObservedAt exists and is distinct from lastFetchTime',
  /let lastRealPriceObservedAt: number/.test(SRC) && /let lastFetchTime: number/.test(SRC),
  'both module vars present');

ok('markPriceSuccess (real fetch) sets the observation instant',
  /function markPriceSuccess[\s\S]{0,400}?lastRealPriceObservedAt = now/.test(SRC),
  'assignment found inside markPriceSuccess');

const cacheReplayBlocks = SRC.match(/lastPriceSource = `🟡 cache[\s\S]{0,200}?return \{ price: cachedGoldPrice/g) ?? [];
const staleReplayBlocks = SRC.match(/lastPriceSource = `🟠 stale[\s\S]{0,200}?return \{ price: cachedGoldPrice/g) ?? [];
const replayTouchesObserved = [...cacheReplayBlocks, ...staleReplayBlocks].some(b => b.includes('lastRealPriceObservedAt'));
ok('cache/stale REPLAY paths do NOT refresh the observation instant',
  cacheReplayBlocks.length > 0 && staleReplayBlocks.length > 0 && !replayTouchesObserved,
  `cache-replay blocks=${cacheReplayBlocks.length} stale-replay blocks=${staleReplayBlocks.length}, none assign lastRealPriceObservedAt`);

ok('ENTRY_ANCHOR_MAX_AGE_MS is not tighter than the existing fresh window',
  /const ENTRY_ANCHOR_MAX_AGE_MS = 60 \* 1000/.test(SRC) && /const EXTERNAL_PRICE_MAX_AGE_MS = 15000/.test(SRC),
  '60s cap vs the pre-registered 15s fresh window');

const anchorGuardIdx = SRC.indexOf('this.entryAnchorChecks += 1');
const featureBuildIdx = SRC.indexOf('const features = await this.calculateMarketFeatures();', anchorGuardIdx > 0 ? anchorGuardIdx : 0);
ok('anchor guard runs BEFORE the feature build (no wasted scoring on a dead anchor)',
  anchorGuardIdx > 0 && featureBuildIdx > anchorGuardIdx,
  `guard@${anchorGuardIdx} < features@${featureBuildIdx}`);

ok('anchor guard rejects on EITHER age OR a replayed source tag',
  /anchorAgeMs > ENTRY_ANCHOR_MAX_AGE_MS \|\| anchorIsReplayed/.test(SRC),
  'both conditions present');

const anchorBlock = SRC.slice(SRC.indexOf('this.entryAnchorChecks += 1'), SRC.indexOf('const features = await this.calculateMarketFeatures();', SRC.indexOf('this.entryAnchorChecks += 1')));
ok('anchor breach emits NOTHING (no bar close, no second venue substituted)',
  /return null;/.test(anchorBlock)
  && !/(barClose|barCloseHistory|gold_m1_bars|GC=F|twelvedata|yahoo|swissquote)/i.test(anchorBlock),
  `block=${anchorBlock.length} chars, returns null, references no fallback price source`);

ok('geometry gate is UNCONDITIONAL (not behind any settings flag)',
  /this\.geometrySanityChecks \+= 1;\s*const emissionPrice = this\.currentPrice;/.test(SRC),
  'no settings guard between the counter and the check');

ok('geometry gate rejects BUY at/above TP1 and SELL at/below TP1',
  /emissionPrice >= tp1[\s\S]{0,60}?emissionPrice <= tp1/.test(SRC),
  'both directions covered with inclusive comparison');

const geomIdx = SRC.indexOf('this.geometrySanityChecks += 1');
const returnIdx = SRC.indexOf('id: `signal_${Date.now()}', geomIdx > 0 ? geomIdx : 0);
ok('geometry gate runs BEFORE the signal object is constructed',
  geomIdx > 0 && returnIdx > geomIdx,
  `gate@${geomIdx} < signal-literal@${returnIdx}`);

ok('both rejections carry a distinct greppable reason tag',
  SRC.includes('[EntryAnchorStale]') && SRC.includes('[GeometryUnwinnable]'),
  'tags present');

console.log(`\nRESULT: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
