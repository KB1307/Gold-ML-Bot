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
