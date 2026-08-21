/**
 * CI GUARD — COMMENT SYNTAX (the cron-in-comment class).
 *
 * ROOT CAUSE THIS GUARDS (2026-08-21, resolver deploy): a cron schedule written
 * inside a block comment CLOSES the comment at the star-slash sequence and
 * turns the rest of the sentence into code — a syntax error in the deployable
 * resolver function. runChecks(expo) never saw it because backend/functions
 * lives outside the expo tsconfig, so a syntactically broken Deno function
 * shipped all the way to deploy.
 *
 * RULE, ENFORCED GOING FORWARD: any comment mentioning an interval-based cron
 * schedule must reword it ("the 15-minute cron"), or otherwise avoid the
 * literal star-slash-plus-digits sequence. This file's own comments follow the
 * same rule.
 *
 * CHECK 1 — PARSE: every .ts/.tsx file under expo/ (excluding node_modules and
 *   build output) AND backend/ is parsed with the TypeScript parser; ANY parse
 *   diagnostic fails. This closes the coverage gap that let a broken backend
 *   function ship, and costs a fraction of a full type-check.
 * CHECK 2 — PATTERN: the same files are scanned for the accidental-comment-
 *   close shape: star-slash, then digits, then a word (the exact shape of the
 *   original bug, where an interval schedule mid-sentence silently ended the
 *   comment). String literals are stripped first so legitimate cron strings in
 *   CODE never false-positive.
 * SELF-TEST: every run first verifies that the guard DETECTS the exact original
 *   broken line and does NOT flag the fixed line — if the self-test fails, the
 *   guard itself is broken and exits non-zero.
 *
 * Run: bun run scripts/ci_guard_comment_syntax.ts   (from expo/)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const EXPO_ROOT = process.cwd();
const PROJECT_ROOT = join(EXPO_ROOT, '..');
const SKIP_DIRS = new Set(['node_modules', '.expo', 'dist', 'artifacts', '.rork', 'web']);

/** Original broken resolver comment (2026-08-21), kept as the regression fixture. */
const BROKEN_LINE = ' *   4. Bounded per invocation (BACKFILL_BATCH rows) so the */15 cron stays\n *      fast; at 40 rows/run the 287-row backlog clears in ~2 hours.';
/** The fix the user applied (reworded — no interval expression in the comment). */
const FIXED_LINE = ' *   4. Bounded per invocation (BACKFILL_BATCH rows) so the 15-minute cron\n *      fast; at 40 rows/run the 287-row backlog clears in ~2 hours.';

/** The accidental-comment-close shape: star-slash, digits, whitespace, a word. */
const CRON_IN_COMMENT_RE = /\*\/\s*\d+\s+[A-Za-z]/;

/**
 * Strip string literals from TS source so cron schedules in CODE (string
 * literals) are not flagged. Lightweight state machine: tracks single quotes,
 * double quotes, template literals (with nesting), line comments and block
 * comments. String-literal contents are replaced with spaces so column
 * positions survive.
 */
function stripStringLiterals(source: string): string {
  const out: string[] = [];
  let i = 0;
  let state: 'normal' | 'single' | 'double' | 'template' = 'normal';
  const templateStack: string[] = [];
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? '';
    if (state === 'normal') {
      if (c === '/' && next === '/') {
        // Line comment: copy verbatim (no strings inside a line comment).
        const nl = source.indexOf('\n', i);
        const end = nl === -1 ? source.length : nl;
        out.push(source.slice(i, end));
        i = end;
        continue;
      }
      if (c === '/' && next === '*') {
        // Block comment: copy verbatim.
        const close = source.indexOf('*/', i + 2);
        const end = close === -1 ? source.length : close + 2;
        out.push(source.slice(i, end));
        i = end;
        continue;
      }
      if (c === "'") { state = 'single'; out.push(' '); i += 1; continue; }
      if (c === '"') { state = 'double'; out.push(' '); i += 1; continue; }
      if (c === '`') { state = 'template'; templateStack.push(''); out.push(' '); i += 1; continue; }
      out.push(c);
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (c === '\\') { out.push('  '); i += 2; continue; }
      if (c === quote) { state = 'normal'; out.push(' '); i += 1; continue; }
      if (c === '\n') { state = 'normal'; out.push('\n'); i += 1; continue; }
      out.push(' ');
      i += 1;
      continue;
    }
    // template literal
    if (c === '\\') { out.push('  '); i += 2; continue; }
    if (c === '`') { state = 'normal'; templateStack.pop(); out.push(' '); i += 1; continue; }
    if (c === '$' && next === '{') { out.push('  '); i += 2; continue; }
    out.push(c === '\n' ? '\n' : ' ');
    i += 1;
  }
  return out.join('');
}

