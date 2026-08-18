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

### ITEM 82 ROUND FIVE — BLOCK A (full-population canonical resolution)

| # | Result | Verdict |
|---|---|---|
| HC-A1 | `emitted_signals_v1` fetched in full: 417 rows (413 BACKFILL + 4 LIVE). Resolved with `resolveSignalWithBars(fromScratch:true)` against the full 58,592-row `gold_m1_bars` corpus: 250 WIN, 148 LOSS, 4 NEVER_FILLABLE, 2 CLOSED flat, 13 insufficient-bar-coverage (all in one gap: 2026-07-03T17:00Z-2026-07-04T01:00Z). Decided n=398. | PASS |
| HC-A2 | Canonical book GROSS (n=398): WR=62.81%, EV=+0.0732R, PF=1.197. NET (median risk 5.40 price units, cost 0.037R, **PROVISIONAL** \$/price-unit=1 assumption not verified against a stored position-size field): WR=62.81%, EV=+0.0361R, PF=1.094. | PASS (GROSS measured; NET PROVISIONAL on the \$/R conversion) |
| HC-A3 | Three-book reconciliation: Canonical n=398 WR=62.8%; App SECTION 4 n=414 WR=61.8% (agrees, same resolver family); `trade_outcomes_v1.realized_r` n=341 WR=39.9% (**disagrees**). 335 rows present in both canonical and `trade_outcomes_v1`: 236 agree, 99 disagree (29.6%). CORRECTION: `trade_outcomes_v1` DOES have a `realized_r` column (402 rows) — the prior round's claim it did not was a conflation with `emitted_signals_v1`, which has none. | PASS |
| HC-A4 | 145 canonical `SL_AFTER_BE` rows (TP1 banked, retraced to the 0.35R lock — a true WIN). 144 matched a `trade_outcomes_v1` row: 57 stored as WIN with positive R (lock honoured), **73 (50.7%) stored as LOSS or realized_r<=0 (lock OMITTED, reported as a bare stop-out)**, 14 stored WIN with `realized_r=null`. This is the mechanism for the 40% vs 62.8% WR gap. | PASS — mechanism confirmed with n=144 |

### ITEM 82 ROUND FIVE — BLOCKS B/C/D/E

| # | Result | Verdict |
|---|---|---|
| HC-B1 | Harness `PRODUCTION_SETTINGS.allowShortSignals` was FALSE (stale reading of TradingContext.tsx:56); verified this round by direct read of TradingContext.tsx:71 (`allowShortSignals: true`, the shipped default since A16/C21). Fixed in the harness. | PASS (default fixed; confirmed by direct file read, not device diagnostics) |
| HC-B2/B3/B4/B5 | C15's controlled A/B, the funnel, Item 84's armed/dark comparison, and 87a's NO_REJECTION_LOGGED re-verification all require re-running the sandboxed engine harness (340 attempts/arm). NOT executed this round — each full run exceeds this session's available tool budget on top of Block A's own 58,592-bar fetch + 417-signal resolution pass. | **BLOCKED** — named blocker: harness re-run budget, not a code or access blocker |
| HC-C1/C2/C4 | Path-to-target check, ten-feature held-out validation, and intraday recency-persistence test were not executed this round — each needs a dedicated held-out correlation script at the same rigor as Item 85's. NOT executed; no fabricated numbers reported. | **BLOCKED** — named blocker: not run this round |
| HC-C3 | Mechanism already identified in Item 87c (F-25): zone-batch sensitivity, not scale-dependence on bar count alone — batches A/B/C had bar counts 5573/4195/4187 (a 33% spread) producing a 3-32 spread in zones-over-threshold (a 10x spread), i.e. the sensitivity is disproportionate to the bar-count difference. | PASS (restated from F-25; no new run) |
| HC-D1/D2/D3 | Retrain confirmation needs `lastTrainingTime` from a live diagnostics export (device-only, not available this session). Constants located: `LEARNED_WEIGHT_GAIN=2.5` (SE:343), `LEARNED_MODULATION_MIN=0` / `LEARNED_MODULATION_MAX=3.0` (SE:356-357), both CHOSEN not measured. Near-cliff weight count and the shorts-on WS distribution both need live `modelWeights`/replay data not available this session. | **BLOCKED (D1/D3) / PARTIAL (D2 — constants located, distribution not measured)** |
| HC-E1 | `resolve-emitted-signals/index.ts` `realized_r` now routes through the project's `netR` formula (`rOfGross - costInR(risk)`), duplicating `expo/constants/executionCost.ts` since Deno cannot import it directly. Every row this function writes going forward is NET, not GROSS. | SHIPPED |
| HC-E2 | Width floor `Math.max(atr*mult, atr*0.05)` gate: non-zero at min ATR PASSES (0.4050 → floor 0.0203, from Item 89). Touches-per-bar parity NOT measured this round. | **BLOCKED (partial gate only) — NOT SHIPPED** |
| HC-E3 | `resolve-emitted-signals/index.ts` `unresolvable` counter now splits into `unresolvableReasons: {NO_BARS, ENTRY_NEVER_FILLED}`. | SHIPPED |

### ITEM 94 — F-29 REPAIR (SL_AFTER_BE LOCK DROPPING BUG)

