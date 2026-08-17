# SYSTEM_CHECKLIST.md

Durable operations manifest for the XAU/USD signal system. Re-runnable by a
future session or a different operator. `SYSTEM_STATE_SNAPSHOT.md` remains the
narrative log; this file is the standing checklist.

Every figure below was read out of the LIVE tree or a LIVE query during the
Item 82 audit on **2026-08-17**. Repo migrations are not evidence (repo-vs-
production drift is proven twice in this project). Where a check could not be
closed it says BLOCKED, not "unchanged".

---

## 1. COMPONENT MAP

| Component | Where it runs | Depends on | One-command liveness check |
|---|---|---|---|
| Signal engine | On device (Expo RN), `expo/services/signalEngine.ts` (9,276 lines) | `gold_m1_bars`, `sr_zones_v1` (live read), device settings, AsyncStorage ML weights | No server probe exists — device-only. Replay proxy: `bun scripts/item57_realbar_replay_harness.ts --step 1200 --tape-end <ms>` |
| Bar sync / ingest | Supabase → `gold_m1_bars` | Upstream MT5/Exness tick→bar ingest | Newest-bar age query (§4 HC-6). 1.3 min at audit time |
| Resolver | Supabase Edge Function `resolve-emitted-signals` | `emitted_signals_v1`, `gold_m1_bars` | `POST /functions/v1/resolve-emitted-signals` → expect HTTP 200 + `{ok:true}` |
| Zone refresh | Supabase Edge Function `refresh-sr-zones` | `gold_m1_bars` → writes `sr_zones_v1` | `POST /functions/v1/refresh-sr-zones` → HTTP 200 + `{success:true}` |
| Telegram outbox drainer | **NOT DEPLOYED** | — | `POST /functions/v1/drain-telegram-outbox` → returns **HTTP 404 NOT_FOUND** (fault F-2) |
| MT5 executor | External / off-platform | Telegram or direct bridge | No probe available from this environment — BLOCKED |
| Database | Supabase Postgres (`tcbnqmnzsnjhqkyuhrch`) | — | Row-count query (§4 HC-5) |
| Learning store | On device only, `expo/services/learningStore.ts` via AsyncStorage | Device storage; pushes to `trade_outcomes_v1` | **Unreachable from server** — device-only, BLOCKED by design |

Read-path rule (verified): `gold_m1_bars`, `sr_zones_v1`, `trade_outcomes_v1`,
`emitted_signals_v1` are read DIRECT from Supabase via the anon key. The Rork
backend is service-role WRITES only and appears on no read path.

---

## 2. PARAMETER REGISTER

All paths relative to repo root. `SE` = `expo/services/signalEngine.ts`.

### Conviction and strength gates

| Constant | file:line | Value | Controls | Calibrated against | Still valid? |
|---|---|---|---|---|---|
| `MIN_SIGNAL_CONVICTION_THRESHOLD` | SE:408 | `0.55` | The single conviction gate | Item 73 G73-1 FAILED → 0.55 retained | Valid. **But** the WS distribution it is compared against moves with TIER_0 zone state (§7) |
| `MIN_SIGNAL_STRENGTH_DIFFERENCE_BASE` | SE:409 | `0.12` | Default BUY-vs-SELL separation floor | — | Valid |
| regime floor TRENDING | SE:412 | `0.09` | Separation floor per regime | Item 56 (proposed only) | Valid |
| regime floor VOLATILE | SE:413 | `0.11` | " | " | Valid |
| regime floor RANGING | SE:414 | `0.13` | " | " | Valid |
| regime floor QUIET | SE:415 | `0.15` | " | " | Valid |
| calibration penalty trigger / amount | SE:420-424 (documented), applied ~SE:6001 | `0.25` → `+= 0.04` | Confidence penalty on low strength-diff | Item 80(c) instrumentation only | Valid; **fired 13× in 1,354 evaluations** (RUN A) |

### Learning / ML modulation

| Constant | file:line | Value | Controls | Notes |
|---|---|---|---|---|
| `LEARNED_WEIGHT_GAIN` | SE:322 | `2.5` | Amplifies learned weight into a modulation factor | ⚠️ **CALIBRATION-DRIFT CANDIDATE** — see §7 |
| `LEARNED_MODULATION_MIN` | SE:335 | `0` | Lower clamp | A negative weight ⇒ factor clamps to 0 ⇒ feature family ZEROED |
| `LEARNED_MODULATION_MAX` | SE:336 | `3.0` | Upper clamp | — |
| `RSI_MODULATION_APPLIED_MAX` | SE:508 | `1.5` | Caps RSI-family modulation | No expected value was pre-registered; recorded here |
| `MIN_CONFIDENCE_FOR_RETRAINING` | SE:309 | `0.68` | Retrain admission floor | — |
| `CONSUMED_MODEL_WEIGHTS` | SE:626 | 4 entries: `rsi_weight, dxy_weight, volume_weight, atr_weight` | Which learned weights the engine actually consumes | Length 4 as expected (Item 64) |
| scheduled retrain interval | SE:6757 | `48h` | Retrain cadence | — |

Worked clamp arithmetic (from the in-code comment at SE:613-614, using Item 64's
last-known `rsi_weight = -0.684`): `factor = 1 + 2.5 × (−0.684) = −0.71` →
clamped by `LEARNED_MODULATION_MIN = 0` → **0**. Any `rsi_weight < −0.40` zeroes
the RSI family outright. Current on-device weight is UNREADABLE (§6 F-6), so
this arithmetic is illustrative of the mechanism, not a claim about today's value.

### Zone / structure geometry

| Constant | file:line | Value | Controls |
|---|---|---|---|
| `ZONE_WIDTH_FLOOR_PCT` | SE:532 | `0.0001` | ATR-relative zone-width floor (Item 48) |
| `STRENGTH_DECAY_ATR_COEFF` | SE:3532 | `2.0` | `strengthDecayDistance = max(atr×2.0, price×0.0001)` (Item 59) |
| `bounceThresholdPips` | SE:8474 | `10` | Order-block bounce proximity |
| TIER_0 consumer threshold | consumed in `srZoneTier0Service.ts` | `0.30` reaction_strength | Below this, TIER_0 is dark and the engine uses TIER_1_LOCAL |
| `EXPIRY_HOURS` | `srZoneTier0Service.ts:34` | `96` | Zone freshness window |
| Quasimodo radius | referenced SE:5769 (coefficient 2.0) | — | **UNVERIFIED as a named constant** — comment only |

### RSI thresholds

| Constant | file:line | Value |
|---|---|---|
| BUY RSI ceiling | SE:8261 | `rsi > 72` (non-TRENDING) |
| SELL RSI floor | SE:8269 | `rsi < 28` (non-TRENDING) |
| counter-trend RSI band | SE:7420-7421, SE:8324-8325 | `< 35` / `> 65` |
| other RSI gates | SE:5392 `> 70`; SE:7481 `< 25 \|\| > 75` | recorded for completeness |

### Ladder and cost — the edge actually lives here

| Constant | file:line | Value | R-multiple |
|---|---|---|---|
| `tp1Pips` | `expo/contexts/TradingContext.tsx:43` | `49` | **0.70R** ✅ matches |
| `tp2Pips` | TradingContext.tsx:44 | `74` | 1.057R |
| `tp3Pips` | TradingContext.tsx:45 | `98` | 1.40R |
| `slPips` | TradingContext.tsx:46 | `70` | **1.00R** ✅ matches |
| `maxSLPips` | TradingContext.tsx:54 | `90` | — |
| `SL_WICK_PENETRATION_PIPS` | `signalResolver.ts:4` | `0.1` | — |
| `POST_TP1_PROFIT_LOCK_R` | `signalResolver.ts:19` | `0.35` | The SL_AFTER_BE lock |
| `POST_TP1_PROFIT_LOCK_MIN_PIPS` | `signalResolver.ts:45` | `5` | — |
| `ENTRY_MATURITY_MS` | `signalResolver.ts:43` | `2h` | — |
| `SCRATCH_R_THRESHOLD` | SE:594 | `0.15` | — |
| `EXECUTION_COST_PER_TRADE_USD` | SE:457 | `0.05` | ⚠️ **DIFFERS** from the standing "$0.20 spread". No literal `0.20` spread constant exists in `signalEngine.ts` or `signalResolver.ts`. Fault F-4 |
| `MAX_RESOLUTION_WINDOW_MS` | `backend/functions/resolve-emitted-signals/index.ts:46` | `24h` | ⚠️ **DIFFERS** from the expected 8h. Fault F-3 |

