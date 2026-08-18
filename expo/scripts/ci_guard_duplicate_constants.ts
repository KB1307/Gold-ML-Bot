/**
 * CI GUARD — DUPLICATE / DIVERGENT ENGINE CONSTANT DETECTOR
 * (Item 124d, WIDENED by Item 130)
 *
 * WHY THIS EXISTS
 * ---------------
 * Before Item 124 the tree held 100,941 lines of frozen `__sandbox_*` engine
 * copies against 16,838 lines of live services (6:1). Those copies held
 * constants that CONTRADICTED live code:
 *
 *   TRAINING_WINDOW_DAYS  = 0    (live, 1 file)  vs = 14   (stale)
 *   tp1Distance = settings.tp1Pips (live, 1 file) vs
 *                 dynamicSlPips * SCALPER_TP_R_MULTIPLES (stale)
 *
 * A grep for the TP ladder returned the OLD implementation ten times and the
 * new one once. This is the most likely mechanism behind (a) gates shipping
 * against a construct that was never measured, and (b) prior sessions citing
 * line numbers that did not match live code.
 *
 * ITEM 130 — THE ORIGINAL SCOPE WAS TOO NARROW.
 * ---------------------------------------------
 * v1 scanned only `expo/services` + `expo/contexts` and reported "zero
 * duplicates". That was TRUE WITHIN SCOPE but INCOMPLETE: `LOOKBACK_HOURS` is
 * defined TWICE in LIVE code and v1 saw neither definition, because both live
 * outside the two scanned roots:
 *
 *   backend/functions/refresh-sr-zones/index.ts:23   (Supabase Edge Function)
 *   expo/backend/trpc/routes/srZones.ts:32           (tRPC route)
 *
 * They agree at 24 today with NOTHING enforcing it — the same
 * dual-implementation pattern that produced F-3's divergent resolver windows.
 *
 * THREE TIERS
 * -----------
 *  1. LIVE_ROOTS  — a second definition of a tracked constant is a FAILURE,
 *     unless the constant is listed in PARITY_ALLOWED.
 *  2. PARITY_ALLOWED — constants that legitimately exist in more than one live
 *     location because a DEPLOYMENT BOUNDARY prevents sharing. Duplication is
 *     tolerated; DIVERGENCE IS A FAILURE. Values are parsed and compared.
 *  3. WARN_ROOTS  — scripts. They legitimately pin their own values for
 *     historical replay, so divergence is reported as a WARNING and does not
 *     fail the build. A stale value there is still a trap, so it is never
 *     silent.
 *
 * WHY LOOKBACK_HOURS IS PARITY-ASSERTED RATHER THAN EXTRACTED
 * ----------------------------------------------------------
 * `backend/functions/refresh-sr-zones/index.ts` is a Deno Supabase Edge
 * Function: it imports via `https://esm.sh/@supabase/supabase-js@2` and reads
 * `Deno.env`, and it is deployed as a standalone bundle from
 * `backend/functions/`. It cannot import from `expo/` — different runtime,
 * different module resolution, different deployment artifact. A shared module
 * would either break the Expo/Metro bundle or break the edge deploy. The
 * deployment boundary genuinely prevents sharing, so the correct fix is the
 * loud parity assertion below.
 *
 * Run: bun expo/scripts/ci_guard_duplicate_constants.ts
 * Exit 0 = clean (warnings allowed). Exit 1 = duplicate or divergence.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/** Roots that contain LIVE code. Item 130 added the two backend roots. */
const LIVE_ROOTS: readonly string[] = [
  'expo/services',
  'expo/contexts',
  'expo/backend',
  'backend/functions',
];

/** Roots whose divergence WARNS but does not fail (Item 130c). */
const WARN_ROOTS: readonly string[] = ['expo/scripts'];

/**
 * Constants legitimately defined in more than one LIVE location because a
 * deployment boundary prevents a shared import. Duplication is allowed;
 * DIVERGENCE FAILS. This is the Item 130(a) parity assertion.
 */
