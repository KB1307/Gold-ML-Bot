/**
 * CI GUARD — DUPLICATE ENGINE CONSTANT DETECTOR (Item 124d)
 *
 * WHY THIS EXISTS
 * ---------------
 * Before Item 124 the tree held 100,941 lines of frozen `__sandbox_*` engine
 * copies against 16,838 lines of live services (6:1). Those copies held
 * constants that CONTRADICTED live code:
 *
 *   TRAINING_WINDOW_DAYS  = 0    (live, 1 file)  vs = 14   (stale, 12 files)
 *   tp1Distance = settings.tp1Pips (live, 1 file) vs
 *                 dynamicSlPips * SCALPER_TP_R_MULTIPLES (stale, 10 files)
 *   LOOKBACK_HOURS        = 24   (live, 2 files) vs = 120  (stale, 3 files)
 *
 * A grep for the TP ladder returned the OLD implementation ten times and the
 * new one once. This is the most likely mechanism behind (a) gates shipping
 * against a construct that was never measured, and (b) prior sessions citing
 * line numbers that did not match live code.
 *
 * Deleting the sandboxes fixed the symptom. THIS GUARD IS THE PERMANENT FIX:
 * cleanup alone does not prevent recurrence.
 *
 * WHAT IT DOES
 * ------------
 * Scans the LIVE source roots (expo/services, expo/contexts) and FAILS with a
 * non-zero exit code if any tracked engine constant is DEFINED more than once
 * in the working tree. Definitions only — references/reads are ignored.
 *
 * Run: bun expo/scripts/ci_guard_duplicate_constants.ts
 * Exit 0 = zero duplicates. Exit 1 = duplicate found, printed with file:line.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/** Source roots that contain LIVE engine code. Sandboxes/scripts are excluded by design. */
const SCAN_ROOTS: readonly string[] = ['expo/services', 'expo/contexts'];

/**
 * Engine constants whose value materially changes signal geometry, scoring,
 * emission, dedup, or learning. A second definition of any of these in the
 * live tree means two sources of truth.
 */
const TRACKED_CONSTANTS: readonly string[] = [
  'SCALPER_TP_R_MULTIPLES',
  'SCALPER_TP3_STRETCH_R',
  'SCALPER_TP3_STRETCH_MAX_R',
  'TRAINING_WINDOW_DAYS',
  'LOOKBACK_HOURS',
  'DEDUP_TIME_WINDOW_MS',
  'DEDUP_PRICE_BAND_ATR',
  'MODULATION_ENABLED',
  'LEARNED_MODULATION_MIN',
  'LEARNED_MODULATION_MAX',
  'ZONE_MERGE_THRESHOLD_ATR',
  'BLOCKED_UTC_HOURS',
  'OB_FILTER_ENABLED',
  'OB_PROXIMITY_ATR',
  'MIN_CONFIDENCE_THRESHOLD',
  'ATR_NOISE_FLOOR_MULTIPLIER',
  'PATH_TO_TARGET_VETO_ENABLED',
  'AWAIT_ZONE_TTL_MS',
];

interface Definition {
  readonly constant: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string, out: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.') || entry.startsWith('__sandbox')) continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Matches a top-level or module-scope DEFINITION of a constant.
 * Deliberately excludes object-property reads (`X.Y =`), imports, and
 * comparisons so that only real declarations count.
 */
function definitionRegex(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`);
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(root, files);

  console.log('='.repeat(72));
  console.log('CI GUARD — DUPLICATE ENGINE CONSTANT DETECTOR (Item 124d)');
  console.log('='.repeat(72));
  console.log(`Scan roots      : ${SCAN_ROOTS.join(', ')}`);
  console.log(`Files scanned   : ${files.length}`);
  console.log(`Constants tracked: ${TRACKED_CONSTANTS.length}`);
  console.log('');

  const found = new Map<string, Definition[]>();

  for (const file of files) {
    let lines: string[];
    try {
      lines = readFileSync(file, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const name of TRACKED_CONSTANTS) {
      const re = definitionRegex(name);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (re.test(line)) {
          const list = found.get(name) ?? [];
          list.push({
            constant: name,
            file: relative(process.cwd(), file),
            line: i + 1,
            text: line.trim().slice(0, 96),
          });
          found.set(name, list);
        }
      }
    }
  }

  const duplicates: Definition[][] = [];
  const singles: Definition[] = [];
  const absent: string[] = [];

  for (const name of TRACKED_CONSTANTS) {
    const defs = found.get(name);
    if (!defs || defs.length === 0) {
      absent.push(name);
    } else if (defs.length === 1) {
      const only = defs[0];
      if (only) singles.push(only);
    } else {
      duplicates.push(defs);
    }
  }

  console.log('--- SINGLE DEFINITION (healthy) ---');
  for (const d of singles) {
    console.log(`  OK   ${d.constant.padEnd(30)} ${d.file}:${d.line}`);
  }
  console.log('');

  if (absent.length > 0) {
    console.log('--- NOT PRESENT IN LIVE TREE (informational, not a failure) ---');
    console.log(`  ${absent.join(', ')}`);
    console.log('');
  }

  if (duplicates.length > 0) {
    console.log('--- !!! DUPLICATE DEFINITIONS — GUARD FAILS !!! ---');
    for (const defs of duplicates) {
      const first = defs[0];
      if (!first) continue;
      console.log(`  DUPLICATE: ${first.constant} defined ${defs.length}x`);
      for (const d of defs) {
        console.log(`      ${d.file}:${d.line}  ${d.text}`);
      }
    }
    console.log('');
    console.log(`RESULT: FAIL — ${duplicates.length} constant(s) with more than one definition.`);
    console.log('Two sources of truth means a grep can return the wrong answer and a');
    console.log('gate can ship against a construct that was never measured.');
    process.exit(1);
  }

  console.log(`RESULT: PASS — zero duplicate definitions across ${files.length} live files.`);
  console.log(`Single-source-of-truth confirmed for ${singles.length} tracked constant(s).`);
  process.exit(0);
}

main();
