/**
 * ITEM 225 / B5 verification — run the SHIPPED startup assertion against the LIVE
 * schema and print its verdict.
 *
 * This imports assertEmittedSchemaContract() from the service the app boots with,
 * so what is asserted here is the same code path app/_layout.tsx invokes. It is
 * NOT a re-implementation of the check (that would be the Item 149 mistake in a
 * new costume). Read-only.
 */
import { readFileSync } from 'node:fs';

async function main(): Promise<void> {
  // The service reads process.env for its Supabase credentials, so hydrate them
  // from .env exactly as the other scripts in this directory do.
  for (const l of readFileSync('.env', 'utf8').split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    process.env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, '');
  }
  const { assertEmittedSchemaContract } = await import('../services/emittedSignalService');
  console.log('='.repeat(100));
  console.log('B5 — SHIPPED STARTUP SCHEMA ASSERTION, RUN AGAINST THE LIVE SCHEMA');
  console.log('='.repeat(100));
  const result = await assertEmittedSchemaContract();
  console.log(`\n  structured result: ${JSON.stringify(result, null, 2)}`);
  console.log(`\n  VERDICT: ${result.ok ? 'PASS — every column the write path writes exists live' : 'FAIL/INCONCLUSIVE — see probeError / missingInDb above'}`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
