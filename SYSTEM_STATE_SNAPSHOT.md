# System State Snapshot — 2026-07-31

Durable record of the system's verified state after Steps 1-2 of the
SELL-suppression + data-venue unification build. A future session should
start from this ground truth, not re-derive it.

---

## 1. Unified Data Venue (Step 2 — the highest-value change)

**Before:** live generation's OHLC history (`highHistory`/`lowHistory`/`barCloseHistory` → `calculateRealATR()` → SL/TP sizing, session highs/lows, pivots, breakout detection) was sourced via REST from the **GC=F/TwelveData** chain (`fetchHistoricalData` → backend `goldPrice.getHistoricalData` route). This carried a confirmed **~$59 median basis (579 pips)** vs the Vantage `gold_m1_bars` used for audit/resolution/S-R zones. TwelveData's free-tier quota (800 credits/day) exhausted after ~13.3 hours, causing fallback to Yahoo **GC=F futures** for ~44% of trading hours — during which every trade's SL/TP was sized on a price ~590 pips from the bars that later audited its outcome.

**After (verified):** `fetchHistoricalData` (`expo/lib/trpc.ts`) now queries `gold_m1_bars` (Vantage MT5 / Exness XAUUSDm) from Supabase as the **PRIMARY** source. Generation and audit now share one spot-accurate, quota-free venue. The existing GC=F/TwelveData backend chain is preserved as a **fallback** for when Supabase is unreachable or has a stale/missing bar gap.

**Verified by** `expo/scripts/verifyBasisClosed.ts`:
- `fetchHistoricalData` returns bars tagged `vantage-mt5-supabase` (PRIMARY confirmed)
- Matched-minute basis vs audit venue (gold_m1_bars direct): **$0.0000 median, $0.0000 max** (n=119)
- Before-measurement: `expo/scripts/analyzeTwelveDataFallback.ts` — Pair 1 (TwelveData vs Vantage) $0.54 median; Pair 2 (GC=F vs Vantage) $57.93 median (n=108); fallback fires ~44% of day

**Stale-bar guard (Step 2c):** if the newest `gold_m1_bars` row is older than 5 minutes relative to `toTime`, the Supabase primary returns empty so the caller falls through to the GC=F/TwelveData fallback chain — stale bars are NEVER silently served as current. Threshold: `STALE_BAR_THRESHOLD_MS = 5 * 60 * 1000`.

**Array-alignment integrity:** the ATR array-misalignment fix (prior session) still passes — `expo/scripts/verify_item3_atr_array_misalignment.ts` 5/5 assertions green. `calculateRealATR` reads `prevClose` from `barCloseHistory` (bar-aligned), not `priceHistory` (tick-cadence).

**72h simulation:** before/after repoint both produce 13 BUY / 0 SELL (shorts suppressed). Signal count/timing unchanged in the sim because the sim harness uses synthetic sandbox bars that override `fetchHistoricalData` — it does NOT exercise the new Supabase primary. The real proof is the `verifyBasisClosed.ts` trace above. The repoint only affects the live app path, where the basis is confirmed $0.

**Telegram format:** untouched (`expo/services/telegramNotifier.ts` last modified before this build; no diff).

---

## 2. SELL Suppression (Step 1 — `allowShortSignals`) — VERIFIED

**Decision basis:** six read-only counterfactuals (retest-wait, zone-SL, fixed-120-SL, SELL-side filters, SELL entry-shift 70-pip, SELL entry-shift 45-pip). BUY consistently strong (EV +0.19R covered / +0.695R full sample); SELL structurally marginal (+0.033R covered). No tested treatment made retained SELLs genuinely profitable. Suppressing SELL entirely produced the highest whole-system EV (+0.1883R vs +0.0806R baseline).

**Implementation:**
- `allowShortSignals: boolean` (default **FALSE**) added to `Settings` — a toggle, not hardcoded removal. Gold's long bias is structural today but could change; flippable back on without a code change via Settings.
- Suppression at the **emission layer** (`signalEngine.ts:6450`), AFTER geometry is computed, BEFORE internal state mutations. The engine still fully scores and geometry-computes every qualifying SELL; when suppressed it returns `null` and does NOT mutate `lastSignalType`, `lastSignalTime`, `lastSellSignalTime`, `cooldown`, `active-signal lock`, or `signalsGeneratedCount`.
- BUY emission path is **byte-unchanged** — the suppression check only fires when `analysis.signalType === 'SELL'`.
- Zero executor changes: the MT5 Telegram executor simply receives fewer signals (zero SELLs).

**Shadow logging (durable — Design B, VERIFIED LIVE 2026-07-31, re-verified with live DB evidence):** suppressed SELLs are written DIRECTLY to `shadow_signals_v1` via the anon Supabase client (`expo/services/shadowSignalService.ts` → `createClient(url, EXPO_PUBLIC_SUPABASE_ANON_KEY)` → `.insert()`). This is Design B: the write goes straight to Supabase via the public anon key, which is RLS-permitted for INSERT. The service key (`SUPABASE_SERVICE_ROLE_KEY`) is NEVER used by the live engine path and is NEVER shipped to the browser — confirmed by grep (the key VALUE is absent from all source files; the key NAME appears only in `expo/backend/` server-only code and `expo/scripts/` Node-only scripts, neither of which is in the client bundle). The `EXPO_PUBLIC_SUPABASE_ANON_KEY` (which IS in the client bundle by design) is the only key the shadow write path uses.

**Design history (transparency):** Gate 1 was originally closed on Design A (server-side tRPC `shadow.push` route using the service key, anon DELIBERATELY denied insert). The design was later switched to Design B (anon direct insert) because both backend URLs were confirmed 503 ("no bundle deployed") for an entire prior session, and there is no deploy mechanism available in this environment for the Hono/tRPC backend. Design B removes that fragile dependency entirely. This switch was not announced at the time — it is documented here explicitly so the next session starts from verified ground truth, not a contradiction.

**RLS policy (migration `003_shadow_signals_anon_insert.sql`, VERIFIED LIVE by empirical test 2026-07-31):**
- anon/authenticated INSERT: ✅ ALLOWED (empirically confirmed — a row inserted via the anon key landed in the DB and was read back via service role)
- anon/authenticated SELECT: ✅ ALLOWED (empirically confirmed)
- anon/authenticated UPDATE: ✅ BLOCKED (empirically confirmed — anon update against a real row had no effect; entry stayed 4050.0, not 9999.0)
- anon/authenticated DELETE: ✅ BLOCKED (empirically confirmed — anon delete against a real row had no effect; row still existed on read-back)
- CHECK constraint enforces `direction = 'SELL'`

**Design B abuse surface (consciously accepted):** the public anon key IS shipped in the browser bundle, so anyone holding it can INSERT arbitrary rows into `shadow_signals_v1`. This is acceptable because:
1. `shadow_signals_v1` is a DIAGNOSTIC-ONLY table with zero operational impact on signal generation or trade execution.
2. Anon has INSERT + SELECT only — junk rows cannot MODIFY or DELETE existing data (empirically confirmed above).
3. The engine's `signal_id` format (`shadow-sell-<timestamp>-<random>` / `signal_<timestamp>_<random>`) is recognizable, so future analysis can filter by it.
4. Worst case is discardable noise, not data corruption or privilege escalation.
5. Design B removes the fragile dependency on the Freestyle backend staying deployed (it was 503 for a full prior session) — this is the tradeoff that justifies B over A.

The shadow record captures the full would-be geometry PLUS the +40pip entry-shift variant (77% fill rate in counterfactual) so every tested SELL alternative stays monitorable against real forward data.

**Verified by (all real, pasted evidence from re-verification 2026-07-31):**
- `expo/scripts/verifyGate1Reconciliation.ts` — empirical live DB test: anon INSERT succeeded (row id=17 landed, read back via service role), anon SELECT works, service-role INSERT works as control. Existing real rows confirmed (5 rows from live suppression).
- `expo/scripts/verifyAnonUpdDel.ts` — anon UPDATE against real row: entry stayed 4050.0 (not 9999.0) → BLOCKED. anon DELETE against real row: row still exists → BLOCKED.
- `expo/scripts/verifyRealExport.ts` — generates a REAL diagnostics export via `buildDiagnosticsExportText` with the SAME inputs the app uses. SECTION 6 renders with real data: 6 suppressed SELLs, session/HTF breakdowns, aggregate geometry, 6 most recent records. Write-path counters render: `successes: 1, failures: 0`. The shadow summary is fetched via the backend tRPC `shadow.summary` route (now 200 OK — backend is deployed as of this verification).
- `expo/scripts/verifyShadowFailure.ts` — forces a REAL shadow-write failure by pointing `pushShadowSellRecord` at a bad URL: `shadowWriteFailures` incremented 0→1, greppable warning `[ShadowSell] SHADOW_WRITE_FAILED (fire-and-forget): ...` fired. Both confirmed through the actual code path, not a stub.
- Service key leak check: grep for key VALUE (first 20 chars) across all source files = 0 matches. Grep for key NAME in client-shipped code (contexts/services/app/components/lib) = 0 matches. Only the anon key (`EXPO_PUBLIC_SUPABASE_ANON_KEY`) appears in client code (`shadowSignalService.ts`, `lib/supabase.ts`, `lib/trpc.ts`).
- `expo/scripts/verifyGate1ShadowLivePath.ts` — prior verification: fires the REAL `pushShadowSellRecord`, row `gate1-designB-1785483623094` landed with all fields matching.
- `expo/scripts/test_sell_suppression.ts` — 26 assertions, all PASS: suppressed SELL returns null + no state mutation; allowed SELL emits + mutates state; BUY unaffected by toggle; BUY emits immediately after suppressed SELL (no cooldown consumed).
- 72h sim: shorts-suppressed = 13 BUY / 0 SELL; shorts-allowed = 12 BUY / 17 SELL (BUY count 12→13 is the expected consequence — suppressed SELLs free active-signal slots for BUYs).

**Write-path failure visibility (durability, VERIFIED LIVE 2026-07-31):** the shadow write is fire-and-forget and never blocks generation, but a failure is NOT silent. On insert failure or throw, `pushShadowSellRecord` (a) logs a distinct, greppable warning tagged `[ShadowSell] SHADOW_WRITE_FAILED` / `SHADOW_WRITE_ERROR`, and (b) increments an in-memory counter (`shadowWriteFailures` in `shadowSignalService.ts`). Both `shadowWriteFailures` and `shadowWriteSuccesses` are surfaced in the diagnostics export — SECTION 6 prints the counts at the top of the shadow section, with an explicit ⚠ alert line and remediation instructions when `shadowWriteFailures > 0`. **Verified by `verifyShadowFailure.ts`:** a forced failure (bad Supabase URL) through the real `pushShadowSellRecord` path incremented `shadowWriteFailures` 0→1 and emitted the `[ShadowSell] SHADOW_WRITE_FAILED` warning. The counters reset on app reload (they are process-lifetime, not persistent — by design, since they monitor the current process's write path).

**Backend deployment status (2026-07-31):** the backend tRPC routes are now responding 200 OK (previously 503 "no bundle deployed" for an entire prior session). The backend deployment state is known to FLAP — it was down for a full prior session and is up now, with no deploy mechanism available in this environment to guarantee it stays up.

**Known limitation — summary display depends on the backend (write path does NOT):**
- The shadow **WRITE path** is backend-independent (Design B writes directly via the anon key to Supabase). A backend outage does NOT stop shadow records from landing in `shadow_signals_v1`.
- The shadow **failure/success COUNTERS** (`shadowWriteFailures` / `shadowWriteSuccesses`) are client-side in-memory and also backend-independent — they render in SECTION 6 of the diagnostics export regardless of backend state.
- The shadow **SUMMARY display** (count, date range, session/HTF breakdown, recent records) is fetched through the backend tRPC `shadow.summary` route. During a backend outage this section will show **null/empty** even though real rows ARE being written to the table.
- **Source of truth during a backend outage:** if the export's SECTION 6 summary is null but the write-path counters show `successes > 0`, do NOT conclude logging is broken. Query `shadow_signals_v1` directly (the liveness check SQL in section 4 below) — THAT is the source of truth, not the export's summary section. The summary is a convenience display, not the durable record.

---

## 2b. TIER_0 S/R ZONES — SCHEDULED REFRESH IS LIVE (2026-08-01)

**Status: LIVE.** A Supabase Edge Function (`refresh-sr-zones`) computes zones
from `gold_m1_bars` and writes to `sr_zones_v1` on a pg_cron schedule. NO Rork
backend anywhere in the path — pg_cron fires `net.http_post` to the Edge Function,
which reads bars and writes zones via the service role key auto-injected by
Supabase. No client needs to be open. No manual script needs to be run.

**Architecture (Option 4 — Edge Function + pg_cron + pg_net):**
- Edge Function: `backend/functions/refresh-sr-zones/index.ts` (Deno TypeScript)
  - Ported `computeZonesFromBars` verbatim from `srZones.ts`
  - B2(b) pagination fix: paginates bar fetch (6,524 bars retrieved, >>1000)
  - B2(c) dedupe fix: dedupes by (price, type) before write
  - B2(c) upsert-then-prune: upserts first, then prunes stale rows — a failed
    write leaves the previous cache intact (not empty)
  - Deployed at: `https://tcbnqmnzsnjhqkyuhrch.supabase.co/functions/v1/refresh-sr-zones`
- Schedule: pg_cron job `refresh-sr-zones` at `5 */4 * * *` (every 4 hours at :05)
  - Calls `net.http_post` to the Edge Function URL
  - `timeout_milliseconds := 30000`

**Verified by direct DB evidence (2026-08-01):**
- pg_cron 1.6.4 and pg_net 0.20.3 confirmed installed via `pg_extension` query
- `cron.database_name = 'postgres'` confirmed
- Two scheduled runs confirmed in `cron.job_run_details`:
  - jobid=4, runid=4, 08:16:00 UTC, status=succeeded
  - jobid=4, runid=5, 08:18:00 UTC, status=succeeded
- `sr_zones_v1` after each run: 24 rows, 17 with reactionStrength >= 0.3,
  all `updated_at` = run timestamp, max(last_touch_ts) = 2026-07-31T20:56Z
- Edge Function manual test: `barsFetched=6526, rawZones=25, dedupedZones=24,
  upserted=24, overThreshold=17`
- Schedule switched from 2-minute test to production `5 */4 * * *` — confirmed
  no 2-minute run fired after the switch

**What is also live (unchanged from prior):**
- `expo/services/srZoneTier0Service.ts` — client reads `sr_zones_v1` DIRECTLY from
  Supabase via the anon key (B2(a)). Backend-independent.
- TIER_0 failure visibility counters + greppable warnings + diagnostics export
  section (B2(c)).

**What is NOT live (dead code on the 503 backend):**
- `expo/backend/trpc/routes/srZones.ts` — the pagination + dedupe + upsert-then-prune
  fixes are duplicated in the Edge Function, which IS live. The backend code is
  retained as a reference but is NOT in the critical path.

**Expiry note:** zones currently have `max(last_touch_ts) = 2026-07-31T20:56Z`
(Friday close). The 4-hour schedule will refresh with Monday's bars when the
market reopens Sunday ~22:00Z, so `last_touch_ts` will advance. PRICE_ACTION
zones older than EXPIRY_HOURS=96 are filtered at read time; ALWAYS_FRESH sources
(PREV_DAY, PIVOT, WEEKLY) are recomputed fresh each run and never expire.

**LIVENESS CHECK — repeatable:**
Query `cron.job_run_details` for recent `refresh-sr-zones` runs:
```sql
SELECT runid, jobid, status, start_time, end_time, return_message
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.jobs WHERE jobname = 'refresh-sr-zones')
ORDER BY start_time DESC LIMIT 5;
```
Or check `sr_zones_v1.updated_at` — if it's within 4 hours of now, the schedule
is running.

---

## 2c. THE SIMULATION HARNESS IS NOT REPRODUCIBLE ACROSS SESSIONS (2026-08-02)

**Recorded because it was nearly used as evidence.** `expo/scripts/runSignalSimulation.ts`
produces DIFFERENT signal counts for the SAME git HEAD in different sessions: one
session gave 5 signals over a 72h window, another gave 8 signals over a 24h window.
A 24h run producing MORE than a 72h run cannot be a duration effect, so the harness
carries session-dependent state (synthetic sandbox bars / seeding) that is not pinned.

**RULE, binding from now on:** simulation counts may ONLY be compared WITHIN a single
session, before-vs-after, both runs executed back to back (e.g. `git stash` to HEAD,
run, restore, run). A simulation count quoted from a PRIOR session is not a baseline
and must never be used as an absolute reference. The Item F comparison (8 -> 10 signals,
10 -> 34 engine-successful runs, median confidence 72.3 -> 80.4) satisfies this rule and
stands; the "recover from 2" figure from an earlier session does not and was withdrawn.

---

## 3. SELL SUPPRESSION — HISTORY, CORRECTION, AND CURRENT STATE

**CURRENT STATE (2026-08-02): `allowShortSignals` is ON. Toggled by the user.**

Rationale on record: the suppression rested on SELL at 21.7% WR, which was the
`SL_AFTER_BE` labelling bug, not a real result. On bar-verified outcomes SELL is
63.2% WR / +0.0093R / PF 1.03 — break-even, which is a reason to MEASURE, not to
suppress. The Item F6 forward criteria (emission rate per market-open hour, the
RANGING-regime check, the RSI distribution check) cannot be evaluated with half the
direction space muted.

**CAVEAT THAT MUST TRAVEL WITH THAT NUMBER:** the SELL +0.0093R figure was measured on
signals generated by the OLD TICK-DRIVEN engine. The post-Item-F directional layer is
bar-sourced, so the post-F SELL population is UNMEASURED. +0.0093R is not a forecast
for it.

### 3a. Item 5's original numbers were WRONG and are superseded

Item 5 (2026-08-01) reported bar-verified `ALL n=369 WR=63.1% PF=1.82 EV=+0.3019R
net=+$581.6`. The WIN RATE was right; the EV was inflated ~5x because Item 5 used a
MIRROR of the resolver that exited at the furthest target reached and had no post-TP1
lock and no protected exit. The CANONICAL figures, produced by the REAL
`resolveSignalWithBars` (imported, not reimplemented) with `{ fromScratch: true }` and
the R>0 predicate over all 369, are:

```
ALL:  n=369  WR=63.1%  PF=1.16  EV=+0.0605R  net=+$111.2
BUY:  n=157  WR=63.1%  PF=1.35  EV=+0.1287R
SELL: n=212  WR=63.2%  PF=1.03  EV=+0.0093R
status decomposition: SL_AFTER_BE=137  SL_HIT=136  ALL_TARGETS_HIT=76  PARTIAL_WIN_SL_HIT=20
```

**The true edge is THIN.** Equal win rates, but PF 1.35 vs 1.03 — BUY carries the book
and SELL is break-even. Any figure in this file or in prior reports quoting EV +0.3019R,
+0.3344R or +0.2579R is from the mirror and is superseded by the above.

---

## 3b. ITEM 5 — ORIGINAL RE-TEST (SUPERSEDED, kept for provenance)

**MEASUREMENT ONLY at the time. Numbers below are the MIRROR's and are WRONG — see 3a.**

Re-resolved all 369 export signals against real gold_m1_bars via fromScratch.
206 of 369 (55.8%) changed status vs old-stored outcomes — the old outcomes
were resolved under corrupted paths (false SL_HIT, GC=F basis, ATR
misalignment, phantom resolvedAtBarTs).

**Bar-verified results:**
```
ALL:  n=369  WR=63.1%  PF=1.82  EV=+0.3019R  net=+$581.6
BUY:  n=157  WR=63.1%  PF=1.70  EV=+0.2579R  net=+$236.1
SELL: n=212  WR=63.2%  PF=1.91  EV=+0.3344R  net=+$345.5
```

**Old-stored (for comparison):**
```
BUY:  n=157  WR=57.3%
SELL: n=212  WR=21.7%
```

**VERDICT: The evidence NO LONGER SUPPORTS suppressing SELL.**
Both BUY and SELL are profitable on bar-verified data. SELL is actually
slightly MORE profitable than BUY (+0.3344R vs +0.2579R). The original
suppression decision was based on old-stored outcomes where SELL WR was
21.7% — but 55.8% of those were resolved under corrupted paths. On clean
bar-verified data, SELL WR is 63.2%, essentially identical to BUY.

**No change made at the time.** Superseded: the EV figures here are mirror artifacts
(see 3a) and `allowShortSignals` has since been turned ON by the user (see 3).

---

## 3c. ITEM D — TP LADDER SWEEP: NO LADDER ADOPTED (2026-08-02)

**READ-ONLY. Nothing was implemented. Both pre-registered guards failed.**

400 cells (176 coarse + 224 fine), every cell re-resolving all 369 signals through the
REAL resolver — 147,600 resolutions. Axes: TP1 as R-multiple AND as absolute pips, lock
as a fraction of TP1 (0.3/0.4/0.5) and the incumbent 0.35xR, the 0.9xTP1 cap on/off, and
TP2/TP3 held-absolute vs scaled-with-TP1.

- **PLATEAU: FAIL.** The pooled optimum's `tp23` neighbour is 36% away (+0.1825R ->
  +0.1177R), far outside the pre-registered 20% band.