const PARITY_ALLOWED: readonly string[] = [
  'LOOKBACK_HOURS',
  'ZONE_STALENESS_HALF_LIFE_HOURS',
  'CONSUMER_THRESHOLD',
  'ZONE_TOUCH_WIDTH_ATR',
  'CLUSTER_MERGE_WIDTH_ATR',
];

/**
 * Engine constants whose value materially changes signal geometry, scoring,
 * NOTE: LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS (signalEngine, 6h) is tracked
 * SEPARATELY from ZONE_STALENESS_HALF_LIFE_HOURS (server zone paths, 18h). The
 * first run of the widened guard flagged these as a parity violation; they are
 * in fact two INTENTIONALLY different tiers that shared one name. Item 130
 * renamed the local one rather than reconciling the values, because the values
 * are correct and the NAME was the trap.
 * emission, dedup, learning, or the zone map.
 */
const TRACKED_CONSTANTS: readonly string[] = [
  'SCALPER_TP_R_MULTIPLES',
  'SCALPER_TP3_STRETCH_R',
  'SCALPER_TP3_STRETCH_MAX_R',
  'TRAINING_WINDOW_DAYS',
  'LOOKBACK_HOURS',
  'ZONE_STALENESS_HALF_LIFE_HOURS',
  'CONSUMER_THRESHOLD',
  'ZONE_TOUCH_WIDTH_ATR',
  'CLUSTER_MERGE_WIDTH_ATR',
  'DEDUP_TIME_WINDOW_MS',
  'DEDUP_PRICE_BAND_ATR',
  'DEDUP_CLUSTER_BAND_ATR',
  'MODULATION_ENABLED',
  'LEARNED_MODULATION_MIN',
  'LEARNED_MODULATION_MAX',
  'LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS',
  'ZONE_MERGE_THRESHOLD_ATR',
  'BLOCKED_UTC_HOURS',
  'OB_FILTER_ENABLED',
  'OB_PROXIMITY_ATR',
  'OB_FILTER_MIN_BARS',
  'MIN_SL_ATR_MULTIPLE',
  'PATH_TO_TARGET_VETO_ENABLED',
  'ENTRY_QUALITY_TRIGGER_ENABLED',
  'TP3_CONFIDENCE_STRETCH_ENABLED',
  'EXECUTION_COST_PER_TRADE_USD',
];

interface Definition {
  readonly constant: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly value: string;
  readonly tier: 'LIVE' | 'WARN';
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
 * Matches a module-scope DEFINITION of a constant. Deliberately excludes
 * object-property assignment, imports, and comparisons.
 */
function definitionRegex(name: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`);
}

/**
 * Extracts the assigned value as a normalised string so two definitions can be
 * compared for PARITY. Trailing comments and semicolons are stripped; a
 * trailing arithmetic expression is preserved verbatim (e.g. `225 * 60 * 1000`)
 * because a change to any factor is a real divergence.
 */
function extractValue(line: string, name: string): string {
  const re = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(.*)$`);
  const m = re.exec(line);
  const raw = m?.[1] ?? '';
  return raw
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*$/, '')
    .replace(/;\s*$/, '')
    .trim();
}