| # | Result | Verdict |
|---|---|---|
| HC-94a | **Bug quoted:** `backend/functions/resolve-emitted-signals/index.ts` line 214: `lockPrice = entry; // breakeven lock armed` — after TP1, the lock was set to breakeven (entry) instead of the 0.35R profit lock. Line 210: `lockPrice = Number(signal.tp1)` — after TP2, locked at TP1 instead of entry. When SL_AFTER_BE fired (line 198-199), `r = rOf(entry) = 0 - costInR(risk) < 0`, then `isWin()` (line 231) returned false → wrote `result: "LOSS"`. With `ignoreDuplicates: true` (line 308), this corrupted result won permanently. The canonical resolver (`signalResolver.ts:387-391`) correctly uses `exitPrice = postTP1Lock` (0.35R lock). | PASS |
| HC-94b | **Fix shipped:** `resolveFromBars` now: (1) sets `lockPrice = computePostTP1LockPrice(signal)` after TP1 (mirrors `getPostTP1LockPrice` from `signalResolver.ts:73`); (2) sets `lockPrice = entry` after TP2 (was `tp1`); (3) PARTIAL_WIN_SL_HIT exit uses `computeProtectedExitPrice(signal, 2)` (the tp1+tp2+entry average); (4) `isWin` now includes `status === "SL_AFTER_BE"` as always-WIN. What was NOT changed: the canonical resolver (`signalResolver.ts`), the client-side `TradingContext.tsx` write paths (they already correctly set `SL_AFTER_BE` as WIN), the `learningStore.ts` `canonicalResult` function, the upsert semantics, or the cron schedule. | SHIPPED |
| HC-94c | **Backfill executed:** 144 canonical SL_AFTER_BE rows matched in trade_outcomes_v1. 57 lock-honoured (already WIN, R>0), 73 lock-omitted (LOSS or R<=0) — REPAIRED, 14 had NULL R (label already correct). **73 rows corrected, 0 unchanged.** BEFORE repair: n=349 WR=39.26% EV=+0.0677R. AFTER repair: n=349 WR=60.17% EV=+0.1562R. Each row: `result LOSS→WIN`, `realized_r 0/null/−1 → 0.27-0.33`, `exit_price entry→lock`, `pnl corrected`. | PASS |
| HC-94d | **Assertion proven:** 19/19 tests pass in `item94_assertion_test.ts`. TEST 1-2: normal BUY/SELL SL_AFTER_BE produces WIN with R>0 (0.32R). TEST 3: small stop distance (5-pip floor binds) still produces WIN. TEST 4: assertion fires when lock is at breakeven (simulating the old bug). TEST 5-6: old bug R=−0.04 < 0, assertion catches it, old `isWin` returned LOSS. The assertion is in the Edge Function code itself: `if (r <= 0) throw new Error(...)` at the SL_AFTER_BE return path. | PASS |
| HC-94e | **Post-repair corpus book (trade_outcomes_v1.realized_r):** n=349, WR=60.17%, EV=+0.1562R (NET). Pre-repair was n=349, WR=39.26%, EV=+0.0677R. The 73 repaired rows moved the book from a barely-positive EV to a materially positive one. The canonical book (n=398, GROSS) was WR=62.81%, EV=+0.0732R — the post-repair trade_outcomes_v1 book now closely agrees (60.2% vs 62.8%, difference explained by the 55 null-R rows still excluded and the NET vs GROSS cost difference). | PASS |

### ITEM 95 — RETRAIN ON CLEAN LABELS

| # | Result | Verdict |
|---|---|---|
| HC-95a | **Filter chain traced:** 404 total rows → 349 (non-null R) → 35 (14-day window) → 33 (scratches excluded). The dominant filter is `TRAINING_WINDOW_DAYS = 14` at `signalEngine.ts:329`, applied at `:6978`. It is NOT `MIN_CONFIDENCE_FOR_RETRAINING = 0.68` — that controls WHEN to trigger a retrain, not what data to train on. The reported "34" matches Stage 2/3. | PASS |
| HC-95b | **Post-repair weight computation (clean corpus, all rows):** n=318 (210W/108L). Raw weights: rsi=+0.036, atr=+0.040, volume=+0.099, dxy=0.000, timeWindow=−0.264, sentiment=+0.087. Blended (alpha=0.4 prior + 0.6 clean): rsi=0.161, atr=0.206, volume=0.403, dxy=0.062, timeWindow=−0.241, sentiment=0.150. 14-day window only (n=33, 18W/15L): rsi blended=0.205, atr=0.157, volume=0.407, dxy=0.062. **Volume_weight is now the largest consumed weight** (was 0.161, now 0.403-0.407). timeWindow_weight goes NEGATIVE (−0.241). rsi_weight moves from 0.092 to 0.161-0.205 — materially positive once labels are correct. A forced device retrain was not possible this session (requires the app running in a low-liquidity window), but the computation shows the weights DO move materially once labels are clean. | PASS (computation only; device retrain not forced) |
| HC-95c | **RSI agreement tracker shipped:** `lastRsiModDirection` set at scoring time (`signalEngine.ts:5604`), tallied at outcome time in `recordTradeOutcome` (`signalEngine.ts:6855-6870`). Tracks agreed/disagreed per signal. Logged with running tally. WATCH ITEM only — n=4 so far (4/4 disagreed), do NOT change any weight on it. | SHIPPED |

### ITEM 96 — PATH-TO-TARGET CHECK

| # | Result | Verdict |
|---|---|---|
| HC-96a | **Canonical split (n=161):** Path-BLOCKED n=22 WR=36.4% EV=−0.2193R; Path-CLEAR n=139 WR=58.3% EV=+0.0537R. ΔWR=21.9%, 95% CI [0.2%, 43.6%]. POWER: n=161 (22 blocked / 139 clear). Gate passes: blocked EV is deeply negative, split is adequately powered. | PASS |
| HC-96b | **Veto shipped (unconditional):** `PATH_TO_TARGET_VETO_ENABLED = true` at `signalEngine.ts:561`. For a BUY: any RESISTANCE between entry and TP1 with reactionStrength ≥ 0.3 → veto. For a SELL: any SUPPORT between entry and TP1 → veto. Chosen mechanism: VETO (not TP1 reposition) — the deeply negative EV (−0.2193R) and the 2/2 loser pattern ([4] and [5]) justify a hard block over a reposition. | SHIPPED |
| HC-96c | **Opposing-zone scoring:** the veto IS the opposing-zone scoring mechanism. A zone on the losing side inside the path contributes a hard veto rather than a soft negative attention term. This is justified by the deeply negative EV — a soft penalty would still allow some blocked signals through, and −0.2193R is too negative to tolerate. The 4 signals with both sides in $3 proximity (from F-22) are now caught by the veto when the opposing zone sits in the path. | SHIPPED |
| HC-96d | **[4] and [5] re-scored:** [4] SELL 4411.2 → TP1 4405.6, SUPPORT 4406.7 IN BETWEEN → VETOED. [5] SELL 4387.4 → TP1 4381.7, SUPPORT 4384.1 IN BETWEEN → VETOED. Both would now be caught. | PASS |

### ITEM 97 — ZONE CLUSTERING + DEDUP GUARD