- **STABILITY: FAIL.** H1's optimum is `TP1 1.00R / scaled`; H2's is `45p / abs`. The two
  chronological halves want different parameterisations, not merely different values.
- **THE OPTIMUM IS A GRID-EDGE ARTIFACT.** EV rises monotonically past the mandated
  1.00R ceiling all the way to 5.00R (+0.3942R). The sweep is not locating an optimum;
  it is expressing a monotone preference for wider targets on a trending sample.
- **THE MECHANISM IS BACKWARDS.** The "optimum" produces ZERO full-loss -> locked-win
  conversions and 47 win -> full-loss reversions; WR falls 63.1% -> 50.4%. Its entire
  gain comes from WIN -> WIN signals paying more (+0.2925R) partly offset by the
  reversions (-0.1704R). It does not exercise TP1's lock-arming role at all.

**The lock 0.35xR -> 0.20xR finding: NOT a clean single-axis win. DO NOT PICK IT UP.**
At the LIVE ladder, changing only the lock from 0.35xR to 0.20xR gives EV +0.0784R vs
+0.0605R with WR unchanged at 63.1%. It was originally reported as "the one genuinely
non-structural finding." **That framing was wrong and is corrected here:** a lock closer to
entry leaves more room after TP1, so trades run longer — which is the SAME mechanism as
wider targets letting trades run longer. Both are flattered by the same trending sample. It
is a smaller expression of the identical artifact that failed the plateau and stability
guards, NOT an independent result. NOT adopted, and it must not be re-adopted on this
sample by a future session treating it as a clean single-axis improvement.

**The resolver now carries an optional `ladder` sweep hook** (`LadderOverride` in
`expo/services/signalResolver.ts`). Every field is optional and every default reproduces
live behaviour exactly — proven by the canonical set reproducing WR 63.1% / EV +0.0605R
and the identical 137/136/76/20 decomposition after the hook was added. Nothing in the
live app passes it; grep-verifiable that `ladder:` appears only under `scripts/`.

---

## 3d. FORWARD MONITORING IS LIVE (2026-08-03)

Every remaining question is answerable only by forward data, so the F6 criteria are now
evaluated by a script rather than by hand.

- `expo/scripts/forwardMonitor.ts` — evaluates all six F6 criteria. Reads `gold_m1_bars`
  DIRECTLY from Supabase (anon key), resolves with the REAL `resolveSignalWithBars`
  `{ fromScratch: true }`, R>0 predicate, canonical definition printed once in the header.
  Every criterion prints its PRE-REGISTERED refutation threshold, the current value, and a
  power verdict; an underpowered criterion prints UNDERPOWERED, never a pass or a fail.
  Also prints forward MFE/MAE p25/50/75 against the pre-F reference (MFE24
  2.32/6.45/11.83, MAE24 2.41/5.94/12.30) — Item D's stated transfer test.
  Usage: `bun run scripts/forwardMonitor.ts --forward /tmp/forward_export.txt`.
- **Telemetry added to make criteria 2, 3 and 4 evaluable at all** (additive, no scoring
  path touched): each signal now exports a `forward telemetry:` line (rsi, regime,
  regimeStrength, atr, htf, adx — all already on `learningContext`, previously never
  exported), and a new SECTION 8 exports the bar-layer readiness/stand-aside counters from
  `signalEngine.getDirectionalLayerStats()`. An export lacking these parses as
  NOT INSTRUMENTED, which is deliberately distinct from zero.
- `expo/scripts/test_forward_monitor_parsers.ts` — 14/14, writer<->parser contract proven
  against the REAL `buildDiagnosticsExportText`, including that an export without the
  counters parses as null rather than 0/0.

---

## 3e. TELEGRAM DELIVERY IS OFF THE RORK BACKEND (ITEM 6, 2026-08-04)

**LIVE.** Delivery path is now:
`client --(anon key)--> Supabase Edge Function send-telegram-alert --> api.telegram.org`.
No Rork backend anywhere. `TELEGRAM_BOT_TOKEN` is a Supabase SECRET (set via
`supabase secrets set`, digest visible in `supabase secrets list`), so it stays
server-side; the client holds only the public anon key.

**Durable outbox, not more retries:** every alert is first PERSISTED to
`telegram_outbox_v1` (anon INSERT + SELECT via RLS; UPDATE/DELETE denied and
empirically verified blocked), then dispatched. Delivery state is mutated only by
the Edge Function with the service role. A pg_cron job `drain-telegram-outbox`
(`* * * * *`, pg_net -> Edge Function, same architecture as `refresh-sr-zones`)
retries PENDING rows until DELIVERED or AGED_OUT, so delivery no longer depends on
the client being open.

**Aging horizon = 10 minutes, DERIVED not assumed** (`expo/scripts/measureAlertAgingHorizon.ts`,
40,000 anchor minutes of gold_m1_bars): P(price still touches the +/-$2.0 entry
band at t0+D) = 100% @1m, 95% @2m, 88% @3m, 76% @5m, 59.7% @10m, 50.4% @15m,
27.7% @60m. At 10m an alert is about as likely to be unexecutable as executable,
so delivery stops rather than pushing the executor into a stale trade.

**Live evidence (2026-08-04):** 12/12 availability probes HTTP 200; 3/3 real
end-to-end sends delivered to BOTH chats (`attempts:1`, chat status 200/200,
1.37-2.23s); a row inserted via the ANON key with `expires_at` in the past was
marked `AGED_OUT` by the cron drain inside 60s with no client involvement; anon
UPDATE and DELETE against that row affected 0 rows.

**Message format is byte-identical** to the pre-Item-6 format and the chat IDs are
unchanged, so the MT5 executor needs ZERO changes (asserted in
`test_telegram_delivery_counters.ts`, 17/17).

## 3f. ITEM 7 — THE 413-vs-5 SHADOW DISCREPANCY WAS NOT THE BACKEND (2026-08-04)

The premise was that SECTION 6 reported 5 rows because the summary was fetched
through the 503-prone backend. MEASURED: `shadow_signals_v1` holds 413 rows, but
**408 of them are from 2026-03** and only **5 fall inside the section's 30-day
window** (service-key `count exact` = 413 all-time / 5 last-30d; the anon direct
read returns exactly 5). SECTION 6's "5" was CORRECT. The read was repointed
directly at Supabase anyway (DATA-SOURCE RULE + a real latent 1000-row PostgREST
cap, now paginated), but no under-reporting bug existed. The retired backend route
was observed returning 200 then 503 within a single script run — the flap is real,
it just was not the cause here.

## 3g. ITEM 9 — THE EXPORT ARTIFACT IS OFF THE RORK BACKEND (2026-08-04)

**LIVE.** `Settings > Export Diagnostics` now publishes DIRECTLY to Supabase Storage
via the anon key: `expo/services/diagnosticsExportStore.ts` ->
bucket `diagnostics`. No Rork backend anywhere. The retired path
(`diagnostics.saveExport` + `GET /api/export/latest`) stored the artifact in a
PROCESS-LIFETIME in-memory variable on the 503-prone backend — a flap or a
restart could deny the whole evidence base.

**Design choice — Storage object, not a table row.** A table row must be read
back through PostgREST, which returns JSON-escaped content; the artifact is
plain text read by humans and parsed by `forwardMonitor.ts`. A Storage object
serves the exact bytes as `text/plain`.

**Staleness is eliminated structurally, not by cache headers.** Each export is
written to an IMMUTABLE `exports/<iso>.txt` object and THAT url is handed to the
user; `latest.txt` is a mutable pointer for tooling and is the only object anon
may overwrite (RLS restricts UPDATE to `name = 'latest.txt'`).

**Live evidence (`expo/scripts/probeItem9ExportPath.ts`, 18/18 PASS):** sha256 of
the published 21,402-byte payload identical on read-back for both the archive and
`latest.txt`; `content-type: text/plain`; 12/12 reads HTTP 200; a SECOND export
left the first archive URL byte-identical; anon DELETE removed 0 objects; anon
upsert over an archive returned `new row violates row-level security policy` and
the content was preserved; both archives reconciled via the service key.

**Migration:** `004-diagnostics-export-storage` (bucket + 3 policies, additive).

## 3h. ITEM 10 — THE 408 MARCH ROWS ARE SIMULATION OUTPUT (2026-08-04)

**RESOLVED. Not timestamp corruption. Nothing deleted.** The 408 rows dated
2026-03-18/19 in `shadow_signals_v1` were written by
`expo/scripts/runSignalSimulation.ts`, whose fake clock starts at
`SIMULATION_START_MS = Date.UTC(2026, 2, 17, 20, 0, 0)` = **2026-03-17T20:00:00Z**
(month index 2 = March) and advances in `STEP_MS = 30_000` steps over a synthetic
~$3010-3055 price band.

Measured (`expo/scripts/investigateItem10Reconcile.ts`, read-only, service key):
- 408/408 March `created_at` values lie exactly on the 30-second grid anchored to
  `SIMULATION_START_MS`; 0/5 of the real July rows do.
- 408/408 offsets are >= the 1.5h warmup; max offset 48.89h (a 48h+ sim run).
- 408/408 have `signal_id` embedded epoch === `created_at` exactly.
- 408/408 entries fall in $3023.7-3054 while `gold_m1_bars` holds **0 rows** in
  March 2026 (coverage starts 2026-06-18, close 4272.17).
- MARCH ATR p50 = 0.2 vs live p50 = 4.3 — the synthetic series is far smoother.
- Serial ids: the 5 real July rows are ids 12-16; the March-dated rows are ids
  **21-428 contiguous**, i.e. INSERTED AFTER them.

**10(b) — `created_at` is SIGNAL-DERIVED, not insert-time.** The column has
`DEFAULT now()` (migration 001) but the client OVERRIDES it:
`shadowSignalService.ts:114` writes `created_at: new Date(r.createdAt).toISOString()`.
So any harness with a faked clock stamps its own time into a durable table.
This is by design for real signals (the signal's own creation instant is the
useful key) but it means **the table cannot distinguish live rows from harness
rows by time**. Filter by `id > 16`, or by price band, until a provenance column
exists. NO provenance column exists today — reported, not fixed.

## 3i. ITEM 11 — learning.getOutcomes IS BACKEND-DEPENDENT (2026-08-04, NOT FIXED)

`learningStore.hydrateFromRemote()` reads the durable corpus through
`trpcClient.learning.getOutcomes` — the Rork backend. On failure it catches,
`console.warn`s and returns `{ available: false, pulled: 0 }`; `signalEngine`
logs nothing when `available === false` and proceeds with the LOCAL tier only.
On web the local tier is an in-memory array wiped on every reload, so a 503 at
startup means the model can train on an EMPTY or truncated corpus with no error
in the export.

Live probe (`expo/scripts/investigateItem11LearningRead.ts`): the API_BASE_URL
origin returned 200 12/12 with real outcome rows; the FUNCTIONS_URL origin
returned `503 no bundle deployed` 12/12. `trade_outcomes_v1` holds **51 rows**
(WIN 24 / LOSS 27, BUY 23 / SELL 28, schema v2 20 / v1 31) and **anon SELECT can
read all 51**, so a direct repoint needs no new policy.

**NOT IMPLEMENTED — proposal only.** No telemetry records the corpus size used at
training, so whether a given `model_weights_v1` came from a truncated corpus is
UNKNOWABLE from current artifacts (rule 8). Retrain requires >= 20 outcomes.

**SUPERSEDED BY ITEM 12 (below) — the read is now direct, paginated and counted.**

## 3j. ITEM 12 — THE LEARNING-CORPUS READ IS OFF THE RORK BACKEND (2026-08-04)

**LIVE.** `learningStore.hydrateFromRemote()` now reads `trade_outcomes_v1`
DIRECTLY from Supabase via the anon key, PAGINATED at 500 rows/page
(`fetchRemoteOutcomesDirect`). The retired `trpcClient.learning.getOutcomes`
call is GONE from the shipped code (only the doc header names it, and the test
asserts on comment-stripped source so a comment can never pass for a call).

**Writes deliberately unchanged.** `pushOutcomesToRemote` still goes through the
service-role backend route, so the training corpus stays un-poisonable by anyone
holding the public anon key. Proven live: anon INSERT rejected with `new row
violates row-level security policy`; anon UPDATE and DELETE against a real row
affected 0 rows and left `pnl` byte-identical.

**Truncation is PROVEN, not inferred.** When a pull fills the caller's limit the
reader issues a 1-row probe past the window; inferring truncation from "the last
page was full" reported a corpus that exactly drains the limit as truncated (a
false alarm the unit test caught before it shipped).

**Durable counters (ITEM 12(d)).** `learning_corpus_counters_v1` in AsyncStorage,
same pattern as the telegram counters (ADD-on-hydrate, never assign, so a hydrate
that completes before the counters load is not discarded):
`hydrateAttempts / hydrateSuccesses / hydrateUnavailableCount / lastPulled /
lastPages / lastTotal / lastTruncatedByLimit / lastUnavailableReason`.
They reconcile mechanically: attempts = successes + unavailable. Rendered inside
SECTION 2 of the export; a caller that supplies nothing renders NOT INSTRUMENTED,
which is deliberately distinct from zero.

**Weight provenance (the 11(b) forward fix).** `retrainModel` now persists
`corpusSizeAtTraining` and `hydrateUnavailableAtTraining` alongside the weights,
and SECTION 2 prints both. A vector that predates this telemetry prints UNKNOWN,
never 0 — provenance-unknown and trained-on-zero are different claims.

**Live evidence (`expo/scripts/probeItem12CorpusReadPath.ts`, 11/11 PASS):**
12/12 anon reads OK (185-950ms); anon count 51 === service-key count 51; the REAL
production reader returned all 51 rows oldest-first with 0 duplicates in 249ms;
limit=25 produced `truncated=true`, limit=51 produced `truncated=false`; the
retired backend route returned **503 on BOTH origins 8/8** at the same moment the
new path was serving 200s — which is exactly why it is no longer on this path.

**Unit evidence:** `expo/scripts/test_item12_learning_corpus_direct_read.ts`
22/22 (1200-row corpus pulled across 3 pages, no page >500, oldest-first, no
duplicates, unavailable read counted + local corpus untouched, counters survive a
simulated reload, export renders provenance). `test_durable_learning_store.ts`
still 26/26 after its sandbox was extended to stub the new imports.

## 3k. ITEM 13 — PROVENANCE COLUMN: BACKFILL RULE VERIFIED (SPEC ONLY, NOT BUILT)

Measured by `expo/scripts/investigateItem13ProvenanceBackfill.ts` (read-only):
- `shadow_signals_v1`: 413 rows, ids 12..428. Rule A (`id > 16` => SIMULATION)
  and Rule B (entry inside the synthetic $2900-3200 band => SIMULATION) agree on
  **413/413 rows (100.0%), zero disagreements** — 5 LIVE, 408 SIMULATION. The
  brief's precondition is satisfied, so `id > 16` is safe as the backfill rule.
- Independent third check: `gold_m1_bars` holds **1257 rows on 2026-07-31** (the
  LIVE rows' date) and **0 rows on 2026-03-18** (the SIMULATION rows' date).
  NOTE for future sessions: `gold_m1_bars.timestamp` is an **ISO timestamptz, NOT
  epoch ms**. Filtering it with epoch integers returns 0 rows for the WRONG
  reason — the first run of this script did exactly that and would have reported
  a fake corroboration.
- `trade_outcomes_v1`: 51 rows, **0 inside the simulation band**, and there is NO
  serial id column — so the `id > N` rule does NOT transfer. It does carry a
  separate DB-default `created_at` (e.g. `2026-07-29T21:02:10.558Z`) alongside the
  signal-derived `ts`, which is the split Item 13 proposes for `shadow_signals_v1`.

**NOT BUILT. No migration run.**

## 3l. CODE FREEZE FOR THE FORWARD MEASUREMENT WEEK (2026-08-05)