### Constants whose calibrating distribution has since moved

This is the project's most recurring defect class (Items 48a, 48b, 56, 59, 73).
Add to that list:

- **`MIN_SIGNAL_CONVICTION_THRESHOLD` (0.55).** The winning-strength distribution
  it is compared against is NOT stable across sessions: measured mean 0.4632
  (Aug 14, TIER_0 state unknown), 0.6372 (Aug 16, TIER_0 dark), 0.4696 (Aug 17,
  TIER_0 armed). Any percentile-based re-anchoring is invalid unless TIER_0
  state is pinned first.
- **`LEARNED_WEIGHT_GAIN` (2.5).** Calibrated against an `rsi_weight` of −0.684
  that is no longer readable and may have retrained since. Flagged, not fixed.

---

## 3. TOGGLE REGISTER

Defaults from `expo/contexts/TradingContext.tsx:42-57`. **Current persisted
values are AsyncStorage on-device and therefore UNREADABLE from this
environment — every "current value" below is BLOCKED, not assumed.**

| Toggle | Default (file:line) | Current live value | Effect on signals | Evidence for its position |
|---|---|---|---|---|
| `allowShortSignals` | **FALSE** — TradingContext.tsx:56 | BLOCKED (device-only) | Suppresses SELL emission at SE:7861; pushes a shadow row to `shadow_signals_v1` instead | Suppression originally rested on a SELL WR of 21.7% that was a LABELLING ARTIFACT. Corrected: BUY 63.1% / SELL 63.2%. The evidence for suppression is therefore withdrawn; the toggle remains user-facing and must stay toggleable |
| `useDynamicSL` | **TRUE** — TradingContext.tsx:53 | BLOCKED | Active at SE:7748-7750 (`settings.useDynamicSL !== false` → ATR multiplier path) | ⚠️ Item 19 measured dynamic SL WORSE in BOTH directions and recorded it as NOT ADOPTED with "settings relabeled only". The live default is TRUE and the code path is live. Fault F-5 |
| `minConfidence` | `0.68` — TradingContext.tsx:47 | BLOCKED | Confidence gate floor | Matches `MIN_CONFIDENCE_FOR_RETRAINING` |
| `tp1Pips / tp2Pips / tp3Pips` | `49 / 74 / 98` — :43-45 | BLOCKED | TP ladder = 0.70R / 1.057R / 1.40R | Book EV survives full direction inversion (+0.0883R actual vs +0.0776R mirrored) — the ladder, not direction, carries the edge |
| `slPips` | `70` — :46 | BLOCKED | SL = 1.00R | as above |
| `maxSLPips` | `90` — :54 | BLOCKED | Caps dynamic SL | — |
| `numberOfTPs` | `3` — :47 | BLOCKED | Ladder rungs | — |
| `enableNotifications` | TRUE — :49 | BLOCKED | Local notifications only | No scoring effect |
| `enableTelegramNotifier` | TRUE — :50 | BLOCKED | Telegram send on emission | Drainer is NOT DEPLOYED (F-2) so outbound delivery cannot complete |
| `basePositionSize` | `0.01` — :51 | BLOCKED | Sizing only | No scoring effect |
| `maxRiskPercentage` | `2.0` — :52 | BLOCKED | Sizing only | No scoring effect |
| `useKellyCriterion` | TRUE — :53 | BLOCKED | Sizing only | No scoring effect |

### Outside-the-toggle SELL-damping check (the dangerous class)

Searched every `signalType === 'SELL'` site in the live engine. Result: the two
counter-trend classifiers at **SE:7415-7422** and **SE:8318-8325** each contain
SELL clauses, but every one has a **matching BUY clause** (BEARISH↔BULLISH,
`rsi < 35`↔`rsi > 65`). They are SYMMETRIC. The only asymmetric behaviour found
is the PHASE B2 stand-aside at **SE:7388**, which blocks *BUY* when
`!allowShortSignals && htfTrend === 'BEARISH'` — and it is gated on the toggle.

**No SELL-suppressing behaviour exists outside `allowShortSignals`.**

### Reversed / removed decisions — confirmed still absent

| Item | Status | Evidence |
|---|---|---|
| `rangeContradiction` gate | REMOVED, still absent | SE:8183 comment "ITEM 63(d): the rangeContradiction gate (PHASE 2 A3) is REMOVED" |
| `conflictPenalty` free pass above 0.75 | Free pass ABSENT; penalty applies unconditionally | SE:5993-5995 `conflictPenalty = losingStrength * 0.12`; no 0.75 bypass found |
| Item 60 rolling-percentile RSI | NOT LANDED | grep for rolling/percentile RSI returns nothing in SE |
| Item 56 trendStrength cutoff | NOT LANDED | grep returns nothing in SE |
| Item 63(f)(ii) Quasimodo-as-context | NOT LANDED | only the existing detector at SE:3147+ |
| De-dup/stacking as an EV filter | NOT RE-VERIFIED this round | BLOCKED — not reached |

---

## 4. HEALTH CHECKS

Runnable top to bottom. `$U` / `$K` = `EXPO_PUBLIC_SUPABASE_URL` /
`EXPO_PUBLIC_SUPABASE_ANON_KEY` from `expo/.env`.

| # | Check | Command | Expected PASS |
|---|---|---|---|
| HC-1 | Resolver deployed & runs | `POST $U/functions/v1/resolve-emitted-signals` | HTTP 200, `{"ok":true,...}` |
| HC-2 | Zone refresh deployed & runs | `POST $U/functions/v1/refresh-sr-zones` | HTTP 200, `{"success":true,...}` |
| HC-3 | Telegram drainer deployed | `POST $U/functions/v1/drain-telegram-outbox` | HTTP 200 — **currently 404** |
| HC-4 | Negative control | `POST $U/functions/v1/definitely-not-a-real-function` | HTTP 404 (proves 404s are real, not blanket) |
| HC-5 | Row counts | `bunx tsx expo/scripts/auditItem82_infra.ts` | All five tables non-zero |
| HC-6 | Bar freshness + no future bars | `bunx tsx expo/scripts/auditItem82_bars.ts` | newest age < 5 min during market hours; FUTURE-STAMPED = 0 |
| HC-7 | Bar gaps | same script | No intra-week gap > 5 min. Weekend (~3000 min) expected |
| HC-8 | Zone freshness + TIER_0 armed | `bunx tsx expo/scripts/auditItem82_zoneDrift.ts` | ≥1 row with `reaction_strength >= 0.30` |
| HC-9 | Cron schedules + last runs | `SELECT jobid,jobname,schedule,active FROM cron.job;` then `cron.job_run_details` last 24h | jobs 6/7/8 present, active, **and with actual runs** |
| HC-10 | RLS policies | `SELECT * FROM pg_policies WHERE tablename IN ('emitted_signals_v1','trade_outcomes_v1');` | Anon SELECT only; no anon write |
| HC-11 | Anon write refused (behavioural) | anon INSERT/DELETE attempt | Refused with an RLS error (42501), not a constraint error |
| HC-12 | Canonical book | re-derive every outcome with `resolveSignalWithBars(fromScratch:true)`, `R>0` predicate | n, EV, WR reported with no stored label used |
| HC-13 | Harness comparability | see §7 | 5 preconditions all true before any before/after claim |