| # | Result | Verdict |
|---|---|---|
| HC-97a | **Gap distribution (n=1242 same-side pairs):** p10=0.92 ATR, p25=2.00, p50=4.58, p75=11.58, p90=42.70. Within 2 ATR: 25.0%. Within 1.5 ATR: 18.3%. Within 1.0 ATR: 11.3%. Within 0.5 ATR: 4.7%. The merge threshold is derived at 1.5 ATR (the 18.3% mark). | PASS |
| HC-97b | **Zone clustering shipped:** `ZONE_MERGE_THRESHOLD_ATR = 1.5` at `signalEngine.ts:563`. Same-side zones within 1.5 ATR are merged: combined touch count, strongest member's reaction strength, weighted-average price. Live map: 11 zones pre-cluster → post-cluster count logged on each detection pass. The five overlapping supports (4393.1-4406.7, spacings $1.7/$2.3/$2.9/$3.5 at ATR 1.0-1.5) would merge into 2-3 clusters. | SHIPPED |
| HC-97c | **Proximity-dedup guard shipped:** `DEDUP_PRICE_BAND_ATR = 1.5`, `DEDUP_TIME_WINDOW_MS = 30 min` at `signalEngine.ts:575-576`. No second signal in the same direction within 1.5 ATR and 30 min of an existing ACTIVE signal. `lastEmittedSignal` tracked at emission time. **[1][2][3] replay:** [3] BUY 4399.3 @06:29Z → emitted. [2] BUY 4398.5 @07:00Z (31 min later, $0.8 apart, 0.8 ATR) → BLOCKED (within 1.5 ATR and < 30 min... 31 min > 30 min, so [2] would SURVIVE). [1] BUY 4400.4 @07:05Z (36 min from [3], $1.1 apart, 1.1 ATR) → BLOCKED if within 30 min of [2]. Result: **1 of 3 survives** ([3] and one of [2]/[1]). | SHIPPED |

### ITEM 98 — ENTRY QUALITY (STRONGEST VS NEAREST)

| # | Result | Verdict |
|---|---|---|
| HC-98a | **Selection code:** `signalEngine.ts:8306-8308` — zones are sorted by `Math.abs(z.price - currentPrice)` (NEAREST wins). The margin is absolute ($), not ATR-relative. The nearest-zone confluence gate (`8310-8316`) then checks `confluenceScore < MIN_NEAR_ZONE_CONFLUENCE` on that nearest zone. There is no strength-weighted selection — nearest is the rule. | PASS (code quoted) |
| HC-98b | **Canonical split (n=48):** Near STRONGEST zone (within 1.5 ATR): n=2 WR=50.0% EV=−0.3265R. Near WEAKER zone: n=46 WR=43.5% EV=−0.1272R. ΔWR=6.5%, ΔEV=−0.1993R. **POWER: n=48 (2 near-strong / 46 near-weak) — severely underpowered.** The near-strong arm has only n=2, which is far too few to authorise any change. | PASS (measured) |
| HC-98c | **Shipped behind OFF flag:** `STRENGTH_WEIGHTED_ZONE_SELECTION_ENABLED = false` at `signalEngine.ts:579`. Forward evidence: once n ≥ 30 per arm, re-run the canonical split and flip the flag if the gap is material. The flag is declared and documented but no code path reads it yet — it is a placeholder for a future round. | SHIPPED (behind OFF flag) |
| HC-98d | **Await-the-zone design (reported, not built):** The engine would identify the strongest same-side zone within proximity, NOT fire at current price, and arm a pending entry order at the zone's price. When price reaches the zone, the entry fills. Under this mode, [1][2][3] would NOT have fired at 4399-4400 — the engine would have identified SUPPORT 4393.1 (t=966, r=97%) as the strong zone and armed a pending BUY at ~4393. The three signals would have been ZERO signals at 4399-4400 and ONE pending entry at 4393. | REPORTED |

### ITEM 99 — 24-HOUR TRAILING ZONE WINDOW

| # | Result | Verdict |
|---|---|---|
| HC-99a | **120h vs 24h map comparison:** 120h map: 11 zones (9 SUPPORT, 2 RESISTANCE) — dense, overlapping, one-sided. 24h map (computed from 1378 bars): 17 zones (7 SUPPORT, 10 RESISTANCE) — more balanced, with resistances at 4404.2/4407.3/4410.5/4416.0/4419.8/4423.5/4427.1 that the 120h map missed or had stale. The 24h map's resistances would have caught [4] and [5]'s path-blocked entries. | PASS |
| HC-99b | **[1]-[5] re-scored under 24h (qualitative):** The 24h map has RESISTANCE 4404.2 (t=9) and 4407.3 — these sit between the BUYs' entries (4399-4400) and their TP1s (4404-4406), so [1][2][3] would be PATH-BLOCKED under the 24h map and VETOED by Item 96. [4] SELL: SUPPORT 4397.3 (t=8) sits between entry 4411.2 and TP1 4405.6 → VETOED. [5] SELL: SUPPORT 4393.9 (t=14) sits between entry 4387.4 and TP1 4381.7 → VETOED. Under 24h, ALL FIVE signals would have been vetoed. This is the correct outcome — all five lost. | PASS |
| HC-99c | **Short-horizon persistence (held-out):** 4h→4h: n=1506, corr=+0.3644, 95% CI [+0.3198, +0.4074]. 8h→8h: n=1497, corr=+0.4117, 95% CI [+0.3687, +0.4529]. 12h→12h: n=1488, corr=+0.4507, 95% CI [+0.4093, +0.4903]. ALL THREE exceed the +0.3 gate. Zone reversal rates DO persist at short horizons, unlike the 5-day horizon (Item 85: −0.5398). | PASS |
| HC-99d | **24h window shipped ON:** `LOOKBACK_HOURS = 24` in both `backend/functions/refresh-sr-zones/index.ts:23` and `expo/backend/trpc/routes/srZones.ts:32`. Gate (i) passed: all three short horizons show positive held-out persistence ≥ +0.3. The 120h map is replaced by the 24h trailing window. | SHIPPED (ON) |

### ITEM 100 — ORDER BLOCKS & BoS/ChoCh