**FREEZE POINT: `d7fc9dfbd0ded6c948e97255831afa526299f5c7` (`d7fc9df`), branch `main`,
2026-08-04 20:53:59 +0000.** At freeze, `git status` showed **0 dirty files outside
`.rork/history/`** (agent transcripts, not app code), so the whole app is
attributable to that one commit. This section itself is a doc-only commit made
after the freeze; it changes no runtime code and does not move the freeze point.

**QUEUED, DELIBERATELY NOT BUILT during the week:**
- **ITEM 13** (provenance `source` column). Specced + backfill rule verified
  413/413. Risk is DORMANT: `runSignalSimulation.ts` is a manual script that
  cannot run on its own. A migration on two production tables during the
  measurement week adds change-risk to the exact period being measured.
- **ITEM 8** (rejection-reason telemetry). Criterion 4 already has a real
  denominator from the durable SECTION 8 counters, so Item 8 is not required to
  evaluate this week.

**AUTHORISED work during the week:** diagnosis of exports only, plus any
STOP-AND-FIX condition actually firing. If a fix lands mid-week the forward
sample SPLITS: record the new commit here, the UTC instant it went live, and
re-baseline every counter, because the durable counters accumulate across the
install lifetime and will otherwise mix two code states in one rate.

## 3m. ITEM 14 — CRITERION-4 THRESHOLD CONFLICT RESOLVED (2026-08-05)

**THE THRESHOLD IS 5%, NOT 25%.** Resolved in favour of the artifact, not the prose.