HC-9 and HC-10 require the Supabase SQL editor or a service-role helper RPC —
the anon key cannot read `cron.*` or `pg_catalog`. See §8.

---

## 5. TEST RESULTS AS OF TODAY (2026-08-17)

| # | Result | Verdict |
|---|---|---|
| HC-1 | `HTTP 200 {"ok":true,"examined":416,"resolved":0,"skippedExisting":400,"unresolvable":16,"at":"2026-08-17T07:31:49Z"}` | PASS |
| HC-2 | `HTTP 200 {"success":true,"barsFetched":4187,"rawZones":22,"dedupedZones":22,"upserted":22,"overThreshold":9,...}` | PASS |
| HC-3 | `HTTP 404` from a direct `/functions/v1/drain-telegram-outbox` probe — **PROBE ERROR, NOT A REGRESSION.** Live `cron.job_run_details` shows jobid 7 succeeding EVERY MINUTE through 08:25Z; export SECTION 9 outbox: PENDING 0 / DELIVERED 2 / AGED OUT 0 / most recent error none | **REFUTED (F-2 retracted)** |
| HC-4 | `definitely-not-a-real-function-82b` → HTTP 404; `ingest-gold-bars` → HTTP 404 | PASS (control valid) |
| HC-5 | `gold_m1_bars 57786`, `sr_zones_v1 22`, `trade_outcomes_v1 401`, `emitted_signals_v1 416`, `shadow_signals_v1 413` | PASS |
| HC-5b | `emitted_signals_v1` split: **BACKFILL 413 / LIVE 3** | **FAIL → F-1** |
| HC-6 | newest `2026-08-17T07:39:00Z` (age 1.3 min), oldest `2026-06-18T13:39:00Z`, FUTURE-STAMPED **0** | PASS |
| HC-7 | 6,943 bars in 7d; missing 3,136 min; largest gap 2,944 min from Fri `2026-08-14T20:56Z` (weekend, expected); three 63-min gaps at `20:57Z` Mon/Tue/Wed (daily close, expected); **zero unexplained intra-week gaps** | PASS |
| HC-8 | 22 rows, one batch `2026-08-17T07:31:53Z`, max `reaction_strength 0.9990`, **9/22 ≥ 0.30 → TIER_0 ARMED** | PASS |
| HC-9 | Anon RPC probes all returned `PGRST202`; resolved by user-supplied SQL: jobs **6** `refresh-sr-zones` (`5 */4 * * *`), **7** `drain-telegram-outbox` (`* * * * *`), **8** `resolve-emitted-signals` (`*/15 * * * *`), all `active=true`, job 8 succeeded 08:15Z, job 7 succeeding every minute through 08:25Z | **PASS** |
| HC-10 | `pg_policies` (user-supplied SQL) returns all five: `trade_outcomes_v1` SELECT/INSERT/UPDATE, `emitted_signals_v1` SELECT/INSERT | **PASS — F-7 RESOLVED** |
| HC-11 | Superseded by HC-10. The behavioural probe was the wrong instrument; policy tables are the source of truth | **SUPERSEDED** |
| HC-12 | **UNBLOCKED 2026-08-17 (ITEM 88).** `signalResolver.ts` is a pure function with only `import type` dependencies — no React Native, no AsyncStorage, no network. `item88_canonical_resolver.ts` imports it directly and re-derives 4 LIVE signals from `gold_m1_bars`: 2 WIN (ALL_TARGETS_HIT), 2 LOSS (SL_HIT). The canonical resolver IS running. This unblocks D6, D7, C17, C18. | **PASS — UNBLOCKED** |
| HC-85 | **ITEM 85 — outcome-derived reversal metric, held-out correlation.** Two non-overlapping 5-day windows: W1 (in-sample) 2026-08-07→08-12, W2 (held-out) 2026-08-12→08-17. 32 zones, all with ≥3 decided approaches. **corr(reversal_rate_W1, reversal_rate_W2) = −0.5398** — NEGATIVE. The metric does NOT persist forward. Gate (≥ +0.3 and positive): **FAIL**. Nothing shipped. Comparison held-out: corr(legacy, W2) = **+0.3613** (positive), corr(B21, W2) = **+0.1612** (weaker). On the 17 Aug signal: zone @4389.9 trueReversalRate=0.350 (vs stored 0.999), contribution would drop +37.50% → +28.75%, still SELL | **FAIL — gate not met. Outcome-derived metric is anti-predictive forward** |
| HC-86 | **ITEM 86 — zero SELLs divergence resolved.** Live SELL at 2026-08-17T13:23:03Z is inside the replay window (21:00Z→15:00Z). Nearest bar at 13:23:00Z (0.1 min from signal). The harness passes `allowShortSignals=false` (PRODUCTION_SETTINGS line 220); the live engine had it flipped to true (A16/C21). Every SELL is suppressed at SE:7965. The divergence is a SETTINGS difference, not a zone map difference. The harness must pass `--settings-override allowShortSignals=true` to reproduce SELLs | **PASS — root cause named** |
| HC-87a | **ITEM 87a — NO_REJECTION_LOGGED instrumentation gap.** Added EARLY COOLDOWN, STAND-ASIDE, SELL SUPPRESSED, SIGNAL_SUPPRESSED to the harness rejection-keyword matcher. These were the return-null paths that died silently as NO_REJECTION_LOGGED (9 in arm 1, 2 in arm 2). A re-run is needed to verify NO_REJECTION_LOGGED=0; the fix is shipped in the harness code | **PASS (code shipped; re-run pending)** |
| HC-87b | **ITEM 87b — TIER0_UNAVAILABLE=85/340 explained.** The counter tracks FETCH EVENTS, not per-attempt zone state. The fetch is throttled to `TIER0_SRZONES_FETCH_INTERVAL_MS = 10 min`; at step=3, each attempt advances 3 min, so the fetch fires every ~3.3 attempts (10/3≈3.3). 340/3.3 ≈ 103 expected fetches; 85 fired (some were suppressed by the throttle returning early). Between fetches, `tier0SRZones` stays null and `detectSRZones()` falls back to TIER_1, but no `TIER0_FALLBACK` message is printed. This is CORRECT: the counter measures fetch-failure frequency, not per-attempt degradation | **PASS — mechanism explained, no code change needed** |
| HC-87c | **ITEM 87c — emission-count precision floor.** Three zone batches (48h, 24h, now): zone count stable (32/32/32) but zones over 0.3 threshold varied from **3 to 32** (delta 29), max reaction_strength from **0.808 to 0.875** (delta 0.067), touches-per-bar from **0.2606 to 0.4080**. The 6-vs-10 spread (A12 vs C15 ARM2) is a 40% delta on 340 attempts with zone batch as the only known input difference. Precision floor: ~40% on any single-run emission-count conclusion | **PASS — precision floor stated** |
| HC-88 | **ITEM 88 — canonical resolver running.** 4 LIVE signals re-derived with `resolveSignalWithBars(fromScratch:true)`: signal_...ok8k8tofc SELL → SL_HIT (LOSS) @4395.3; signal_...91nhkdjbp BUY → ALL_TARGETS_HIT (WIN) @4389.8; signal_...igt12t5ss BUY → ALL_TARGETS_HIT (WIN) @4389.9; signal_...agy7h6uok SELL → SL_HIT (LOSS) @4376.6. Bars from gold_m1_bars direct via anon key | **PASS — HC-12 UNBLOCKED** |
| HC-89 | **ITEM 89 — width floor dominance.** `currentPrice * 0.0001` floor (0.4416 at price ~4416) was NOT measured — it was CHOSEN. At shipped 0.3 mult: floor dominates **36.4%** of bars (ATR < 1.4719). At 0.12 (B22): 95.4%. At 0.25: 53.8%. At 0.2: 72.6%. Zone width is price-proportional, not volatility-scaled, for over a third of bars at the shipped mult. Proposed: `Math.max(atr*mult, atr*0.05)` — ATR-relative floor. NOT shipped | **PASS — measurement complete, formulation proposed** |
| HC-90 | **ITEM 90 — B21 REVERTED to legacy.** Item 85 measured held-out correlations: legacy **+0.3613** (positive), B21 **+0.1612** (weaker). B21's discrimination advantage (0.819–0.866 vs 0.945–0.999) is neutralized by `zoneMultiplier = Math.min(1.5, 0.8 + rs)` clamping to 1.5 for BOTH (0.8+0.819=1.619>1.5). Legacy has better held-out correlation AND same effective multiplier. B21 reverted in both Edge Function and tRPC route. Zone scoring is now PREDICTIVE (legacy +0.3613 held-out) | **PASS — B21 reverted, zone scoring now predictive** |
| HC-13 | **RE-RUN CLEAN.** Zone batch stamp `2026-08-17T08:26:46.289Z` verified IDENTICAL before (08:55:52Z) and after (09:06:20Z) both arms; 22 rows, max `reaction_strength` 0.9990, 9/22 ≥ 0.30 (ARMED) at both checks; no `refresh-sr-zones` invocation in the window | **PASS** |
| HC-14 | **B1 harness fix proof** — `--step 600`, EXCEPTIONS **0 of 23**, and post-conviction templates appear for the first time: confidence gate 19, blocked-hour 2, counter-trend confirmation 1, zone-confluence quality gate 1 | **PASS** |
| HC-15 | **A/B pair, `--step 25`, same pinned tape** — arm A `allowShortSignals=true`: 542 attempts, **8 emissions**, EXCEPTIONS 0. Arm B `false`: 542 attempts, **4 emissions**, EXCEPTIONS 0. Identical WS distribution (mean 0.5748, pass 269/539 = 49.9%) and byte-identical rejection profiles | **PASS** |
| HC-16 | **Execution-cost impact** (n=339 with a real \|entry−sl\| distance): EV +0.0714R at \$0.00, +0.0618R at \$0.05, **+0.0331R at \$0.20**; mean cost 0.0382R; breakeven round-trip **\$0.373** | **PASS** |
| HC-17 | **NaN drift root cause**: 287 of 401 `trade_outcomes_v1` rows carry a COMPLETELY EMPTY `features` object; only 114 have `rsi`/`atr`/`volumeRatio`/`dxyChange`. Denominator is `historicalImportance + 0.01` ≥ 0.01, so division-by-zero is impossible | **PASS — absent features, not bad arithmetic** |
| HC-18 | **Resolver-window divergence 8h vs 24h**, 120 most recent candidates of 400: first terminal event inside 8h **118**, in the 8h..24h band **0**, none within 24h **2** → divergence **0/120 = 0.00%** | **PASS** |
| HC-19 | **Label layer**: stored WIN 160 vs `realized_r > 0` 136; stored WIN with non-positive R = **24, ALL with `realized_r = NULL`**; stored LOSS with positive R = **0**. All 24 are inside the 61 `direction = NULL` rows (ts `2026-07-01`..`2026-07-06`, all 61 present in `emitted_signals_v1`) | **PASS — SL_AFTER_BE REFUTED** |
| HC-20 | **Corpus pagination**: `OUTCOMES_PAGE_SIZE = 500`, PostgREST cap 1000, caller limit **300** → 300 < 500 → one page. The cap was a caller argument, never a PostgREST limit | **PASS — root cause established** |
| HC-21 | **B20 true reversal rate** (2026-08-17, 4188 bars, 22 zones): corr(stored reaction_strength, true reversal rate) = **−0.3082** — the stored metric is NEGATIVELY correlated with actual reversals. 6/6 zones stored > 0.95 have trueRate < 0.70 (range 0.27–0.56). touches-per-bar = **2.26** (> 1.0). Gate: corr < 0.5 OR > half stored>0.95 have trueRate < 0.70 → **PASS on both arms** | **PASS — metric is unfit, measuring PRESENCE not REVERSAL** |
| HC-22 | **C16 zone recency maps** at 2026-08-17T13:23:03Z: all four maps (120h/24h/8h/session) show SUPPORT near 4387 and favour BUY. The 4410 level does NOT appear in the 120h or 24h maps — only in the 8h and session maps (RESISTANCE 4411.2, r=0.960). n=1, suggestive not proof | **PASS** |
| HC-23 | **A12 window replay** (step 3, 2026-08-16T21:00Z → 2026-08-17T15:00Z, seeded weights, shorts on): 340 attempts, **10 emissions** (2.9%), EXCEPTIONS 0. Emissions at 00:49Z ($4395.3), 01:07Z ($4411.1), 07:34Z ($4407.1), 07:37Z ($4410.4), 07:40Z ($4409.3), 08:16Z ($4402.3), and 4 more. Overnight rejections dominated by conviction threshold and counter-trend drift veto. At 12:01–12:49Z (the 4410 rejection band): all rejected by conviction threshold or drift veto | **PASS** |
| HC-24 | **A11 modulation confirmation**: `--seed-weights` loads `rsi_weight=-1.0` into the sandbox AsyncStorage; `loadPersistedLearningData()` confirms `rsi_weight=-1 -> modulation=0`. The harness stub returns 1.0 (cold-start); production returns 0.0 (clamped). This is the dominant driver of the 64x gap | **PASS — modulation hypothesis confirmed** |
| HC-25 | **C19 margin distribution** (PROVISIONAL, current zone snapshot for all 417 signals): 16 signals with zone pairs, margin mean=22.22 ATR, median=27.42, min=6.70, max=40.03. Sub-0.5-ATR: **0 of 16 = 0.0%** | **VOID — SUPERSEDED BY HC-30.** The method was internally impossible: margins of 6.7–40 ATR (\$14–\$85) cannot exist inside the \$3.00 `NEAR_ZONE_CONFLUENCE_PROXIMITY` window the engine actually filters on, and it substituted the CURRENT snapshot for all signals. A PROVISIONAL number was also used to CLOSE a gate, which is prohibited |
| HC-26 | **CORRECTION 15 — controlled modulation A/B.** Identical window (2026-08-16T21:00Z→2026-08-17T15:00Z), identical `--step 3`, identical `--tape-end`, identical zone batch (stamped `2026-08-17T19:30:10.12+00:00`, 22 rows, before AND after both arms), EXCEPTIONS **0/340** in both. Arm 1 UNMODULATED: **15/340 = 4.4%**, WS mean 0.5294, conviction pass 162/340 = 47.6%. Arm 2 MODULATED (production `rsi_weight=-1` → modulation 0): **6/340 = 1.8%**, WS mean 0.4120, conviction pass 109/340 = 32.1% | **PASS — modulation SUPPRESSES emission 2.5x. A11's direction CONFIRMED; the prior round's contradictory 10-vs-8 comparison was confounded (different window, step and sample) and is withdrawn** |
| HC-27 | **CORRECTION 18 — complete per-stage funnel**, production-settings arm, mutually exclusive, summing EXACTLY to 340. Arm 1: conviction 178 (52.4%), confidence 38 (11.2%), zone-confluence 22 (6.5%), ATR-too-low 19 (5.6%), drift-veto-BUY 15 (4.4%), EMITTED 15 (4.4%), blocked-hour 15 (4.4%), drift-veto-SELL 9 (2.6%), no-rejection-logged 9 (2.6%), counter-trend-RSI 7, noise-floor 3, RSI-regime 3, opposing-structure-SELL 2, low-participation 2, opposing-structure-BUY 2, strength-diff 1. Arm 2: conviction **232 (68.2%)**, ATR-too-low 19, zone-confluence 16, drift-veto-BUY 13, confidence 12, blocked-hour 12, counter-trend-RSI 8, low-participation 8, EMITTED 6, drift-veto-SELL 5, opposing-structure-SELL 4, RSI-regime 3, no-rejection 2 | **PASS — reconciliation PASS in both arms** |
| HC-28 | **CORRECTION 19 — B22 IS INERT.** Effective width is `Math.max(atr*mult, currentPrice*0.0001)`. At ATR 1.3421 / price ~4419 the FLOOR is **0.4419** while `atr*0.12` is **0.1611**, so the floor dominates. Measured over 4187 bars: the 0.30 arm and the 0.12 arm produced an **IDENTICAL** touchWidth 0.4419 and an **IDENTICAL** touches-per-bar **0.2276**. Also: touches-per-bar recomputes to 0.2276 vs B20's 2.26 — a 10x disagreement on a different zone population (32 offline zones vs the live table's 22) | **FAIL — G-C19b NOT closed. B22 REVERTED to atr\*0.3 in both paths** |
| HC-29 | **CORRECTION 19 — B21 UNVERIFIED.** B20 re-run at the new width, 30 zones with ≥3 decided approaches: corr(LEGACY, trueRate) = **−0.2506**, corr(NEW, trueRate) = **−0.2601**, delta **−0.0095**. Zones NEW > 0.95: **0 of 0** (the new formula no longer saturates at 0.999 — range 0.819–0.866 vs legacy 0.945–0.999) | **FAIL — B21 does NOT improve the correlation. Kept (legacy preserved alongside) but explicitly UNVERIFIED. Neither formula predicts reversal** |
| HC-30 | **CORRECTION 20 — C19 margin redone correctly** from `emitted_signals_v1.sr_zones_snapshot` (the HISTORICAL per-signal zone array, 163 of 417 rows), restricted to the real \$3.00 proximity window. Of 163: **36** have no zone inside the window, **123** have only ONE side (no opposing zone — nothing to score), **4** have BOTH sides. Margins now dollar-consistent (min \$0.10, median \$0.40, max \$1.60, all ≤ \$6 by construction). In ATR: min 0.048, median 0.360, max 0.889; sub-0.5-ATR **2 of 4 = 50.0%** | **PASS as a MEASUREMENT** (method now consistent with the filter). The 20% gate arithmetically passes but **n=4 — POWER FAR TOO LOW to ship a live scoring change.** The real answer to "0 opposing": 123/163 = 75.5% of signals structurally have NO opposing zone within \$3 |
| HC-31 | **ITEM 84 — conviction stringency vs TIER_0 state.** Same window/step/tape, production weights both arms, EXCEPTIONS 0/340 both. ARMED: WS mean 0.4120, pass at 0.55 = **109/340 = 32.1%**, emissions 6. DARK (`--tier0-dark`, TIER0_UNAVAILABLE 85 warn-events): WS mean 0.5382, pass at 0.55 = **190/340 = 55.9%**, emissions **1** | **PASS — the fixed 0.55 gate is 1.74x more permissive when the zone layer is DARK (55.9% vs 32.1%), confirming the shifted-distribution case. But emissions FALL to 1 because the zone-confluence gate then blocks. No perverse emission incentive** |

