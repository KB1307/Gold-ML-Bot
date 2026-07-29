# Project notes for agents

## Ignore list (permanent)

- `.rork/plans/harden-test-tooling-smooth-out-how-the-a_*.plan.md` — **STALE. Deleted 2026-07-29.**
  Its Steps A/B were completed long ago; it kept resurfacing in context and is irrelevant to
  all current and future work. If a file with this slug reappears, ignore it entirely and do
  not treat it as an active plan. Do not re-create it.

## Learning memory (XAU/USD signal engine)

- Resolved trade outcomes are durable in Supabase `trade_outcomes_v1` (primary key `signal_id`,
  writes are UPSERTs through the backend `learning.*` tRPC routes using the service-role key;
  the table only exposes a public SELECT policy).
- `expo/services/learningStore.ts` is the local cache tier (expo-sqlite on native, in-memory on
  web) in front of that durable corpus. `hydrateFromRemote()` unions remote into local, re-sorts
  by timestamp, and backfills local-only rows upward.
- The persisted feature vector (`SignalLearningContext`) is at **schema version 2** (wide vector).
  Version 1 records (six scalars only) still exist and must never be back-filled with invented
  values — check `featureSchemaVersion` before assuming wide fields are present.
