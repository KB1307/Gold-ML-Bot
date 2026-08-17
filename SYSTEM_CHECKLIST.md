# SYSTEM_CHECKLIST.md

Standing pre-flight checklist for this trading system. Every item here exists
because a specific claim was once made and later found to be unsupported. Run
the relevant block BEFORE reporting any before/after comparison as evidence.

Last updated: 2026-08-17 (Item 82 audit / Correction 6).

---

## A. Comparability gate — run BEFORE claiming any before/after delta

A harness delta is evidence ONLY if all five hold. If any fails, the correct
report is "not comparable", not a number.

- [ ] **A1. Engine source pinned.** `git log --since=<runA> -- expo/services/signalEngine.ts`
      returns nothing, OR the diff is inspected and shown to be non-behavioural.
- [ ] **A2. Harness source pinned.** Same check for the harness file itself.
      A harness edit changes the *instrument*, which is as invalidating as an engine edit.
- [ ] **A3. Tape-end pinned and identical.** Both runs passed the SAME explicit
      `--tape-end`. An unpinned tape-end means the two runs read different bars.
- [ ] **A4. Sampling identical.** Same `--step`. Different step = different
      evaluation set = different distribution, trivially.
- [ ] **A5. TIER_0 zone state identical.** See section B. This is the one that
      was missed and it silently invalidated a run.

## B. TIER_0 S/R zones are LIVE-READ and NOT pinned — the biggest comparability trap

Verified facts (Item 82 audit):

- The engine reads `sr_zones_v1` **directly from Supabase on every evaluation**
  (`expo/services/srZoneTier0Service.ts:255`). The replay harness pins the bar
  tape but does **NOT** pin zones.
- The refresh **wholesale replaces** the table — it writes a new batch then
  prunes everything older (`expo/backend/trpc/routes/srZones.ts:329`,
  `.delete().lt("updated_at", runTs)`). Confirmed live: all 21 rows share a
  single `updated_at` (`2026-08-17T06:33:26Z`).
- Therefore **two harness runs on different days read a different zone set even
  with byte-identical engine source and an identical pinned tape-end.** Every
  zone-dependent gate (reaction strength, bounce threshold, winning strength)
  moves with it.

Checklist:

- [ ] **B1.** Before/after runs completed inside the SAME zone-refresh batch —
      i.e. `max(updated_at)` on `sr_zones_v1` is identical for both runs.
- [ ] **B2.** `max(reaction_strength)` recorded for each run. If it is
      `< 0.30` (the TIER_0 consumer threshold) the engine ran on
      `TIER_1_LOCAL` micro-zones, which is a different system.
- [ ] **B3.** Zone snapshot captured with the run output, not assumed.
      Probe script: `expo/scripts/auditItem82_zoneDrift.ts` (read-only).

## C. Instrument integrity — an instrument can be structurally dead

- [ ] **C1. Counters must observe the channel the signal actually uses.**
      Fixed 2026-08-17: the harness patched only `console.log`, but the engine
      emits `[SRZoneTier0] TIER0_UNAVAILABLE` (`srZoneTier0Service.ts:227`) and
      `TIER0_FALLBACK_TO_TIER1` (`signalEngine.ts:3594,3599`) via
      **`console.warn`**, which was never intercepted. `tier0Unavailable` was
      pinned at `0` for every run, so the harness's own
      "DEGRADED AND NOT COMPARABLE" guard could never fire.
      **A reported `TIER0_UNAVAILABLE = 0` from before this fix is meaningless.**
- [ ] **C2.** Any new counter is proven live by forcing the condition once and
      seeing it increment. A zero from an unproven counter is not evidence.
- [ ] **C3.** Guard clauses that gate a conclusion are themselves tested.

## D. Verification hygiene

- [ ] **D1.** Run artifacts written to a **repo path**, not `/tmp`. The sandbox
      clears `/tmp`; artifacts cited in a report must survive to be re-checked.
- [ ] **D2.** Claims quote file:line, not memory.
- [ ] **D3.** Distinguish "no evidence for" from "evidence against".
- [ ] **D4.** Data-dependent results carry the data snapshot (zone batch stamp,
      tape-end, row counts) alongside the number.

## E. Known live configuration (re-verify, do not trust)

- [ ] **E1.** `allowShortSignals` default is **FALSE** — SELLs are suppressed at
      the emission layer (`contexts/TradingContext.tsx:56`;
      suppression at `services/signalEngine.ts:7861`, shadow-write at `:7913`).
      Any SELL-side statistic therefore describes shadow records, not live trades.
- [ ] **E2.** `sr_zones_v1` visible to anon: 21 rows, 9 of which clear the 0.30
      consumer threshold (2026-08-17). Re-measure before use.
- [ ] **E3.** Sandbox engine copies under `expo/scripts/__sandbox_*/` are frozen
      forks and are NOT the live engine. Never cite them as live behaviour.

---

## Open / unresolved

- **Correction 6 (WS mean shift 0.4632 → 0.6372).** Code is excluded as the
  cause: `signalEngine.ts` was unchanged between the runs, and the only harness
  change (`1b3dfa9`) added two `console.log` lines. The surviving mechanism is
  **live zone drift (section B)** plus a **dead TIER0 counter (C1)** that hid the
  degradation. The shift is therefore **not attributable to any engineered
  improvement**, and the earlier framing of it as a verified gain is withdrawn.
  A clean re-measurement requires B1 (both runs in one zone batch) and the C1 fix.