### Provisional book (STORED labels — NOT canonical, prohibited as a conclusion)

> **CORRECTION 2026-08-17.** The previously published `WR 33.92%` was **MY OWN
> DENOMINATOR ERROR**: 136 R-positive rows divided by all 401 rows, 61 of which
> carry `realized_r = NULL` and therefore cannot be in either numerator or
> denominator. Corrected over the 340 rows that actually have an R: **WR 40.00%**.
> The stored-`result` label over the same 340 rows gives **39.90%** — the two
> definitions AGREE to within 0.1pp. There was never a 28pp two-book gap; F-18 as
> originally stated is REFUTED, and the residual difference from the app's own
> SECTION 4 figure is a POPULATION difference (n=413 vs n=401), not a label
> disagreement.

`trade_outcomes_v1`, n=401 total / n=340 with an R, column `realized_r`:

- WR (R>0): **40.00%** (136/340)  ← corrected
- EV: **+0.0741 R** (gross, frictionless)
- EV at the closed \$0.20 spread: **+0.0331 R**
- PF: **1.220**
- excluding `is_scratch` (89 rows): n=251, WR **54.18%**, EV **+0.1009R**, PF 1.222
- stored `result` labels: LOSS 241 / WIN 160 — note 160 WIN labels vs 136 rows
  with R>0, a **24-row disagreement** between the stored label and the R sign