function main(): void {
  const liveFiles: string[] = [];
  for (const root of LIVE_ROOTS) walk(root, liveFiles);
  const warnFiles: string[] = [];
  for (const root of WARN_ROOTS) walk(root, warnFiles);

  console.log('='.repeat(74));
  console.log('CI GUARD — DUPLICATE / DIVERGENT ENGINE CONSTANTS (Item 124d + 130)');
  console.log('='.repeat(74));
  console.log(`LIVE roots      : ${LIVE_ROOTS.join(', ')}`);
  console.log(`WARN roots      : ${WARN_ROOTS.join(', ')}`);
  console.log(`Live files      : ${liveFiles.length}`);
  console.log(`Script files    : ${warnFiles.length}`);
  console.log(`Constants tracked: ${TRACKED_CONSTANTS.length}`);
  console.log(`Parity-allowed  : ${PARITY_ALLOWED.join(', ')}`);
  console.log('');

  const found = new Map<string, Definition[]>();

  const scan = (files: string[], tier: 'LIVE' | 'WARN'): void => {
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
          if (!re.test(line)) continue;
          const list = found.get(name) ?? [];
          list.push({
            constant: name,
            file: relative(process.cwd(), file),
            line: i + 1,
            text: line.trim().slice(0, 96),
            value: extractValue(line, name),
            tier,
          });
          found.set(name, list);
        }
      }
    }
  };

  scan(liveFiles, 'LIVE');
  scan(warnFiles, 'WARN');

  const failures: string[] = [];
  const warnings: string[] = [];
  const healthy: Definition[] = [];
  const parityOk: { name: string; value: string; defs: Definition[] }[] = [];
  const absent: string[] = [];

  for (const name of TRACKED_CONSTANTS) {
    const all = found.get(name) ?? [];
    const live = all.filter((d) => d.tier === 'LIVE');
    const scripts = all.filter((d) => d.tier === 'WARN');

    if (live.length === 0) {
      absent.push(name);
    } else if (live.length === 1) {
      const only = live[0];
      if (only) healthy.push(only);
    } else if (PARITY_ALLOWED.includes(name)) {
      const values = new Set(live.map((d) => d.value));
      if (values.size === 1) {
        parityOk.push({ name, value: live[0]?.value ?? '', defs: live });
      } else {
        failures.push(
          `PARITY VIOLATION: ${name} has ${values.size} DIFFERENT live values across the deployment boundary:\n` +
            live.map((d) => `      ${d.file}:${d.line}  = ${d.value}`).join('\n'),
        );
      }
    } else {
      failures.push(
        `DUPLICATE DEFINITION: ${name} defined ${live.length}x in LIVE code:\n` +
          live.map((d) => `      ${d.file}:${d.line}  ${d.text}`).join('\n'),
      );
    }

    // Item 130c — script divergence WARNS, never fails.
    if (live.length > 0 && scripts.length > 0) {
      const liveValue = live[0]?.value ?? '';
      for (const s of scripts) {
        if (s.value !== liveValue) {
          warnings.push(`${name}: script ${s.file}:${s.line} = ${s.value}  (live = ${liveValue})`);
        }
      }
    }
  }

  console.log('--- SINGLE LIVE DEFINITION (healthy) ---');
  for (const d of healthy) console.log(`  OK     ${d.constant.padEnd(30)} ${d.file}:${d.line}  = ${d.value}`);
  console.log('');

  if (parityOk.length > 0) {
    console.log('--- PARITY-ASSERTED ACROSS DEPLOYMENT BOUNDARY (values AGREE) ---');
    for (const p of parityOk) {
      console.log(`  PARITY ${p.name.padEnd(30)} = ${p.value}  (${p.defs.length} live definitions)`);
      for (const d of p.defs) console.log(`           ${d.file}:${d.line}`);
    }
    console.log('');
  }

  if (absent.length > 0) {
    console.log('--- NOT PRESENT IN LIVE TREE (informational, not a failure) ---');
    console.log(`  ${absent.join(', ')}`);
    console.log('');
  }

  if (warnings.length > 0) {
    console.log('--- WARN: SCRIPT VALUES DIVERGE FROM LIVE (does NOT fail the build) ---');
    console.log('  Scripts legitimately pin values for historical replay. Listed so a');
    console.log('  stale script value is never silent.');
    for (const w of warnings) console.log(`  WARN   ${w}`);
    console.log('');
  }

  if (failures.length > 0) {
    console.log('--- !!! GUARD FAILS !!! ---');
    for (const f of failures) console.log(`  ${f}`);
    console.log('');
    console.log(`RESULT: FAIL — ${failures.length} problem(s) in LIVE code.`);
    console.log('Two sources of truth means a grep can return the wrong answer and a');
    console.log('gate can ship against a construct that was never measured.');
    process.exit(1);
  }

  console.log(
    `RESULT: PASS — ${healthy.length} single-source constant(s), ${parityOk.length} parity-asserted, ` +
      `${warnings.length} script warning(s), across ${liveFiles.length} live files.`,
  );
  process.exit(0);
}

main();
