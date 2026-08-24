/**
 * PHASE D / D2 — SETTINGS MIGRATION PROOF (checkpoint requirement).
 *
 * CHECKPOINT D requires: "a test proving a persisted 49/74/98 install migrates
 * to 25/50/80". This script exercises migrateSettingsToV2 against the four
 * cases that matter, with hard assertions (exit 1 on any failure):
 *
 *   1. Untouched pre-Item-121 install (49/74/98 + useDynamicSL true)
 *        → ladder 25/50/80, useDynamicSL false, schemaVersion 2.
 *   2. Customized install (user ladder 30/60/90, useDynamicSL true)
 *        → every user value preserved; only schemaVersion stamped.
 *   3. Already-v2 row → returned UNCHANGED (changed=false).
 *   4. Old ladder + otherwise customized (minConfidence 0.90)
 *        → ladder migrates (it IS the stale default), user values preserved.
 *
 * Run: bunx tsx scripts/verifySettingsMigration.ts   (from expo/)
 */
import { migrateSettingsToV2, SETTINGS_SCHEMA_VERSION } from '../services/settingsMigration';
import type { Settings } from '../types/trading';

const BASE: Settings = {
  tp1Pips: 25,
  tp2Pips: 50,
  tp3Pips: 80,
  slPips: 70,
  numberOfTPs: 3,
  minConfidence: 0.68,
  enableNotifications: true,
  enableTelegramNotifier: true,
  basePositionSize: 0.01,
  maxRiskPercentage: 2.0,
  useKellyCriterion: true,
  useDynamicSL: false,
  maxSLPips: 90,
  allowShortSignals: true,
};

let failures = 0;

function check(name: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${name} — ${detail}`);
  }
}

console.log('='.repeat(80));
console.log('PHASE D / D2 — SETTINGS MIGRATION PROOF — ' + new Date().toISOString());
console.log('='.repeat(80));

// ── Case 1: untouched pre-Item-121 install (THE checkpoint requirement) ──────
console.log('\nCase 1: persisted 49/74/98 + useDynamicSL=true (stale defaults row)');
const legacy: Settings = { ...BASE, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98, useDynamicSL: true };
const r1 = migrateSettingsToV2(legacy);
check('tp1Pips 49 → 25', r1.settings.tp1Pips === 25, `got ${r1.settings.tp1Pips}`);
check('tp2Pips 74 → 50', r1.settings.tp2Pips === 50, `got ${r1.settings.tp2Pips}`);
check('tp3Pips 98 → 80', r1.settings.tp3Pips === 80, `got ${r1.settings.tp3Pips}`);
check('useDynamicSL true → false', r1.settings.useDynamicSL === false, `got ${r1.settings.useDynamicSL}`);
check('schemaVersion stamped 2', r1.settings.schemaVersion === SETTINGS_SCHEMA_VERSION, `got ${r1.settings.schemaVersion}`);
check('changed flag true', r1.changed, 'changed=false');
check('slPips untouched at 70', r1.settings.slPips === 70, `got ${r1.settings.slPips}`);
console.log(`  changes: ${r1.changes.join(' | ')}`);

// ── Case 2: customized install — user VALUES preserved (except the stale default) ──
console.log('\nCase 2: user-customized install (30/60/90 ladder, useDynamicSL=true)');
const custom: Settings = { ...BASE, tp1Pips: 30, tp2Pips: 60, tp3Pips: 90, useDynamicSL: true, minConfidence: 0.9 };
const r2 = migrateSettingsToV2(custom);
check('custom ladder preserved 30/60/90', r2.settings.tp1Pips === 30 && r2.settings.tp2Pips === 60 && r2.settings.tp3Pips === 90, `got ${r2.settings.tp1Pips}/${r2.settings.tp2Pips}/${r2.settings.tp3Pips}`);
check('useDynamicSL true → false (stale-default rule applies to ALL v1 rows; one-tap re-enable in Settings)', r2.settings.useDynamicSL === false, `got ${r2.settings.useDynamicSL}`);
check('minConfidence preserved 0.90', r2.settings.minConfidence === 0.9, `got ${r2.settings.minConfidence}`);
check('schemaVersion stamped', r2.settings.schemaVersion === SETTINGS_SCHEMA_VERSION, `got ${r2.settings.schemaVersion}`);
check('changed true (version stamp only for values)', r2.changed, 'changed=false');

// ── Case 3: already-v2 row is idempotent ─────────────────────────────────────
console.log('\nCase 3: already-migrated v2 row');
const v2: Settings = { ...BASE, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98, useDynamicSL: true, schemaVersion: 2 };
const r3 = migrateSettingsToV2(v2);
check('v2 row returned unchanged', r3.settings.tp1Pips === 49 && r3.settings.useDynamicSL === true, `got ${r3.settings.tp1Pips}/${r3.settings.useDynamicSL}`);
check('changed=false', !r3.changed, 'changed=true');

// ── Case 4: stale ladder + otherwise customized ──────────────────────────────
console.log('\nCase 4: stale 49/74/98 ladder + custom minConfidence 0.90 + useDynamicSL true');
const mixed: Settings = { ...BASE, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98, useDynamicSL: true, minConfidence: 0.9 };
const r4 = migrateSettingsToV2(mixed);
check('ladder migrated to 25/50/80', r4.settings.tp1Pips === 25 && r4.settings.tp2Pips === 50 && r4.settings.tp3Pips === 80, `got ${r4.settings.tp1Pips}/${r4.settings.tp2Pips}/${r4.settings.tp3Pips}`);
check('minConfidence preserved 0.90', r4.settings.minConfidence === 0.9, `got ${r4.settings.minConfidence}`);
check('useDynamicSL true → false (stale default rule)', r4.settings.useDynamicSL === false, `got ${r4.settings.useDynamicSL}`);

console.log('\n' + '='.repeat(80));
if (failures === 0) {
  console.log('VERDICT: ✅ PASS — all migration cases behave as pre-registered.');
  console.log('The checkpoint requirement is satisfied: a persisted 49/74/98 install migrates to 25/50/80.');
} else {
  console.log(`VERDICT: ❌ FAIL — ${failures} assertion(s) failed.`);
  process.exit(1);
}