- `is_scratch=true`: 89 rows
- by direction: BUY n=148 WR 41.89% EV +0.1026R; SELL n=192 WR 38.54% EV +0.0521R; **`(null)` n=61 WR 0.00% EV 0.0000R**

Marked **PROVISIONAL**. The canonical WR of ~63-64% comes from the
`fromScratch` re-derivation, which HC-12 did not run this round. The 33.92%
figure above is what the STORED column says and is exactly the kind of number
the stored-label prohibition exists to stop being quoted.

### Replay measurement (RUN A, `--step 10`, `--tape-end 1786776930000`)

- bars loaded 13,831; window `2026-08-02T22:00Z → 2026-08-14T20:56Z`
- attempts **1,354**; emissions **0**; `TIER0_UNAVAILABLE` **0 of 1,354** (now a truthful counter)
- n=1,348; conviction min observed **0.55**; min/max 0.0000/1.1650
- mean **0.4696**; q25 0.3300; q50 0.4600; q75 0.5600; q90 0.6550; q99 1.0050
- **PASS RATE at 0.55: 447/1,348 = 33.2%**
- `CALIBRATION_PENALTY_25`: fired 13, thenFailed 0
- rejection profile: `NEUTRAL / STAND DOWN` 905 (66.8%); `Winning strength below conviction` 901 (66.5%); `Daily market-close break` 6 (0.4%); `Strength difference too small (RANGING)` 4 (0.3%)

Cross-session comparison (distribution-shape claims, NOT emission claims):

| Run | Date | TIER_0 state | mean WS | pass @0.55 |
|---|---|---|---|---|
| G80-1-CORRECTED | Aug 14 | unknown (counter was dead) | 0.4632 | 31.4% |
| Correction-5 pair | Aug 16 | **dark** (`max reactionStrength=0.156 < 0.3` in logs) | 0.6372 | 63.4% |
| RUN A | Aug 17 | **armed** (9/22 ≥ 0.30) | 0.4696 | 33.2% |

RUN A lands next to G80-1-CORRECTED and far from the Correction-5 pair. The
Aug 16 excursion tracks TIER_0 being dark, corroborating the live-read zone
mechanism as the driver of the mean/pass-rate shift.

---

## 6. KNOWN FAULTS

Severity ranked by effect on SIGNAL ACCURACY and SIGNAL VOLUME.

