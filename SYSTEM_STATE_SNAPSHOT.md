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

## 3. ITEM 5 — SELL SUPPRESSION RE-TEST ON BAR-VERIFIED OUTCOMES (2026-08-01)

**MEASUREMENT ONLY. allowShortSignals is UNCHANGED (still false).**

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

**No change made.** This is a measurement. allowShortSignals stays false
until the user decides whether to flip it.

---

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