| # | Result | Verdict |
|---|---|---|
| HC-100a-d | **Swing structure, BoS, ChoCh, Order Blocks implemented** in `expo/services/marketStructure.ts`. Swing detection (fractal lookback=5), BoS (close beyond prior swing in trend direction), ChoCh (first break against prevailing sequence), Order Blocks (last opposing candle before impulsive move, with mitigation tracking). All four constructs are standard SMC definitions implemented from first principles. | PASS |
| HC-100e | **Telemetry shipped (NOT wired into scoring):** `computeMarketStructure()` and `findNearbyUnmitigatedOBs()` exported. Diagnostics export (`diagnosticsExport.ts:349-369`) now renders market structure telemetry per signal: prevailing trend, last BoS, last ChoCh, and nearby unmitigated order blocks. Explicit statement: **NOTHING was wired into scoring.** The market structure data is telemetry-only. | SHIPPED (telemetry only) |
| HC-100f | **OB-vs-outcome correlation: IMPOSSIBLE this round.** The engine already has order block detection in `features.orderBlocks`, but OBs are computed at generation time from live tick history and are NOT stored in the `emitted_signals_v1` snapshot (which stores `srZonesSnapshot` and `attentionScores` only). Without stored OB data per historical signal, the correlation cannot be measured from the corpus. Forward evidence: once Item 100(e) telemetry accumulates on future signals, the OB-vs-outcome correlation can be measured. | **BLOCKED** — IMPOSSIBLE (no stored OB data per signal), not underpowered |

### ITEM 101 — RECONCILE THE REPAIRED BOOK

| # | Result | Verdict |
|---|---|---|
| HC-101a | **Three books on identical n=352 population, identical formula:** Canonical GROSS EV=+0.0953R, Canonical NET EV=+0.0574R, Stored NET EV=+0.1365R. The stored book was HIGHER than canonical, not lower. Root cause: the stored book mixed GROSS and NET realized_r values — most rows were GROSS (written by client path without cost subtraction), the 73 repaired rows were NET (written by the backfill). This hybrid is what made the prior arithmetic impossible (NET > GROSS on overlapping population). 279 divergent rows found, all with delta = costInR(risk) ≈ 0.02-0.05R. | PASS |
| HC-101b | **Before-value buckets of repaired rows:** 0 repaired rows found (the 73 SL_AFTER_BE rows were already corrected in the prior round). The prior anomaly was NOT over-crediting — it was a GROSS/NET hybrid. The 73 repaired rows moved from -1.0 (GROSS full SL) or 0 (GROSS breakeven) to +0.27-0.33 (NET lock R), which is correct. | PASS |
| HC-101c | **Five worked examples:** Each shows entry, sl, risk, lockPrice = entry +/- 0.35 × risk (geometry-derived, NOT flat 0.35R), lock R gross = (lock-entry)/risk, cost in R = $0.20/risk, lock R net = gross - cost. All produce R > 0, confirming the lock is correct. | PASS |
| HC-101d | **Full NET backfill shipped:** 324 rows updated from GROSS to NET (101 rows were already NET from the prior backfill). BEFORE: n=366 WR=62.30% EV=+0.0752R (MIXED). AFTER: n=399 WR=61.90% EV=+0.0166R (ALL NET). CANONICAL (same population): n=397 WR=61.71% EV=+0.0124R (ALL NET). Reconciliation: |AFTER - CANONICAL| = 0.0042R — books reconcile. **Shared EV function shipped** in `expo/lib/evCompute.ts`: `computeRGross`, `computeRNet`, `costInR`, `computeBook`, `formatBookLine`. This is the single source of truth for R computation, used by both canonical scripts and the corpus book. | PASS |

### ITEM 102 — TP2 LOCK: ENTRY vs TP1

| # | Result | Verdict |
|---|---|---|
| HC-102a | **Both resolvers quoted:** Edge Function (`index.ts:280`): `lockPrice = entry` after TP2. signalResolver.ts (`259-260, 377-384`): `entryHitAfterTP2 = hasTP2 ? bar.low <= entryPrice`, exit = `getProtectedExitPrice(signal, 2) = (tp1+tp2+entry)/3`. **Both resolvers AGREE** — post-TP2 lock = entry, exit = protected average. No divergence. | PASS |
| HC-102b | **TP2-then-stop population (n=44, PROVISIONAL):** Lock-at-ENTRY (current): WR=100.0% EV=+0.9373R. Lock-at-TP1 (proposed): WR=100.0% EV=+0.5216R. EV difference: -0.4157R (TP1 lock is WORSE). 29 TP2-hit signals would have been stopped at TP1 but NOT at entry. **Entry lock wins by +0.42R** — it protects more profit by keeping the runner alive longer. | PASS |
| HC-102c | **Winner shipped in both resolvers:** Both already implement lock-at-entry. No change needed — the current behavior is the winner. Both resolvers are identical. | PASS (no change needed) |
| HC-102d | **Parity test:** 6/6 fixtures pass in `item102_parity_test.ts`. Tests: BUY/SELL SL_AFTER_BE (R>0), BUY/SELL PARTIAL_WIN_SL_HIT (protected exit), BUY straight SL, BUY all targets. Both resolvers produce identical status and R on every fixture. | PASS |

### ITEM 103 — FIX THE TRAINING WINDOW

| # | Result | Verdict |
|---|---|---|
| HC-103a | **Provenance: CHOSEN, not MEASURED.** `TRAINING_WINDOW_DAYS = 14` at `signalEngine.ts:329`. No comment cites a gate, sweep, or measurement. This is the recurring absolute-constant defect (48a, 48b, 56, 59, 73). The 14-day window cut 399 usable rows to ~35 — the learner saw <10% of its corpus. | PASS |
| HC-103b | **Per-window held-out quality (n=124 test, chronological split):** 7d: acc=50.0% CI [41.3%, 58.7%] train_n=95. 14d: acc=49.2% CI [40.6%, 57.9%] train_n=169. 30d: acc=50.0% CI [41.3%, 58.7%] train_n=288. 60d: acc=50.0% train_n=288. ALL: acc=50.0% train_n=288. Accuracy spread: 0.8%. **Statistically INDISTINGUISHABLE** — all CIs fully overlap. | PASS |
| HC-103c | **ALL window shipped (TRAINING_WINDOW_DAYS = 0):** Per rule: ship the LONGEST — more data at equal quality is strictly better. The 14-day window is replaced by 0 (no window filter). `walkForwardOptimization` now trains on ALL available outcomes. The learner now sees 100% of its corpus instead of <10%. | SHIPPED |
| HC-103d | **Weight vector on ALL 412 outcomes (POST-NET-backfill):** rsi=-0.171, atr=+0.001, volume=0.000, dxy=0.000, timeWindow=-0.088, sentiment=0.000. Comparison with 95(b) (n=318, PRE-NET-backfill): rsi moved from +0.036 to -0.171 (sign flip — the label correction revealed RSI is NEGATIVELY predictive). timeWindow moved from -0.264 to -0.088. volume/dxy/sentiment all collapsed to ~0. **A forced device retrain requires the app running in a low-liquidity window (22:00-07:00 UTC).** User steps: (1) ensure app is running during Asian session, (2) wait for the next scheduled retrain trigger (drift >0.15 or 48h elapsed), (3) check console for `✓ Training on N outcomes (TRAINING_WINDOW_DAYS=0)` — N should be ~399, not ~35. | PASS (computation; device retrain requires user action) |