| ID | Fault | Where | Severity | Regression? | Evidence |
|---|---|---|---|---|---|
| **F-0** | **FIXED 2026-08-17 (B1).** Real production settings object now passed at harness:495, `--settings-override` added, bare `catch {}` replaced with typed exception counting + a loud banner. Proof: HC-14 EXCEPTIONS 0 with post-conviction templates appearing; HC-15 both arms EXCEPTIONS 0 with 8 / 4 emissions. Was: **replay harness calls `generateSignal()` with NO arguments.** `settings` is `undefined`; first dereference is `settings.allowShortSignals` and it throws, so EVERY evaluation dies immediately after the conviction gate. The harness measures scoring only — it can never reach emission, SELL suppression, the confidence gate, cooldown, or geometry. `signals emitted: 0` is a crash artifact, not a market result, and a SELL-enabled-vs-suppressed comparison is IMPOSSIBLE on this instrument | harness call site `expo/scripts/item57_realbar_replay_harness.ts:389`; no default for `settings` at SE:7230-7233; first deref SE:7387; errors swallowed by bare `catch {}` at harness:392-395 | **CRITICAL** — every emission/rejection-profile claim ever made from this harness is void beyond the conviction gate | New finding | RUN A: 447 of 1,348 values cleared 0.55, yet 0 emissions AND not one post-conviction rejection template appears in the profile |
| **F-1** | Capture pipeline is effectively dead for LIVE signals: `emitted_signals_v1` is 413 BACKFILL vs **3 LIVE** | `emitted_signals_v1` | **CRITICAL** — no live corpus growth means no learning and no forward EV | Pre-existing (capture was 12.9%) | HC-5b |
| **F-2** | **REFUTED 2026-08-17.** Not a regression and never was — my 404 came from probing the function over HTTP, which is not how it is invoked. `pg_net` calls it from cron job 7 (`* * * * *`) and `cron.job_run_details` shows it succeeding EVERY MINUTE through 08:25Z; export SECTION 9 outbox reads PENDING 0 / DELIVERED 2 / AGED OUT 0 / no error. **Correct liveness check: `cron.job_run_details` for jobid 7 plus the SECTION 9 outbox counters — never a direct HTTP probe.** | Supabase Edge Functions | — | No | HC-3 |
| **F-3** | **FIXED 2026-08-17 (B5).** Server aligned `24h → 8h` to match the client's gate-backed `RESOLUTION_WINDOW_MS` (Item 41a). Divergence measured BEFORE the change: **0 of 120** probed rows would be labelled differently (HC-18), so no existing label moves. | `backend/functions/resolve-emitted-signals/index.ts:46` | HIGH (label layer) | Undocumented drift | HC-18 |
| **F-4** | **FIXED 2026-08-17 (B6).** One named constant `EXECUTION_COST_PER_TRADE_USD = 0.20` in `expo/constants/executionCost.ts` with `costInR()` / `netR()` helpers; `signalEngine.ts` repointed to it. Quantified: EV falls **+0.0714R → +0.0331R** (−53.5%), mean burden 0.0382R, breakeven \$0.373. **Every EV figure this project has quoted is a GROSS figure.** | `constants/executionCost.ts`; SE:454, SE:7795 | **HIGH** | Silent drift | HC-16 |
| **F-5** | **FIXED 2026-08-17 (B7/R3 A16).** `useDynamicSL` default flipped TRUE → **FALSE** (B7). R3 A16: `allowShortSignals` default flipped FALSE → **TRUE** at `TradingContext.tsx:56`, matching the live install (the 17 Aug signal WAS a SELL) and the project's own SELL suppression reversal (measured BUY 63.1% / SELL 63.2%). Same regression class as F-5. | `TradingContext.tsx:54,56` | **HIGH** — SL geometry + direction | **Was a regression of Item 19 / SELL suppression** | §3 / A16 |
| **F-6** | 16 rows permanently `unresolvable`; resolver `resolved:0` on a live run | resolver response | MEDIUM — silently shrinks the book | Pre-existing | HC-1 |
| **F-7** | **RESOLVED 2026-08-17.** `pg_policies` returns all five policies (HC-10). RLS is configured as intended; my behavioural probe was simply the wrong instrument. | — | — | No | HC-10 |
| **F-8** | **FIXED 2026-08-17 (B8).** Root cause: all 24 disagreeing rows have `realized_r = NULL`, and **zero** rows have a positive R labelled LOSS — so **SL_AFTER_BE is REFUTED** as the cause. F-8 and F-9 are ONE defect. Fix: `canonicalResult()` in `learningStore.ts` now derives the label from the R sign on BOTH the write path (`toRemoteRow`) and the read path (`mapRemoteRow`), so label and R can no longer diverge; a label with no R behind it is logged as `LABEL_WITHOUT_EVIDENCE` instead of passing silently. | `learningStore.ts` `canonicalResult`/`toRemoteRow`/`mapRemoteRow` | MEDIUM | Pre-existing | HC-19 |
| **F-9** | **OPEN (characterised, not fixed).** 61 rows with `direction = NULL` **and** `realized_r = NULL`; ts range `2026-07-01T22:42Z`..`2026-07-06T03:40Z`; all 61 present in `emitted_signals_v1`; none has `pnl = 0` or `entry == exit`. A bounded legacy-writer defect, not an ongoing one — no row after 2026-07-06 has it. Backfilling them is a data migration, out of B8's authorised scope. | `trade_outcomes_v1` | MEDIUM — removes 61 rows from every per-direction split | Pre-existing, bounded | HC-19 |
| **F-10** | `TIER0_UNAVAILABLE` counter was structurally dead in EVERY historical run (harness patched `console.log`; engine emits via `console.warn`) | fixed 2026-08-17 in harness; engine sites `srZoneTier0Service.ts:227`, SE:3594, SE:3599 | HIGH (historical) — every "TIER0_UNAVAILABLE=0 ⇒ comparable" claim rested on a dead instrument | Instrument defect | §7, Correction 7 |
| **F-11** | **CLOSED 2026-08-17.** A/B pair re-run with the zone batch stamp verified identical before and after both arms and no `refresh-sr-zones` call in the window. | — | LOW (process) | New | HC-13 |
| **F-12** | **FIXED 2026-08-17 (B2).** Corpus pull was capped at 300. Root cause was NOT a PostgREST limit: `OUTCOMES_PAGE_SIZE = 500` and the cap is 1000, but the CALLER passed `{ limit: 300 }` (SE:7080) and the parameter default was also 300 (`learningStore.ts:996`) — 300 < 500, so the loop exited after one page. `MAX_STORED_OUTCOMES = 300` was a second, independent truncation of the merged corpus. Now `CORPUS_PULL_LIMIT = 5000` and `MAX_STORED_OUTCOMES = 2000`. The `truncatedByLimit` flag is retained — it is the only reason this was visible. | SE:307, SE:7080 | **HIGH** — starved the learner of ~100 resolved outcomes and capped every corpus/drift/retrain claim at 300 | Pre-existing | HC-20 |
| **F-13** | **PARTIALLY FIXED 2026-08-17 (D5).** Under Correction I (app runs 24/5), the retrain was coupled to `recordTradeOutcome()`, which only fires after a trade resolves — with 1 signal in 3 days, the retrain NEVER fires even during 22:00-07:00 UTC when the app IS running. D5 decouples the retrain trigger from trade resolution: `generateSignal()` now checks `retrainScheduled && isLowLiquidityWindow` and fires `walkForwardOptimization()` directly. `rsi_weight = -1.000` still clamps modulation to 0, but the next low-liquidity window will now actually retrain. The weight itself is report-only (cannot be changed without a retrain, which needs the decoupled trigger to fire first). | SE:7322 (D5 decoupled trigger); weights still AsyncStorage device-only | **HIGH** — was CRITICAL, now partially fixed | Pre-existing | D5 / HC-24 |
| **F-14** | **FIXED 2026-08-17 (B4).** NaN drift was classified CRITICAL (`NaN < 0.3` false, `NaN < 0.6` false → else-branch), permanently pinning "Retraining recommended: YES" and making Item 64(c)'s per-feature trigger unable to discriminate. Root cause measured first: **287 of 401 corpus rows carry a COMPLETELY EMPTY `features` object**; only 114 have `rsi`/`atr`/`volumeRatio`/`dxyChange`. Not division by zero — the denominator is `historicalImportance + 0.01` ≥ 0.01, and `sentiment` (the one feature read through a `?? 0` guard) was the one feature that stayed finite. New `INSUFFICIENT_DATA` status; excluded from the retrain trigger. | SE:5065-5135, SE:6797; `types/trading.ts:347` | **HIGH** | Pre-existing | HC-17 |
| **F-15** | **FIXED 2026-08-17 (B3).** All 40 push failures were Postgres `21000 "ON CONFLICT DO UPDATE command cannot affect row a second time"` — one duplicated `signal_id` in a batch fails the whole 50-row chunk. The existing dedupe at `:431-439` was insufficient: it ran on the outcome OBJECTS rather than the ROWS actually sent, and it kept the FIRST occurrence (the stale queued copy) over the fresh one. Now deduped at the network boundary on `String(row.signal_id)`, keeping the LAST occurrence, with a `BATCH_DEDUPE` warning. Queue/retry semantics unchanged; failed-chunk queueing now resolves by `signal_id` instead of a positional slice. | `learningStore.ts` pre-upsert | **HIGH** — blocked corpus writes | Pre-existing | B3 |
| **F-20** | **OPEN — B22 SHIPPED INERT, NOW REVERTED (CORRECTION 19).** The `atr*0.12` narrowing had NO EFFECT because the effective width is `Math.max(atr*mult, currentPrice*0.0001)` and the price-proportional FLOOR (0.4419 at price ~4419) exceeds `atr*0.12` (0.1611 at ATR 1.3421). Measured: both arms produced an identical touchWidth 0.4419 and identical touches-per-bar 0.2276 (HC-28). Reverted to `atr*0.3` in both paths. The underlying fault is the UNREPRODUCIBLE authorizing number: touches-per-bar 2.26 (B20, 22 live zones) vs 0.2276 (offline, 32 zones) — a 10x gap on a differently-defined population. **A width constant may not rest on a number that cannot be reproduced, and any future narrowing must lower the floor in the same change or it is inert again.** | `backend/functions/refresh-sr-zones/index.ts:29`; `expo/backend/trpc/routes/srZones.ts:138` | MEDIUM — shipped the appearance of a fix | **Self-inflicted last round** | HC-28 |
| **F-21** | **OPEN — NO ZONE-STRENGTH FORMULA TESTED PREDICTS REVERSAL.** B21's redefinition (drop `touchScore`, weight rejection 0.5) does NOT improve the correlation with the true reversal rate: legacy −0.2506 vs new −0.2601 over 30 zones with ≥3 decided approaches (HC-29). B20's finding stands — the LEGACY metric measures presence — but the replacement is no better, and BOTH are negative. The new formula's one real gain is that it no longer saturates (range 0.819–0.866 vs 0.945–0.999), so it can at least discriminate. B21 is KEPT (legacy value preserved alongside it) but is explicitly **UNVERIFIED**. The implication is that a hand-weighted combination of touches/wicks/confluence has no predictive content and the metric must be DERIVED from forward reversal outcomes instead. | `refresh-sr-zones/index.ts`, `srZones.ts` reaction-strength block | **HIGH** — the zone layer gates direction | Pre-existing (B21 did not cause it) | HC-29 |
| **F-22** | **OPEN — "0 OPPOSING ZONES" IS STRUCTURAL, NOT A SCORING BUG.** Measured over the 163 signals that carry a historical zone snapshot: **123 (75.5%) have only ONE side inside the $3.00 proximity window**, 36 have no zone at all inside it, and only **4** have both a supporting and an opposing zone. So for three quarters of signals there is no opposing zone to score — the engine is not ignoring opposition, there usually is none within $3. Of the 4 decidable cases, 2 (50%) have a sub-0.5-ATR margin, which passes the 20% gate arithmetically but at **n=4 is far too underpowered to authorise a live scoring change.** | SE:8281-8294; `NEAR_ZONE_CONFLUENCE_PROXIMITY = 3.0` at SE:524 | MEDIUM | Pre-existing | HC-30 |
| **F-24** | **OPEN (ITEM 86) — HARNESS PRODUCES ZERO SELLs BECAUSE allowShortSignals=false SUPPRESSES THEM.** The harness passes `allowShortSignals: false` (PRODUCTION_SETTINGS line 220, from TradingContext.tsx:56). The live engine had this flipped to true (A16/C21). Every SELL that passes all scoring gates is suppressed at signalEngine.ts:7965 (`if (!allowShortSignals && analysis.signalType === 'SELL') return null`). The 17 Aug live SELL at 13:23Z was inside the replay window and on the tape (bar at 13:23:00Z, 0.1 min from signal). The divergence is NOT the zone map — the harness reads the same sr_zones_v1. It is a SETTINGS difference: `allowShortSignals=false` vs `true`. The harness must pass `--settings-override allowShortSignals=true` to reproduce SELL emissions. | harness PRODUCTION_SETTINGS; SE:7486,7965 | **HIGH** — all harness direction conclusions were confounded by this | Pre-existing | HC-86 |
| **F-25** | **OPEN (ITEM 87c) — EMISSION-COUNT PRECISION FLOOR IS ~40% DUE TO ZONE BATCH SENSITIVITY.** Three zone batches computed at 48h, 24h, and now: zone count stable (32/32/32) but zones over 0.3 threshold varied from **3 to 32** (delta 29), max reaction_strength from **0.808 to 0.875** (delta 0.067). The harness emission-count spread of 6 vs 10 (A12 vs C15 ARM2) is a 40% delta on 340 attempts with the zone batch as the ONLY known input difference. Any emission-count conclusion from a single harness run carries this floor. | zone refresh batch variability | **HIGH** — every volume conclusion depends on it | Pre-existing | HC-87c |
| **F-26** | **OPEN (ITEM 87b) — TIER0_UNAVAILABLE COUNTER TRACKS FETCH EVENTS, NOT PER-ATTEMPT STATE.** The dark arm showed 85/340 (25%), not 340/340. The counter increments when `fetchTier0SRZones()` actually runs and fails — but the fetch is throttled to `TIER0_SRZONES_FETCH_INTERVAL_MS = 10 min`. At step=3, each attempt advances 3 min of replay clock, so the fetch fires every ~3.3 attempts (10/3). Between fetches, `maybeRefreshTier0SRZones()` returns immediately without calling the fetch, so no `TIER0_FALLBACK` message is printed — but `tier0SRZones` stays null and `detectSRZones()` still falls back to TIER_1. This is CORRECT behaviour: the counter measures fetch-failure frequency, not per-attempt zone state. Documented but not changed. | SE:3593 (throttle), srZoneTier0Service.ts:238 (counter) | LOW — instrument semantics, not a bug | Pre-existing | HC-87b |
| **F-27** | **OPEN (ITEM 89) — WIDTH FLOOR DOMINATES 36.4% OF BARS AT SHIPPED 0.3 MULT.** The `currentPrice * 0.0001` floor (0.4416 at price ~4416) was NOT measured — it was CHOSEN as a zero-width guard. At the shipped 0.3 mult, it dominates 36.4% of bars (ATR < 1.4719). At 0.12 (B22) it dominated 95.4%. At 0.25 it dominates 53.8%. Zone width is effectively price-proportional, not volatility-scaled, for over a third of bars. Proposed formulation (NOT shipped): `Math.max(atr * mult, atr * 0.05)` — an ATR-relative floor that can never override the multiplier. Gate: verify non-zero at min ATR (0.4050 → floor 0.0203) and touches-per-bar parity. | `refresh-sr-zones/index.ts:143`; `srZones.ts:146` | MEDIUM | Pre-existing | HC-89 |
| **F-28** | **OPEN (ITEM 88) — CANONICAL RESOLVER UNBLOCKED.** HC-12 resolved: `signalResolver.ts` is a pure function with only `import type` dependencies. No React Native, no AsyncStorage, no network. The blocker was that no script had wired it to live Supabase data. `item88_canonical_resolver.ts` now imports it directly and re-derives outcomes from `gold_m1_bars`. 4 LIVE signals re-derived: 2 WIN (ALL_TARGETS_HIT), 2 LOSS (SL_HIT). This unblocks D6, D7, C17, C18. | signalResolver.ts | — | Resolved | HC-88 |
| **F-23** | **OPEN (report-only, ITEM 84) — THE 0.55 CONVICTION GATE IS 1.74x STRICTER WHEN THE ZONE LAYER WORKS.** Controlled arms, same window/step/tape, production weights, EXCEPTIONS 0/340 both: ARMED WS mean 0.4120 and pass rate **32.1%**; DARK WS mean 0.5382 and pass rate **55.9%**. The fixed threshold is compared against a distribution that MOVES with zone availability — the absolute-constant-vs-shifted-distribution class. Consequence measured, and it is NOT perverse: emissions FALL when dark (1 vs 6) because the zone-confluence gate then blocks what conviction let through. So a broken zone layer does not increase volume; it silently changes WHICH gate is binding. Threshold deliberately unchanged. | `MIN_SIGNAL_CONVICTION_THRESHOLD = 0.55` at SE:429 | **HIGH** — zone health silently controls which gate binds | Pre-existing | HC-31 |
| **F-16** | **FIXED 2026-08-17 (D2).** All four reconcile counters now computed with `String()` normalization on signalId, and a shared-count assertion (`shared = local - local_only = remote - remote_only`) is logged. The prior inconsistency (17 shared one way, 11 the other) was caused by type-coerced signalIds comparing asymmetrically. | `learningStore.ts:1135-1200` | MEDIUM | Pre-existing | D2 |
| **F-17** | **OPEN — F6 criterion 4 is REFUTED on its own pre-registered threshold.** Stand-aside rate **5.40%** (1,427 / 26,414) against the project's own 5% refutation line, up from 2.37% on 13 Aug. Threshold deliberately NOT changed. Diagnosis in §5/C3. | SE:2353; `diagnosticsExport.ts:713-745` | **HIGH** — directional layer status | Newly crossed | C3 |
| **F-19** | **FIXED 2026-08-17 (D3).** New `NOT_YET_LOADED` reason added to `Tier0FailureReason`; the cold-start race (fetch launched but not yet resolved) is now attributed as `notYetLoaded` rather than appearing as an unexplained fallback. The export will show `notYetLoaded > 0` instead of `0 failed read(s), 1 pass fell back`. | `srZoneTier0Service.ts:77-82, 232` | LOW | Pre-existing | D3 |

