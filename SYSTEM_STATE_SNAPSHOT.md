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

**Shadow logging (durable — Design B, VERIFIED LIVE 2026-07-31):** suppressed SELLs are written DIRECTLY to `shadow_signals_v1` via the anon Supabase client (`expo/services/shadowSignalService.ts` → `createClient(url, EXPO_PUBLIC_SUPABASE_ANON_KEY)` → `.insert()`). This is Design B: the write goes straight to Supabase via the public anon key, which is RLS-permitted for INSERT. The service key (`SUPABASE_SERVICE_ROLE_KEY`) is NEVER used by the live engine path and is NEVER shipped to the browser — confirmed by grep (the key value is absent from all source files; the key name appears only in `expo/backend/` server-only code and `expo/scripts/` Node-only scripts, neither of which is in the client bundle).

**Why Design B (not Design A):** the original Design A (server-side tRPC `shadow.push` route using the service key) depended on the backend being deployed. Both backend URLs are confirmed 503 ("no bundle deployed") on ALL routes as of 2026-07-31: `EXPO_PUBLIC_RORK_API_BASE_URL` (dev.rorktest.dev) and `EXPO_PUBLIC_RORK_FUNCTIONS_URL` (rork.app). There is no deploy mechanism available in this environment for the Hono/tRPC backend. Design B removes that dependency entirely — the client writes directly via the anon key, which is already public by design and guarded by RLS.

**RLS policy (migration `003_shadow_signals_anon_insert.sql`):** anon/authenticated have INSERT (`WITH CHECK true`) and SELECT. No UPDATE/DELETE for anon. A CHECK constraint enforces `direction = 'SELL'`. Abuse surface: a malicious client could insert junk rows — acceptable for a diagnostic-only table with zero operational impact on signal generation or trade execution. Junk cannot modify existing data (no UPDATE/DELETE), and the engine's `signal_id` format (`shadow-sell-<timestamp>-<random>`) is recognizable for future filtering.

The shadow record captures the full would-be geometry PLUS the +40pip entry-shift variant (77% fill rate in counterfactual) so every tested SELL alternative stays monitorable against real forward data.

**Verified by (all real, pasted evidence):**
- `expo/scripts/verifyGate1ShadowLivePath.ts` — fires the REAL `pushShadowSellRecord` (imported from shadowSignalService.ts), waits for the fire-and-forget insert, reads back via service-role client. Row `gate1-designB-1785483623094` landed with all fields matching. **This is the live engine path, not a proxy.**
- `expo/scripts/test_sell_suppression.ts` — 26 assertions, all PASS: suppressed SELL returns null + no state mutation; allowed SELL emits + mutates state; BUY unaffected by toggle; BUY emits immediately after suppressed SELL (no cooldown consumed).
- 72h sim: shorts-suppressed = 13 BUY / 0 SELL; shorts-allowed = 12 BUY / 17 SELL (BUY count 12→13 is the expected consequence — suppressed SELLs free active-signal slots for BUYs).
- Regression suite: `runChecks` green.
- Service key leak check: grep for key VALUE across all source files = 0 matches; grep for key NAME = only in `expo/backend/` and `expo/scripts/` (never imported by client code); `shadowSignalService.ts` uses only `EXPO_PUBLIC_SUPABASE_ANON_KEY`.

**Write-path failure visibility (durability, verified 2026-07-31):** the shadow write is fire-and-forget and never blocks generation, but a failure is NOT silent. On insert failure or throw, `pushShadowSellRecord` (a) logs a distinct, greppable warning tagged `[ShadowSell] SHADOW_WRITE_FAILED` / `SHADOW_WRITE_ERROR`, and (b) increments an in-memory counter (`shadowWriteFailures` in `shadowSignalService.ts`). Both `shadowWriteFailures` and `shadowWriteSuccesses` are surfaced in the diagnostics export — SECTION 6 prints the counts at the top of the shadow section, with an explicit ⚠ alert line and remediation instructions when `shadowWriteFailures > 0`. This makes a broken shadow path VISIBLE in a future export rather than invisible. The counters reset on app reload (they are process-lifetime, not persistent — by design, since they monitor the current process's write path).

---

## 3. Open Finding — Drift-Veto-on-BUY (NEXT optimization candidate, deliberately deferred)

**Finding (from prior session, `expo/scripts/analyzeDriftVetoOnBuy.ts`):** the Phase 2 counter-trend drift veto IS over-firing on BUYs. It dropped **4/50** counter-trend BUYs that had **positive EV (+0.2295R, 75% win rate)**. Three of the four were winners (+1.149R, +0.385R, +0.385R). The veto is costing the long book **$3.8 in net $** and **+0.0036R in EV per signal**. The veto threshold (2.0×ATR) may be too low for BUYs, or the counter-trend classification may be too broad.

**Why this matters now:** longs are the entire system (SELLs suppressed). A veto that drops winning longs directly costs the only book that's running.

**Status: NOT actioned. Deliberately deferred.** This was investigated read-only and logged. No engine change was made. The current samples predate the Step 2 data-venue fix, so acting on this now would be optimizing against a baseline measured on the wrong venue. The recommended sequence is: let the corrected engine run → gather real forward data → re-evaluate the drift veto against the new baseline before any fix.

---

## 4. Recommended Next Action

**LET THE SYSTEM RUN and gather real forward data from the corrected engine before any further optimization.** The current samples (six counterfactuals, Phase 1 audit, drift-veto analysis) all predate the Step 2 data-venue unification. Every conclusion in this build is sound on its own measured data, but the forward data from the corrected engine is the only data that reflects the system as it now genuinely stands. Acting on further optimization now — drift-veto fix, new geometry variants, new filters — would be optimizing against a baseline that no longer exists.

Specifically:
1. **Shadow logging is now live** (Design B, verified 2026-07-31) — no backend redeploy required for shadow writes. The backend tRPC routes (`shadow.push`, `goldPrice.getHistoricalData`) remain 503, but the shadow write path no longer depends on them. If the backend is ever redeployed, the old tRPC `shadow.push` route can serve as a secondary write path, but it is no longer required.
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
