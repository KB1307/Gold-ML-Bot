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

**Interpretation:** if `allowShortSignals` is currently `false` (the default) and `recent_shadow_sells = 0`, the shadow write path is broken — suppressed SELLs are NOT being logged durably. Check in order: (1) the Supabase project is reachable and `shadow_signals_v1` exists (migration `003_shadow_signals_anon_insert.sql` applied); (2) `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are set in the client env; (3) the RLS INSERT policy on `shadow_signals_v1` is still present (`SELECT polname FROM pg_policies WHERE tablename = 'shadow_signals_v1'`). If all three are fine, export diagnostics from the app and check SECTION 6 — the `shadowWriteFailures` counter will be > 0 if the live process has been seeing insert failures. A zero-rows + zero-failures result means suppression is genuinely inactive (no qualifying SELLs in the window), not a broken path.