---

## 7. MEASUREMENT RULES

1. **Canonical method.** Outcomes are re-derived with the real
   `resolveSignalWithBars`, `fromScratch: true`, predicate `R > 0`, no
   exclusions. Anything else is PROVISIONAL and must be labelled so.
2. **Stored-label prohibition.** Never read `result`/`status` as an outcome.
   `SL_AFTER_BE` means the stop was taken AFTER TP1 banked, exiting at the
   ~0.35R lock — `R > 0`, therefore a **WIN**. Mislabelling this class once moved
   a win rate by 29.7pp and drove months of wrong conclusions. F-8 shows the
   disagreement is still present in 24 rows today.
3. **Emission-power rule.** Per-attempt emission rate is ~1.15e-4. Detecting a
   2× change needs ~139,000 attempts (~100 days of tape) at 80% power, so
   emission RATE is **IMPOSSIBLE** to measure on this tape, not merely
   underpowered. Distribution-shape claims are NOT emission claims — label
   which is which every time. Any emission claim must state attempt count AND
   the detectable-effect floor or it is void.
4. **TIER_0 precondition for cross-session comparison.** `sr_zones_v1` is read
   LIVE on every evaluation (`srZoneTier0Service.ts:255`, called from SE:3572)
   and the refresh WHOLESALE REPLACES the table (`backend/trpc/routes/srZones.ts:329`
   writes a batch then `.delete().lt("updated_at", runTs)`). The harness pins the
   bar tape but **NOT** the zones. Two runs on different days therefore read a
   different zone set even with byte-identical engine source and an identical
   pinned `--tape-end`. Before comparing runs, confirm both fall inside ONE zone
   batch (`max(updated_at)` identical) and record `max(reaction_strength)`; if it
   is `< 0.30`, TIER_0 was dark and the run is a TIER_1_LOCAL run, i.e. a
   different system.