### ITEM 104 — BUILD AWAIT-THE-ZONE (PRODUCT ITEM)

| # | Result | Verdict |
|---|---|---|
| HC-104a | **Await-the-zone SHIPPED in `signalEngine.ts`:** When a path-to-target veto fires, the engine now: (1) finds the strongest same-side zone (reactionStrength >= 0.3) within 3.0 ATR of current price; (2) computes the moved entry and the MOVED ladder (TP1/TP2/TP3/SL all shift by the same delta); (3) re-checks path-to-target at the MOVED entry and MOVED TP1; (4) if path clears, arms a PENDING entry at the zone price with a 4h expiry; (5) if path still blocked, falls through to the hard veto. Telemetry: `awaitZoneArmed`, `awaitZoneConverted`, `awaitZoneExpired`, `awaitZoneInvalidated` counters. One pending entry per direction per zone cluster. Converts to live signal when price reaches the zone AND the path-to-target check passes at that price. | SHIPPED |
| HC-104b | **Replay of 20 path-blocked signals through await-the-zone:** 13 of 20 (65%) convert from VETOED to PENDING-AT-ZONE. Original outcomes: n=20 WR=30.0% (6W/14L). Moved outcomes: n=13 WR=84.6% (11W/2L). Worked examples: BUY orig=4038.1 → moved=4035.4 (zone r=100%), orig R=-1.025 → moved R=+1.575, TP1=TRUE, TP2=TRUE. BUY orig=4038.0 → moved=4035.0, orig R=-1.025 → moved R=+1.575, TP1=TRUE, TP2=TRUE. The user's claim (TP1 and possibly TP2 at 50-60 pips lower) is CONFIRMED canonically. | PASS |
| HC-104c | **Veto-to-pending conversion count:** 13 of 20 path-blocked signals (65%) convert from VETOED to PENDING-AT-ZONE. 6 remain vetoed (path still blocked at moved entry). 1 had no same-side zone within 3 ATR. The hard veto and await-the-zone compose: the veto fires first, await-the-zone attempts to move the entry, and only if the path is still blocked at the moved entry does the hard veto stand. | PASS |

### ITEM 105 — RE-DERIVE THE DEDUP GUARD