/** Recursively collect .ts/.tsx files under a root, skipping build dirs. */
function collectTsFiles(root: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collectTsFiles(full, acc);
    } else if (st.isFile() && (name.endsWith('.ts') || name.endsWith('.tsx'))) {
      acc.push(full);
    }
  }
  return acc;
}

/** TypeScript parse diagnostics for one file (syntax only — no type-check). */
function parseDiagnostics(path: string, content: string): ts.Diagnostic[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  return (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

function main(): void {
  let failed = false;

  // ── SELF-TEST: the guard must catch the original bug and pass the fix ──
  const brokenStripped = stripStringLiterals(BROKEN_LINE);
  const fixedStripped = stripStringLiterals(FIXED_LINE);
  const selfTestPatternCatches = CRON_IN_COMMENT_RE.test(brokenStripped);
  const selfTestPatternPassesFixed = !CRON_IN_COMMENT_RE.test(fixedStripped);
  const brokenComment = `/**\n * DOC.\n${BROKEN_LINE}\n */\n`;
  const fixedComment = `/**\n * DOC.\n${FIXED_LINE}\n */\n`;
  const selfTestParseCatches = parseDiagnostics('selftest-broken.ts', brokenComment).length > 0;
  const selfTestParsePassesFixed = parseDiagnostics('selftest-fixed.ts', fixedComment).length === 0;
  console.log('SELF-TEST:');
  console.log(`  pattern catches original broken line : ${selfTestPatternCatches ? 'YES' : 'NO (GUARD BROKEN)'}`);
  console.log(`  pattern passes the fixed line        : ${selfTestPatternPassesFixed ? 'YES' : 'NO (GUARD BROKEN)'}`);
  console.log(`  parser catches original broken file  : ${selfTestParseCatches ? 'YES' : 'NO (GUARD BROKEN)'}`);
  console.log(`  parser passes the fixed file         : ${selfTestParsePassesFixed ? 'YES' : 'NO (GUARD BROKEN)'}`);
  if (!selfTestPatternCatches || !selfTestPatternPassesFixed || !selfTestParseCatches || !selfTestParsePassesFixed) {
    console.error('\n❌ ci_guard_comment_syntax SELF-TEST FAILED — the guard itself is broken. Do not trust this run.');
    process.exit(1);
  }

  // ── CHECK 1 + 2 over the real tree ──
  const files = [
    ...collectTsFiles(EXPO_ROOT),
    ...collectTsFiles(join(PROJECT_ROOT, 'backend')),
  ];
  let parseFailures = 0;
  let patternHits = 0;
  console.log(`\nscanning ${files.length} .ts/.tsx files (expo + backend)...`);

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // CHECK 1 — parse diagnostics (the class of error that shipped in the resolver).
    const diags = parseDiagnostics(file, content);
    if (diags.length > 0) {
      parseFailures += 1;
      failed = true;
      for (const d of diags.slice(0, 3)) {
        const pos = d.file?.getLineAndCharacterOfPosition(d.start ?? 0);
        const where = pos ? `${relative(PROJECT_ROOT, file)}:${pos.line + 1}:${pos.character + 1}` : relative(PROJECT_ROOT, file);
        console.error(`  ❌ PARSE ${where} — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    // CHECK 2 — accidental comment close: star-slash + digits + word.
    const stripped = stripStringLiterals(content);
    const lines = stripped.split('\n');
    for (let ln = 0; ln < lines.length; ln++) {
      const m = lines[ln].match(CRON_IN_COMMENT_RE);
      if (m) {
        patternHits += 1;
        failed = true;
        console.error(`  ❌ CRON-IN-COMMENT ${relative(PROJECT_ROOT, file)}:${ln + 1} — an interval schedule mid-comment closed the comment ("${m[0]}..."). Reword it (e.g. "the 15-minute cron") or escape the slash.`);
      }
    }
  }

  console.log(`\nparse failures: ${parseFailures}; cron-in-comment hits: ${patternHits}`);
  if (failed) {
    console.error('❌ ci_guard_comment_syntax FAILED');
    process.exit(1);
  }
  console.log('✅ ci_guard_comment_syntax PASSED — no comment-syntax errors, no interval schedules inside comments.');
}

main();