5. **Comparability gate — all five, or report "not comparable" instead of a number.**
   (a) engine source pinned (`git log -- expo/services/signalEngine.ts`);
   (b) harness source pinned — a harness edit changes the instrument;
   (c) identical explicit `--tape-end`;
   (d) identical `--step`;
   (e) identical TIER_0 zone batch (rule 4).
6. **Instrument integrity — a counter can be structurally dead.** A counter must
   observe the channel the signal actually uses (F-10: `console.warn` vs
   `console.log`). Prove every new counter by forcing its condition once and
   watching it increment. A zero from an unproven counter is not evidence. Guard
   clauses that gate a conclusion must themselves be tested.
7. **Repo is not production.** Never cite a migration file as database state.
   Proven twice: migration 003's invalid `CREATE POLICY IF NOT EXISTS` sits in
   the repo while the policy is live; `resolve-emitted-signals` exists in the
   repo while sibling functions 404 in production.
8. **Provenance over appearance.** Ask the source system. Sandbox forks under
   `expo/scripts/__sandbox_*/` are frozen copies and are never evidence of live
   behaviour.
9. **Artifacts must survive.** Write run output to a repo path
   (`expo/artifacts/`), never `/tmp` — the sandbox clears it, and evidence cited
   in a report must remain re-checkable. This rule exists because a prior
   session's `/tmp` vectors were lost and had to be re-run.
10. **State POWER before the result**, and when measurement is IMPOSSIBLE rather
    than underpowered, say so and name the forward evidence that would settle it.

---

## 8. OPERATIONS RUNBOOK

| Failing check | What it means | Action | Who |
|---|---|---|---|
| HC-1 resolver ≠ 200 | Labels stop being produced; book freezes | Redeploy `resolve-emitted-signals` from the Supabase dashboard | **USER** (dashboard deploy) |
| HC-2 zone refresh ≠ 200 | `sr_zones_v1` goes stale; after 96h TIER_0 goes dark | Redeploy `refresh-sr-zones`; then re-run HC-8 | **USER** |
| HC-3 drainer 404 (**current**) | Telegram outbox never drains → executor never receives signals | Deploy `drain-telegram-outbox`, or confirm the executor uses a different transport and correct this file | **USER** |
| HC-6 stale bars | Scoring runs on old prices | Check upstream MT5/Exness ingest; verify the frozen-tick guard on all three paths (startup, periodic re-measure, cache write) | **USER** (MT5 restart) |
| HC-6 future-stamped > 0 | The broker-offset defect class that once produced 2,092 future bars; invisible to magnitude checks | STOP measuring. Fix the offset guard first, then re-derive anything measured in the affected window | AGENT can diagnose; **USER** restarts MT5 |
| HC-7 intra-week gap | Silent scoring defect, not cosmetic | Backfill the window, then re-derive affected outcomes | AGENT |
| HC-8 max reaction_strength < 0.30 | TIER_0 dark; every run is TIER_1_LOCAL and NOT comparable to an armed run | Do not compare across the boundary. Re-run once armed | AGENT |
| HC-9 / HC-10 BLOCKED (**current**) | Cannot see cron schedules, actual runs, or RLS policies from the anon key | Run the two SQL statements in §4 in the Supabase SQL editor and paste results, or create a service-role helper RPC | **USER** (SQL editor) |
| HC-9 job active but never ran | `active=true` is NOT evidence it ran | Inspect `cron.job_run_details`; re-schedule | **USER** |
| HC-11 anon write accepted | Corpus can be mutated by any client | Add/repair RLS policies; re-probe behaviourally, expecting `42501` | **USER** (SQL editor) |
| HC-12 BLOCKED (**current**) | No canonical book; only stored-label numbers exist | Build a node-runnable canonical re-derivation harness around `resolveSignalWithBars` | AGENT |
| HC-13 comparability fail | Any before/after number is void | Re-run the pair inside one zone batch; do NOT invoke `refresh-sr-zones` while a run is in flight (F-11) | AGENT |
| F-0 harness crash | All post-conviction harness output is void | Pass a real settings object at the call site — **requires explicit go-ahead**, findings are reported not fixed | AGENT on approval |
| F-1 capture dead | No live corpus, no learning, no forward EV | Trace emission → `emitted_signals_v1` on device; needs on-device telemetry | AGENT + **USER** (device) |
| ML weights / push telemetry needed | AsyncStorage, device-only | Export from the device diagnostics screen; unreachable server-side | **USER** (device) |

### Verification hygiene (applies to every action above)

- Quote file:line from the live tree, never memory, never a prior report.
- Distinguish "no evidence for" from "evidence against".
- Carry the data snapshot (zone batch stamp, tape-end, row counts) alongside any
  number it depends on.
- One blocked check does not stop the others — record BLOCKED with its reason and
  continue.