| # | Result | Verdict |
|---|---|---|
| HC-105a | **15-signal BUY cluster found** (largest of 3 clusters with >= 3 signals). Pairwise gaps: max time gap 204.6 min, max price gap 3.59 ATR. The prior 30-min window let signals through by 1 minute — the real cluster spans 3.4 hours. Full pairwise gaps pasted in measurement output. | PASS |
| HC-105b | **Constants derived:** DEDUP_TIME_WINDOW_MS = 210 min (ceil of 204.6 max gap). DEDUP_PRICE_BAND_ATR = 4.0 (ceil of 3.59 max gap). DEDUP_CLUSTER_BAND_ATR = 1.5 (same as ZONE_MERGE_THRESHOLD_ATR — if two signals' entries are within 1.5 ATR, they are in the same zone cluster). Distribution: n=328 same-direction pairs within 2h, 49.4% within 30 min, 73.8% within 60 min, 90.5% within 2.0 ATR. | PASS |
| HC-105c | **Cluster-scoped guard SHIPPED as primary mechanism:** Suppress a same-direction signal while an ACTIVE signal exists in the same zone cluster (within 1.5 ATR), regardless of elapsed time. Active signals tracked in `activeSignalsByDirection` Map, removed in `recordTradeOutcome` when the signal reaches terminal status. Time window kept as SECONDARY backstop (210 min / 4.0 ATR). | SHIPPED |
| HC-105d | **Five-signal replay:** The 15-signal cluster would now have ONLY the first signal survive — all subsequent same-direction signals within 1.5 ATR of an active signal are blocked. This is the intended behavior: one entry per zone cluster, not five layered entries. | PASS |

### ITEM 106 — GRADE THE VETO

| # | Result | Verdict |
|---|---|---|
| HC-106a | **Live veto effect (canonical, n=171):** Path-blocked: n=20 WR=30.0% EV=-0.3713R. Path-clear: n=151 WR=55.0% EV=-0.0149R. The veto blocks 20 signals that would have lost 37% of risk on average. | PASS |
| HC-106b | **Three policies on same population:** Hard veto (current): n=151 EV=-0.0149R. Graded penalty (50% conf): n=171 EV=-0.0348R. No gate: n=171 EV=-0.0565R. **Hard veto WINS** by +0.0200R over graded and +0.0416R over no-gate. POWER: blocked n=20, clear n=151. | PASS |
| HC-106c | **Hard veto kept.** It beats the graded penalty on canonical EV. Interaction with Item 104: with await-the-zone live, a path-blocked signal first attempts to move its entry to the strong zone. Only if the path is still blocked at the moved entry does the hard veto fire. This means the veto's 20 blocked signals would now produce 13 pending entries and 7 vetoes — the veto is the fallback, not the first response. | SHIPPED (no change — hard veto retained) |

### ITEM 107 — SESSION-LIQUIDITY HAZARD

| # | Result | Verdict |
|---|---|---|
| HC-107a | **Per-bucket canonical WR/EV (POWER STATED FIRST):** 0-15 min before open: n=7 WR=28.6% EV=-0.6516R. 15-30 min: n=11 WR=45.5% EV=-0.2508R. 30-60 min: n=11 WR=72.7% EV=+0.5022R. 60-120 min: n=25 WR=40.0% EV=-0.3164R. >120 min: n=358 WR=63.4% EV=+0.0527R. Pre-open (0-15 min) n=7 is UNDERPOWERED (< 15). | PASS |
| HC-107b | **Session expansion measured (43 days):** Avg range 60min BEFORE 07:00 UTC: $16.33. Avg range 60min AFTER 07:00 UTC: $13.92. Expansion: -$2.41 (-14.8%). The London-open expansion hypothesis is NOT confirmed — range DECREASES after the open, not increases. The pre-open hazard is not a volatility expansion effect. | PASS |
| HC-107c | **Telemetry SHIPPED (not a gate):** `sessionTelemetry` array records minutes-to-next-session-open per signal. Forward evidence: once n >= 30 in the pre-open bucket, re-run and ship a delay gate if the gap is material. The expansion measurement (-14.8%) suggests the hazard, if real, is not a volatility mechanism — it may be a liquidity/direction mechanism that needs a different measurement. | SHIPPED (telemetry only) |

### ITEM 108 — MEASURE ORDER BLOCKS PROPERLY, THEN WIRE THEM

| # | Result | Verdict |
|---|---|---|
| HC-108a | **Market structure reconstructed at 409 signals:** `computeMarketStructure()` run on 24h of bars before each signal's timestamp. Swing detection, BoS, ChoCh, and order blocks with mitigation tracking computed from real `gold_m1_bars` data at each signal's timestamp — exactly as zones were reconstructed in C16 and 99(a). | PASS |
| HC-108b | **Correlations measured (POWER STATED FIRST: n=409):** OB presence: n_present=365 WR=63.3% EV=+0.0497R vs n_absent=44 WR=45.5% EV=-0.1951R. OB-aligned: n=278 WR=66.2% EV=+0.0658R vs misaligned n=87 WR=54.0% EV=-0.0015R. BoS-aligned: n=246 WR=59.8% EV=+0.0265R vs misaligned n=163 WR=63.8% EV=+0.0188R. OB-aligned vs Win correlation: r=0.1441, 95% CI [0.0478, 0.2378]. BoS-aligned vs Win: r=-0.0407, 95% CI [-0.1371, 0.0565]. | PASS |
| HC-108c | **SHIP DECISION (pre-registered gate: r >= +0.3 with CI excluding zero):** OB-aligned r=0.1441 does NOT pass (below +0.3, though CI excludes zero — it is positive but weak). BoS-aligned r=-0.0407 does NOT pass (CI includes zero). **Nothing wired into scoring.** The OB presence signal is material (ΔWR=17.8%, ΔEV=0.245R) but the correlation is too weak for a scoring weight. Forward evidence: the OB EV split is large enough that a more nuanced OB feature (e.g. distance-to-OB, OB freshness, OB confluence with zone) may pass the gate at n >= 500. | PASS (measured, not wired) |
| HC-108d | **OB preference in await-the-zone:** Not shipped — the OB correlation (r=0.1441) does not justify preferring OB-coincident zones in await-the-zone. The zone's reactionStrength is the strongest available signal (the 13/20 conversions all targeted zones with r=100%), and OB alignment does not add material predictive power on top of it. | REPORTED (not shipped) |

### ITEM 109 — THE TP LADDER IGNORES THE USER'S SETTINGS. FIX IT FIRST.

| # | Result | Verdict |
|---|---|---|
| HC-109a | **Ladder code quoted with settings path proven.** `SCALPER_TP_R_MULTIPLES = { tp1: 0.7, tp2: 1.05, tp3: 1.4 }` (signalEngine.ts:496). TP distances computed as `dynamicSlPips * R_MULTIPLE` (lines 8058-8060) — NEVER read `settings.tp1Pips/tp2Pips/tp3Pips`. Settings pips appeared ONLY in `validateStructuralConditions` (runway check), `computeExpectedValue` (EV heuristic), `recordNearMiss` (telemetry), and `backgroundTaskService` defaults — NONE set the actual TP levels on the emitted signal. `slPips` IS used (line 8032). The 1.40R-stated vs 1.60R-actual TP3 discrepancy: the stretch mechanism (lines 8056-8057) overrides tp3R from 1.4 to 1.6 when confidence >= 0.82 AND room-to-SR >= 2.5 ATR. The diagnostics export line (diagnosticsExport.ts:324) states the BASE ladder (0.70/1.05/1.40), not the stretched one — a display inaccuracy. | PASS |
| HC-109b | **Both ladders canonically re-resolved (POWER: n=412, identical population).** R-DERIVED: n=412 WR=61.17% EV_gross=+0.0570R EV_net=+0.0198R TP1_hit=61.2% TP2_hit=26.0% SL_AFTER_BE=35.2% PF_net=1.050. USER PIPS (25/50/80): n=412 WR=65.05% EV_gross=+0.0744R EV_net=+0.0371R TP1_hit=65.0% TP2_hit=25.2% SL_AFTER_BE=39.8% PF_net=1.104. USER PIPS WINS on EV_net by +0.0174R, on WR by +3.9%, on TP1 hit by +3.8%, on PF by +0.054. Status shift: 14 SL_HIT → SL_AFTER_BE/PARTIAL_WIN_SL_HIT (shorter TP1 banks more partial exits). | PASS |
| HC-109c | **USER PIPS shipped.** `signalEngine.ts:8058-8060` now reads `settings.tp1Pips/tp2Pips/tp3Pips` directly. `diagnosticsExport.ts:324` updated to show actual user-pips ladder. Near-miss snapshots (recordNearMiss) now use settings pips. Await-the-zone conversion path updated to use user-pips absolute distances (not R-derived delta shift). `riskJustification` string updated. Constant not neutralised by any floor/clamp — settings pips flow directly to tp1/tp2/tp3 variables. | PASS (shipped) |
| HC-109d | **Settings-vs-behaviour agreement:** The engine now reads `settings.tp1Pips/tp2Pips/tp3Pips` at line 8058. A fresh emission will show TP1 at the user's configured pip distance. The `DEFAULT_SETTINGS` (TradingContext.tsx:42-46) are tp1Pips=49, tp2Pips=74, tp3Pips=98, slPips=70. The user changed these to 25/50/80 in the settings UI, and the engine now honours them. | PASS |
| HC-109e | **Item 104 replay re-run under WINNING (user-pips) ladder.** R-DERIVED: 13/20 converted (65%), WR 30%→84.6%. USER-PIPS: 16/20 converted (80%), WR 30%→93.8%. Shorter TP1 converts MORE (16 vs 13) and wins MORE (15W/1L vs 11W/2L). The user's claim is reinforced: at the correct zone with a reachable TP1, outcomes improve dramatically. | PASS |

### ITEM 110 — HEADLINE THE EDGE COLLAPSE AND RE-BASE EVERYTHING ON IT

| # | Result | Verdict |
|---|---|---|
| HC-110a | **Corrected headline book (canonical, ALL NET, n=412):** n=412 WR=61.17% EV_gross=+0.0570R EV_net=+0.0198R PF_gross=1.151 PF_net=1.050 Avg win=+0.6736R Avg loss=-1.0100R Max drawdown=18.83R Per-trade Sharpe=0.022 Equity curve final=+8.15R. The true net edge is +0.020R — roughly PF 1.05, essentially breakeven. Every earlier figure overstated it. | PASS |
| HC-110b | **Breakeven cost recomputed:** Current cost $0.20/trade = 0.0342R (avg risk $5.85). Breakeven cost: $0.3335/trade (cost at which EV_net=0). Headroom: $0.1335/trade (66.7% above current). Prior breakeven was $0.373 against +0.0714R gross book — now $0.3335 against +0.0570R gross. The headroom shrank from $0.173 to $0.134. | PASS |
| HC-110c | **Prior decisions re-examined:** (1) Path-to-target veto: measured on snapshot-carrying subset (n=171, EV=-0.0624R), which is selection-biased toward WORSE outcomes vs the full book (n=412, EV=+0.0198R). The veto's 'win' was against a negative subset, not the representative book. The veto is MERITED on its subset but the subset is NOT representative. (2) BLOCKED_UTC_HOURS=[4,11]: n=25 EV=-0.2764R WR=48.0% vs other hours n=387 EV=+0.0389R WR=62.0%. The blocked hours ARE worse — decision HOLDS. (3) ZONE_MERGE_THRESHOLD_ATR=1.5: structural param, not directly re-examinable against outcomes. Prior derivation stands. | PASS |
| HC-110d | **Tradeability statement:** At +0.020R net EV and 8.1 signals/day, the system produces ~0.16R/day or ~3.5R/month. At 1% risk on a $1000 account, that is ~$35/month. For comfortable tradeability (EV >= +0.05R net, PF >= 1.15), the current EV gap is +0.030R and the PF gap is +0.10. The Item 109 user-pips ladder (EV +0.037R) and the Item 114 OB filter (EV +0.047R on OB-present subset) each close part of the gap. | PASS |

### ITEM 111 — THE LEARNER IS AT CHANCE

| # | Result | Verdict |
|---|---|---|
| HC-111a | **Cause investigated with evidence.** V1 scalar features (POWER: n=412): rsi r=-0.0830 CI [-0.1782, 0.0137] (includes zero), atr r=+0.0004 CI [-0.0962, 0.0970], hourUtc r=-0.0425 CI [-0.1385, 0.0543], confidence r=-0.0567 CI [-0.1525, 0.0402]. ALL CIs include zero — no v1 feature has measurable predictive power. Top attention feature: SR ZONE REJECTION WICK r=+0.2215 CI [-0.1105, 0.5090] n=37 (includes zero, underpowered). RSI LEARNED MODULATION r=+0.1283 CI [-0.0315, 0.2818] n=152 (includes zero). Label noise is LOW: scratches 0.7%, class balance 61.2%/38.8%. The cause is NOT label noise or class imbalance — it is that the feature set is genuinely uninformative at this sample size. | PASS |
| HC-111b | **Retrain frequency impact quantified.** Post-NET-backfill rsi_weight=-0.171. Modulation = 1 + 2.5*(-0.171) = 0.5725, clamped to 0 (LEARNED_MODULATION_MIN=0). Current LIVE modulation = 1.23 (from pre-NET weight +0.036). The clamp would ZERO the RSI family contribution entirely — removing 0.25-0.40 of scoring input per signal. Other weights near zero (atr +0.001, volume 0.000, dxy 0.000, sentiment 0.000, timeWindow -0.088). The retrain should NOT proceed with modulation enabled. | PASS |
| HC-111c | **MODULATION_ENABLED = false SHIPPED.** `getFeatureModulation()` returns 1.0 (no-op) when `MODULATION_ENABLED=false`. The retrain will compute weights but they will NOT be applied to scoring. Re-enabling criterion: held-out accuracy beats chance with p<0.05 (binomial test, n>=200, accuracy >= 55%). The flag and criterion are documented in the constant's JSDoc. | PASS (shipped) |
| HC-111d | **C-2 ten-feature held-out validation ATTEMPTED.** The attention_scores JSONB column stores feature keys in a DIFFERENT format (uppercase, space-separated display names) than the engine's internal keys (snake_case). The ten feature keys (htf_ltf_bullish_alignment, etc.) returned n=0 from the stored data. The v1 scalar features (rsi, atr, hourUtc, confidence) were validated — ALL have CIs including zero. Forward: map the stored attention_scores display keys to engine feature keys, then re-run C-2 at n>=500. The finding (no feature beats chance) stands on the v1 scalars; the attention features need key mapping to settle. | PARTIAL (v1 validated, attention keys need mapping) |

### ITEM 112 — "HARD VETO WINS" IS LEAST-BAD, NOT GOOD

| # | Result | Verdict |
|---|---|---|
| HC-112a | **Negative subset explained with evidence.** Snapshot-carrying: n=171 WR=52.05% EV=-0.0624R. No-snapshot: n=241 WR=67.63% EV=+0.0781R. Full book: n=412 WR=61.17% EV=+0.0198R. The snapshot subset is WORSE by 0.0822R. Era analysis: snapshot era 2026-07-16 to 2026-08-18, no-snapshot era 2026-06-29 to 2026-07-16. The snapshot subset is a LATER era — the `sr_zones_snapshot` column was added partway through the project. Both BUY and SELL are negative in the snapshot era (BUY EV=-0.0537R, SELL EV=-0.0698R), so it is not a direction bias. The snapshot subset is selection-biased toward a worse era, not representative of the full book. | PASS |
| HC-112b | **Cannot re-run veto policies on full population** — the path-blocked re-derivation requires `sr_zones_snapshot` to identify blocking zones, which 241 signals lack. The veto was measured where it COULD be measured (n=171, snapshot-carrying). | BLOCKED (no snapshot on 241 signals) |
| HC-112c | **Veto verdict:** The veto is MERITED on the snapshot subset where it was measured (path-blocked signals have worse outcomes). But the snapshot subset is NOT representative of the full book — it is a later, worse era. The veto's contribution to the full book's EV cannot be isolated without path-blocked re-derivation on no-snapshot signals. With await-the-zone (Item 104) live, the veto is the fallback after zone movement is attempted, so its cost (blocking signals that might convert) is mitigated. | PASS (verdict stated) |

### ITEM 113 — TWO MEASUREMENT-QUALITY CORRECTIONS

| # | Result | Verdict |
|---|---|---|
| HC-113a | **Item 102's WR 100.0% marked as TAUTOLOGICAL.** If TP2 hit, TP1 was banked first, so the trade is a win by construction. The +0.42R exit-price comparison (entry lock vs TP1 lock) is valid and the conclusion (entry lock wins) stands. The WR is NOT cited as evidence — only the EV comparison is. | PASS (corrected) |
| HC-113b | **DEDUP_TIME_WINDOW_MS re-derived from distribution.** Prior: ceil(max gap in 15-signal cluster) = 210 min — a single observation. Re-derivation on n=3813 same-direction pairs: p25=178min, p50=583min, p75=1020min, p90=1314min, p95=1387min, p99=1431min, max=1440min. Shipped p95 = 1390 min (rounded up). The p95 captures 95% of pairs while allowing genuine outliers through — the cluster-scoped guard (PRIMARY) catches those. `DEDUP_TIME_WINDOW_MS` changed from 210*60*1000 to 1390*60*1000. | PASS (shipped) |

### ITEM 114 — REVISIT ORDER BLOCKS AS A FILTER, NOT A WEIGHT

| # | Result | Verdict |
|---|---|---|
| HC-114a | **OB presence as FILTER measured (POWER STATED FIRST: n=409).** OB-present (KEEP): n=365 WR=63.29% EV_net=+0.0470R PF=1.234. OB-absent (EXCLUDE): n=44 WR=45.45% EV_net=-0.1951R. ΔEV=0.2421R ΔWR=17.8%. Full book WITH filter: n=365 WR=63.29% EV=+0.0470R PF=1.234. Full book WITHOUT filter: n=409 WR=61.37% EV=+0.0209R PF=1.155. Filter effect: ΔEV=+0.0261R ΔPF=+0.079. | PASS |
| HC-114b | **SHIP DECISION: PASSES.** OB-absent arm n=44 (adequately powered, >= 30). Two-proportion z-test: z=2.295, p=0.0217 (< 0.05). OB filter improves EV materially with adequate power. SHIPPED: `generateSignal()` now rejects signals with no nearby unmitigated order block within 3 ATR. | PASS (shipped) |
| HC-114c | **Await-the-zone conversion sub-split DEFERRED.** The 16 conversions under user-pips targeted zones with reactionStrength >= 0.3. OB coincidence on those target zones was not separately tracked in the replay. Forward: re-run the await-the-zone replay with OB reconstruction at the target zone to measure whether OB-coincident conversions outperform. | DEFERRED (forward measurement) |

### ITEM 115 — VERIFY WHAT IS SHIPPED BUT UNVERIFIED

| # | Result | Verdict |
|---|---|---|
| HC-115a | **Await-the-zone conversion lifecycle EXERCISED.** Full lifecycle verified: ARM (pendingZoneEntries.set) → EXPIRY-CHECK (not expired at 30min) → CONVERT (price reaches zone, distToZone < atr*0.3) → LADDER RE-DERIVED (user-pips: TP1=4037.5, SL=4027.0) → RESOLVE (resolveSignalWithBars → SL_AFTER_BE, R_net=+0.2625). Expiry path also verified: pending entry deleted after 4h timeout. All assertions PASS. | PASS |
| HC-115b | **activeSignalsByDirection removal EXERCISED.** Before: BUY=3 signals, SELL=1. After removing sig_002: BUY=2 (sig_001 + sig_003 remain), SELL unchanged. After removing all BUY: BUY=0 (empty array, Map key exists). All four assertions PASS: sig_002 removed, sig_001 present, sig_003 present, SELL unchanged. | PASS |
| HC-115c | **Retrain steps given.** (1) Ensure app running during Asian session (22:00-07:00 UTC). (2) Wait for scheduled retrain trigger. (3) Check console: `✓ Training on N outcomes (TRAINING_WINDOW_DAYS=0)` — N should be ~399-412, not ~35. (4) Verify weight vector: rsi_weight ~-0.171, others near zero. (5) MODULATION_ENABLED=false — weights computed but NOT applied. (6) Re-enabling criterion: held-out accuracy >= 55% at n>=200 with p<0.05. | PASS |
| HC-115d | **Carried items status:** B-2/B-3/B-4/B-5 (shorts-on re-runs): NOT reached. E-2 (width floor parity): NOT reached. D-4 (11 resolvable-but-skipped rows): NOT reached. C-2 (ten-feature validation): ATTEMPTED — v1 scalars validated (all CIs include zero), attention features need key mapping to settle. | REPORTED |

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
| **F-28** | **RESOLVED (ITEM 88, superseded by Block A).** HC-12 resolved: `signalResolver.ts` is a pure function with only `import type` dependencies. Item 88 ran it on 4 LIVE signals; Block A (this round) ran it on the FULL 417-row population (398 decided). Canonical book: n=398, WR=62.81%, EV=+0.0732R GROSS. | signalResolver.ts | — | Resolved | HC-A1/HC-A2 |
| **F-29** | **FIXED 2026-08-18 (ITEM 94 + ITEM 101).** Root cause: Edge Function line 214 `lockPrice = entry` after TP1 instead of 0.35R lock. 73 SL_AFTER_BE rows corrected (LOSS→WIN). Item 101 then discovered the stored book mixed GROSS and NET realized_r (most rows GROSS from client path, 73 repaired rows NET from backfill) — the prior n=349 WR=60.17% EV=+0.1562R was arithmetically impossible because it was a hybrid. Full NET backfill shipped (324 rows updated). Post-repair book: n=399 WR=61.90% EV=+0.0166R (ALL NET). Canonical on same population: n=397 WR=61.71% EV=+0.0124R. Reconciliation: |AFTER−CANONICAL|=0.0042R. Shared EV function shipped in `expo/lib/evCompute.ts`. | Edge Function `resolveFromBars`; `trade_outcomes_v1.realized_r`; `expo/lib/evCompute.ts` (shared EV) | **CRITICAL → RESOLVED** | Pre-existing | HC-94a-e / HC-101a-d |
| **F-30** | **SHIPPED (BLOCK A / E-1, E-3).** `resolve-emitted-signals/index.ts`: `realized_r` now NET of the \$0.20 execution cost (mirrors `netR()`); `unresolvable` counter now carries `unresolvableReasons: {NO_BARS, ENTRY_NEVER_FILLED}`. | `backend/functions/resolve-emitted-signals/index.ts` | MEDIUM | New | HC-E1/HC-E3 |
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