- `5` is the PRE-REGISTERED value and exists in three places in the repo:
  `expo/scripts/forwardMonitor.ts:75` (`standAsideRatePct: 5` — the value actually
  evaluated), `expo/services/diagnosticsExport.ts:541` (the printed line), and
  `expo/services/signalEngine.ts:1135` (the counter's own doc comment).
- `25%` exists NOWHERE in the repo. `grep -rn "25%"` across forwardMonitor,
  diagnosticsExport and signalEngine returns only an unrelated ATR band and an
  unrelated win-rate log. It originated in agent chat prose and was never
  pre-registered. Adopting it would have been a 5x post-hoc loosening of a live
  threshold (rule 1). **Any stop-condition table quoting 25% is WRONG.**

**They measure the SAME quantity** — numerator `standAsides`, denominator
`checks`, both from SECTION 8. No change to the number was needed.

**The denominator label "market-open attempts" is CORRECT — verified, not
assumed.** `isDirectionalLayerReady()` (`signalEngine.ts:2154`) has exactly ONE
call site, `generateSignal()` at `signalEngine.ts:6977`, and
`TradingContext.tsx:2619` returns BEFORE that call when the market is closed
(`if (!outlook.isMarketOpen) { ... return; }`; generation is at :2668).
Closed-market minutes therefore enter NEITHER the numerator nor the denominator.
This mattered: had the counter been unconditional, every weekend check would have
been a stand-aside (stale bars) and pushed the rate toward 100%, guaranteeing a
false REFUTATION at any threshold below ~30%.

**TWO STALE LABELS — REPORTED, NOT FIXED (freeze):**
1. `signalEngine.ts:1137` still says the counters are "Process-lifetime … they
   monitor the CURRENT process, not history." ITEM 4 made them DURABLE. Comment
   stale, code right. NOT edited — moving `signalEngine.ts` mid-freeze for a
   comment is not worth the split.
2. SECTION 8 prints `Readiness checks this process:` — stale for the same reason.
   NOT edited **deliberately**: `parseStandAside()` (`forwardMonitor.ts:160`)
   matches that exact string and every archived export in `diagnostics/exports/`
   carries it, so renaming it would break the parser against historical
   artifacts. The section's own ITEM 4 lines already state the counters are
   durable, so the export self-corrects in place.

**FIXED (read-only script, string-only):** `forwardMonitor.ts` criterion 4 used to
print "counters are process-lifetime. They reset on app reload … read them from an
export taken after a long session." That was the dangerous one — it advised the
OPPOSITE of the truth. Because the counters are cumulative across the install
lifetime they cannot be windowed after the fact, so the pre-week baseline MUST be
subtracted from BOTH numbers to judge one code state. Replaced with the corrected
denominator statement plus the baseline-subtraction requirement.
`test_forward_monitor_parsers.ts` still 14/14 after the edit.

## 3n. ITEMS 17-19 — FREEZE BROKEN DELIBERATELY (2026-08-05)

**PARENT COMMIT (pre-change): `0c91885d1f8a69f3891712f6ce27707e584167a7`,
`main`, 2026-08-05 07:46:26 +0000.** The new commit hash is created by the
platform sync AFTER this turn, so it is NOT yet knowable here and must be
recorded, together with the UTC instant the reloaded client first ran it, plus
the pre-split counter values. **The forward sample SPLITS at that instant.**

**RUNTIME CODE CHANGED — exactly one file, `expo/services/signalEngine.ts`:**
- `lastRealPriceObservedAt` / `lastRealPriceSource` (new module vars), written
  ONLY by `markPriceSuccess` (real fetch) and `setExternalPrice` (real tick).
  Deliberately NOT written by the cache/stale replay branches.
- `ENTRY_ANCHOR_MAX_AGE_MS = 60s`, `REPLAYED_PRICE_SOURCE_MARKERS`.
- ITEM 17b guard in `generateSignal()`, BEFORE `calculateMarketFeatures()`.
- ITEM 17c unconditional geometry gate, BEFORE the returned signal literal.
- 4 counters + `getEntryAnchorGateStats()`.
No resolver, scoring, gate, telegram or write path was touched. Items 13, 8 and
all of 19 remain UNBUILT.

### 17a — the entry anchor had NO freshness check (the real defect)
`signalEngine.ts:7338 const entryPrice = this.currentPrice`. The only freshness
notion was `now - lastFetchTime` (`:6955`), and **`updateCurrentPrice()` resets
`lastFetchTime = Date.now()` at `:1555` even when `fetchLiveGoldPrice()` REPLAYED
a cached quote** (`:1064` up to 600s, `:1071` unbounded age). The age clock is
reset on a stale quote, so an arbitrarily old anchor reports as fresh. Bar layer
had `BAR_MAX_AGE_M1_MS = 3min`; the anchor had nothing.

### 17d/17e — measured on the LIVE export + LIVE gold_m1_bars (anon direct)
`expo/scripts/investigateItems17to19.ts`, 392 signals, 379 with a bar at their
generation minute, 38053 bars.
- Anchor-vs-Vantage divergence: p50 $0.61, p90 $2.13, p95 $2.73, p99 $5.32,
  max $11.68. Signal [4] at $7.95 is p99.7 — a genuine tail event, not basis.
- **17c would have rejected 11 of 379 (2.90%)** — already at/past TP1 at their
  own generation minute. Stored outcomes: **7 ALL_TARGETS_HIT**, 2
  PARTIAL_WIN_SL_HIT, 1 SL_HIT, 1 SL_AFTER_BE. So the gate costs mostly
  *recorded wins* — wins that were unwinnable as specified (see 18).
- Anchor AGE is NOT INSTRUMENTED historically, so 17b's rejection count is
  NOT retrospectively measurable (rule 8). Divergence is a different quantity
  and was not substituted for it.

### 18 — THE RESOLVER CREDITS UNTAKEABLE SIGNALS (confirmed, MATERIAL)
`signalResolver.ts:180` `const crossedTp1 = isBuy ? bar.high >= signal.tp1 : ...`
OR-ed into the entry confirmation at `:185`.
- **12 of 379 signals were confirmed ONLY via `crossedTp1`, never touching the
  entry zone. ALL 12 are stored ALL_TARGETS_HIT, mean +1.4000R.**
- EV including them **+0.0778R** (n=379); excluding them **+0.0346R** (n=367).
  **Removing them costs -0.0432R — 56% of the measured EV comes from 12 trades
  that could never have been entered as specified.**
- Baseline reconciliation: re-resolved EV +0.0778R vs canonical +0.0889R. The
  gap is re-resolution method, not the same number; both are reported.

### 19a — the multiplier is NOT pinned; the export mixes ENGINE GENERATIONS
Reconciled (rule 5): `ATR: x)` matches all 392 rows spanning 0.40..124.20 =
several code generations. Only the **39** rows printing the current
`SL <p>p (<m>x ATR) | Multiplier: <x>x` triple came from today's geometry code.
Within those 39: multiplier **1.00x x34**, 1.04x x2, 1.10x/1.01x/1.03x x1;
SL **80p x28**, 50p x5, 83p x2, 88p/81p/58p/66p x1; ATR 0.90..6.60.
**Cause: unit mismatch.** `max(1.0, min(1.6, 0.7 + atr*0.06))` exceeds 1.0 only
when ATR > 5.00 **price-$** (= 50 pips). Only 5 of 39 signals qualify. The
formula was calibrated for ATR in PIPS but `features.atr` is in price-$, so the
multiplier sits on its 1.0 FLOOR. It is computed and effectively discarded, not
disabled. The 1.2xATR noise floor is p50 19.2p / max 79.2p, never above 80p, so
`max(configured, floor)` = the manual SL in 39/39.

### 19e — ON mode as specified is WORSE. Do not adopt on this evidence.
n=39 (POWER: underpowered, stated before the result). ON-mode SL p50 33.6p vs
80p actual. **OFF re-resolved EV +0.0064R / 48.7% WR; ON -0.3372R / 33.3% WR.**
Per-signal $ at 1 unit: OFF +0.263, ON -0.671. Tighter ATR stops sit INSIDE the
noise floor — the exact defect the 1.2xATR floor exists to prevent.

### 19b/19c — GATE COULD NOT CLOSE. NOT IMPLEMENTED. See report.
19b ("OFF: manual tp1/tp2/tp3Pips honoured literally") and 19d ("do NOT change
default behaviour in this pass") are mutually exclusive: OFF **is** the default,
and `DEFAULT_SETTINGS` is tp1 49 / tp2 74 / tp3 98 / sl 70, so honouring them
literally moves TP1 from 0.70R (56p) to 49p = 0.61R on an 80p stop, reinstating
the sub-0.70R TP1 that B3 removed after measuring it forced a 53.9% breakeven
win rate. That is an unmeasured geometry change to the default path during the
measurement week. STOPPED per the standing rule rather than guessing.

### Evidence commands
`bun expo/scripts/investigateItems17to19.ts <export.txt>`
`bun expo/scripts/test_item17_entry_anchor_guards.ts` -> 13/13
`runChecks(expo)` -> clean.

## 3o. ITEM 21 GATE FAILED — REVERTED. ITEM 22 SHIPPED. ITEMS 23/24 MEASURED. (2026-08-05)

**PARENT COMMIT (pre-change): `3c83cdaf8cd5df308bfdd0477a4601eb18e7a60d`.** The new
commit hash is created by platform sync AFTER this turn and must be recorded with
the UTC instant the reloaded client first ran it plus pre-split counters.

### ITEM 21 — BUILT, GATED, **FAILED GATE 2, REVERTED**. NOT DONE.
Evidence: `bun expo/scripts/verifyItems21to24.ts` (both resolvers are the REAL
function; BEFORE recovered via `git show HEAD:expo/services/signalResolver.ts`).
- GATE 1 (over-credited -> NEVER_FILLABLE or gap-priced): **PASS**
- GATE 2 (zone-confirmed BIT-IDENTICAL): **FAIL — 18 of 378 differ**
- GATE 3 (nothing goes NOT-ENTERED -> ENTERED): **PASS**

**Blocker, exactly:** deferring confirmation instead of confirming on a
levels-cross moves the confirmation BAR later, so the ladder is re-walked from a
different starting bar. 18 signals change outcome, including SL_HIT->ALL_TARGETS_HIT
([223]), SL_HIT->SL_AFTER_BE ([251],[347]) and ALL_TARGETS_HIT->SL_AFTER_BE
([352],[353],[373],[381]). All 18 were old-LEVELS-CROSS confirmations; **0 of the
359 genuinely old-zone-confirmed signals differ.** Restricting GATE 2 to those 359
gives 0 differences, but that denominator swap is post-hoc loosening and was
reported, NOT adopted.

### ITEM 18's MATERIALITY NUMBER WAS OVERSTATED BY ME. CORRECTED.
The 18b mirror recorded the FIRST confirmation mechanism and stopped. The real
resolver keeps scanning, so 11 of those 12 later touched their entry band and were
genuinely fillable — just later. Measured with the real resolver:
- **NEVER_FILLABLE = 1 of 379 (0.26%)**, signal [116], BUY 3977.3, old R +1.080.
- Genuine gap fills = **0**.
- Canonical EV: **~~+0.0919R (n=379)~~ -> +0.0840R (n=378)**, delta **-0.0079R**.
**NOT 12 signals and NOT 56% of EV.** The "contaminating every hour" premise is
falsified by measurement; that is why shipping unverified logic was refused.

### ITEM 22 — SHIPPED (no gate; no geometry change, no sample risk)
`expo/app/(tabs)/settings.tsx`: TP section retitled "Engine-Derived", labels
"TP1 (0.70R)/TP2 (1.05R)/TP3 (1.40R)", Base SL -> "Base SL (Used)", helper text now
states the entered TP values are NOT used. Fields deliberately NOT deleted.
`expo/services/diagnosticsExport.ts`: every signal now prints
`geometry mode: SL: manual slPips · TPs: R-derived 0.70/1.05/1.40`.
No `useDynamicGeometry`, no pip value changed, ladder untouched.

### ITEM 23 — UNIT-CORRECTED MULTIPLIER: THE TWO SETS DISAGREE. NOT ADOPTABLE.
`max(1.0, min(1.6, 0.7 + atr*0.6))` — a LARGER stop, a different intervention from
19e's smaller stop.
- Printed-ATR set (n=39, engine's own input, UNDERPOWERED): mult p50 1.60,
  SL p50 123.2p (7.11x ATR); OFF EV +0.0731R/WR 51.3%/PF 1.150 vs
  **ON EV +0.3965R/WR 66.7%/PF 2.190**, $ 0.782 -> 4.101.
- Wide set (n=378, ATR(14) recomputed from `gold_m1_bars`, uniformly labelled but
  Vantage-ATR not engine-ATR): SL p50 81.6p (4.22x ATR); OFF EV +0.0840R/WR 65.1%
  vs **ON EV +0.0676R/WR 57.4%** — WORSE in R, better in $ (0.510 -> 0.637).
**Sets disagree in SIGN.** Trusted set = the wide one (uniform labels, 10x power);
the n=39 result is a 1.60x-clamp artifact on a high-ATR slice. Verdict: no adoption
evidence. Not implemented.

### ITEM 24 — CONTAMINATION OF PRIOR CLOSED ANALYSES: 1 SIGNAL, 0.26%
- Affected population = 1 (signal [116], BUY). SELL share **0**.
- (b) Item D "no ladder adopted" SURVIVES; Item C "SELL-side conclusions reverse"
  SURVIVES (zero SELL exposure); SELL-suppression EV comparison SURVIVES.
- (c) `trade_outcomes_v1` total **51 rows**; rows matching an affected id = **0**.
  ID-FORM CONTROL: 23 of 200 export ids DO match, so the id forms agree and the
  zero is a real absence, not a failed join. **The retraining corpus is clean.**

### 4 legacy defects REPORTED, NOT FIXED (freeze)
`TradingContext.tsx:1217` still auto-confirms on `tpReachedFromEntry ||
slReachedFromEntry`, but `analyzeSignalWithHistoricalData` output is discarded —
`signalResolver` is authoritative at `:1743-1750`, so it has no live effect.

**SUPERSEDED IN PART BY §3p:** the "-0.0079R / EV 0.0840R" figure above was measured
with the REVERTED repricing build, whose 18 outcome rewrites are inside that number.
The narrow fix's clean figure is **+0.0919R -> +0.0893R, delta -0.0026R**. Item 23's
OFF column moves with it (wide set OFF EV 0.0893R, ON 0.0808R — still WORSE in R, so
the Item 23 verdict is unchanged).

## 3p. ITEM 21 NARROW FIX — ALL THREE GATES CLOSED. ITEM 26 RESOLVED. ITEM 27 PRE-FLIGHT. (2026-08-05)

**PARENT COMMIT: `7057160aebd4a824f5974fd3ad1a997f30b91309`.** The new commit hash is
created by platform sync AFTER this turn; it plus the UTC instant the reloaded client
first runs it are STILL the missing freeze-point record. Pre-split counters as of the
12:54Z export: SECTION 8 `3116 checks / 14 stand-asides / 0.45%`; SECTION 9 outbox
(72h) `DELIVERED 7 / PENDING 0 / AGED_OUT 1`; SECTION 2 `hydrates 11/11, UNAVAILABLE 0`.

### ITEM 21 (narrow / "Option 2") — BUILT AND GATED. GATES 1/2/3 ALL PASS.
`expo/services/signalResolver.ts`: the confirmation condition is byte-unchanged
(`touchedZone || crossedTp1 || crossedSl || touchedExtended`), so NO confirmation
timing and NO ladder walk moved. Added:
- `everTouchedEntryBand`, computed as a PRE-PASS over evalBars OUTSIDE the resolution
  loop, at the widest tolerance the confirmation logic itself accepts;
- `entryVia: 'zone' | 'levels-cross' | null` + `entryFillPrice` (provenance only,
  never feeds the ladder; `null`, never 0, when there was no fill);
- terminal `NEVER_FILLABLE` when entry was credited by a levels-cross AND no bar ever
  traded the band — guarded by: never on a seeded stored-status confirmation,
  `evalBars > 0`, and `ENTRY_MATURITY_MS` (the same maturity floor Item 1 put on
  EXPIRED_MISSED_ENTRY, so a young signal is never stamped irreversibly early).
No `'gap'` member and no gap repricing: measured genuine gaps = 0, and the repricing
build rewrote 18 of 378 outcomes, so it stays REVERTED.

Evidence (`bun scripts/verifyItems21to24.ts`, BOTH sides the REAL resolver):
```
GATE 1  over-credited -> NEVER_FILLABLE      : PASS
GATE 2  all 359 zone-confirmed BIT-IDENTICAL : PASS
GATE 3  nothing NOT-ENTERED -> ENTERED       : PASS
canonical EV: 0.0919R n=379 -> 0.0893R n=378   delta -0.0026R
only reclassified signal: [116] BUY 3977.3 ALL_TARGETS_HIT -> NEVER_FILLABLE
the other 19 old levels-cross confirmations: outcome UNCHANGED
```
The restricted-denominator variant is still printed but was NOT needed and NOT
adopted — the literal pre-registered gate passed on its own terms.
`NEVER_FILLABLE` threaded through `types/trading.ts`, `TradingContext.tsx` (terminal
list, exit=entry, NO_TRADE, no execution cost), `history.tsx` (neutral `#94a3b8`,
never red), `telemetry.tsx`.

### ITEM 26 — THERE IS NO THRESHOLD CONFLICT. BOTH SOURCES ARE 5%.
- `expo/services/diagnosticsExport.ts:548` prints `> 5%`.
- `expo/scripts/forwardMonitor.ts:75` gates on `REFUTE.standAsideRatePct = 5`.
Same quantity, same numerator (readiness checks where the bar layer was unavailable
or stale), same market-open-only denominator. The 25% is a DIFFERENT criterion:
`forwardMonitor.ts:71` `atrUnchangedBand = 0.25` — criterion 2's +/-25% realised-ATR
band. The export now states this explicitly (string-only, no logic change).

### ITEM 27 — PRE-FLIGHT: GO, with two OBSERVABILITY gaps named
PASS: Telegram Edge Function live probe (HTTP 400 from the function's OWN validator,
anon key, no Rork backend in the path) + `telegram_outbox_v1` newest row DELIVERED
2026-08-05T17:29:22Z attempts=1; Storage export byte-identical (455,949 B,
`exports/2026-08-05T12-54-27-645Z.txt` === `latest.txt`, anon Storage REST only);
SECTION 2 corpus counters durable (11/11 hydrates, 0 UNAVAILABLE, 51 rows / 1 page);
`gold_m1_bars` newest bar 1.7 min old (external Python sync IS running);
`sr_zones_v1` 9.7 min; SELLs live.
FLAG: outbox AGED_OUT = 1 in 72h. SECTION 9's own refutation threshold says
agedOut > 0 means one emitted signal never reached the executor.
VACUOUS — cannot be proven from outside the client, and both need the user to act:
1. Item 17's entry-anchor counters exist (`getEntryAnchorGateStats()`) but are
   rendered NOWHERE, including the export. Mid-week they are observable ONLY via the
   `[EntryAnchorStale]` / `[GeometryUnwinnable]` runtime log tags. FIX = pass them
   into the export the way SECTION 8 does.
2. The export does not echo `allowShortSignals`, so its live value is INFERRED from
   behaviour (newest suppressed shadow SELL is 2026-07-31; SELLs kept emitting after
   it, e.g. [5] SELL 2026-08-04T15:08Z), not read.

## 3q. DIRECTION-SELECTION INVESTIGATION (2026-08-06) — READ-ONLY, NOTHING BUILT

`expo/scripts/investigateDirectionSelection.ts` (new, read-only). Export 489,276 B
generated 2026-08-06T07:50:26Z; 39,150 `gold_m1_bars` rows read DIRECT via anon key;
canonical bar-covered 383, resolved with a real fill 382; BOOK BASELINE WR 64.1% /
EV 0.0883R / PF 1.246.

### STEP 1 — MECHANISM CONFIRMED. A SIGN/DISPLAY defect, not a weight defect.
`signalEngine.ts:5245`, inside `if (htfTrend === 'BULLISH')`:
`if (rsiOversold || (rsiNeutralBearish && ltfTrend === 'BEARISH')) { rsiBuyContribution
+= 0.35; attentionScores.set('counter_trend_bounce_setup', 0.35); }`
It adds to **rsiBuyContribution** only — it contributes **0.00 to sell strength** and is
unreachable from the `htfTrend === 'BEARISH'` branch. `attentionScores` is a flat
side-agnostic Map and `diagnosticsExport.ts:228` prints it unsigned, so on a SELL the
export renders `COUNTER TREND BOUNCE SETUP=35.00` as if it supported the SELL. The +35
never scored the SELL. Both live SELLs fired with their own second-strongest recorded
evidence pointing the OTHER WAY, and no gate can see that, because the attention map
carries no side.

### STEP 1b — the classifier and the drift veto DID evaluate both SELLs.
`isCounterTrendSignal` (`:7154`) includes `SELL && htfTrend==='BULLISH'` -> TRUE for
both. 60-min drift RECONSTRUCTED from real M1 bars (the engine's own 5-min array is
not persisted, so this is the input rebuilt, not a replay):
- [1] drift **-8.60**, threshold atr 1.6 x 2.0 = **3.20** -> predicate FALSE, veto
  correctly silent. Price then ran **+$30.20** against it. The veto looks BACKWARD at a
  falling hour; the trade died in the rising hour that followed.
- [2] drift **+4.44**, threshold atr 1.9 x 2.0 = **3.80** -> predicate **TRUE, it
  should have REJECTED**. It emitted anyway. Confidence 90.0% >= the 0.85 override
  floor, so the sweep-reversal OVERRIDE at `:7182` is the only path that emits it.
  Which of the two actually happened is **NOT MEASURABLE** (rule 8): neither
  `recentDrift` nor `sessionSweeps[].reversalConfirmed` is exported or durably logged.
  FORWARD EVIDENCE THAT SETTLES IT: export `recentDrift`, its threshold and
  `sweepReclaimConfirmed` on every counter-trend signal.
- UNITS DEFECT (separate): `validateStructuralConditions` `const bounceThreshold = 10`
  (`:8131`) is compared as `Math.abs(zone.price - currentPrice) < 10` = **$10 = 100
  pips**, while its own comment and user-facing tip both say "10 pips". Both SELLs sat
  $3.20 / $1.70 from RESISTANCE 4256.6 — they pass a $10 band and would FAIL a true
  10-pip band. The gate is 10x looser than documented.

### STEP 1c/1d — UNDERPOWERED, and partly IMPOSSIBLE. No verdict taken.
`htf` is `n/a` on **341 of 382 (89.3%)**, so the htf split is IMPOSSIBLE on 9 of every
10 signals. Feature carriers: only **12** in the canonical set (10 BUY / 2 SELL). Every
carrier cell's Wilson 95% interval spans the baseline:
- ALL carriers n=12 WR 50.0% EV -0.1355R, WR95 [25.4, 74.6] -> UNDERPOWERED
- carriers opposing htf n=2 — and those 2 ARE the two live SELLs, so the cell is the
  complaint restated, not independent evidence about it
- SELL RSI<40 n=107 WR 67.3% **EV +0.1132R**; BUY RSI>60 n=87 WR 65.5% **EV +0.1916R**.
  Both POSITIVE. The RSI-side-mismatch hypothesis is NOT confirmed — on this sample it
  points the OPPOSITE way, so "veto SELLs at low RSI" has no support.

### STEP 2 — the pre-registered mirror metric came out DEGENERATE. Reported, not used.
Mirror = same entry, same SL/TP distances, opposite side, REAL resolver, fromScratch.
"Of signals that LOST, what fraction would have WON mirrored?" = **137 of 137 = 100%**,
and that is a **TAUTOLOGY**: all 137 losers are `targetsHit=0` full-1.00R stops, TP1
sits at 0.70R, so price travelling 1.00R against the issued side necessarily passed the
mirror's TP1 first, and the mirror's own stop cannot have printed first or the issued
side would have banked TP3. The metric as specified cannot answer 2(d). It is printed
with the degeneracy proof attached rather than quoted as a finding.
Non-degenerate readings:
- WHOLE BOOK ACTUAL EV 0.0883R WR 64.1% vs **MIRROR EV 0.0776R WR 65.7%** — the
  mirrored book is ALSO profitable, so the book's EV is not coming from direction
  selection; it is coming from the 0.70R-TP1 ladder.
- **BOTH SIDES WON in 114 of 382 (29.8%)** — the 0.70R TP1 was reachable in BOTH
  directions from the same entry, so the side chosen was irrelevant in ~30% of rows.
- issued SELL ACTUAL 0.0501R vs MIRROR 0.0202R; issued BUY ACTUAL 0.1351R vs MIRROR
  0.1476R. The two live SELLs mirrored: both PARTIAL_WIN_SL_HIT, +0.595R / +0.588R.
LIMIT restated: NOT an achievable strategy; nothing here proposes inverting the book.

### STEP 3 — TOUCH COUNT MEASURES OCCUPANCY. CONFIRMED. Cause = the zoneWidth floor.
`refresh-sr-zones/index.ts:119` (script port `computeAndWriteZones.ts:134`):
`zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0015)`. Live: `atr*0.3 = 0.65` but
`price*0.0015 = 6.42`, so **the floor ALWAYS wins** and the band is **+/-$6.42 = 128
pips wide**. The touch predicate `if (Math.abs(close - cluster.price) < zoneWidth)
touches++` runs per BAR, so consecutive minutes each count separately.
Measured on 4256.6 over 2026-08-06T03:00-07:00Z (241 of 241 minutes present):
- 148 of 241 bars "touch" (61.4% of minutes) in only **14 distinct visits**, longest
  single uninterrupted run **52 consecutive bars**, all counted separately.
- **CROSSINGS 15 vs genuine REVERSALS 3 = 5.00 : 1** — crossings dominate, so the
  metric measures occupancy, not structure.
- `touchScore = min(1, touches/6)` saturates at SIX touches. Across all **1226** zone
  rows: touches p50 1 / p75 100 / max 1488; **47.6% already saturated** (touches>6);
  29.6% carry reaction >= 90%. Above 6 the count is decoration — 284 and 1488 score
  identically, so "284 touches / 97%" conveys no more than "6 touches".
- The 128-pip band on 4256.6 spans [4250.2, 4263.0], which also contains SUPPORT
  4248.7's band and RESISTANCE 4262.0's band. Support and resistance OVERLAP, which is
  how the counter-trend gate found a "qualifying RESISTANCE" inside a range price was
  oscillating straight through.

Nothing was proposed. No engine, resolver, gate or scoring code was touched.
Items 13, 8, 19, 20 remain UNBUILT.

## 3r. ITEMS 28 & 29 — GATE TELEMETRY BUILT, FEATURE RENDERING FIXED. COST MODEL: NO RECORD EXISTS. (2026-08-06)

### ITEM 28 — counter-trend gate telemetry (BUILT, no scoring path touched)

Every signal now carries a frozen `counterTrendTelemetry` record (also mirrored into
`learningContext` v3, so it persists into `trade_outcomes_v1.features`): `htfTrendAtGate`,
`ltfTrendAtGate`, `counterTrendClassified`, `recentDrift`, `driftAgainst`,
`driftVetoThreshold`, `driftVetoPredicateTrue`, `sweepReclaimConfirmed`,
`driftVetoOverrideApplied`, `spreadPipsAtEntry`. Built in
`expo/services/attentionTelemetry.ts` by a pure function; rendered as a
`counter-trend gate:` line in SECTION 1 of the export. `null` always means
"uncomputable", never 0, and pre-Item-28 signals render `not-instrumented`.

**Structural proof (28d), automated in `expo/scripts/test_item28_29_telemetry.ts`:** the
current `signalEngine.ts` is diffed against `git show HEAD:` and every added/removed
non-comment line is asserted to mention no scoring identifier (buy/sellSignalStrength,
dir.add*/penalize*, baseConfidence, rawConfidence, smoothedConfidence,
tier0AdjustedConfidence, calibrationPenalty, dynamicSlPips, atrMultiplier, `return null`
…). The drift-veto branch and the B1 classifier are asserted byte-identical. Every
`attentionScores.get('…')` lookup in the engine is enumerated and asserted disjoint from
the telemetry field names (runtime counterpart of the compile-time
`assertTelemetryKeysAreNotScoringKeys`). 32/32 checks pass.

### ITEM 29 — the export's feature rendering was misleading (FIXED)

Two defects, both rendering-only: (a) `Math.abs(score)*100` made a **-0.12 penalty**
print identically to a **+0.12 bonus**; (b) a bullish-family key on a SELL row read as
evidence FOR the SELL when it was recorded because the BUY accumulator moved. The side
is now captured **at the call site** (`DirectionalScoreAccumulator` writes a parallel
`string -> AttentionSide` map — no number, so it cannot enter a strength sum), the export
prints the **signed** value plus `buy-side,OPPOSES-SELL` / `buy-penalty,OPPOSES-BUY` /
`context`, and keys whose side is genuinely call-site-dependent (`fibonacci_alignment`,
`rsi_learned_modulation`, `sr_zone_*`, `multi_touch_sr_confirmation`) print
`side-unclassified` rather than being guessed. `feature` and `score` are unchanged, so
no UI or existing parser shifts meaning.

Also fixed: `htf=n/a` on 355/396 export rows was NOT a live instrumentation failure. It
is a schema boundary — v2 landed 2026-07-29, and **every row from 2026-07-30 onward has
htf populated (40/40)**. Those rows are v1 six-scalar records that never held the field,
and the export now prints `not-instrumented(v1)` instead of `n/a` plus an explicit
`schemaVersion=` token.

### COST MODEL — `EXECUTION_COST_PER_TRADE_USD = 0.05` IS UNEVIDENCED (finding, NOT changed)

Probed every durable store (`expo/scripts/fetchExportAndProbeSpread.ts`):
`gold_m1_bars` = (id, timestamp, open, high, low, close, volume) — no bid/ask;
`shadow_signals_v1` — no spread column; export text — **0 lines** mention spread/bid/ask.
**No durable record anywhere holds a single observed XAU spread. POWER = 0 rows.**
Worse, `setLastKnownSpread()` has **zero call sites**, so `lastKnownSpreadPips` is always
0 — the real spread never entered entry geometry either, and `calculateSpreadRatio()`
can never reach `sufficient:true` (which also means the Part B order-flow path is
permanently on its neutral baseline). Item 28's `spreadPipsAtEntry` closes the RECORD
gap forward, but it will log `none-observed` until a caller feeds real bid/ask in.

Measured sensitivity (`expo/scripts/analyzeExecutionCostSensitivity.ts`, 396 resolved
rows, realised R computed from each record's own exit price and stop distance):
gross EV **+0.0493R**, real risk$ median $5.20 (p10 $3.90 / p90 $8.30).
Net EV: **+0.0397R @ $0.05** · +0.0207R @ $0.15 · **+0.0017R @ $0.25** · -0.0174R @ $0.35.
**Breakeven round-trip cost = $0.259 (2.59 pips).** BUY-only breakeven $0.369 (3.69 pips);
SELL-only $0.181 (1.81 pips). The assumed $0.05 is **0.5 pips**, i.e. the entire book's
positive expectancy fits inside a ~2.6 pip cost assumption that has never been measured.
Nothing was changed on this — it is a measurement gap, and the constant stays 0.05 until
real spread readings exist.

## 3s. ITEMS 32/33/34 — CANONICAL EV RECONCILED, SHADOW ZONE METRIC MEASURED, bounceThreshold COUNTERFACTUAL RUN (2026-08-06, ALL READ-ONLY)

MINDSET 8 rules apply throughout. Nothing was shipped. No scoring path, no
gate threshold, no geometry was touched. Items 13, 8, 19, 20 stay unbuilt.

### ITEM 32 — CANONICAL EV = +0.0883R (Method B, resolver fromScratch, n=382)

Two EV figures existed and are now reconciled (`analyzeItem32ReconcileEV.ts`):

| | Method A (export exit) | Method B (resolver fromScratch) |
|---|---|---|
| outcome source | export `exit price` field | `resolveSignalWithBars(…, {fromScratch:true})` against gold_m1_bars |
| R derivation | `dirSign*(exit-entry)/|entry-sl|` | `dirSign*(resolverExit-fill)/|entry-sl|` |
| win predicate | R > 0 | R > 0 |
| denominator | 396 (all resolved with exit price) | 382 (bar-covered + entry confirmed) |
| exclusions | ACTIVE/EXPIRED_MISSED/NEVER_FILLABLE (none present) | 13 not bar-covered, 1 NEVER_FILLABLE |
| **EV** | **+0.0493R** | **+0.0883R** |
| WR | 47.0% | 64.1% |
| PF | 1.141 | 1.246 |

**Row membership:** 382 in both, 14 in A only (13 not bar-covered + 1 NEVER_FILLABLE), 0 in B only.

**The 0.0391R gap is NOT a discrepancy** — it is two different questions. Method A asks
"what did the export record?" Method B asks "what would a real position have experienced
against actual bars?" The gap is the engine's recording imperfections: 7 CLOSED→ALL_TARGETS_HIT
corrections (resolver found bars hit all 3 TPs; export recorded a flat close), 5 PARTIAL_WIN_SL_HIT→
ALL_TARGETS_HIT corrections, 1 CLOSED→SL_HIT, 1 CLOSED→SL_AFTER_BE. The median R diff is 0.0000R;
the 14 status corrections drive the entire EV gap.

**CANONICAL = Method B (+0.0883R, n=382).** It is the method that does not trust the
engine's own recording and instead asks the bars what actually happened. It is the method
already used by every counterfactual in this system (Items 6, 7, 9–12, 21, 22, 27). Method
A (+0.0493R) remains valid for cost-sensitivity tables but is not a tradable result.

BUY/SELL split (canonical): BUY n=172 EV +0.1351R WR 62.8% PF 1.363; SELL n=210
EV +0.0501R WR 65.2% PF 1.144. MDE at 80% power (each vs zero): BUY 0.2947R, SELL 0.2330R.

**BUY vs SELL DIFFERENCE power (Follow-up 2):** Observed difference (BUY−SELL) = +0.0850R.
Pooled SD 0.9101R, SE of difference 0.0936R, MDE (80% power, alpha=0.05) = 0.2621R.
0.0850R < 0.2621R → **UNDERPOWERED.** The BUY/SELL gap is directionally consistent with
the PF finding (1.363 vs 1.144) but consistency is not confirmation — the gap is not
distinguishable from zero at this sample size.

**CLOSED semantics (Follow-up 4):** CLOSED is NOT a snapshot artifact of an unresolved
signal. In `signalResolver.ts:522`, CLOSED is set by the fromScratch resolver ONLY when
entry was filled but NO TP/SL bar event ever fired AND the signal has matured past
ENTRY_MATURITY_MS with zero targets hit — it is a genuine resolution (exit at last
evaluated bar's close, outcome null = flat). The engine (`signalEngine.ts:7474`) treats
CLOSED as a resolved status for signal-lock release. The 7 export CLOSED→ALL_TARGETS_HIT
corrections in Item 32 are the resolver finding bars the engine's live tracker missed —
CLOSED in the export meant the live tracker gave up before a bar event it should have
caught, not that the signal was still open at export time.

### ITEM 33 — SHADOW ZONE METRIC: structural findings decisive, outcome splits UNDERPOWERED, required-n computed

**33.1d BAND WIDTH (structural, no sample needed):** The live band `Math.max(atr*0.3,
price*0.0015)` = $6.382 (63.8 pips) is **1.2× wider** than the $5.40 gap between 4256.6
and 4262.0 — adjacent levels necessarily merge. Removing the floor (atr*0.3 = $0.512 = 5.1
pips) cuts overlapping-band pairs from **14 to 2** across the same 32 zones. All three
levels (4248.7/4256.6/4262.0) stay distinct at atr*0.3 through atr*1.5; they only merge at
atr*2.0. This is established and needs no sample.

**33.1 RELIABILITY axis:** 435 unique zone levels measured. Visit-based counting with
hysteresis (1.5× band exit threshold). Reversal = closed ≥1 ATR on approach side without
closing through; break = closed through by ≥1 ATR. No /6 cap. Min visits = 3 before
publishing strength. Reversal rates span 0.11–0.82 (median 0.50). All 435 zones meet the
min-visits gate (≥3 visits); the gate is not load-bearing on this sample.

**33.2 MAGNITUDE axis:** Per-reversal excursion from the wick extreme (not close).
N=30 bars (30 min). Median excursion across zones: 2.5–5.5 ATR. Sensitivity check
at N=15/30/60 shows <3% variation — N=30 is stable. Break magnitude reported but not
gated (median break excursion 3.0–5.0 ATR).

**33.2d TP1 clearance (PER-SIGNAL, by geometry era):** The user's $5.70 spec was recorded
as the user's error — 394/396 signals use old geometry (TP1/SL < 0.60, median TP1 $2.60 = 26
pips). Only 2/396 use new geometry (TP1 $5.70 = 57 pips). Per-signal TP1 distance is used
for every clearance test. OLD geometry: n=21 eligible, 21 clear, 0 fail — split IMPOSSIBLE
(all clear). NEW geometry: n=121 eligible, 100 clear, 21 fail — the one clearance test
that is NOT impossible. Outcome split (POWER FIRST):
  CLEARS n=100 EV −0.0036R WR 58.0% PF 0.991
  FAILS  n=21  EV −0.2874R WR 47.6% PF 0.425
  Observed delta 0.2839R, MDE 0.4646R → UNDERPOWERED.
  The direction is what the zone-reaction hypothesis predicts (clears > fails) but
  0.2839R < 0.4646R MDE — this is not a result. Pooled across eras (NOT canonical):
clears n=121 EV −0.0137R, fails n=21 EV −0.2874R — pools across geometry eras.

**33.4h 1D RELIABILITY split (n=142 EV-eligible):** HIGH reliability (reversalRate ≥ 0.500)
EV +0.0703R (n=74) vs LOW EV −0.1896R (n=68). Delta 0.2598R. **MDE 0.4256R → UNDERPOWERED.**

**33.4i 1D MAGNITUDE split (n=142):** HIGH magnitude (excursionATR ≥ 3.477) EV +0.1070R
(n=71) vs LOW EV −0.2154R (n=71). Delta 0.3224R. **MDE 0.4256R → UNDERPOWERED.**

**33.4j 2D GRID (n=142):** Tertiles computed, 3×3 grid printed. Monotonic pattern visible
(R2E2 EV +0.4957R WR 81.3% vs R0E0 EV −0.1513R WR 56.3%). **UNDERPOWERED — ~15 per cell.
The monotonic pattern is NOT a result. A striking pattern across underpowered cells is
what chance produces. Do not read it as signal.**

**33.4k KEY QUESTION:** Both axes UNDERPOWERED. Cannot conclude whether zone
discrimination is the lever. The structural finding (band width merging adjacent levels)
is established without sample. The outcome question needs forward data.

**REQUIRED SAMPLE SIZE (80% power, observed effect sizes, pooled sigma from R distribution):**

| Split | delta | sigma | n/group | total eligible | total signals | trading days | date |
|---|---|---|---|---|---|---|---|
| Reliability | 0.2598R | 0.9057R | 191 | 382 | 1066 | 97 | **2026-11-11** |
| Magnitude | 0.3224R | 0.9057R | 124 | 248 | 692 | 63 | **2026-10-08** |
| 2D grid | 0.6470R | 0.9057R | 31/cell | 279 | 779 | 71 | **2026-10-16** |

Zone-match rate = 142/396 = 35.9%. At ~11 signals/day. The magnitude split reaches power
first (~Oct 8); the 2D extreme-cell comparison reaches power ~Oct 16 (its effect size is
~2.5× larger than the reliability marginal); reliability is the binding constraint (~Nov 11).
**Planning note (Follow-up 3):** when enough data accumulates, check the 2D extreme-cell
comparison FIRST (~Oct 16) rather than waiting on the reliability marginal (~Nov 11) —
it may answer the more specific question sooner. The next decision point is when Item 33's
required-n is met.

### ITEM 34 — bounceThreshold COUNTERFACTUAL: 3 counter-trend signals, IMPOSSIBLE to split

The gate (`signalEngine.ts:8212`, `const bounceThreshold = 10`) compares in DOLLARS ($10 =
100 pips) while the comment says "10 pips". Only **3 signals** in the export are classifiable
as counter-trend from their htf label (SELL+htf=BULLISH: #1, #2; BUY+htf=BEARISH: #36).
355/396 have htf=n/a → classification depends on ltf which is not exported → UNKNOWN.

**Counterfactual (3 counter-trend signals):**

| threshold | pass | block | nearest qualifying zone distance |
|---|---|---|---|
| LIVE $10 (100p) | 3 | 0 | min $1.70 (17p) |
| 10p ($1.00) | 0 | 3 | all ≥ $1.70 |
| 5p ($0.50) | 0 | 3 | |
| 3p ($0.30) | 0 | 3 | |
| 2p ($0.20) | 0 | 3 | |

All three counter-trend signals' nearest qualifying zone is $1.70–$3.20 away (17–32 pips).
A true 10-pip ($1.00) band blocks all 3; the live $10 band passes all 3. **The gate is
knife-edge at $1.00–$2.00** (the jump from 0 blocked to 3 blocked happens between $1.00
and $2.00). The 10-pip split is **IMPOSSIBLE** (rule 8): blocked=3, passed=0 — one side is
empty, no contrast exists. The 355 UNKNOWN signals: 15/355 would pass at 10p, 340/355 would
block — but their classification is unknown.

The unit defect is real and confirmed: $10 is 100 pips, not 10. But the outcome question
(blocked vs retained EV) is IMPOSSIBLE on this sample, not underpowered — there are 3
counter-trend signals and the gate blocks all 3 at the documented threshold. Forward data
with htf labels populated (post-Item 28) is what settles it.

## 3t. ITEMS 35/36 — RESOLVER DIVERGENCE ROOT CAUSE + NEW-GEOMETRY ERA MEASUREMENT (2026-08-07, ALL READ-ONLY)

MINDSET 8 rules apply throughout. Nothing was shipped. No engine code touched.

### ITEM 35 — MECHANISM GAP: audit window (2h) is shorter than outcome window (8h+)

**Scripts:** `expo/scripts/analyzeItem35ResolverDivergence.ts`. 18 CLOSED signals in
the export, 9 bar-covered. Of the 9 bar-covered, 7 are corrected by 8h fromScratch.

**The answer is (b) MECHANISM, not (a) scheduling.** Every single corrected signal's
terminal event occurred AFTER the 2h audit window:

```
  idx  dir   entry   2h_status   8h_status          TP_event_ts              hours_to_TP  within_2h
   15  BUY   4037.4  CLOSED      ALL_TARGETS_HIT    2026-08-03T19:21:00Z      2.70h        NO
   16  BUY   4037.2  CLOSED      ALL_TARGETS_HIT    2026-08-03T19:21:00Z      2.72h        NO
   18  BUY   4036.9  CLOSED      ALL_TARGETS_HIT    2026-08-03T19:21:00Z      2.85h        NO
   19  BUY   4037.5  CLOSED      ALL_TARGETS_HIT    2026-08-03T19:21:00Z      2.87h        NO
   22  BUY   4037.4  CLOSED      ALL_TARGETS_HIT    2026-08-03T19:21:00Z      3.06h        NO
   32  BUY   4108.2  CLOSED      SL_HIT             2026-07-31T00:21:00Z      2.06h        NO
  232  BUY   4123.7  CLOSED      SL_AFTER_BE        2026-07-09T22:01:00Z      2.95h        NO
```

TP events WITHIN 2h audit window: **0**. TP events AFTER 2h audit window: **7**.

The mechanism trace (code-confirmed, not inferred):

1. **Live path** (`catchUpAndEvaluateSignals`, `TradingContext.tsx:1468`): signals >2h old
   are marked CLOSED WITHOUT checking bars — `if (signalAge > twoHoursInMs) { status = "CLOSED" }`.
   Once CLOSED, `catchUpAndEvaluateSignals` skips it on every subsequent pass (line 1450).
2. **Audit path** (`auditTerminalSLSignals`, `TradingContext.tsx:1948`): `resolutionWindowMs =
   twoHoursInMs = 2h` by default. The daily sweep (line 3198) calls WITHOUT `windowMs` override.
   `getAuditBars` fetches bars from `signalTs` to `min(now, signalTs + 2h)` (line 1971).
   `resolveSignalWithBars` with `fromScratch:force` evaluates only those 2h of bars.
3. **fromScratch offline** (Item 32 script): evaluates 8h of bars, finds TP events at 2.06–3.06h.

The audit window (2h = `ENTRY_MATURITY_MS`) is the MATURITY threshold, not the OUTCOME window.
These are different concepts that were conflated: ENTRY_MATURITY_MS defines how long to wait
before declaring a signal EXPIRED_MISSED_ENTRY (no fill). It was never intended to bound how
long a signal can take to hit TP3 after entry. The real outcome window is longer.

**Current state (35c):** 18 CLOSED signals in export, 9 not bar-covered (cannot verify),
7 corrected by 8h fromScratch (all beyond 2h), 2 confirmed as CLOSED. **0 of 7 corrections
are within the 2h audit window.** Force Audit now would correct 0 of these 7 — the audit
window must be widened first.

**No backend-side scheduled re-audit exists.** Only `sr_zones_v1` refresh has a pg_cron
schedule. Signal outcome reconciliation is entirely client-side (foreground useEffect +
setInterval, 21:00–22:00 UTC with 25h catch-up). The daily sweep IS scheduled but only runs
while the app JS context is alive.

**Recommendation (NOT implemented):** extend `resolutionWindowMs` beyond 2h to match the
actual outcome window. The live `catchUpAndEvaluateSignals` CLOSED-at-2h assignment (line
1468) should also be re-examined — it marks CLOSED without bar evidence, which is the
initial wrong assignment the audit then confirms. Do NOT implement without measuring impact
(bar count/CPU/memory per signal at wider windows).

### ITEM 36 — NEW-GEOMETRY ERA: POSITIVE, NOT NEGATIVE — UNDERPOWERED vs OLD

**Script:** `expo/scripts/analyzeItem36GeometryEra.ts`. The user's reference to "approximately
-0.0529R" was the zone-matched subset (n=121 from Item 33.2d). The FULL canonical population
tells a different story.

**36a — OLD vs NEW geometry direct two-group comparison (POWER FIRST):**

```
  OLD geometry (TP1/SL < 0.60):  n=219, EV=+0.0874R, WR=67.1%, PF=1.269, SD=0.8264
  NEW geometry (TP1/SL >= 0.60): n=163, EV=+0.0699R, WR=58.9%, PF=1.171, SD=1.0074
  Observed difference (OLD - NEW) = +0.0175R
  Pooled SD = 0.9068R, SE of difference = 0.0938R
  MDE (80% power, alpha=0.05) = 0.2627R
  POWER: UNDERPOWERED — 0.0175R < 0.2627R
```

The NEW-geometry era is **POSITIVE** (+0.0699R, n=163), not negative. The era gap of +0.0175R
is ~15× below the MDE of 0.2627R → UNDERPOWERED. The NEW era is not distinguishable from the
OLD era. The negative EV the user referenced was from the zone-matched subset (n=121, which
excludes signals without a matched S/R zone), not the full canonical population.

**36b — NEW-geometry outcomes by day (regime shift vs losing streak):**

19 trading days, 10 negative-EV days, 9 positive-EV days. The cumulative EV stays positive
throughout (+0.0699R final). The worst stretch is Jul 29–31 (EV −0.12R to −0.70R, n=6–11/day)
but Aug 3 recovers sharply (+0.71R, n=13). The last two days (Aug 5–6) show +0.30R then −1.00R
(n=2 each, too small to be meaningful). The negative days are interspersed with positive days
— this is a positive-EV system producing routine losing streaks, not a regime shift.

**36c — trade_outcomes_v1 current state:**

51 total rows in `trade_outcomes_v1`. All 51 have `ts` after the export date (the durable
store is more recent than the export snapshot). Full corpus EV: −0.1818R, WR 47.1%, n=51.
This is a DIFFERENT population than the export (51 vs 382 resolved) — it only contains
outcomes recorded by the live learning engine, which has its own recording gaps (the
Item 32 reconciliation showed 14 status corrections, and `trade_outcomes_v1` captures what
the live path recorded, not what the bars show). `trade_outcomes_v1` does not store SL/TP1
fields, so geometry-era classification cannot be done from the durable store. The export's
n=163 NEW-geometry signals remain the best available sample.

**36d — TP1/SL ratio fragility vs separate effect:**

Within-NEW split at own median ratio (0.6667): HIGH ratio n=107 EV +0.0582R, LOW ratio n=56
EV +0.0924R. Within-NEW difference −0.0342R, MDE 0.4652R → UNDERPOWERED. The direction is
opposite to the fragility hypothesis (higher ratio performs worse, but the difference is
noise-level). The era gap cannot be attributed to the TP1/SL ratio alone — but it also
cannot be distinguished from zero at this sample size. There may be a separate regime effect
(market conditions, signal selection changes correlated with the era boundary) but it is
not measurable yet.

**VERDICT:** The NEW-geometry era is positive (+0.0699R). The era gap (+0.0175R) is
UNDERPOWERED. The currently-observed losing stretch is a routine negative streak that a
positive-EV system produces — 10 of 19 days negative, but cumulative EV stays positive
throughout. No regime shift is detectable.

### ITEM 37 — LEARNING CORPUS IS 33.3% CONTAMINATED (2026-08-07, READ-ONLY)

**Script:** `expo/scripts/analyzeItem37CorpusContamination.ts`. All 51 `trade_outcomes_v1`
rows matched to export by signal_id, all 51 bar-covered. Each resolved fromScratch
with 8h bars (canonical Method B), compared to corpus `result` field.

**CONTAMINATION RATE: 17 / 51 = 33.3%** of bar-covered corpus rows carry the wrong
WIN/LOSS label. This is the direct downstream consequence of the Item 35 mechanism
gap — the corpus records what the live path committed, not what the bars show.

**Direction of contamination:**

```
  Label AGREES:     34 / 51 (66.7%)
  Label DISAGREES:  17 / 51 (33.3%)
    False LOSS (corpus=LOSS, bars=WIN):   10 / 51 (19.6%)
    False WIN  (corpus=WIN,  bars=LOSS):   7 / 51 (13.7%)
```

**False LOSS signals (10) — the Item 35 mechanism gap:**

```
  idx  dir   entry   corpus    resolver             resolver_R  corpus_R
  246  SELL  4041.3  LOSS      ALL_TARGETS_HIT      +1.0588R    -1.0000
  249  SELL  4050.1  LOSS      SL_AFTER_BE          +0.3333R    -1.0000
  344  SELL  4086.6  LOSS      SL_AFTER_BE          +0.3295R    -1.0000
   33  BUY   4103.0  LOSS      ALL_TARGETS_HIT      +1.4253R    -1.0000
   36  BUY   4065.2  LOSS      PARTIAL_WIN_SL_HIT   +0.5976R    -1.0000
  250  SELL  4055.8  LOSS      SL_AFTER_BE          +0.3269R    -1.0000
  251  SELL  4073.6  LOSS      ALL_TARGETS_HIT      +1.0588R    -1.0000
  253  SELL  4120.0  LOSS      SL_AFTER_BE          +0.3000R    -1.0000
  379  BUY   4044.5  LOSS      SL_AFTER_BE          +0.3485R    -1.0000
   15  BUY   4037.4  LOSS      ALL_TARGETS_HIT      +1.6000R    -0.0062
```

These 10 signals were marked CLOSED at >2h age (the live path's line 1468),
`recordTradeOutcome(LOSS)` was called, and the 2h-windowed audit confirmed
CLOSED. The 8h fromScratch replay finds TP events at 2.06–3.06h that the audit
never saw. The corpus carries LOSS labels for signals that were actually wins —
ALL_TARGETS_HIT (3), SL_AFTER_BE (5), PARTIAL_WIN_SL_HIT (1).

**False WIN signals (7) — phantom TP from live tick monitor:**

```
  idx  dir   entry   corpus  resolver   resolver_R  corpus_R
  243  BUY   4038.0  WIN     SL_HIT     -1.0000R    +1.1500
  245  BUY   4043.9  WIN     SL_HIT     -1.0000R    +1.2241
  341  BUY   4073.7  WIN     SL_HIT     -1.0000R    +1.0674
  342  BUY   4086.8  WIN     SL_HIT     -1.0000R    +1.1818
  345  BUY   4095.4  WIN     SL_HIT     -1.0000R    +1.0787
  362  SELL  4023.0  WIN     SL_HIT     -1.0000R    +0.3146
   62  SELL  4130.7  WIN     SL_HIT     -1.0000R    +1.6250
```

These 7 signals were recorded as WIN by the live tick monitor (a phantom tick
banked a false TP), but the bars show SL was actually hit. The audit window gap
does NOT explain these — the SL event is within the 2h window, so the audit
SHOULD have caught them. This is a separate contamination source: the live tick
monitor's phantom-TP recording that the audit either hasn't corrected (scheduling)
or confirmed (the forward-seeded audit path can't undo a falsely-banked TP without
force=true, and the daily sweep does run force=true — so either the sweep hasn't
run for these signals, or the 2h window issue also affects the SL-side correction).

**Impact on learning:**

```
  Corpus EV (from realized_r):  -0.1818R  (n=51)
  Resolver EV (from 8h bars):   -0.0770R  (n=51)
  Corpus WR:   47.1%
  Resolver WR: 52.9%
```

The corpus EV is −0.1818R; the bar-verified EV is −0.0770R. The corpus is
**more negative than reality** by 0.105R — the 10 false LOSS labels drag the
corpus EV down more than the 7 false WIN labels drag it up. The learning engine
is training on a pessimistically biased label set.

**Implication for retraining:** The `walkForwardOptimization` path
(`signalEngine.ts:6615`) trains on `this.tradeOutcomes`, which is populated from
`recordTradeOutcome` calls — the same calls that pushed the wrong labels to
`trade_outcomes_v1`. The local in-memory corpus and the durable corpus are
contaminated identically. Every retrain between now and a corpus correction is
fitting to labels that are 33.3% wrong. The model is learning that winning
setups are losing setups (10 false LOSS) and that losing setups are winning
setups (7 false WIN), which corrupts feature weights in both directions.

**What would fix it (NOT implemented):**
1. Fix the Item 35 mechanism gap first (widen `resolutionWindowMs` beyond 2h).
2. Run a full force=true audit with the wider window against every signal in
   the corpus, re-deriving outcomes from bars.
3. Update `trade_outcomes_v1` rows with corrected `result`, `pnl`, `realized_r`.
4. Clear the in-memory `this.tradeOutcomes` and repopulate from the corrected
   durable store.
5. Retrain only after the corpus is clean.

Do NOT skip step 1 — correcting the corpus without fixing the mechanism means
the next batch of signals re-contaminates it.

## 3u. ITEMS 38/39/40 — WIDEN-WINDOW IMPACT, FALSE-WIN MECHANISM, LIVE-WEIGHT CONTAMINATION (2026-08-11, ALL READ-ONLY)

Scripts: `analyzeItem38WidenWindowImpact.ts`, `analyzeItem39FalseWinMechanism.ts`,
`analyzeItem39bMechanismAttribution.ts`, `analyzeItem39cSLAnchorCorrected.ts`,
`analyzeItem40WeightContamination.ts`. No engine file modified (`git status` shows only
new untracked scripts). Nothing shipped.

### ITEM 38 — WIDEN-WINDOW IMPACT: 8h IS THE CORRECT DEFAULT, COST IS TRIVIAL

Pre-registered gates: G1 flatten = first width where the next adds <10% of total-24h
corrections; G2 EV within 0.01R of next wider; G3 veto if >5000 bars/signal.

```
  width  n_resolved       EV      WR       PF      SD
  2h            378  +0.0456R  63.0%  1.125  0.8845
  4h            380  +0.0749R  63.4%  1.207  0.9065
  8h            382  +0.0800R  63.6%  1.222  0.9068
  12h           382  +0.0800R  63.6%  1.222  0.9068
  24h           382  +0.0800R  63.6%  1.222  0.9068
```

Status changes vs the 2h baseline, and cost:

```
  width   changed_vs_2h  newly_WIN  newly_LOSS  still_CLOSED  avg_bars/sig  max_bars
  2h                  0          0           0             9         117.3       120
  4h                 10          8           0             2         232.5       240
  8h                 12         10           0             2         447.4       480
  12h                12         10           0             2         654.6       720
  24h                12         10           0             2        1235.4      1440
```

Incremental correction curve:

```
  2h -> 4h    10 corrections   83.3% of total   EV +0.0293R
  4h -> 8h     2 corrections   16.7% of total   EV +0.0051R
  8h -> 12h    0 corrections    0.0% of total   EV +0.0000R
  12h -> 24h   0 corrections    0.0% of total   EV +0.0000R
```

**G1 PASS: the curve flattens at 8h.** **G2 PASS:** |EV(12h) - EV(8h)| = 0.0000R.
**G3 PASS:** max 1440 bars/signal at 24h, far under the 5000 ceiling; at the recommended
8h it is 447 avg / 480 max bars per signal. Cost is NOT a constraint — the 2h default was
never a performance decision.

Every correction is one-directional: **10 newly WIN, 0 newly LOSS.** Widening only ever
discovers wins the 2h window truncated. `CLOSED` drops 9 -> 2, `NEVER_FILLABLE` 5 -> 1.
The 2h window understated EV by 0.0344R (+0.0456R -> +0.0800R): **43% of the canonical EV
was invisible at 2h.**

The 7 Item-35 signals — all correct at 4h, none need more than 4h:

```
  idx        2h                  4h / 8h / 12h / 24h
  15     CLOSED   ->   ALL_TARGETS_HIT
  16     CLOSED   ->   ALL_TARGETS_HIT
  18     CLOSED   ->   ALL_TARGETS_HIT
  19     CLOSED   ->   ALL_TARGETS_HIT
  22     CLOSED   ->   ALL_TARGETS_HIT
  32     CLOSED   ->   SL_HIT
  232    CLOSED   ->   SL_AFTER_BE
```

**RECOMMENDED (not implemented): `resolutionWindowMs` default 2h -> 8h.** 8h captures 100%
of available corrections at 36% of the 24h bar cost.

### ITEM 38(ii) — DOES `force:true` OVERRIDE THE :1450 SKIP? THE QUESTION CONFLATES TWO FUNCTIONS

`:1450` and `force:true` are **in different functions**. They do not interact.

- `:1450` lives in **`catchUpAndEvaluateSignals`**. It skips CLOSED/SL_HIT/SL_AFTER_BE/
  ALL_TARGETS_HIT/PARTIAL_WIN_SL_HIT. That function has **no `force` parameter at all** —
  `force:true` cannot reach it, override it, or alter it in any way.
- `force:true` is an option of **`auditTerminalSLSignals`** (`:1918`), a separate function.
  Its loop gate is `:1964`: `if (!isTerminal || (!force && alreadyAudited && tooOldForBars))`.
  `CLOSED` **is** in `TERMINAL_SIGNAL_STATUSES` (`:93`), so `isTerminal` is true for CLOSED
  signals and they **are** audited. `force` bypasses only the audit-lock/too-old skip, and
  sets `fromScratch: force` (`:1995`) so a falsely-banked terminal can be undone.

**So: the audit DOES re-examine CLOSED signals today; the `:1450` skip never blocked it.**
Force Audit corrects 0 of 7 **solely** because `resolutionWindowMs = 2h` (`:1948`) and
`toTime = signalTs + resolutionWindowMs` (`:1971`) — it re-reads the same 2h of bars and
re-confirms CLOSED. Widening the window alone is therefore **sufficient to correct the
existing 7**, with no change to `:1450`.

**BUT `:1468` must ALSO change to stop RE-CONTAMINATION going forward.** Two separate
requirements, not to be conflated:

1. **Repair existing** wrong rows: widen `resolutionWindowMs`. Sufficient on its own.
2. **Stop new** wrong rows: fix `:1468`, which marks CLOSED at >2h *without checking any
   bars* and calls `recordTradeOutcome(..., 'LOSS')` at `:1478`. That is the origin of every
   false LOSS. Left in place it keeps writing wrong LOSS labels a widened audit must then
   chase and correct after the fact.

### ITEM 39 — FALSE-WIN MECHANISM: **NOT** A PHANTOM TICK. TWO HYPOTHESES REJECTED BY THEIR OWN GATES.

My Item 37 write-up speculated these 7 came from "the live tick monitor banking a phantom TP".
**That hypothesis is REJECTED by its own pre-registered gate.** Recorded because a wrong
hypothesis stated as fact is exactly what MINDSET rule 2 exists to catch.

**39b EXIT-PRICE FINGERPRINT.** Each live terminal branch writes a deterministic exitPrice, so
the corpus `exit_price` identifies which branch fired — provenance from data, not code reading:

```
  idx  dir   corpus_exit    tp3   partial   after_be_lock      sl   => BRANCH
  243  BUY        4044.9 4044.9    4040.2          4039.8  4032.0   ALL_TARGETS_HIT (TP3)
  245  BUY        4051.0 4051.0    4046.2          4045.9  4038.1   ALL_TARGETS_HIT (TP3)
  341  BUY        4083.2 4083.2    4076.9          4076.5  4064.8   ALL_TARGETS_HIT (TP3)
  342  BUY        4097.2 4097.2    4090.2          4089.6  4078.0   ALL_TARGETS_HIT (TP3)
  345  BUY        4105.0 4105.0    4098.6          4098.2  4086.5   ALL_TARGETS_HIT (TP3)
  362  SELL       4020.2 4013.4    4019.8          4020.2  4031.9   SL_AFTER_BE (post-TP1 lock)
  62   SELL       4124.2 4124.2    4128.4          4129.3  4134.7   ALL_TARGETS_HIT (TP3)
```

6 of 7 came through the **ALL_TARGETS_HIT TP3 branch**, 1 through **SL_AFTER_BE**.

**HYPOTHESIS 1 (phantom tick) — REJECTED.** Gate G1 required: no bar in the full 24h window
reaches the banked TP. Result: **0 of 7.** All 7 genuinely touched their TP on real Vantage
bars. There was no phantom price.

```
  idx  dir   implied_TP   MFE_24h   TP_touched?    TP_at     SL_at   which FIRST
  243  BUY       4044.9    4136.1           YES   +0.61h    +0.04h   SL first
  245  BUY       4051.0    4136.1           YES   +1.79h    +0.08h   SL first
  341  BUY       4083.2    4144.0           YES  +19.59h    +1.42h   SL first
  342  BUY       4097.2    4144.0           YES  +20.38h    +0.41h   SL first
  345  BUY       4105.0    4144.0           YES  +21.76h    +0.13h   SL first
  362  SELL      4019.9    4012.9           YES   +0.78h    +0.32h   SL first
  62   SELL      4124.2    4040.1           YES   +1.17h    +0.14h   SL first
```

**SL was touched FIRST in 7 of 7.** The defect is ORDERING/CONFIRMATION, not price quality.

**HYPOTHESIS 2 (SL-confirmation asymmetry for all 7) — ALSO REJECTED, and my first attempt to
test it was itself methodologically wrong.** Item 39b counted "bars closing beyond SL" over the
full 24h, which for idx 345 returned 1160 bars — that only reflects price collapsing and
staying down all day and says nothing about the first-touch moment. Corrected in Item 39c by
anchoring strictly at the FIRST SL touch:

```
  idx  dir  SL_touch  touch_bar  pen_at  consec_closed  returned_inside  TP_touch  TP<2h
  243  BUY    +0.04h     CLOSED   12.4p              1             YES     +0.61h    YES
  245  BUY    +0.08h       WICK    7.1p              0             YES     +1.79h    YES
  341  BUY    +1.42h       WICK    0.9p              0             YES    +19.59h     NO
  342  BUY    +0.41h     CLOSED    7.2p              1             YES    +20.38h     NO
  345  BUY    +0.13h       WICK    0.6p              0             YES    +21.76h     NO
  362  SELL   +0.32h     CLOSED    7.4p              2             YES     +0.78h    YES
  62   SELL   +0.14h       WICK    8.3p              0             YES     +1.17h    YES
```

Corrected attribution — **the 7 do NOT share one mechanism**:

```
  2 signals  A      (245, 62)        wick-only first touch + TP inside 2h -> confirm asymmetry
  2 signals  B      (341, 345)       wick-only first touch + TP only reachable at +19h/+21h
  3 signals  NOT-A  (243, 342, 362)  first touch CLOSED beyond SL -> live SHOULD have confirmed
```

Bar coverage is clean for all 7 (120 bars per 2h window, max gap 1 min), so the resolver's
SL_HIT labels are trustworthy (G3: 0 of 7 untrustworthy).

**THE REAL ASYMMETRY, named.** The live tick monitor applies a strongly asymmetric evidentiary
standard:

- **SL side** is gated by `confirmSLHit` (`TradingContext.tsx:2812`), requiring >=1.5 pips
  penetration AND >=2500ms sustained AND >=2 ticks (`:196-198`). Price recovering past the
  level **deletes the tracker** (`:2819`), so the breach restarts from zero.
- **TP side has NO gate at all.** `:2882` (BUY) and `:2930` (SELL) are bare comparisons —
  `else if (price >= signal.tp3 && targetsHit < 3)` -> `ALL_TARGETS_HIT` on a SINGLE read.
- The banked exit is then **assumed perfect**: `exitPrice = signal.tp3` (`:2971`), not the
  price actually read.

SL needs proof beyond reasonable doubt; TP needs one glance. For the 2 mechanism-A signals
that is exactly what happened: a brief SL wick failed to confirm, the trade stayed open, and
the later TP was banked instantly and unconditionally.

**FOR THE 5 NON-A SIGNALS THE MECHANISM IS NOT YET PROVEN.** For 341/342/345 the TP is first
reachable on Vantage bars only at +19h to +21h, far outside the live monitor's reach (`:2773`
forces CLOSED past 2h); for 243/342/362 the first SL touch *closed* beyond SL and should have
confirmed. Both anomalies point the same way: **the price series the live monitor was reading
did not match `gold_m1_bars`.** That is the venue split already documented in Phase 0 Item 4 —
entry/live price comes from Capital.com/Swissquote spot while `gold_m1_bars` is Vantage MT5
XAUUSDm. Not asserted as proven; named as the leading remaining candidate.

**39a IMPOSSIBLE-MEASUREMENT DECLARATION (MINDSET rule 8).** The literal tick reads that
triggered these 7 confirmations are **NOT RECOVERABLE**. `diagnosticEventStore` is local SQLite
on a rolling 24h window (`diagnosticEventStore.ts:59`) and these signals are from 2026-07-01 to
2026-07-22. Further, there is no `LIVE_TICK_TP_*` event type at all — the enum (`:19-49`) has
`LIVE_TICK_SL_CANDIDATE`/`LIVE_TICK_SL_HIT` but **no TP counterpart** — so the ungated TP branch
never logged anything even when the store was live. The exact per-tick forensic Item 39a asked
for is impossible, not underpowered.

**FORWARD EVIDENCE THAT WOULD SETTLE IT:** add `LIVE_TICK_TP_CANDIDATE`/`LIVE_TICK_TP_HIT`
events recording the triggering price, its venue/source tag, and the concurrent `gold_m1_bars`
value. That single addition distinguishes venue divergence from a confirmation defect on the
next occurrence, and costs nothing at decision time (the store is fire-and-forget).

### ITEM 39b — SAME BUG CLASS AS THE PATH 3 DEFECT? **NO — A SEPARATE, NEVER-HARDENED PATH.**

Gate G2 asked whether the responsible branch lacks a corroboration gate. Direct comparison:

- **Path 3 (catch-up fallback), ALREADY HARDENED.** Every TP branch is gated: `:1585`
  `currentPrice >= signal.tp3 && confirmFallbackBreach('TP3', ...)`, likewise TP2 `:1594`,
  TP1 `:1599`, SELL side `:1636/:1645/:1650`. `confirmFallbackBreach` (`:1529`) enforces the
  same duration/penetration/tick thresholds across separate catch-up passes and logs
  `PATH3_TP_CANDIDATE`/`PATH3_TP_CONFIRMED`. The comment at `:1523-1528` records this as the
  Part A TP-direction-mixup fix.
- **Path 1 (live tick monitor), NEVER HARDENED.** `:2882`/`:2930` have no gate and no event.

**Verdict: the earlier fix has NO gap — it did exactly what it claimed, but only for Path 3.**
The defect class (a single uncorroborated read banking a terminal outcome) was fixed in the
fallback path and left untouched in the primary live path. The named path is
**`updateAllSignalsStatus`'s TP1/TP2/TP3 branches, `TradingContext.tsx:2882` (BUY) and `:2930`
(SELL)** — the only remaining ungated terminal-banking comparisons in the codebase.

The `classifyTick` spike gate (`:2752`) is NOT a substitute. It rejects only jumps exceeding
`8 + 6*dt` pips (capped at 10s, max 68 pips). TP3 distances here are 4-10 price units, well
inside that budget, so the spike gate passes these ticks through by design.

### ITEM 39c — IS THE FALSE-WIN MECHANISM CURRENTLY ACTIVE? **YES.**

Gate G3 required the ungated branch to be present in the working tree and reachable.

- Present: `:2882`/`:2930` are ungated in the current working tree. `git status` confirms
  `TradingContext.tsx` is unmodified — this is committed, live code.
- Reachable: `updateAllSignalsStatus` runs on every accepted live tick, behind no feature flag.
  The only guards before it are the spike gate (`:2752`, passes normal TPs), a 5s grace period
  (`:2769`), and the >2h CLOSED cutoff (`:2773`).
- No TP-side telemetry exists, so recurrences are currently **invisible**.

**A signal generated today can still get a false WIN recorded.** The corpus is therefore still
actively accumulating false-WIN contamination, **independent of Item 35** and **unaffected by
widening the audit window**. This is why the Item 37 fix sequence was incomplete: it addressed
only the false-LOSS half.

One mitigating note, for accuracy: the daily sweep runs `force:true` (`:2283`, `:3198`) with
`fromScratch`, which CAN undo a falsely-banked TP — but only for signals whose SL event falls
inside the 2h window it reads, and only when the app is foregrounded during the sweep. It
corrected none of these 7.

### ITEM 40 — THE LIVE WEIGHT VECTOR **IS** FITTED TO CONTAMINATED LABELS

Live `model_weights_v1` provenance (export SECTION 2):

```
  Last training time:              2026-08-06T07:50:00.730Z
  Feature count:                   6
  Corpus size at training:         51 outcome(s)
  Corpus-unavailable at training:  0
```

The 17 wrong rows were **re-derived independently** (not hardcoded from Item 37): all 51 corpus
rows matched and bar-covered, resolved fromScratch over 8h, 17 disagreements — the same 17,
confirming Item 37 reproduces.

**40a — retrain enumeration is IMPOSSIBLE from durable evidence (MINDSET rule 8).**
The corpus reached the 20-outcome retrain gate at **2026-07-31T09:13:29Z** (row #20 by ts,
signal `3xb0vvcw8`). From that instant every `recordTradeOutcome` could trigger a retrain
(48h-scheduled `:6552`, or confidence/drift `:6558`, deferred to 22:00-07:00 UTC `:6565`). But
`model_weights_v1` persists **only the latest** retrain (`:6823-6827`) — no retrain-history array
and no durable retrain-history table (`backend/migrations` holds only `shadow_signals_v1`). The
full list of historical retrains and their exact training sets is **not recoverable**.
Impossible, not underpowered.
**FORWARD EVIDENCE:** append-only retrain-history record (timestamp + training-set signal_ids)
written on every `walkForwardOptimization`.

**40b — THE ANSWER, unambiguous:**

```
  Live vector trained at:                  2026-08-06T07:50:00.730Z
  Training window (14d):                   ts >= 2026-07-23T07:50:00.730Z
  Rows existing at training time:          51
  Of those, inside the 14-day window:      51
  Fallback path used (window < 10)?        NO
  RECONSTRUCTED TRAINING SET SIZE:         51
  PERSISTED corpusSizeAtTraining:          51   <- G3 MATCH, reconstruction is reliable

  Known-wrong rows inside the training set: 17
  CONTAMINATION FRACTION:                   33.3%
  G1 VERDICT: live weight vector is CONTAMINATED.
```

G3 closed cleanly: persisted `corpusSizeAtTraining` (51) equals the reconstructed training-set
size (51), so the reconstruction is cross-validated rather than assumed. The entire corpus fell
inside the 14-day window, so the training set IS the whole corpus — every one of the 17 wrong
rows is in it.

**Decay-weighted influence.** `retrainModel` applies `weight = 0.75 ^ daysSinceOutcome`
(`:6644-6651`), normalised. The wrong rows carry **26.5% of total decay weight** versus their
33.3% raw count share — slightly less than headline, because most cluster on 2026-07-29/31,
6-8 days before training. But the single most influential wrong row is the most recent one:

```
  2026-08-03  dm1mv29uv  weight=4.51%   (corpus LOSS, bars ALL_TARGETS_HIT)
  2026-07-31  663a4rkbv  weight=1.70%
  2026-07-31  9d4fa59b8  weight=1.70%
  2026-07-31  adsl1y6o0  weight=1.70%
  2026-07-31  hy4qxpd99  weight=1.70%
```

One mislabelled row (`dm1mv29uv`, a real ALL_TARGETS_HIT recorded as LOSS) carries 4.51% of the
entire training signal on its own.

**Plain answer for the retrain-halt decision:** the currently live 6-feature weight vector was
fitted on 51 outcomes of which 17 (33.3% by count, 26.5% by decay weight) carry the wrong label.
It is contaminated NOW — this is not a future risk. Retraining again before the corpus is
corrected re-fits to the same wrong labels. The decision is the user's, on these numbers.

### BOTH CONTAMINATION MECHANISMS, SIDE BY SIDE (for the single combined correction)

```
  mechanism      rows  origin                               fixed by widening window?
  false LOSS       10  :1468 marks CLOSED at >2h with no     PARTIALLY - repairs existing;
                       bar check, then records LOSS :1478    :1468 must change to stop new
  false WIN         7  :2882/:2930 ungated TP branches       NO - untouched by window width;
                       bank a terminal on a single read      STILL ACTIVE TODAY
```

**Item 37's proposed 5-step fix sequence covers only the false-LOSS column.** A combined
correction must also address `:2882`/`:2930`, or the corpus re-contaminates from the false-WIN
side immediately after the repair.

## 3v. ITEMS 41 & 42 — FALSE-LOSS MECHANISM FIXED, LIVE TP BRANCHES GATED (2026-08-11, FIRST ENGINE CHANGE SINCE ITEM 22)

Scripts: `test_item41_false_loss_fix_replay.ts`, `test_item42_tp_gate_replay.ts` (both read-only).
Engine files modified: `expo/contexts/TradingContext.tsx`, `expo/services/diagnosticEventStore.ts`.
**SL-side logic and Path 3 were NOT touched.** `runChecks(expo)` clean.

### ITEM 41 — THE 2h WALL-CLOCK LOSS STAMP IS GONE

One canonical constant now owns maturity on all three paths, so they cannot drift apart
again:

```
  TradingContext.tsx:259   const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;
```

8h is the Item 38 measured basis, not a preference: corrections flatten at 8h (0 further
corrections at 12h/24h), |EV(12h)-EV(8h)| = 0.0000R, cost 447.4 bars/signal vs a 5000 veto.

```
  41a  audit default windowMs   twoHoursInMs -> RESOLUTION_WINDOW_MS   (~:1998)
  41b  catch-up ">2h => CLOSED + recordTradeOutcome(LOSS)"  DELETED
       replaced by barWindowEnd/isMatured + coverage-gated resolution (:1512-:1513)
  41c  live monitor ">2h => CLOSED" wall-clock stamp        REMOVED
       now `if (signalAge > RESOLUTION_WINDOW_MS) return signal;`
  all three `twoHoursInMs` declarations removed
```

41c was beyond the literal brief and is called out deliberately: the live monitor held a
SECOND evidence-free CLOSED that fed `:1450`'s skip guard. Without removing it, 41c's own
premise would have been false.

**A label is never guessed.** Resolution runs `fromScratch` only when `assessBarCoverage`
reports dense; thin coverage leaves the status untouched for a later pass.

Replay of all 51 corpus rows through the fixed path (47 dense-covered, 4 left unchanged):

```
  G41-1  10 false-LOSS rows, 10 now WIN, 0 still LOSS                 PASS
  G41-2  30 rows where corpus and bars already agree, 0 flipped       PASS
  G41-3  4 thin-coverage rows, 0 of them labelled anyway              PASS
```

Note on the brief's wording: it said "the 7 known false-LOSS signals". Item 37's measured
split is 10 false LOSS + 7 false WIN = 17. The 10-row set is what Item 41 owns; the 7 are
the false-WIN set and belong to Item 42.

EV on the replayed set (informational only — Item 43 owns the durable correction):
corpus as stored -0.1818R (n=51) vs fixed path -0.1335R (n=47), delta **+0.0483R**.

### ITEM 42 — LIVE TP3 BRANCHES NOW MEET THE SL SIDE'S OWN EVIDENCE STANDARD

42a gates BOTH terminal TP3 branches through `confirmTPHit`, which calls the SAME already-
validated pure helper as `confirmSLHit` with the SAME three constants — no new parameter
was invented:

```
  SL_CONFIRMATION_MIN_PENETRATION_PIPS  >= 1.5 pips
  SL_CONFIRMATION_MIN_DURATION_MS       >= 2500 ms
  SL_CONFIRMATION_MIN_TICKS             >= 2 ticks
```

TP1/TP2 are deliberately left ungated: they are non-terminal, and gating TP1 would move the
post-TP1 profit lock — i.e. SL-side behaviour, which is out of scope.

42b adds `LIVE_TICK_TP_CANDIDATE` / `LIVE_TICK_TP_HIT`, carrying `venue`, `refPrice`,
`penetrationPips`, `elapsedMs`, `tickCount`, `concurrentBarClose` and `barVsTickDelta`.
This is the instrument whose absence made Item 39a impossible.

**G42-1 COULD NOT BE CLOSED, AND IS NOT CLAIMED.** Item 39 established SL was touched FIRST
on real bars in 7 of 7. Any bar-faithful tick stream therefore reaches the SL branch before
TP3 is ever evaluated — the UNGATED mirror already returns SL_HIT for all 7, so the replay
contains no false WIN for the gate to refuse. The corpus WIN could only have come from prices
that disagree with `gold_m1_bars`, and those literal ticks are unrecoverable (24h rolling
store, signals from 2026-07-01..2026-07-22, no TP telemetry type existed). IMPOSSIBLE, not
underpowered. **The 7 rows are NOT claimed fixed by Item 42.** What this does establish is
narrower and useful: they are not reproducible from Vantage prices at all, so venue divergence
(Phase 0 Item 4) is the only mechanism still standing, and 42b settles it on the next event.

G42-1b replaces it with a test that IS decisive for the shipped code, on a real signal's real
levels:

```
  stream      UNGATED (old code)   GATED (Item 42a)   verdict
  FLICKER     ALL_TARGETS_HIT      TP2_HIT            defect reproduced, then refused
  SUSTAINED   ALL_TARGETS_HIT      ALL_TARGETS_HIT    genuine TP3 still banked
```

FLICKER = one lone tick 0.5 pips past TP3 (sub-threshold on all three axes). SUSTAINED = 4-5
pips past TP3 held across 5 ticks / 60s. A no-op gate banks both; an over-conservative gate
refuses both. The shipped gate does neither.

Control arm (G42-2), size set by the data and reported whatever it came out as:

```
  bar-verified genuine ALL_TARGETS_HIT signals   7
  still banked by the LIVE MONITOR under gate    6
  no longer banked live                          1   (idx 367, n0xo9skxy)
```

The 1 is NOT a lost win. The bar resolver is authoritative and UNCHANGED by Item 42 — the 8h
audit still books it as ALL_TARGETS_HIT from real bars. The gate only removes the live
monitor's authority to bank a terminal on evidence that would not survive the SL side's own
standard.

### STATE AFTER 41+42

Both re-contamination mechanisms from §3u are closed at the source. The corpus itself is
still wrong — 17 bad rows are still stored, and `model_weights_v1` is still trained on them
(33.3% by count, 26.5% by decay weight). **Item 43 (corpus correction) and Item 44 (single
retrain) have NOT been started.**

## 3w. ITEMS 43 & 44 — CORPUS CORRECTED TO BAR TRUTH, RETRAIN MEASURED (2026-08-11)

Scripts: `item43_correct_corpus.ts` (the only WRITING script in this sequence),
`test_item43b_local_tier_repopulate.ts`, `item44_retrain_on_corrected_corpus.ts`.
Engine file modified: `expo/services/learningStore.ts` (43b). `runChecks(expo)` clean.

### ITEM 43(a) — ALL 17 ROWS REWRITTEN TO THEIR BAR-VERIFIED TRUTH

Census, not a sample: all 51 durable rows re-derived from real Vantage bars over the 8h
window. 51/51 had recoverable geometry, 0 unmatched, 0 flat resolutions. Exactly 17
disagreed — the same 17 Items 37/39/40 identified, no more and no fewer.

Stored values reproduce the engine's own convention rather than a new one
(`signalEngine.ts:6440,:6472,:562`): `pnl = ±|exit-entry|`, `realized_r = pnl/|entry-sl|`,
`is_scratch = |R| < 0.15`. Reads anon-direct; writes service-role only.

```
  10 false LOSS -> WIN     idx 15, 33, 36, 246, 249, 250, 251, 253, 344, 379
   7 false WIN  -> LOSS    idx 62, 243, 245, 341, 342, 345, 362
```

The 7 false-WIN rows WERE corrected despite Item 42's G42-1 being unclosable, because those
are different questions: "what did price do" is settled with certainty by bars (SL first in
7 of 7, three gate closures in Item 39); "can a replay reproduce the live monitor banking
them" is what died with the lost ticks. The corpus stores the first answer.

```
  G43-1 exactly the 17 disagreeing rows written, 0 errors             PASS
  G43-2 independent read-back (fresh anon client) confirms 17/17      PASS
  G43-3 0 of 51 bar-resolvable rows still disagree                    PASS
  G43-4 no row created or deleted (51 before, 51 after)               PASS
```

### ITEM 43(b) — THE HYDRATE PATH WOULD HAVE THROWN THE CORRECTION AWAY

Reading the live path (not assuming) found the corrections could never have reached the tier
the model trains from. `hydrateFromRemote()` merged as a pure UNION BY signalId — "a
signalId already present locally is left untouched". On any device already holding the 17
stale rows (the normal case on native, where the tier is durable SQLite) the durable
correction was silently discarded, forever, with nothing in the logs.

Fixed in `learningStore.ts`: on a label/R conflict the DURABLE row wins, because the local
tier is only ever a cache of it (learningStore's own stated contract). Local-only rows are
still never discarded — they are still backfilled upward. Relabels are logged and returned
as a new `refreshed` count.

Proven against the real module and the real corrected corpus, by seeding a tier with the
exact pre-Item-43 labels:

```
  G43b-1 17/17 rows carry the corrected label after hydration         PASS
  G43b-2 zero stale labels remain                                    PASS
  G43b-3 row count preserved (52 -> 52), no signalId lost            PASS
  G43b-4 CONTROL: 34 already-correct rows byte-identical             PASS
  G43b-5 a local-only row SURVIVES (a refresh, not a wipe)           PASS
```

### ITEM 43(c) — CORRECTED CORPUS EV

```
  BEFORE  n=50  EV=-0.1853R  WR=48.0%  PF=0.644
  AFTER   n=51  EV=-0.1476R  WR=52.9%  PF=0.686
  DELTA        EV +0.0377R   WR +4.9pp
```

This is a corrected MEASUREMENT of the same past trades, not an improvement in the strategy.
Nothing about the engine got better between BEFORE and AFTER. Note the corpus EV
(-0.1476R) still differs from the canonical bar-replay EV (+0.0800R, Item 38) — the corpus
prices real entry fills, the replay prices bar geometry; §3s owns that reconciliation.

### ITEM 44 — RETRAIN MEASURED; THE LIVE VECTOR IS STILL THE CONTAMINATED ONE

`model_weights_v1` is device AsyncStorage with no server copy, so writing the live vector
from a script is IMPOSSIBLE by architecture. What was done instead is the part that answers
the question: the REAL `retrainModel()` over the REAL corrected corpus, on the same n=51
training set Item 40 reconstructed, so the ONLY variable is the 17 labels.

**G44-4 (cold-start control reproduces the live vector) could NOT close, and is not claimed.**
Both cold arms returned rsi_weight = exactly -0.600000 against the live -0.956150. The
arithmetic names the cause: `W_final = 0.4*W_historical + 0.6*W_recent` (`:6774`), and a cold
engine has `W_historical = 0`, so a fully saturated -1.0 fit can only reach -0.6. -0.956150
is the fixed point that many COMPOUNDING cycles converge toward. Reproducing it needs the
full retrain history, which Item 40 already established is never persisted. IMPOSSIBLE, not
underpowered.

First-principles consequence, and the operationally useful number: the device will not cold
start either — its next retrain blends the corrected fit against the contaminated vector it
holds. Seeding the live vector as `W_historical` via the real `loadPersistedLearningData()`
gives the warm-start prediction:

```
  feature             LIVE (now)   WARM on OLD    WARM on CORRECTED   delta(corr-old)
  rsi_weight           -0.956150     -0.982460           -0.982460         +0.000000
  atr_weight            0.564880      0.475395            0.288458         -0.186937
  sentiment_weight     -0.142306     -0.248917           -0.396034         -0.147117
  volume_weight         0.052717      0.069033            0.077075         +0.008042
  timeWindow_weight    -0.044876     -0.077962           -0.076128         +0.001834
  dxy_weight            0.000273      0.000109            0.000109         +0.000000
```

```
  G44-1 training set carries zero stale labels (0 of 51)                     PASS
  G44-2 n=51 === Item 40's corpusSizeAtTraining (labels are only variable)   PASS
  G44-3 6/6 features defined and finite                                      PASS
  G44-4b(i)   warm seed verified === live vector to 1e-9 before training      PASS
  G44-4b(ii)  labels demonstrably move weights (max delta 0.186937)          PASS
  G44-4b(iii) corrected retrain deterministic across two runs (1e-12)        PASS
```

Contamination cost the model most on `atr_weight` (0.475 -> 0.288, a 39% overstatement of
volatility's discriminative power) and `sentiment_weight` (-0.249 -> -0.396). `rsi_weight`
is saturated at the clamp in both arms, so the labels cannot move it. No sign flips.

**LIVE STATUS, stated plainly: the device still holds the contaminated
2026-08-06T07:50:00.730Z vector.** 43(b) changed the INPUT, so the next scheduled retrain
(48h / drift / confidence degradation) reproduces the corrected column. FALSIFIABLE CHECK:
export SECTION 2 must show a `Last training time` later than 2026-08-06T07:50:00.730Z with
those weights. Until that timestamp moves, nothing here has reached production.

## 4. Open Finding — Drift-Veto-on-BUY (NEXT optimization candidate, deliberately deferred)

**Finding (from prior session, `expo/scripts/analyzeDriftVetoOnBuy.ts`):** the Phase 2 counter-trend drift veto IS over-firing on BUYs. It dropped **4/50** counter-trend BUYs that had **positive EV (+0.2295R, 75% win rate)**. Three of the four were winners (+1.149R, +0.385R, +0.385R). The veto is costing the long book **$3.8 in net $** and **+0.0036R in EV per signal**. The veto threshold (2.0×ATR) may be too low for BUYs, or the counter-trend classification may be too broad.

**Why this matters now:** longs are the entire system (SELLs suppressed). A veto that drops winning longs directly costs the only book that's running.

**Status: NOT actioned. Deliberately deferred.** This was investigated read-only and logged. No engine change was made. The current samples predate the Step 2 data-venue fix, so acting on this now would be optimizing against a baseline measured on the wrong venue. The recommended sequence is: let the corrected engine run → gather real forward data → re-evaluate the drift veto against the new baseline before any fix.

---

## 5. Recommended Next Action

**LET THE SYSTEM RUN and gather real forward data from the corrected engine before any further optimization.** The current samples (six counterfactuals, Phase 1 audit, drift-veto analysis) all predate the Step 2 data-venue unification. Every conclusion in this build is sound on its own measured data, but the forward data from the corrected engine is the only data that reflects the system as it now genuinely stands. Acting on further optimization now — drift-veto fix, new geometry variants, new filters — would be optimizing against a baseline that no longer exists.

Specifically:
1. **Shadow logging is live** (Design B, verified 2026-07-31 with live DB evidence) — no backend dependency for shadow WRITES. The backend tRPC routes are now deployed (200 OK as of this verification), but the write path writes directly via the anon key regardless. The backend `shadow.summary` route is used only for the diagnostics export SUMMARY section; if it reverts to 503, the summary will be null but the write-path counters in SECTION 6 still render.
2. **Run forward for at least 2-3 weeks** on the corrected engine (gold_m1_bars as primary OHLC + SELL suppressed + shadow logging live).
3. **Re-export diagnostics** and re-run the drift-veto-on-BUY analysis against the new forward data before deciding whether to adjust the veto threshold.
4. **Monitor `shadow_signals_v1`** to confirm suppression is still the right call — if a future regime shift toward gold weakness is detected (shadow SELLs start showing positive EV against real bars), flip `allowShortSignals` back on.

### LIVENESS CHECK — repeatable, anyone can run later

To confirm shadow logging is actually working at any later date (no need to re-derive the architecture):

```sql
-- In the Supabase SQL editor or via the anon client:
SELECT count(*) AS recent_shadow_sells
FROM shadow_signals_v1
WHERE created_at > now() - interval '6 hours';
```

**Interpretation (see also §6 for Items 52–55):** if `allowShortSignals` is currently `false` (the default) and `recent_shadow_sells = 0`, the shadow write path is broken — suppressed SELLs are NOT being logged durably. Check in order: (1) the Supabase project is reachable and `shadow_signals_v1` exists (migration `003_shadow_signals_anon_insert.sql` applied); (2) `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set in the client env; (3) the RLS INSERT policy on `shadow_signals_v1` is still present (`SELECT polname FROM pg_policies WHERE tablename = 'shadow_signals_v1'`). If all three are fine, export diagnostics from the app and check SECTION 6 — the `shadowWriteFailures` counter will be > 0 if the live process has been seeing insert failures. A zero-rows + zero-failures result means suppression is genuinely inactive (no qualifying SELLs in the window), not a broken path.

---

## Items 63–66 closeout (Items 67, 68, 69) — 2026-08-12

**Item 67 — G63-4 re-run as a controlled comparison.** The originally reported G63-4 mixed a prior-session BEFORE (step=25) with a this-session AFTER (step=50) — two uncontrolled variables at once, the exact comparison pattern already proven invalid for the old synthetic harness. Re-run properly: pre-63/64 engine extracted read-only from git (`git show a101ad2^:expo/services/signalEngine.ts`, where `a101ad2` is the Items 63/64/66 commit — parent has zero matches for the new constants), BEFORE run at step=50; shipped engine restored (byte-identical, working tree clean, `runChecks` green); AFTER run at step=50; same session, back to back, same 13,899 bars ($4,019.10–$4,441.15). Result: BEFORE 272 attempts / 0 signals / 181 conviction rejections (66.5%); AFTER 272 attempts / 0 signals / 183 (67.3%). **New instrumentation finding:** two runs of IDENTICAL AFTER code (earlier `AFTER-item63-64` vs `AFTER-controlled-step50`) differ by 11 conviction rejections (172 vs 183) — the harness has a run-to-run noise floor and the 181→183 BEFORE/AFTER delta is inside it. Conclusion (0 signals both, rejection profile unchanged) survives the controlled comparison. Standing use pattern established: BEFORE/AFTER harness comparisons must be same-session, same step, back to back, and deltas must exceed the same-code rerun noise floor before any claim is made.

**SUPERSEDED BY ITEMS 71/72 — the "unchanged profile" reading was a noise artefact.** Re-run on the deterministic instrument (Date-constructor clock installed before the engine import, tape pinned via `--tape-end`, step=10 = 1,354 attempts/arm, three arms in parallel on one pinned 13,837-bar tape): BEFORE (parent `a101ad2^`) 851 conviction rejections / 62.9%, 12 strength-diff-too-small; AFTER twin A 942 / 69.6%, twin B 941 / 69.5%, both 1 strength-diff-too-small. Same-code twin spread = 1 rejection (0.07pp); BEFORE→AFTER delta = +91 rejections (+6.7pp) = **~91x the noise floor, a real effect that the old ±4pp instrument could not see**. Mechanism, exactly as predicted mechanically at ship time: Item 63's mutual exclusion removes the dual-fire S/R and QM contributions that used to inflate winning strength, so more attempts now fall below the conviction threshold, and the strength-difference gate nearly stops firing (12→1) because the losing side no longer supplies competing strength. Emissions were 0 in all arms, which per Item 71 is the EXPECTED and uninformative result.

**Item 68 — migration 005 confirmed.** Actual file: `backend/migrations/005_trade_outcomes_anon_upsert.sql` (34 lines). Grants INSERT and UPDATE to anon/authenticated on `public.trade_outcomes_v1`. Difference from migration 003 (shadow_signals_v1, INSERT-only): the UPDATE policy exists because the anon upsert (`onConflict: 'signal_id'`) and the Item 43b label-correction flow both need it. Design B pattern otherwise identical.

## Items 77, 75, 78, 79, 80 — 2026-08-14

**Item 77 — resolver DEPLOYED and RESOLVING.** Three controlled probes from one run: POSITIVE (refresh-sr-zones → HTTP 200), NEGATIVE (no-such-function-xyz → HTTP 404), TARGET (resolve-emitted-signals → HTTP 200 with body `{"ok":true,"examined":3,"resolved":0,"skippedExisting":3,"unresolvable":0}`). `trade_outcomes_v1` = 54 rows (was 51, +3 from resolver). pg_cron schedule BLOCKED — `cron.job` not exposed via PostgREST (PGRST205); migration 004 has the schedule as a commented-out template requiring manual SQL execution. Drift-check script shipped at `expo/scripts/check_resolver_deployment.sh` (all 3 probes pass).

**Item 75 — 413 rows BACKFILLED to emitted_signals_v1.** Parser extracted 413 records from the 13 Aug export SECTION 1, 413 unique IDs (PASS). All 413 upserted with `source='BACKFILL'` via `Prefer: resolution=ignore-duplicates` (0 errors). 3 LIVE rows verified intact (all still `source='LIVE'`). Post-backfill: 3 LIVE + 413 BACKFILL = 416 total. No status label was read into any column (G75-2). 75(d): `trade_outcomes_v1` ∩ SL_AFTER_BE = 15 (not 149) — the 149 local corpus signal_ids are NOT the same set as the 149 SL_AFTER_BE signal_ids. 39 of 54 `trade_outcomes_v1` rows are NOT SL_AFTER_BE, refuting the capture-selection hypothesis. 95 of 149 local corpus rows are local-only and not accessible from this environment.

**Item 78 — silent swallow FIXED.** `pushOutcomesToRemote` return type changed to `{ upserted, queued, failed, failureDetail }`. `!remoteSyncEnabled` path now queues outcomes (was silently dropping them). Batch and failed arrays deduplicated by `signalId`. Caller at hydrateFromRemote now logs failure detail. Forced-failure test: bad table → HTTP 404 PGRST205, invalid key → HTTP 401, correct table → HTTP 201, cleanup → HTTP 204. The `pushFailureStatusKey` function buckets these as 'PGRST205' and '401'. runChecks green. Harness stub updated for new return type.

**Item 79 — 413/413 is a COINCIDENCE.** Intersection of 413 export IDs and 413 `shadow_signals_v1` IDs = **0** (completely disjoint). `shadow_signals_v1` genuinely holds 413 suppressed SELLs (all `direction='SELL'`), NOT the same population as the export's 413 signals. SECTION 6 only reports 5 (from in-memory counters since process start). 408 of 413 rows are missing from SECTION 6's window. Per prompt: reported and STOPPED — no fix on the spot.

**Item 80 — granularity measured, :6001 instrumented, harness precondition shipped.** AFTER arm (n=67, --step 200, TIER0_UNAVAILABLE=0): 37 distinct values, modal spacing 0.01 (10 times), top 10 mass points = 56.7% of total. Contributions enumerated: 0.40/0.35/0.30/0.25/0.12/0.10/0.09/0.08/0.03. Mass at 0.5300 explained by combinations: 0.40+0.10+0.03, 0.35+0.10+0.08, 0.30+0.12+0.08+0.03. Position: increments are DELIBERATE DESIGN (fixed weights), but the granularity is an ARTIFACT for threshold-tuning — the staircase distribution prevents any threshold from achieving a target pass rate. :6001 instrumentation shipped: `calibrationPenalty25Count` counter + `CALIBRATION_PENALTY_25_FIRED` log + `getCalibrationPenalty25Stats()` getter. Counter incremented: fired 1 time(s) in the --step 200 run. 0.25 and 0.04 confirmed unchanged. Harness precondition shipped: `TIER0_UNAVAILABLE` count in header + DEGRADED banner logic.

**Standing items carried forward:** pg_cron schedule for `resolve-emitted-signals` needs manual SQL execution (BLOCKED from this environment). Items 13, 8, 20, 56's trendStrength cutoff, 60's RSI reformulation, 63(f)(ii), and the 4 remaining 73(c) constants remain unshipped. SPREAD unchanged at $0.20.

## Items 74, 76, 73, 75 — 2026-08-14

**Item 74 — push telemetry SHIPPED; the gap is now observable. Gates BLOCKED on a device export.** The export carried hydrate counters and NOTHING outbound, so "was a push attempted?" was unobservable. Added: (a) a build marker (`expo/constants/buildMarker.ts`, SHA `43bf752`) plus three RUNTIME symbol probes rendered in the export header — `signalEngine.getConsumedModelWeightKeys()` (Item 64, expect 4), and `learningStore.getPushPathDescriptor()` returning the live `PENDING_PUSH_KEY`, `OUTCOMES_TABLE`, onConflict key and whether the anon client actually constructs (Item 66); (b) durable outbound counters in AsyncStorage key `outbound_push_stats_v1`, rehydrated at init and ADDED not assigned — attempts, successes, failures bucketed by PostgREST code, cumulative ROWS pushed, queue depth now and at init, last attempt/success/failure, verbatim 300-char failure body, and a `suppressedByReason` map that counts every early return that exits WITHOUT a network call (`REMOTE_SYNC_DISABLED`, `EMPTY_BATCH`, `SUPABASE_NOT_CONFIGURED`); (c) reconciliation visibility computed on every hydrate (local count, remote count, local-only, remote-only). G74-0/G74-1/G74-2 are BLOCKED: they require a fresh on-device export, which cannot be produced from this environment.

**Item 74(d) SUPPRESSION AUDIT — the key finding. Reconciliation-on-hydrate ALREADY EXISTS and predates Item 66.** `hydrateFromRemote` computes `missingRemotely = local.filter(o => !remoteIds.has(o.signalId))` and pushes it (`learningStore.ts:786-790`); the identical block exists in the pre-66 snapshot (`__sandbox_item12__/learningStore.item12.ts:687`). Only two callers of `pushOutcomesToRemote` exist in the live tree: `signalEngine.ts:6803` (on outcome recording) and that hydrate path. **This REFUTES H1 by code reading** — H1 claimed "nothing diffs local against remote and enqueues the 98", but the diff has always been there. Failures are swallowed (`console.warn` only, never rethrown, `pushOutcomesToRemote` never throws by contract) — reportable, not fixed.

**Item 76 — NO BRANCH TAKEN. Blocked by design, not by effort.** G74-2 cannot close without a post-migration export. The 2026-08-13T12:49Z export predates the migrations (004's first LIVE row lands 15:49Z), so every push it could describe would have failed with 42501 for reasons since removed. Writing Branch A reconciliation would duplicate logic that already exists and would be shipped on unmeasured mechanism. Migration state verified live and is NOT the blocker: anon upsert to `trade_outcomes_v1` now returns `23502` (NOT NULL on `ts`) — RLS PASSED — and anon PATCH returns `204`, so INSERT and UPDATE policies are both live.

**Item 73 — PREMISE ERROR + INSTRUMENT DEFECT + G73-1 FAIL. Threshold NOT changed.** (1) The live conviction constant is `MIN_SIGNAL_CONVICTION_THRESHOLD = 0.55` (`signalEngine.ts:408`), NOT the 0.35 the item assumed; 0.35 does not exist as any strength gate (the regime diff floors are 0.09/0.11/0.13/0.15). Confirmed at runtime: the harness now reads the threshold back out of the engine's own log line rather than quoting the repo, and both arms printed `conviction min OBSERVED FROM THE ENGINE: 0.55`. (2) INSTRUMENT DEFECT, found and fixed mid-item: the first pair of arms ran with `TIER0_UNAVAILABLE reason=NOT_CONFIGURED` on all 1,348 evaluations because the replay trees never populated `process.env` — the engine fell back to TIER_1 local micro-zones. Item 63 is *about* S/R zone mutual exclusion, so that measurement was structurally incapable of measuring it and is DISCARDED (it reported BEFORE/AFTER pass 72.48%/62.76%). Re-run with the environment armed (`TIER0_UNAVAILABLE` count 0, `sr_zones_v1` = 22 rows). (3) Canonical result, one pinned 13,837-bar tape (`--tape-end 1786604170000`), step=10, n=1,348 strength values per arm, attempt counts identical at 1,354: BEFORE (`a101ad2^`) mean 0.4905, median 0.4700, pass@0.55 = 488/1348 = **36.20%**; AFTER (HEAD) mean 0.4577, median 0.4600, pass@0.55 = 410/1348 = **30.42%**. Item 63 made the engine **5.79pp stricter** — direction and rough magnitude replicate the earlier +6.7pp finding. (4) **G73-1 FAILS.** The AFTER distribution is a STAIRCASE, not a continuum: 120 values sit exactly at 0.5300 and 78 exactly at 0.5500, so achievable pass rates jump 40.06% (thr<=0.530) -> 30.64% (thr=0.540). The best achievable is +3.86pp, far outside the +/-1.0pp gate. **No threshold reproduces the BEFORE pass rate, so per the pre-registered rule nothing was changed.** The mass points are engine output granularity (contributions added in 0.05/0.01 steps), so a percentile re-anchor is the wrong instrument for this constant.

**Item 73(c) COMPOUNDING GATES — inventory, all calibrated pre-Item-63.** Downstream of the conviction gate, `strengthDifference` (a strength-derived quantity, directly shrunk by mutual exclusion) is compared against FIVE further constants: `signalEngine.ts:5875` regime floors 0.09/0.11/0.13/0.15 via `getMinStrengthDifferenceForRegime` (+ adaptive adjust, floored at 0.04); `:5904` 0.15 (moderate-conviction warning, log-only); `:5960` 0.12 and `:5963` 0.18 (confidence tiering); `:6001` 0.25 (adds +0.04 calibration penalty). Completeness established by enumerating every occurrence of the two carrier identifiers `winningStrength` and `strengthDifference` across all 9,238 lines and classifying each of the 28 hits as gate / log / assignment / telemetry — not by searching for numeric literals, which cannot be exhaustive. Live evidence they compound: the strength-difference rejection fell 10 -> 3 between arms while conviction rejections rose 862 -> 938, i.e. rejection PRESSURE MIGRATED between gates rather than appearing. `:6001`'s 0.25 penalty is the one that silently tightens the confidence gate without ever logging a rejection. Reported only; no per-constant re-anchor shipped.

**Item 75 — BLOCKED at 75(a) and 75(d); nothing backfilled.** (a) The backfill population CANNOT be established: the emission history lives only inside a client-side diagnostics export artifact, and the anon bucket listing returns `[]`, so no artifact is retrievable from here. The 413-vs-396 discrepancy is now RESOLVED and both numbers are wrong for this purpose — **413 is the live row count of `shadow_signals_v1`** (verified: `content-range: 0-0/413`), a different population (suppressed SELL shadows), while 396 was the emitted-signal count quoted from an export header. They were never the same quantity. Backfilling to a population I cannot count would violate the rule against unmeasured numbers. (d) The resolver is **NOT DEPLOYED**: `POST /functions/v1/resolve-emitted-signals` returns 404, identical to a deliberately nonexistent function control, while `refresh-sr-zones` returns 200 from the same call shape. `backend/functions/resolve-emitted-signals/index.ts` exists in the repo and is therefore repo-only — the same repo/production drift class as migration 003. No pg_cron schedule can be confirmed either. **The forward path is NOT verified.** (b)(c) not attempted, so no outcome labels were written anywhere.

**Item 75 — the emission write path IS working, unprompted good news.** `emitted_signals_v1` now holds 1 row, `source='LIVE'`, `signal_id=signal_1786636175293_agy7h6uok`, emitted 2026-08-13T15:49:35Z, SELL 4368.6/SL 4376.6, with a full 10-zone TIER_0_SERVER `sr_zones_snapshot`. The user's earlier 0/0/0 count was taken minutes after table creation. Emission persistence (Item 52) is live and capturing forward.

## Items 70, 71, 72 — 2026-08-13

**Item 70 — the migration SQL was INVALID; fixed.** `CREATE POLICY IF NOT EXISTS` is not valid PostgreSQL in any version: the PG17 `CREATE POLICY` grammar has no `IF NOT EXISTS` clause (it exists for CREATE TABLE/INDEX only), and pasting it fails with `ERROR: syntax error at or near "NOT"`. It was present in `003_shadow_signals_anon_insert.sql:15` and `005_trade_outcomes_anon_upsert.sql:29,33`. Both 004 and 005 now obtain idempotency from `DROP POLICY IF EXISTS` on the same policy names immediately before each plain `CREATE POLICY`. **Unresolved contradiction, recorded deliberately:** 003 carries the invalid syntax in the repo yet its policy IS live. Proof chain: anon INSERT on `shadow_signals_v1` returns `23502` (NOT NULL on `entry_shifted`), not an RLS error; and a decisive ordering probe on `trade_outcomes_v1` — a row that violated NOT NULL — returned `42501` RLS, proving RLS is evaluated BEFORE NOT NULL. So the 23502 means RLS PASSED, i.e. an anon INSERT policy exists on `shadow_signals_v1`. Therefore the text executed against the database on 2026-07-31 was NOT the text now in the repo file. **Repo migration files are not a reliable record of what was applied; the database is the only authority.**

**Item 71 — the harness is UNDERPOWERED FOR EMISSION, permanently, at every feasible step.** Per-attempt emission rate on this tape is ~1.15e-4, so expected emissions are 0.03 at step=50, 0.16 at step=10, and only ~1.6 even at step=1. Detecting a 2x emission-rate change at 80% power needs ~16 events per arm ≈ 139,000 attempts ≈ ~100 days of M1 tape. **Zero emissions is the EXPECTED result and is not evidence of anything.** Measured cost basis for step choice: step=50 = 271 attempts in ~150s ≈ 0.55 s/attempt, so step=1 ≈ 2.1 h/arm (4.2 h for a pair) while step=10 ≈ 12.5 min/arm; step=10 was chosen and the three arms were run in parallel in separate working copies. STANDING RULE: any future harness emission claim MUST state its attempt count and its detectable-effect floor, or it is void. The rejection-profile output remains valid and is now high-resolution.

**Item 72 — noise floor root-caused and cut from ~4pp to ~0.07pp.** Two causes, both at the harness boundary; no scoring logic touched. (1) The engine reads wall-clock time through the `new Date()` CONSTRUCTOR as well as `Date.now()` — session classification, the low-liquidity window, the hard dead-hour clock blocks and the daily market-close break all call `new Date().getUTCHours()` (signalEngine.ts:3372, 4013, 4038, 4307, 4557, 6727, 7219, 7486, 8988), so a replay run at 06:00 UTC classified the same bar into a different session than one run at 12:00 UTC. (2) The clock was installed AFTER the engine import, leaving module-level time captures on the real clock. Fixes, all in `expo/scripts/item57_realbar_replay_harness.ts`: patch the global Date constructor (zero-arg returns the replay instant; explicit `new Date(x)` forwarded untouched), install it BEFORE the dynamic import, and add `--tape-end` to pin the bar window (previously derived from the real clock, so runs minutes apart loaded 13,899 vs 13,836 bars). Measured same-code twin spread: 11 rejections (~4pp) → 8 (0.6pp) → **1 (0.07pp)**. Direct evidence the clock now drives the gates: "Daily market-close break" rejections appear in replay output for the first time. NOT bit-exact, so the floor is recorded as ~0.1pp rather than claimed as zero; the residual is most likely async ordering plus `Math.random()` in signal-id generation (signalEngine.ts:7835, 7986), neither of which touches scoring.

**Item 69 — migration 004 NOT applied.** Direct anon-key query of `emitted_signals_v1` on the live database returned HTTP 404 `PGRST205` ("Could not find the table 'public.emitted_signals_v1' in the schema cache" — the hint it returns pointing at `shadow_signals_v1` is itself live evidence that 001+003 ARE applied). Both 004 and 005 are pending. They are independent — 004 creates table `emitted_signals_v1`, 005 only adds RLS policies to the pre-existing `trade_outcomes_v1`; neither references the other. Apply both in the Supabase SQL editor (004→005 for numbering hygiene; no hard dependency).
