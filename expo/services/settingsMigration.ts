/**
 * PHASE D / D2 — VERSIONED SETTINGS MIGRATION (F-9, 97 items overdue).
 *
 * sanitizeSettings() spreads PERSISTED settings over DEFAULT_SETTINGS, so an
 * install saved before Item 121 keeps the old 49/74/98 TP ladder (measured
 * EV +0.0198R) forever instead of the shipped 25/50/80 (+0.0371R), and a row
 * saved before Item 82 keeps useDynamicSL=true — the path Item 19 measured as
 * WORSE in both directions. Every forward measurement is taken on a mix of two
 * ladders until this is fixed. This module is that fix.
 *
 * RULES (pre-registered):
 *   v1 row (no schemaVersion) → v2:
 *     1. TP ladder exactly (49, 74, 98) → (25, 50, 80). Those numbers entered
 *        the row as the pre-Item-121 DEFAULTS; a user who deliberately chose
 *        the identical values is indistinguishable and pays a one-time re-set
 *        (documented cost, justified by Item 109(b): 25/50/80 superior on every
 *        metric on the identical population).
 *     2. useDynamicSL === true → false. The true value entered the row as the
 *        pre-Item-82 DEFAULT (F-5's exact defect class). A deliberate toggle is
 *        indistinguishable; the escape hatch is the Settings toggle itself
 *        (one tap). Item 19 measured the dynamic-SL path worse in both
 *        directions, so the default correction wins the ambiguity.
 *     3. Everything else is preserved verbatim — this migration touches ONLY
 *        the two fields whose persisted values are known to be stale DEFAULTS.
 *   v2+ row → returned unchanged.
 *
 * Pure function: no AsyncStorage, no side effects — testable and reusable.
 * NOT changed: any DEFAULT, any clamp, the Settings UI, the engine's reads.
 */
import type { Settings } from '@/types/trading';

export const SETTINGS_SCHEMA_VERSION = 2;

/** The pre-Item-121 default TP ladder — the "stale default" fingerprint. */
const LEGACY_DEFAULT_LADDER: readonly [number, number, number] = [49, 74, 98];

export interface SettingsMigrationResult {
  settings: Settings;
  /** True when any field changed (caller should persist the migrated row). */
  changed: boolean;
  /** Human-readable description of what was migrated, for the log line. */
  changes: string[];
}

export function migrateSettingsToV2(raw: Settings): SettingsMigrationResult {
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion >= SETTINGS_SCHEMA_VERSION) {
    return { settings: raw, changed: false, changes: [] };
  }

  const settings: Settings = { ...raw };
  const changes: string[] = [];

  if (
    settings.tp1Pips === LEGACY_DEFAULT_LADDER[0] &&
    settings.tp2Pips === LEGACY_DEFAULT_LADDER[1] &&
    settings.tp3Pips === LEGACY_DEFAULT_LADDER[2]
  ) {
    settings.tp1Pips = 25;
    settings.tp2Pips = 50;
    settings.tp3Pips = 80;
    changes.push(`TP ladder 49/74/98 → 25/50/80 (pre-Item-121 stale default; Item 109(b) measured 25/50/80 superior)`);
  }

  if (settings.useDynamicSL === true) {
    settings.useDynamicSL = false;
    changes.push('useDynamicSL true → false (pre-Item-82 stale default; Item 19 measured the path worse in both directions — re-enable in Settings if deliberate)');
  }

  const alreadyStamped = typeof raw.schemaVersion === 'number';
  settings.schemaVersion = SETTINGS_SCHEMA_VERSION;
  if (!alreadyStamped) changes.push(`schemaVersion stamped ${SETTINGS_SCHEMA_VERSION}`);

  return { settings, changed: changes.length > 0, changes };
}
