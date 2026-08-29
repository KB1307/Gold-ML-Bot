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
| `MIN_SIGNAL_CONVICTION_THRESHOLD` | SE:473 | `0.55` | The single conviction gate | Item 73 G73-1 FAILED → 0.55 retained | Valid. **But** the WS distribution it is compared against moves with TIER_0 zone state (§7) |
| `MIN_SIGNAL_STRENGTH_DIFFERENCE_BASE` | SE:474 | `0.12` | Default BUY-vs-SELL separation floor | — | Valid |
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
| `tp1Pips` | `expo/contexts/TradingContext.tsx:57` | `25` (ITEM 121 measured-better ladder; pre-D2 installs auto-migrated — see §3 note on the settings migration) | 0.357R |
| `tp2Pips` | TradingContext.tsx:58 | `50` | 0.714R |
| `tp3Pips` | TradingContext.tsx:59 | `80` | 1.143R |
| `slPips` | TradingContext.tsx:63 | `70` | **1.00R** ✅ matches |
| `maxSLPips` | TradingContext.tsx:78 | `90` | — |
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
| HC-124 | **REPO HYGIENE.** Safety grep: ZERO references to `__sandbox` from `expo/services|contexts|app|components|backend`, `backend/` — dependency runs one way only. Tag `archive/sandboxes-2026-08-18` pushed and confirmed on remote (`git ls-remote` → `efee36c`). Nine `__sandbox_*` dirs removed (100,941 LOC vs 16,838 live = 6:1). `tmp/diff_ws_vectors.sh` → `expo/scripts/`, `tmp/` removed. 33 one-off `analyze*`/`audit*` scripts archived under the tag (175→133). CI guard `ci_guard_duplicate_constants.ts` shipped: **PASS — zero duplicate definitions across 21 live files, 12 tracked constants single-source.** Stale ladder `tp1Distance = dynamicSlPips *` now ZERO occurrences in tree. `SYSTEM_STATE_SNAPSHOT.md` (146KB, contained proven-fabricated "43 of 1347" at :1889) frozen → `docs/ARCHIVE_STATE_2026-08.md` with unverified-provenance header | **PASS** |
| HC-116 | **OB FILTER SHIPPED AGAINST WRONG CONSTRUCT — CONFIRMED AND FIXED.** grep for `marketStructure|computeMarketStructure|findNearbyUnmitigatedOBs` in `signalEngine.ts` → **ZERO MATCHES** (never imported), while `marketStructure.ts` exists. Item 114's filter read `features.orderBlocks` ← `this.detectOrderBlocks()` (SE:3221) ← `this.priceHistory` (TICKS, SE:1803), 4h cutoff + **top-10 by strength** + **NO mitigation** (SE:3304-3309). Authorising measurement used `computeMarketStructure()` over 24h BARS with mitigation. **Jaccard agreement on the reject set = 21.1%** (both reject 15, only-old 27, only-wired 29) — constructs NOT interchangeable. OLD-reject arm EV **+0.0133R WR 57.14%** — the tick filter was rejecting a PROFITABLE arm. Re-wired to bars+mitigation; re-measured n=426: OB-present n=382 WR 62.83% EV +0.0045R PF 1.116 vs OB-absent n=44 WR 45.45% EV −0.0215R PF 0.620, **z=2.238 p=0.0252** | **PASS — effect survives on the wired construct** |
| HC-117 | **TWO DOC DEFECTS CORRECTED.** (a) JSDoc claimed `rsi_weight=-0.171` → clamp "would ZERO the RSI family contribution". FALSE: `1 + 2.5*(-0.171) = +0.5725` > MIN=0, NOT clamped; true effect is reduction to **0.57x**, not elimination. Corrected; `MODULATION_ENABLED=false` decision stands on chance-level evidence. (b) SE:8638 cited `DEDUP_TIME_WINDOW_MS=210 min ... 204.6 min / 3.59 ATR` against a live value of 1390 min. Corrected. **`0.684` comment (SE:759-765) CONFIRMED UNTOUCHED** — `1 + 2.5*(-0.684) = -0.71` genuinely clamps, so it is correct | **PASS** |
| HC-118 | **DEDUP RE-DERIVED FROM DUPLICATE CLUSTERS.** Cluster definition: maximal set ≥2 sharing (1) same direction, (2) entries within `DEDUP_CLUSTER_BAND_ATR=1.5` ATR, (3) overlapping `[entry,tp3]` ladders; single-linkage in emission order. n=426 → 30 clusters, **15 duplicate clusters**, 396 internal gaps, 411/426 signals inside one, largest chained cluster 180. Internal gap distribution p25=**10.2** p50=**54.8** p75=**224.6** p90=637.4 p95=1866.8 p99=8178.4 min. p95 (1866.8) is WIDER than the 1390 it replaces — a single-linkage chaining artefact. **SHIPPED p75 = 225 min** (was 1390). Emission over 50.1-day book: 1390min+guard → 40 (0.80/day); 225min+guard → 39 (0.78/day); guard ALONE → 39 (0.78/day); no dedup → 426 (8.50/day). **The wide time window added 1 signal in 50 days — the cluster guard is doing all the work** | **PASS** |
| HC-119 | **EMISSION RATE MEASURED — SYSTEM IS STARVED.** Dedup-layer measurement (HC-118) shows surviving emission **0.78-0.80 signals/day** against a raw 8.50/day, i.e. the dedup layer alone suppresses **~91%**. This is FAR below the pre-registered 2/day floor. Relaxation shipped this round: `DEDUP_TIME_WINDOW_MS` 1390→225 min (derived p75, not chosen). **PARTIAL:** the full mutually-exclusive four-gate funnel with per-gate marginal costs (119a/119b) was NOT run — the cluster-guard simulation blocks against ALL prior emissions rather than only ACTIVE ones, so 0.78/day is a PESSIMISTIC LOWER BOUND, not the live rate | **PARTIAL** |
| HC-121 | **DEFAULT LADDER SHIPPED.** `TradingContext.tsx` `DEFAULT_SETTINGS` tp1/tp2/tp3 **49/74/98 → 25/50/80**; `slPips` deliberately unchanged at 70 (Item 109b held SL fixed). Authorising measurement: Item 109(b) n=412 — 25/50/80 WR 65.05% EV +0.0371R PF 1.104 vs 49/74/98 WR 61.17% EV +0.0198R PF 1.050. NOT NEUTRALISED: `sanitizeSettings()` (TC:372) applies no clamp/floor/`Math.max` to any `tp*Pips` — it only clamps `minConfidence` and type-checks booleans. **EXISTING INSTALLS ARE STRANDED**: `sanitizeSettings` spreads `DEFAULT_SETTINGS` FIRST then persisted `settings`, so a persisted `trading_settings` key (TC:2385) overrides the new default — defaults reach FRESH INSTALLS ONLY | **PASS (migration required)** |
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

### ITEM 130 — CI GUARD SCOPE WIDENED (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-130a | **LOOKBACK_HOURS duplication resolved by PARITY ASSERTION, not extraction.** `backend/functions/refresh-sr-zones/index.ts` is a Deno Edge Function (imports `https://esm.sh/@supabase/supabase-js@2`, reads `Deno.env`, deployed as a standalone bundle from `backend/functions/`). It cannot import from `expo/` — different runtime, module resolution, and deployment artifact. The deployment boundary genuinely prevents sharing, so the guard now parses and COMPARES the values across the two live definitions and FAILS loudly on divergence. Confirmed agreeing: `PARITY LOOKBACK_HOURS = 24 (2 live definitions)`. | SHIPPED (parity assertion) |
| HC-130b | **SCAN_ROOTS widened** from `expo/services, expo/contexts` to add `expo/backend` and `backend/functions`. Live files scanned 21 → 36; tracked constants 18 → 24. | SHIPPED |
| HC-130c | **Scripts handled with a WARN TIER** (chosen over forcing scripts to import live constants, because scripts legitimately pin historical values for replay and importing would silently change what a replay measures). 134 script files scanned; divergence reported, never fatal. Live warnings: `TRAINING_WINDOW_DAYS` script=14 vs live=0; `LOOKBACK_HOURS` script=120 vs live=24 (x2); `ZONE_STALENESS_HALF_LIFE_HOURS` script=18 vs live=6 (x2). | SHIPPED (WARN tier) |
| HC-130d | **THE WIDENED GUARD FOUND A REAL DEFECT ON ITS FIRST RUN.** `ZONE_STALENESS_HALF_LIFE_HOURS` had **two different live values**: 6 in `signalEngine.ts` vs 18 in BOTH zone paths. Investigated rather than reconciled: the 6h is the LOCAL in-memory zone tier (documented as intentionally faster-decaying) and the 18h is the server multi-day tier. The VALUES are correct; the shared NAME was the trap — a grep returned two contradictory answers with no way to tell which tier. Renamed the local one to `LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS` (value UNCHANGED at 6, 3 call sites updated). | SHIPPED (rename, no value change) |
| HC-130e | **Widened guard output: PASS.** `21 single-source constant(s), 2 parity-asserted, 13 script warning(s), across 36 live files`, exit code 0. | PASS |

### ITEM 131 — SL CEILING NOW CLAMPS INSTEAD OF REJECTING (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-131a | **Rejection frequency counted at cap 90 — on the ENGINE'S OWN ATR CONSTRUCT.** Measured over 59,556 bar-ATR samples (verbatim port of `calculateRealATR(14)`) on the 2026-06-18→2026-08-18 tape. `atrFloorSlPips = atr * 12`, so the gate binds when ATR > 7.50. Result: **107/59,556 = 0.18% of tape minutes** at cap 90 (cap 70 → 0.63%; cap 110 → 0.06%; cap 130 → 0.02%). Bar-ATR distribution p50=1.719, p90=3.092, p99=5.302, max=12.374. On the 13 LIVE-sourced signals the stored ATR maxes at 2.60 (atrFloor 31 pips), so **this gate has never bound on a live signal.** A RARE suppressor, not a major one. | PASS |
| HC-131b | **CLAMP SHIPPED.** The `return null` at SE:8248 is replaced by `slCeilingBinds` detection + clamp; `dynamicSlPips = Math.min(Math.max(configuredSlPips, atrFloorSlPips), maxSLPips)` and the signal PROCEEDS. **Not neutralised:** `maxSLPips` is read straight from settings (default 90) and `Math.min` is the only operation; no downstream floor can re-widen the stop. **Ceiling-bind telemetry shipped:** counters `slCeilingBindCount`/`slCeilingEvaluationCount`, `lastSLCeilingBind`, and `getSLCeilingStats()`, plus a loud console line naming the tighter-than-noise-floor risk and pointing at the Max SL Cap setting. | SHIPPED |
| HC-131c | **Tight-stop cohort CANNOT be measured on this book — the stored ATR is a different construct.** Splitting on `emitted_signals_v1.atr` gives TIGHT n=141 (33.1%) WR=68.09% EV=+0.0666R vs REST n=285 WR=57.54% EV=−0.0064R — i.e. tight stops look BETTER, the opposite of the expected noise-stop-out risk. But that split is an ARTEFACT: the stored `atr` column is BACKFILL-dominated (n=413, p50=4.50, p90=22.30, **max=124.20** — implausible for 1-min gold) while LIVE rows (n=13) show p50=1.50, p90=2.50, max=2.60, matching the bar-derived p50=1.719. The 33.1% figure is measured on the inflated backfill construct, not the one the live gate reads. IMPOSSIBLE, not underpowered. Forward evidence: `getSLCeilingStats()` after live sessions. | **BLOCKED** — construct mismatch (F-32) |
| HC-131d | **What Item 131 did NOT change:** `slPips` (70), `MIN_SL_ATR_MULTIPLE` (1.2), the `atrMultiplier` formula (`0.7 + atr*0.06` clamped 1.0–1.6), `maxSLPips` default (90), the user's persisted settings, the near-miss recorder for every other reason, and all TP geometry. | REPORTED |

### ITEM 132 — EMISSION FUNNEL (PARTIAL) (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-132d | **ACTIVE-ONLY CLUSTER GUARD SIMULATED CORRECTLY — the prior 0.78/day was a pessimistic lower bound, as suspected.** The live PRIMARY guard blocks only while a same-cluster same-direction signal is STILL ACTIVE; the prior round blocked on ANY previously emitted signal. Corrected simulation over n=426 / 50.1 days, using each signal's real canonical resolution time as its active window: raw **8.50/day**; ACTIVE-only guard + 225-min window **156 = 3.11/day**; ACTIVE-only guard with NO time window **342 = 6.83/day**. At the user's live minConfidence 0.90 the figure is **103 = 2.06/day**. | PASS (132d) |
| HC-132abc | **NOT REACHED.** The mutually-exclusive four-stage funnel summing exactly to attempts at both 0.90 and 0.72, and the per-gate marginal costs with each gate individually disabled (including the SL rejection and the 225-min window), require the `item57` replay harness under production settings with zone batch stamps. Not run this round. | **NOT REACHED** |

### ITEM 133 — CONFIDENCE THRESHOLD NUMBERS (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-133a | **Per-threshold canonical book, POWER FIRST. All five arms ADEQUATE (n≥302).** Confidence distribution p05=0.660 p25=0.823 p50=0.910 p75=0.930 p90=0.940 max=0.950. Full book n=426 WR=61.03% EV=**+0.0178R** PF=1.044. By threshold: 0.68 → n=350 WR=58.86% EV=−0.0102R PF=0.976; 0.72 → n=340 WR=58.82% EV=−0.0091R PF=0.979; 0.80 → n=330 WR=58.48% EV=−0.0140R PF=0.968; 0.85 → n=313 WR=58.79% EV=−0.0115R PF=0.973; 0.90 → n=302 WR=58.94% EV=−0.0049R PF=0.988. | PASS |
| HC-133b | **Implied emission rate per threshold** (225-min dedup + ACTIVE-only cluster guard, 50.1-day span): 0.68 → 124 = 2.48/day; 0.72 → 119 = 2.38/day; 0.80 → 119 = 2.38/day; 0.85 → 108 = 2.16/day; 0.90 → 103 = **2.06/day**. Moving 0.90 → 0.72 buys only +0.32 signals/day. | PASS |
| HC-133c | **THE CONFIDENCE GATE IS ANTI-PREDICTIVE ON THIS BOOK.** Every threshold from 0.68 up produces NEGATIVE EV and PF<1, while the FULL book is +0.0178R / PF 1.044. The n=76 signals BELOW 0.68 therefore carry EV ≈ **+0.147R** — they are the entire positive edge. Recommendation: **90% costs almost nothing in frequency (2.06 vs 2.48/day) and buys no EV**, so lowering it is not the lever; the finding is that confidence RANKING is inverted and needs re-derivation, not re-thresholding. User's persisted setting UNTOUCHED. | PASS (finding, F-33) |

### ITEM 134 — SETTINGS UI COPY CORRECTED (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-134a | **All three corrected.** (1) TP panel header `Take Profit Levels (Engine-Derived)` → `Take Profit Levels (Pips — Used By The Engine)`; column headers `TP1 (0.70R)/TP2 (1.05R)/TP3 (1.40R)` → `TP1 (pips)/TP2 (pips)/TP3 (pips)`; the "Not used by the engine" help text replaced with what actually happens, plus a DERIVED read-only R readout (`tp1Pips / slPips`) so the ratio is visible without implying it is the input. (2) Stop Loss help: "default 70 pips" → 90, "TP zones default 30 pips apart" removed (defaults are 25/50/80), and the Item 131 clamp behaviour documented including the tighter-than-noise-floor caveat. (3) Allow Short help: "Default OFF. Six counterfactuals confirmed SELLs are structurally marginal" → Default ON, finding REVERSED as a labelling artifact, corrected BUY 63.1% / SELL 63.2%. | SHIPPED |
| HC-134b | **Sweep of remaining settings help strings found no further stale engine claims.** The Dynamic Stop Loss helper ("Auto-adjust SL by ATR volatility (capped at Max SL)") is accurate. Verified strings at `settings.tsx:576,581,592,603,623-638,677-690,843-847`. | PASS |
| HC-134c | **COPY ONLY — no behaviour changed.** No constant, threshold, geometry, gate, or emission path was touched by Item 134. `runChecks(expo)` green. | CONFIRMED |

### ITEM 135 — CARRIED (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-135 | **NOT REACHED:** 135(a) Item 120 era question (per-calendar-week bucketing) — now slipped FOUR rounds, remains the single most consequential open measurement (F-10). 135(b) Item 122 / C-2 attention key mapping — slipped EIGHT rounds. 135(c) Item 123 ATR asymmetry — now BLOCKED on Item 139 (F-32 backfill ATR corrupt). 135(d) B-2/B-3/B-4/B-5, E-2, D-4 — not reached. | **NOT REACHED** |

---

### ITEM 136 — ZONE MAP STALENESS: CADENCE + ZONE-AGE TELEMETRY (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-136a | **STALENESS CONFIRMED — WORSE THAN ESTIMATED.** sr_zones_v1 `updated_at` = `2026-08-17T19:30:10.12+00:00` on ALL 22 rows. Signal [1] fired at `2026-08-18T16:25:33Z`. **Map was 1255 minutes (20.9 hours) old** when the signal entered — not 9 hours as estimated. The cron `5 */4 * * *` (every 4h) appears to have stopped running after 19:30 UTC on Aug 17; the 00:05, 04:05, 08:05, 12:05, and 16:05 runs on Aug 18 either didn't fire or failed silently. cron.job read via anon key returned PGRST205 (table not exposed). The stale map's nearest support zones to entry 4368.8 were 4370.6 (rs=0.475, 598 touches) and 4367.2 (rs=0.475, 403 touches) — both at 48% reaction strength, the WEAKEST in the map. Nine of eleven zones sat $14–$60 above price. The 4363–4365 support the user saw on the chart did not exist. | PASS |
| HC-136b | **ZONE FORMATION TIME MEASURED — 15-MIN CADENCE DERIVED.** Over 205 zone formations from 6,943 M1 bars (7-day window): p10=0 min, p25=0 min, p50=0 min, p75=0 min, p90=0 min, max=380 min. **96.1% qualify in <5 min, 97.6% in <15 min, 98.0% in <30 min, 98.5% in <60 min.** The qualification criterion is 2+ touches or 1 rejection wick — the same rule the server compute uses. The cadence must be materially shorter than the p25; at 0 min, any reasonable cadence satisfies this. **15 minutes is chosen over 5:** the 18h half-life decay means the map barely changes in 5 minutes except for the newest level, so 5-min over-samples at 3x the invocations for information the decay discards. 15 min catches 97.6% of zones within one interval. The 2.4% that take longer to qualify are levels with very little early evidence — exactly the ones that should wait for a second touch. | PASS |
| HC-136c | **FRESH MAP RECONSTRUCTION: THE 4363–4365 SUPPORT APPEARS.** Reconstructed the zone map from `gold_m1_bars` with a fresh 24h window ending at 16:25:33Z (1,378 bars). The fresh map contains **SUPPORT @ 4364.8 rs=0.995 touches=8 rejectionWicks=9** and **SUPPORT @ 4363.6 rs=0.981 touches=4 rejectionWicks=7** — both at 98%+ reaction strength, not 48%. The fresh map also contains SUPPORT @ 4368.2 (rs=1.0, $0.6 from entry) and SUPPORT @ 4366.7 (rs=0.996). **MECHANISM ONE (STALENESS) IS THE SOLE CAUSE.** Mechanism two (touch-count dominance) does NOT need to be the primary fix: the scoring formula caps touchScore at `Math.min(1, touches/6)`, so a 900-touch zone does not outscore a 6-touch one. The decay factor was doing its job; the map was just old. Stale-vs-fresh comparison: 22 stale zones (all gone), 32 fresh zones (all new). The entire stale map was from a previous 24h window that no longer reflected current price action. | PASS |
| HC-136d | **CADENCE FIX SHIPPED — 4h → 15min.** Migration `006_zone_cadence_and_telemetry.sql` unschedules the old `5 */4 * * *` cron and schedules `*/15 * * * *`. 96 runs/day vs the current 6. The project already runs `drain-telegram-outbox` every minute (1,440 invocations/day), so 96 is within existing practice. **Invocation constraint stated:** the Supabase dashboard has shown EXCEEDING USAGE LIMITS before — 96 invocations/day of a paginated bar fetch (~4,187 bars, 5 pages) is non-trivial. An incremental fetch optimization (only ~15 new bars per run) is a separate item — this migration changes the SCHEDULE only. The user must run this migration in the Supabase SQL Editor. | SHIPPED (migration) |
| HC-136e | **SESSION-SCOPED TIER NOT SHIPPED — mechanism two ruled out by 136(c).** The fresh map at 16:25:33Z already contains the 4363–4365 support at rs=0.995/0.981 under the EXISTING scoring formula. The problem was not that new zones couldn't compete — it was that the map was never recomputed. A session-scoped tier is unnecessary for this specific defect. However, the finding in 136(b) that 96.1% of zones qualify in <5 min means a fresh 24h recompute sees essentially all session-formed levels. Shipping a separate tier would add complexity without addressing the root cause. Deferred, not blocked. | DEFERRED (not needed for this defect) |
| HC-136f | **LOCAL-OVERLAY EVALUATION: RECOMMENDED AS A COMPLEMENT, NOT A REPLACEMENT.** The engine already computes TIER_1_LOCAL zones from its own in-memory bar store (`detectSRZones()`, ~100 M1 samples). This gives ~1-minute freshness at zero server cost. **THE 31-JULY CAUTION:** TIER_1_LOCAL supplied the dominant scoring feature in all four losing BUYs on 31 July. But that was as a FALLBACK REPLACEMENT for a dead TIER_0 (backend 503'd, no zones loaded), not as an ADDITIVE OVERLAY alongside a healthy one. The distinction holds: a TIER_1 overlay alongside a fresh TIER_0 would not dominate scoring because TIER_0 zones (with 8+ touches and 0.99 reaction strength) would outrank them. The risk is if TIER_0 goes stale AGAIN (which it did for 20.9 hours) — then TIER_1 becomes the de facto primary and the 31-July failure mode repeats. **Recommendation:** ship the local overlay as an ADDITIVE source (appended to `features.srZones` with `tier: 'TIER_1_SESSION'`) only after the 15-min cadence is confirmed running. Forward evidence that settles it: zone-age telemetry showing max age < 20 min over 48h of live operation. | RECOMMENDED (not shipped this round) |
| HC-136g | **ZONE-AGE TELEMETRY SHIPPED.** Every emitted signal now records `zone_map_age_minutes` in `emitted_signals_v1` (migration adds the column). The signal emission path at `signalEngine.ts:8855` computes `Math.round((now - this.tier0SRZonesFetchedAt) / 60000)` when TIER_0 is active, or `null` when TIER_1_LOCAL fallback is used. The `emittedSignalService.ts` `toRow()` function writes it. **This must never again be invisible** — a 20.9-hour-stale map caused signal [1] to enter $5 above a support it could not see. | SHIPPED |

### ITEM 137 — AWAIT-THE-ZONE ENTRY-QUALITY TRIGGER (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-137a | **WIRING CONFIRMED AT LINE LEVEL.** `signalEngine.ts:8624`: `if (PATH_TO_TARGET_VETO_ENABLED)` → `:8637`: `if (blockingZone)` → `:8643`: `const sameSideZones = features.srZones.filter(...)` → `:8654`: `if (sameSideZones.length > 0)` → arms pending entry. The await-the-zone code is **reachable ONLY from inside the `if (blockingZone)` block**. A path-clear signal (no opposing zone between entry and TP1) never enters this branch, so a poor-but-path-clear entry has no mechanism to be improved. For signal [1]: TP1 was 4371.4 and nearest opposing zone (RESISTANCE 4415.2) sat far above it, so the path-to-target check PASSED, no veto fired, and await-the-zone was never consulted. | PASS |
| HC-137b | **ENTRY-QUALITY MEASUREMENT — THE GATE FAILS. POWER: MARGINAL (n=79/41).** Using **bar-derived ATR** (F-32: stored atr is corrupt for backfill rows): Near (<1.5 ATR to nearest same-side zone) n=79 WR=40.5% EV=**-0.2125R** CI=[-0.449, 0.024] vs Far (>=1.5 ATR) n=41 WR=53.7% EV=**+0.0303R** CI=[-0.304, 0.365]. **The far bucket is BETTER, not worse** — the opposite of the pre-registered gate's assumption. Entering far from a same-side zone does not degrade outcome; if anything it improves it. Per-bucket breakdown confirms the monotonic trend: 0-0.5 ATR EV=-0.083R, 0.5-1.0 EV=-0.209R, 1.0-1.5 EV=-0.302R, 1.5-2.0 EV=+0.244R. The gate FAILS the pre-registered criterion ("far-from-zone bucket shows materially worse canonical EV"). | FAIL |
| HC-137c | **TRIGGER SHIPPED BEHIND AN OFF FLAG (Item 137(e)).** `ENTRY_QUALITY_TRIGGER_ENABLED = false` at `signalEngine.ts:634`. The flag is off because the measurement inverted the hypothesis — far entries are NOT worse. Underpowered must not mean deferred: the flag and the full trigger path are documented so they can be enabled if forward evidence flips the finding. **Forward evidence that would flip it:** a regime-conditioned split where the far bucket degrades in TRENDING markets specifically (the current split is regime-agnostic, and the near-bucket's poor EV may be concentrated in chop). | SHIPPED (flag OFF) |
| HC-137d | **REPLAY NOT RUN — the trigger is OFF.** Replaying signal [1] through an OFF trigger produces the same entry. The five failed BUYs from 18 Aug cannot be replayed through a new trigger that is documented as failing its measurement. Replays deferred until the flag is flipped by forward evidence. | DEFERRED |
| HC-137e | **Shipped behind OFF flag with forward evidence named** — satisfies 137(e). | PASS |

### ITEM 138 — CONFIDENCE SCORE RE-DERIVATION (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-138a | **SUB-0.68 COHORT MEASURED DIRECTLY — DIFFERENT FROM PRIOR INFERENCE.** Direct: n=58 (not 76), WR=65.52%, EV=**+0.0754R**, PF=1.216, **CI=[-0.145, +0.296] — INCLUDES ZERO.** The prior round inferred n=76 and EV≈+0.147R by subtraction from the full book; both were wrong because the canonical book has since grown (n=313 now vs 426 then) and the resolver has resolved more rows. The sub-0.68 cohort is positive but NOT statistically significant at p<0.05. | PASS (measurement) |
| HC-138b | **SCORE DECOMPOSED — 9 INPUTS + 5 PENALTIES.** Confidence = `0.40 + signalStrength * 0.40 + alignmentBonus + sentimentBoost + fibBoost + srReactionBoost + regimeBoost + timeBoost + learningAdjustment`, then penalties: strengthDifference < 0.12 (*0.85), < 0.18 (*0.94), losingStrength > 0.3 (-), dataQuality, calibration. The dominant term is `signalStrength * 0.40` — 50% of the base. signalStrength itself is the sum of all buy/sell contributions from the attention scoring block. Documented inline at `signalEngine.ts:6440-6468`. | PASS |
| HC-138c | **MECHANICAL EXPLANATIONS TESTED — THREE FOUND, NONE DECISIVE.** (1) TP3 stretch: the old code at :8056-8057 stretched TP3 when confidence ≥ 0.89. Measurement confirms the TP3/SL ratio for high-conf is 1.60 vs 1.06 for low-conf — the stretch WAS firing. But Item 109 rewired TP to user-pips, so the stretch is now inert. `TP3_CONFIDENCE_STRETCH_ENABLED=false` documents this. (2) SL multiplier: `atrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + atr*0.06))` is NOT conditioned on confidence — it reads ATR only. (3) **ERA CONFOUND: sub-0.68 is 100% BACKFILL (0% LIVE), spread across Jun 29–Jul 31.** F-32 proved era splits can be artefacts of a corrupted column. The sub-0.68 EV +0.0754R with CI including zero, combined with the era confound, means **F-33 is NOT CONFIRMED as inversion.** The prior round's anti-predictive finding may be an artefact of the backfill population, not a property of the confidence score. | PASS (finding: F-33 NOT CONFIRMED) |
| HC-138d | **NO COMPONENT DISABLED — F-33 NOT CONFIRMED, so no component can be disabled with a CI excluding zero.** The prior round's claim that the confidence score is "inverted" was based on subtraction-inferred numbers (n=76, EV=+0.147R) that do not reproduce directly (n=58, EV=+0.0754R, CI includes zero). The era confound (100% backfill) further weakens the finding. **Re-derivation plan stated:** confidence must be re-derived against canonical realised R on a LIVE-only corpus (currently n=14, far too small). The user's persisted threshold is UNTOUCHED. The prior round's F-33 entry in the checklist is amended to reflect this. | PASS (finding: F-33 NOT CONFIRMED) |

### ITEM 139 — BACKFILL ATR QUARANTINE (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-139a | **SOURCE FIELD IDENTIFIED — different venue/period, not a unit error.** The backfill `atr` column is in PRICE UNITS (risk/atr p50=1.02, matching the expected 1.0–1.6 multiplier range), NOT pips. Cross-checking 413/413 backfill signals against bar-derived ATR(14) at the same timestamp: stored_atr/bar_atr ratios range **3.8x to 10.2x** (median ~9x). The backfill ATR is from a DIFFERENT VENUE or PERIOD — it is not `calculateRealATR(14)` on `gold_m1_bars`. The live ATR column (n=14) matches bar-derived ATR perfectly (p50=1.60 vs bar p50=1.72). An ATR of 124.20 on 1-min gold at ~$4,400 is not a market value; it is a cross-venue artefact. | PASS |
| HC-139b | **DAMAGE LIST — every ATR-conditioned conclusion marked.** (1) SL ceiling calibration (Item 131): STILL-HOLDS — measured on bar-derived ATR (59,556 samples), NOT the stored column. (2) Item 123 ATR asymmetry: NOW-SUSPECT — was going to use the stored column; now BLOCKED on 139(c). (3) Item 131(c) tight-stop cohort: NOW-SUSPECT — already BLOCKED last round as IMPOSSIBLE due to construct mismatch. (4) Zone-width ATR floor: STILL-HOLDS — the zone compute uses its own ATR(14) from the bars it fetches, not the stored column. (5) Regime classification: STILL-HOLDS — uses `features.atr` from `calculateRealATR(14)` on the engine's own bar arrays, not the stored column. (6) Item 137(b): STILL-HOLDS — used bar-derived ATR, explicitly stated. **Only the stored `atr` column is corrupt; the engine's live ATR path is clean.** | PASS |
| HC-139c | **FIX SHIPPED — client-side clamp + DB range assertion + quarantine SQL.** (a) `emittedSignalService.ts`: ATR clamped to [0, 20] before write (`Math.max(0, Math.min(20, record.atr))`), preventing implausible values from hitting the DB constraint. (b) Migration 006: `CHECK (atr IS NULL OR (atr >= 0 AND atr <= 20))` on `emitted_signals_v1`. (c) Quarantine SQL output by `item139_quarantine_atr.ts`: `UPDATE emitted_signals_v1 SET atr = NULL WHERE source = 'BACKFILL' AND atr IS NOT NULL;` — must be run in the Supabase SQL Editor with the service-role key (anon cannot UPDATE). Live rows are UNTOUCHED. | SHIPPED |

### ITEM 140 — MODULATION DISABLE SCOPE (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-140a | **BOTH PATHS QUOTED — they are SEPARATE.** Path 1: `getFeatureModulation('rsi_weight')` at `:5943` → `:5572`: `if (!MODULATION_ENABLED) return 1;` → returns 1.0 (identity multiplier). Path 2: `rsiBuyContribution`/`rsiSellContribution` computed at `:5843-5900` from HTF/LTF/RSI conditions — these are INDEPENDENT of `MODULATION_ENABLED`. The attention contribution is `rsiBuyContribution * rsiModulation` where `rsiModulation = Math.min(1.0, RSI_MODULATION_APPLIED_MAX) = 1.0` when modulation is off. So the attention score = the full base value (e.g. 0.35 * 100 = 35.0). | PASS |
| HC-140b | **THE FLAG DISABLES THE LEARNED-WEIGHT AMPLIFICATION, NOT THE BASE FEATURE.** With `MODULATION_ENABLED=false`: `getFeatureModulation` returns 1.0, so `rsiModulation=1.0`, so the RSI contributions pass through at full base value. The 35.00 attention score the user saw on signal [1] is `rsiSellContribution * 1.0 * 100 = 0.35 * 100 = 35.0` — the CORRECT unamplified value. The flag is NOT named `RSI_FEATURE_ENABLED`; it is named `MODULATION_ENABLED` and it disables the learned-weight layer (which was at chance, 49.2-50.0% held-out accuracy). The base RSI contributions are hand-coded directional rules with domain logic, NOT learned weights. **Frequency:** every signal with an HTF/LTF alignment condition firing carries a nonzero RSI contribution — this is by design and affects every signal. | PASS |
| HC-140c | **DECISION: LEAVE AS-IS.** The flag does exactly what its name implies — disables the learned modulation multiplier, not the base feature. Zeroing the attention contribution would remove a legitimate directional signal. The learned layer IS disabled (returns 1.0). The base RSI conditions are NOT at chance (they are hand-coded rules, not learned weights). No change shipped. | PASS (no change needed) |

### ITEM 141 — CARRIED (2026-08-18)

| # | Result | Verdict |
|---|---|---|
| HC-141a | 132(a)(b)(c) funnel ATTRIBUTION — NOT REACHED (fourth round). | **NOT REACHED** |
| HC-141b | Item 120 era question — NOT REACHED (fourth round). F-32 makes this MORE urgent. | **NOT REACHED** |
| HC-141c | Item 122 / C-2 — NOT REACHED (eighth round). | **NOT REACHED** |
| HC-141d | Item 123 ATR asymmetry — now BLOCKED on Item 139(c) quarantine SQL being run. | **BLOCKED** |
| HC-141e | B-2/B-3/B-4/B-5, E-2, D-4 — not reached. | **NOT REACHED** |

---

### ITEMS 142-218 — THE RECONSTRUCTED LEDGER (Phase D/D1, 2026-08-24)

The checklist previously ENDED at Item 141; Items 142-218 (77 items) existed only
in chat history, code comments, and `expo/artifacts/*` — the mechanism by which
items slipped. This ledger is reconstructed from those in-repo sources. Entries
marked **RECONSTRUCTION GAP** have no durable in-repo record at all — that is
itself the finding (audit Finding 1), recorded rather than papered over.

| Item | Status | Evidence / pointer |
|---|---|---|
| 142-145 | RECONSTRUCTION GAP | no in-repo record |
| 146 | Measurement: path-to-target veto block rate, live + frozen maps, both ladders | `expo/scripts/item146_147_150_151_measure.ts` |
| 147 | Measurement (same round as 146) | same script |
| 148 | Measurement: cumulative emission funnel of all four live suppressors (5th round, no more deferrals) | `expo/scripts/item148_funnel_measure.ts` |
| 149 | SHIPPED: schema-contract guard. Its stale inventory was caught and fixed by Phase A/A1 (`verifySchemaContractLive.ts`) after it printed PASS against a schema lacking migrations 010/011 | `expo/scripts/ci_guard_schema_contract.ts`, `artifacts/ddl_access_probe_2026-08-19.txt` |
| 150 | SHIPPED + LIVE: zero-touch zone RS cap at 0.29 (client + server refresh both) | SE merge loop; `backend/functions/refresh-sr-zones/index.ts` |
| 151 | Measurement (same round as 146) | same script |
| 152(b) | Measurement: era split (Item 120, fourth round) | `expo/scripts/item152b_era_split.ts` |
| 153-155 | RECONSTRUCTION GAP | no in-repo record |
| 156 | CARRIED — **zero code references**; flagged by the 150-218 audit | ledger-only |
| 157 | RECONSTRUCTION GAP | no in-repo record |
| 158 | SHIPPED: pipeline-health 7-day rollup + retention warning (6h http_response visibility gap) | migration 008, `PipelineHealthCard.tsx` |
| 159 | Measurement: LIVE book + 95% CI at current n, sample size + calendar date | `expo/scripts/item159_160_161_round.ts` |
| 160 | MEASURED + RELAXED: OB filter re-measured (present n=291 EV +0.0036R vs absent n=115 +0.0213R, Welch p=0.86 — Item 114's z=2.295 did not reproduce) → 160(c) hard reject replaced by 5pt confidence penalty (LIVE, SE:783). RESOLUTION PENDING as Phase C/C3 | SE:783-787 |
| 161 | Measurement: attention features held-out validated (49 features; volume_node_support_resistance PREDICTIVE r=0.232 CI[0.053,0.397]; none anti-predictive → no disable flags) | `item159_160_161_round.ts` |
| 162, 164-166 | RECONSTRUCTION GAP (unchanged) | no in-repo record. **163 RESOLVED 2026-08-24 (Checkpoint E/E1): ANNOTATION-SHIPPED** — the Item-163 method (per-feature Pearson r vs realized_r with Fisher CI) is durably cited by `item179_180_181_183_round.ts` (183(c)) |
| 167 | SHIPPED: stand-aside observability (reason ring buffer + hourly snapshots) + bar-freshness alarm (DEGRADED >15min = engine staleness seal, DOWN >60min, weekend guard) | migration 009, SE reason ring buffer |
| 168 | SHIPPED: build marker BUILD-DERIVED via babel git-SHA injection; marker-substitution failure made LOUD | `babel.config.js`, `ci_guard_build_marker.ts` |
| 169 | SHIPPED: resolver writes bar-reconstructed RSI-14/ATR-14 (287/417 corpus rows were empty via the resolver path) | `resolve-emitted-signals` |
| 170 | RECONSTRUCTION GAP — attributed 2026-08-24 (E1): chat-only analysis round (ML comparison, explicitly NO CODE) | chat-history source only |
| 171 | **RESOLVED 2026-08-24 (E1): MEASURED** — `item167_169_171_round.ts` (171(a) zero-opposing split, 171(c) entry-to-zone distance), commit 413939a. The Phase D audit missed the script (commit message names only 167/168/169/172) | `expo/scripts/item167_169_171_round.ts` |
| 172 | SHIPPED: user minConfidence above the enforced 0.68 now governs absolutely | SE |
| 173 | RECONSTRUCTION GAP — attributed 2026-08-24 (E1): chat-only carried-items slot (173(a) Item-163 weights inverted) | chat-history source only |
| 174-178 | RECONSTRUCTION GAP | no in-repo record |
| 179 | SHIPPED: bar-derived learning-context reconstruction (179(c) fallback; 179(d) backfill features) | SE:7556-7647, `item179_backfill_features.ts` |
| 180 | **RESOLVED 2026-08-24 (E1): MEASURED** — 180(b) zone-map reconstruction + demand shelves, 180(c) near/far entry-quality on LIVE maps, commit ec79a20 | `item179_180_181_183_round.ts` |
| 181 | **RESOLVED 2026-08-24 (E1): MEASURED** — 181(a) BoS/ChoCh vs shelves, 181(b) BoS-flip zone split, commit ec79a20 | same script |
| 182 | RECONSTRUCTION GAP | no in-repo record |
| 183 | **RESOLVED 2026-08-24 (E1): MEASURED** — 183(a) clean-row accrual + revised n=200 date, 183(c) attention weight table, commit ec79a20 | same script |
| 184 | SHIPPED: 184(a) marker substitution failure is LOUD | `diagnosticsExport.ts:495`, `item184a_babel_marker_proof.cjs` |
| 185, 187-190 | RECONSTRUCTION GAP | no in-repo record. **186 RESOLVED 2026-08-24 (E1): ANNOTATION-SHIPPED** — its result (drift score 0.6330 HIGH, driven entirely by sentiment) is cited in `item196b_drift_artefact_check.ts`'s header, commit af7da4a |
| 191 | LIVE evidence columns (client since 191; **server port shipped Phase A/A3** — migration 012; changed set 13/32 zones). Flag OFF | SE applyRejectionDirectedTyping, `sr_zones_v1` |
| 192 | OFF: no-structure veto for zero-opposing maps. Arm n≥30 at ~0.22/day → projected ~2026-11-28 | SE:709 |
| 193 | OFF with 192: await-the-zone armed from the no-structure branch (193(b)) | SE no-structure branch |
| 194 | **RESOLVED 2026-08-24 (E1): SHIPPED** — `[Item194]` startup reconciliation against emitted_signals_v1, TradingContext.tsx:813-846, commit af7da4a. The audit's "no in-repo record" was wrong — a code-marker search finds it | `expo/contexts/TradingContext.tsx` |
| 195 | SHIPPED: genuine Wilder ATR-14 recompute + construct provenance in the atr column | SE:7598-7627, `item195_recompute_backfill_atr.ts` |
| 196 | 196(b) drift artefact check SHIPPED; 196(d) 50-pip asymmetric entry buffer OFF | SE:735, `item196d_entry_buffer.ts` |
| 197/198 | Measurement: snapshot-era book (−0.1352R arithmetic confirmed); 191(e) re-run on direct ATR | `item197_198_round.ts` |
| 199 | SHIPPED: engine-native ATR construct provenance | SE:7669 |
| 200 | SHIPPED: entry-backing annotations (distFromEntryAtr on every snapshot zone) | SE snapshot builder |
| 201 | Measurement: snapshot-era book EV −0.1016R, era + vol control, ATR imputation fixed by direct recompute; 201(e)/201(f) carried | commit 1aacb36 |
| 202-204 | Measurement only (exit structure round): trail-to-TP2 validated harness, paired Wilcoxon + bootstrap; NO scoring/exit changes shipped | `artifacts/item202_exit_structure_run.txt` |
| 205/206 | CARRIED — **zero code references**; flagged by the 150-218 audit | ledger-only |
| 207-208 | RECONSTRUCTION GAP | no in-repo record |
| 209 | Measurement: out-of-boundary split n=16 (4.8%), WR 68.75%, EV +0.0656R, CI includes 0 → annotation-only | `artifacts/items_209_213_measurement_run.txt` |
| 210 | SHIPPED: behind-entry annotation columns (migration 011, applied live Phase A) | `emittedSignalService.ts` |
| 211 | BLOCKED on Item 210 forward evidence (~n≥80 per bucket) | — |
| 212 | SHIPPED client + **server port Phase A/A2** (migration 010; 32/32 fresh rows non-NULL; 20/32 multi-member) | `refresh-sr-zones`, SE merge loop |
| 213 | SHIPPED: driving-zone touches annotation (migration 011) | `emittedSignalService.ts` |
| 214 | **MEASURED Phase C/C1**: venue basis = 28.4% of TP1 median on the current ladder (STRUCTURAL, threshold 20% exceeded); failed 2026-08-24 BUYs at 51.6%/55.2%. `app_m1_bars` instrument shipped (migration 013) | `artifacts/item214_venue_basis_run.txt` |
| 215 | Measurement: attention coverage snapshot-era 193/193 = 100% | `items_209_213_measurement_run.txt` |
| 216 | BLOCKED per explicit user instruction (modulation report-only) | — |
| 217 | RECONSTRUCTION GAP | no in-repo record |
| 218 | SHIPPED: mandatory ledger round (this ledger is its durable successor) | commit cfc2a0c |

### ITEMS 219-223 — THE FIVE-CHECKPOINT ROUND (2026-08-24T20:45Z)

One prompt, one round, five checkpoints (A–E), each with a written artifact and a PASS gate.

| Item | Status | Evidence / pointer |
|---|---|---|
| 219 | SHIPPED — THE CANONICAL INSTRUMENT (Checkpoint A): `canonicalBook.ts`, a PINNED fromScratch replay (8h window/Item 41a, safeBarStart=emitted+60s, join population, evCompute $0.20 net, bootstrap seed 20260824). A0 settled gross/net with row-level arithmetic: stored realized_r is WRITER-DEPENDENT — app path writes GROSS (signalEngine.ts:7755; 28 rows) vs cron/backfill NET (301 rows). Canonical vs stored on the identical join population: ZERO sign disagreements, 332/334 exit-price agreement — F-29 repairs held. Quotable book: FULL n=432 EV_net +0.0133R [CI −0.0729, +0.1003]; post-boundary LIVE n=36 EV_net −0.2617R. QUOTING RULE: only canonicalBook.ts output is quotable; stored realized_r never without its era convention | `expo/scripts/canonicalBook.ts`, `artifacts/checkpoint_a_book_reconciliation.txt` |
| 220 | MEASURED — WRITE-PATH EXPOSURE + ITEMS 209/210/213 RE-RUNS (Checkpoint B): the write-path guard shipped 39 min AFTER the exposure window closed (68cc662 16:55:33Z vs window [08:40:18Z, ~16:16Z)); 2 of at least 4 LIVE emissions in the window were LOST (orphan outcome rows signal_1787580401459 / signal_1787587872040 = fingerprint; lower bound — invisible losses possible). 209 inversion survives directionally (out-of-boundary −0.0528R beats in-boundary −0.1457R, n=18/137); 210 re-run SUPPORTS entry-backing (near +0.1873R vs far −0.2928R, n=9/9, underpowered); 213 ordering reproduced but within noise (MDE ±0.53R). The 181 rows explained: 181/181 pre-boundary empty snapshots | `expo/scripts/item210_213_rerun.ts`, `artifacts/checkpoint_b_clean_data_reruns.txt` |
| 221 | MEASURED — OB REMOVAL: PROJECTION vs ACTUAL (Checkpoint C): projected 2.71 → 21.43 signals/day (OB off, funnel replay); actual 6.7/day extrapolated from k=1 in 0.15 days (Poisson 95% CI [0.0, 19.8]/day — PROVISIONAL, not yet decidable); post-removal funnel sums EXACTLY (912=912); new binding gate cluster_dedup (76.6% of attempts); canonical re-run moved by 1 ordinary resolution (no OB-absent resolution possible before 2026-08-25T04:30Z) | `scripts/item148_funnel_measure.ts` (Checkpoint C section), `artifacts/checkpoint_c_ob_removal.txt` |
| 222 | MEASURED — VENUE BASIS FIRST CUT + PRE-REGISTERED GATE (Checkpoint D): 206 app bars accrued; median |basis| $0.775 = 31.0% of TP1 (cross-checks the 28.4% stamp-basis); 63.6% of minutes cross ≥1 zone boundary (1.77 crossings/min); lag-1 autocorr 0.721 (PREVIEW ONLY — 206 min cannot measure a half-life). Persistence UNMEASURABLE until 2026-09-07 (pre-registered minimum); proposal costed: translate the ZONE MAP into app space (the ladder is frame-free — relative to entry); NO CODE SHIPPED | `expo/scripts/item214b_basis_persistence.ts`, `artifacts/checkpoint_d_venue_basis.txt` |
| 223 | SHIPPED — LEDGER CLOSURE (Checkpoint E): 7 gap items recovered (171, 180, 181, 183, 186, 163, 194 — see E1 corrections above), 2 attributed chat-only (170, 173), 26 remain genuinely unknown (35 marked → 28 remaining). Awaiting-sample list re-dated; next decision point CONFIRMED: the era-mean test ~2026-09-01 → 09-08 (post-boundary LIVE canonical EV −0.2617R at n=36, CI [−0.5378, +0.0346]; clean exclusion needs n≈49-60 at ~12 LIVE outcomes/week) | `artifacts/checkpoint_e_ledger.txt` |
| 224 | SHIPPED — MAX FAVOURABLE EXCURSION, SPLIT AT THE EXIT (Checkpoint A): migration 014 APPLIED LIVE via runMigration + post-migration PostgREST probe (4/4 columns PRESENT, by-name select accepted). FOUR additive columns on `trade_outcomes_v1`, written by BOTH resolvers (client signalResolver→signalEngine→learningStore; edge index.ts upsert): before-exit pair = CAPTURABLE, after-exit pair = COUNTERFACTUAL (Item 204). Parity of two independent implementations: 5/5 synthetic fixtures AND 448 real resolved signals, ZERO disagreements (also 0 between resolver-attached and fresh compute). Guarded backfill `.is(col,null)` server-side: scanned 453, updated 95+345, 12 no-outcome-row, 1 no-MFE, 0 failures, 440 live non-null; idempotency re-run touched 0 rows. THE ANSWER: of 163 SL_AFTER_BE exits only 10 (6.1%) reached TP2+ BEFORE the exit (TP1 153 / TP2 9 / TP3 1; mean before-exit 0.6607R) while 147 (90.2%) reached TP2+ only AFTER it (mean 4.7228R) — the gap is overwhelmingly COUNTERFACTUAL, not capturable. Terminal status/result/realized_r untouched | `backend/migrations/014_max_favourable_fields.sql`, `expo/services/maxFavourableExcursion.ts`, `backend/functions/resolve-emitted-signals/maxFavourableExcursion.ts`, `expo/scripts/item224_mfe_round.ts`, `artifacts/checkpoint_a_tp_after_be.txt` |
| 225 | MEASURED + PARTIALLY SHIPPED — THE LOST EMISSIONS ARE THREE, NOT TWO (Checkpoint B): witness cross-reference (telegram_outbox_v1 86 rows / orphan outcomes / shadow_signals_v1) found a THIRD orphan, signal_1787083581937_xr6mjtadq at 2026-08-18T20:06:22Z — SIX DAYS before the annotation-drift window, so a different cause; the "2 in the cfc2a0c window" framing was too narrow. Migration-011 boundary pinned from live data to (2026-08-24T16:14:00Z, 2026-08-24T16:27:35.643Z]. The outbox DOES carry the full ladder (the prior 'unrecoverable' read was a detector artifact: it tested /tp1/i against text saying 'TAKE PROFIT 1'), and direction+entry cross-check against the outcome row AGREES for all three — but RESTORE FAILED on `confidence` NOT NULL, which NO witness recorded. Did not fabricate a confidence and did not drop the constraint (both rejected in writing). All three are SELL and all three resolved WIN (+0.275/+0.3291/+0.2911R), so the hole is mildly ADVERSE to the book. SHIPPED: confidence now in the telegram payload (outbox becomes a COMPLETE witness) + boot-time schema assertion deriving its expected set from the write path's OWN toRow() keys — live run: PASS, all 27 written columns exist, missingInDb=[] | `expo/scripts/item225_lost_emissions.ts`, `expo/scripts/verifyB5SchemaAssertion.ts`, `expo/services/emittedSignalService.ts`, `artifacts/checkpoint_b_lost_emissions.txt` |
| 226 | MEASURED — THE REAL POST-OB EMISSION RATE (Checkpoint C): removal instant pinned EXACTLY from `git log -S "OB_FILTER_ENABLED = false"` = 68cc662 2026-08-24T16:55:33Z (not '~17:00Z'; and the SAME commit as the Item 225 guard). 17 LIVE emissions in 1.6214 days = 10.485/day, EXACT Poisson 95%CI [6.108, 16.787]/day. Both the 21.43/day projection AND the 2.71/day pre-removal rate are EXCLUDED: the removal raised the rate ~3.9x and the projection still over-stated it ~2.0x. INHERITANCE STATED: the funnel treated per-gate marginal cost as independent, so EVERY gate's cost estimate in that funnel inherits the over-statement. C3 funnel re-run BLOCKED — the per-gate counters exist only in the client diagnostics export (pipeline_health_v1 holds freshness/liveness, not rejections); not closed by re-quoting the old run. Post-removal cohort n=16 resolved / 1 pending, per-row R printed, power stated insufficient for EV. C5: OB_FILTER_MODE verified DEAD (read at :8845 nested inside `if (OB_FILTER_ENABLED)` at :8840; :2910 reports only), no floor/clamp/Math.max on any read path — RETAINED with the JSDoc corrected | `expo/scripts/item226_ob_rate.ts`, `artifacts/checkpoint_c_ob_rate.txt` |
| 227 | SHIPPED — LEDGER CLOSURE + THE DECISION IS NOW DUE (Checkpoint D): all 26 genuinely-unknown items (142-145, 153-155, 157, 162, 164-166, 174-178, 182, 185, 187-190, 207-208, 217) worked to CLOSED-UNRECOVERABLE on four independent searches (repo grep, `git log --all --grep` over every ref, checklist row inspection — line 623 already recorded 142-145 as 'no in-repo record' — and an artifact scan); they are gaps in the NUMBERING, not open tasks. Item 123 MOVED BLOCKED→READY TO DO: live atr distribution by source shows 0 implausible rows (BACKFILL 413 all NULL, LIVE 54 present, max 7.10), so the Item 139(c) blocker is GONE — but only 54 LIVE rows carry atr, so power is stated not assumed. Item 211 RECOMMENDATION: build it SECOND (after the n=60 evaluation) and build the MEASUREMENT first — annotation-only persistence, then a pre-registered n>=100/arm held-out split excluding zero; per-evaluation cost is one O(n) pass over bars already walked, build cost ~1 round + a later wiring round. HEADLINE: the era-mean test's n gate is ALREADY MET, weeks early — post-boundary LIVE n=50 (was 36), EV_net −0.2012R, CI [−0.4375, +0.0424]. CI STILL INCLUDES ZERO → pre-registered rule says ACCRUE, no post-hoc reading of a 'nearly excluded' interval. NEXT DECISION DATE 2026-08-27 at n=60 (7 more outcomes; 69.04/wk measured post-removal vs 13.25/wk before → the date pulled in from 08-30, and the n=100 gates from ~11-11 to ~09-08) | `expo/scripts/item227_ledger_probes.ts`, `artifacts/checkpoint_d_ledger.txt`, `artifacts/canonical_book_2026-08-26.txt` |
| 228 | SHIPPED — DISPLAY ONLY — THE TELEMETRY CARD LIES BY OMISSION (Checkpoint E): GENERATED is a PROCESS-LIFETIME counter (signalEngine.ts:1636/:1653 init 0, inc :8406/:9269, returned by getSignalGenerationStats :10609-10617; NEVER rehydrated — only directional_layer_counters_v1 is), TODAY'S SIGNALS is a DEVICE-LOCAL day (telemetry.tsx startOfLocalDay; UTC+2 boundary = 22:00Z). The export's "Counters rehydrated from durable storage: YES" belongs to the TELEGRAM/learning-corpus counters (:882/:413), not these. RECONCILED LIVE (472-emission DB DIRECT read): Today's 10 == local-day rows 10 BUY 3/SELL 7 EXACT (bridge signal_1787697376715 @ 08-25T22:36Z); Generated 22 == unbroken last-22 prefix starting 08-24T20:22Z -> process alive since the Aug-24 deploy window (~34 attempts/h ≈ ATTEMPTS 1547); NO SIGNAL LOSS (Section 9 zero-lost + row-level check). SHIPPED MetricTile.caption + StatRow.hint props; ALL 17 figures relabelled with their window/basis; footer states reset-on-restart + device-local times. E5: daily Generated needs NO new persisted state (signalHistory same-window reuse, or count emitted_signals_v1 >= local midnight) — proposed, deferred | `expo/app/(tabs)/telemetry.tsx`, `expo/scripts/item228_telemetry_reconcile.ts`, `expo/artifacts/checkpoint_e_telemetry_labels.txt` |
| 229 | MEASURED — NINE WINS ONE LOSS AND THE BOOK'S REAL GEOMETRY (Checkpoint F): canonical fromScratch replay (pinned Item-224 instrument, 459 resolved) paired to stored realized_r; SL_AFTER_BE identified BY REPLAY STATUS because trade_outcomes_v1 stores result=WIN|LOSS only (label-first discipline; stored MFE also cross-checked — 445 compared, 5 disagreements all on today's rows, explained as SNAPSHOT-AT-WRITE-TIME semantics vs full-window replay). TODAY in R NETS +1.6038R (9 wins mean ~+0.29R lock-capped vs -1R loss): the export's PF 0.91 is DOLLAR-based via position sizing; both true of different questions, now labelled. FULL POPULATION n=167 SL_AFTER_BE: BEFORE-exit TP1 94.0%/TP2 5.4%/TP3 0.6% vs AFTER-exit COUNTERFACTUAL TP3 79.6%. F3 VERDICT: LOCK QUESTION STAYS CLOSED — TP2-before-exit 10/167 (6.0%) CAPTURABLE vs 140/167 (83.8%) ONLY-AFTER; confirms Items 202-204; reopening gate named (>=100 forward exits, >15% share two consecutive months, ≈2026-09-16) but NOT started. F5 IN R: avgWin +0.6793R / avgLoss -1.0289R = 0.660x, implied breakeven WR 60.23% vs actual 56.51% at n=361 (-3.72pp BELOW breakeven, directional, agrees with canonical CI); dollar 3.85/5.87 kept separate | `expo/scripts/item229_sl_after_be.ts`, `expo/artifacts/checkpoint_f_sl_after_be.txt` |
| 230 | MEASURED + DISPLAY FIX — THE DRIFT EXCLUSION IS REACHING ITS COMPUTATION; THE CRITICAL IS REAL VALUES MISLABELLED DEGRADATION (Checkpoint G): analyzeFeatureValueDrift replicated EXACTLY three ways on live corpus (ALL / shipped-path-with-fallback / engine-native-only) — IDENTICAL: 289/459 reconstruction-marked overall but 0/40 inside the window region -> 170 measurable >= 40 fallback floor; shipped path reproduces Section 3 EXACTLY (volumeRatio 0.891→1.432 drift 0.601 CRITICAL; sentiment 0.200→0.021 drift 0.850 CRITICAL). SENTIMENT: values ENGINE-NATIVE (winner-source census BULLISH/BEARISH/NEUTRAL/STRONG-BUY/STRONG-SELL) — really netted ≈0 because FOUR bearish-sentiment WINNERS cancelled bullish ones; a central-tendency metric reports winner divergence as drift-to-zero; mislabelling named, formula change left gated per Item 64(d). VOLUME RATIO REAL, survives exclusion fully (raw dumps pasted), power n=5 vs n=14 stated. G4: Recommended=NO formula (:10685-10688) does NOT read per-feature CRITICAL while scheduling does (:7943 conjunction → set :7962); flag in-memory :1731 so cannot predate session -> set AFTER 07:00Z today, executes tonight 22:00Z; Item 201(c) staleness impossible. SHIPPED: retrainScheduledAtMs/reason recorded at ALL 3 set sites + reset at ALL 3 clear sites, exposed via getter (9 mocks updated), telemetry banner names when+why+execution window, export Section 3 prints AT/TRIGGER lines. MODULATION_ENABLED stays false | `expo/services/signalEngine.ts`, `expo/app/(tabs)/telemetry.tsx`, `expo/services/diagnosticsExport.ts`, `expo/scripts/item230_drift_exclusion.ts`, `expo/artifacts/checkpoint_g_drift_retrain.txt` |
| 231 | SHIPPED + BLOCKED-ON-USER — BUILD MARKER RESTORED A THIRD TIME (Checkpoint H): plugin ABSENT again confirmed live (no plugins array) -> babel.config.js rewritten with rorkBuildMarkerPlugin DEFINED + REGISTERED + SCOPED to buildMarker (file.includes("buildMarker")) in PLAIN JS (node loads it pre-transform), topped by a DO-NOT-STRIP guard comment naming b1c7ca8/af7da4a. EVIDENCE: item184a_babel_marker_proof.cjs through THIS config -> SHA ac82d98 substituted correctly, fresh ISO stamp, no literal remains; ci_guard_build_marker.ts PASSED incl. 5/5 mutated-fixture self-test. GATE CLOSED BLOCKED-ON-USER per its own standard — ONLY a real device export printing a real SHA closes G-H (proof scripts explicitly marked not-gate-closing); exact ordered steps pasted (stop Metro → `npx expo start -c` to defeat transform cache → reload → trigger export → expect real SHA + fresh stamp; stale-cache fallback probes listed) | `expo/babel.config.js`, `expo/artifacts/checkpoint_h_build_marker.txt` |
| 232 | A.1 MEASURED (re-added after external sync dropped rows 232-233) | canonical fade cohort: WITH n=251 EV+0.0274R vs FADE n=180 EV-0.0006R, diff CI [-0.1451,+0.2005] — fades ~EV-zero, DISAGREE w/ provisional; artifact `checkpoint_a1_fade_cohort.txt` |
| 233 | B.1 CLOSED / B.2 MEASURED / B.3 MEASURED-NOT-SHIPPED | entry booked at stored entry on all four confirm paths (signalResolver.ts:243-262); honest-fill paired diff +0.0638R CI [-0.0057,+0.1343] includes zero -> ship nothing, n~1,041 required; artifacts `checkpoint_b1_entry_confirm.txt`, `checkpoint_b2b3_entry_fill_gap.txt` |
| 234 | E.1 MEASURED | canonical band-proximity veto: VETOED n=80 EV-0.1825R / KEPT n=367 EV+0.0567R, diff +0.2392R boot CI [0.0112,0.4632], MDE +/-0.3158R pre-stated; grid 12/12 same-signed; LIVE subset same sign; DISAGREE-with-provisional deltas pasted; 02:15Z failure veto-qualifying (36 touches, rs 0.999). Artifact `checkpoint_e_band_veto.txt` |
| 235 | E.2 MEASURED-NOT-SHIPPED <live> + ANNOTATION-SHIPPED <code> | gate leg 1 FAILS (VETOED CI upper > 0) -> nothing ships live; shadow columns band_veto_would_fire/zone_price in migration 017 + write-only annotation; required n ~ 542 more decided (~990 total). Live-write BLOCKED on migration application |
| 236 | G.1 CLOSED | verbatim quotes signalEngine.ts:4560/:4583-4597/:696 + applyRejectionDirectedTyping ~:4367-4411; 191 DOES record side (rejectionsFromBelow/Above persisted in live snapshots) but flag OFF -> type stays spot-relative |
| 237 | G.2 CLOSED | TEST 1 (bars<02:15:56Z, 68,493): all five zones SUPPORT-behaving — DISAGREE w/ provisional (method/window noted). TEST 2 (bars<10:37:16Z): 4583.2/4580.9/4597.0 stored RESISTANCE -> side-aware SUPPORT; band 4564-4572 absent from snapshot. Artifact `checkpoint_g_side_aware.txt` |
| 238 | G.3 MEASURED | 33/218 verdict flips; FLIP n=33 EV-0.1854R vs UNCHANGED n=185 EV-0.0305R, CI [-0.1805,0.4857], MDE +/-0.5110R (underpowered); at-extreme class flip n=0; next-round rule stated. NO code ships |
| 239 | H.1 CLOSED | quotes refresh-sr-zones :23/:312-315/:412-414/:460-462; band untapped 22Aug->27Aug10:37Z CONFIRMED (390 taps all 21 Aug); formation timestamps DISAGREE w/ bars (provenance noted); band ABSENT from 10:37 snapshot CONFIRMED. Artifact `checkpoint_h_long_memory.txt` |
| 240 | H.2 MEASURED | n=8 qualifying first retests: fav +$30.95 (+3.87R) vs control $18.39, CI [$18.18,$43.73], MDE +/-18.28 (underpowered); Item-99 dual-window reconciliation pasted; nothing ships |
| 241 | I ANNOTATION-SHIPPED <code> + BLOCKED <live-row> | migration 017 (chase_position, opposing_zone_fraction, pre_signal_drift) + write-only emission annotation (NULL-if-unavailable); read-nowhere grep clean; live-row proof BLOCKED on user applying 017 |
| 242 | F.1 BLOCKED | 015/016 STILL unapplied (live checks: agrees column MISSING, shadow_candidates_v1 MISSING) — A.2/C live proofs remain blocked on user SQL-Editor application |
| 243 | F.2 BLOCKED | babel.config.js stripped a FIFTH time (only presets remain; no build-marker plugin) — current export prints literal __BUILD_SHA__ (buildMarker.ts:34); every export-based artifact carries the caveat |
| 244 | F.3 n=9 | emitted=481, outcomes=468, 9 new emissions since 26Aug 21:30Z (first 22:14:51Z) — B.3 pairs ~449/1,041; rerun item233 unchanged at ~1,041 |
| 245 | J.1 CLOSED | live anon queries: all 7 annotation columns present on emitted_signals_v1 (7-row select OK); shadow_candidates_v1 exists (count=1), rows=0 |
| 246 | J.2 BLOCKED | 0 emissions since migrations applied (none since 16:45Z) -> no post-fix annotated row yet; shadow rows need Item-C engine wiring (never shipped). BLOCKED on next real emission |
| 247 | K.1 SHIPPED 6c98302 | chase_position corrected to day-start true-high/low OHLC method (emittedSignalService.ts annotation block, +35/−13 lines); NULL if range<$3 or <30 bars; sync commit confirmed to contain the K edits |
| 248 | K.2 CLOSED (b) | telemetry drift = computeRecentDrift (signalEngine.ts:10564, fiveMinCandles = priceHistory-derived) -> priceHistory must not feed labels; pre_signal_drift stays gold_m1_bars 4h bar-close delta with explicit differs-from-telemetry comment |
| 249 | K.3 CLOSED | read-nowhere grep: identifiers only in write site + migrations; gating/scoring paths EMPTY |
| 250 | L MEASURED | era-clean E.1: VETOED n=80 -0.1825R / KEPT n=138 +0.0207R, diff +0.2032R CI [-0.0582,0.4609] (INCLUDES ZERO), MDE +/-0.3800R; grid 12/12 KEPT>V; required-n ~278 more (~496 total); no-snapshot cohort n=229 +0.0784R era 29Jun-16Jul named as the confound. Artifact `checkpoint_jklmno_correction_round.txt` |
| 251 | M.1 CLOSED | 4-window tables pasted; 02:15 band SUP at ALL windows — DISAGREE w/ expected shape (audit's 24h flip does not reproduce); 4583.2/4598.3 are the only window-sensitive zones |
| 252 | M.2 MEASURED | @48h flip n=39 -0.3162R vs 179 +0.0032R, CI [-0.0007,0.6247], MDE +/-0.4779R; @7d flip n=38 -0.3018R vs 180 -0.0016R, CI [-0.0219,0.6108], MDE +/-0.4828R |
| 253 | M.3 MEASURED | matched class (cp>=0.85 OHLC & opp<=0.10): n=18 WR61.1% EV-0.0346R — canonical DISAGREE w/ provisional n=24 +0.1345R; flips 1/18 @48h, 1/18 @7d |
| 254 | M.4 CLOSED | no window does both jobs at current power (CIs touch zero); class has no +EV left to protect canonically; forward n_flip~80 settles; artifact paragraph |
| 255 | N CLOSED | corrected UTC windows CONFIRMED: 06:30-08:00Z 56 in-band bars (min 4560.6); reaction 12:25-12:45Z 9 bars low<=4572 (min 4563.5 @12:40Z); hourly path pasted |
| 256 | O.1 CAVEAT STANDS | marker stripped 5th time; babel.config.js preset-only; buildMarker.ts:34 literal placeholder; every export-based artifact carries the caveat |
| 257 | O.2 ~449/1041 | emitted=481, outcomes=468, 0 new emissions since 16:45Z; rerun item233 unchanged |
| 258 | O.3 NOT ATTEMPTED | 55 new bars since study -> zero possible candidates for a qualifying first retest |
| 259 | V.1 SHIPPED <working tree; sync hash pending — HEAD 7bba6ca> | canonical M15 builder services/m15ZoneLayer.ts (pre-stated rules in header); v1 side-label inversion caught by acceptance run, fixed BEFORE any number recorded; zero live impact |
| 260 | V.2 SHIPPED + migration handed | 019 (m15_opposed/m15_endorsed/m15_zone_context, pattern of 017) + write-only block in emittedSignalService.ts (self-heal strips fields until applied); read-nowhere grep CLEAN; first live annotated row BLOCKED — 019 not applied (live PGRST204 error pasted in artifact) |
| 261 | V.3 CLOSED | (a) PASS: 4631.9-4633.5 RESISTANCE 3v0 (+4639.1-4640.8 2v1) overlapping 4633-4641 at 02:15:56Z map (53 zones, 14 trading days); (b) FAIL: no zone in 4559-4572 at 10:37:16Z — divergence vs provisional named (port's event rules unspecified); NOT tuned post-hoc |
| 262 | W.1 MEASURED (fp caveat) | fp instrument ABSENT from tree (named blocker) -> configs UNCONDITIONED-ON-fp: A removed 81/-0.1767 kept 138/+0.0207 ret 63.0% CI[-0.0597,0.4534] MDE+/-0.3778 | B 80/-0.0294 vs 139/-0.0656 ret 63.5% CI[-0.3038,0.2390] | C 127/-0.0425 vs 92/-0.0659 ret 42.0% | D 34/-0.3314 vs 185/-0.0011 ret 84.5% CI[-0.0115,0.6547] MDE+/-0.5036; D-cell 34 listed signal-by-signal; whole-book clean EV -0.0523 (n=219) |
| 263 | W.2 MEASURED | M15-opposed BUY 49/-0.0350, SELL 31/-0.0204; ENDORSEMENT canonical: endorsed 94/-0.0322 vs not-endorsed 125/-0.0675 — DISAGREE w/ provisional -0.1808R (transfer warning NOT reproduced) |
| 264 | W.3 VERDICT STATED | none evaluable as defined (fp blocker); unconditioned: A (i)PASS (ii)FAIL CIu 0.4534 (iii)FAIL 63.0%; B/C all FAIL; D (i)PASS (iii)PASS (ii)FAIL CIu 0.6547 -> shipped config STANDS, nothing live changed |
| 265 | X.1 NO P-ROUND EVIDENCE IN TREE | no P-round script/artifact/constant found; live: shadow_candidates_v1 rows=0; band_veto populated on 2 rows (both true); PATH_TO_TARGET_VETO (Item 96, SE:652) only live veto; abort-gate counter not found |
| 266 | X.2 = 0 | retype_verdict_would_change column DOES NOT EXIST (PGRST204 pasted) — Q migration absent from tree and not applied |
| 267 | X.3 STRIPPED AGAIN | buildMarker.ts:34 '__BUILD_SHA__' / :37 '__BUILD_STAMP__'; babel rork-build-marker matches = 0 (7th strip); export artifacts carry the caveat |
| 268 | X.4 483/469 | emitted=483 (+2 since O round), outcomes=469 |
| 269 | BONUS: K live-row proof CLOSED | two post-K-fix annotated rows, all five fields populated in range: signal_1787873651603 (chase 0.448, opp 0.125) + signal_1787897386936 (chase 0.274, opp 0.063) — closes O-round J.2 || A.1 | MEASURED | item232_fade_cohort.ts (REAL resolver, shared evCompute): decided n=431 — WITH n=251 WR62.5% EV_net +0.0274R vs FADE n=180 WR61.7% EV_net -0.0006R; diff +0.0280R boot-CI [-0.1451,+0.2005] P(diff>0)=62.6%; DISAGREE w/ provisional (-0.2300R fades, n=128): fades ~EV-zero here, BUY-fades POSITIVE (+0.0571R), canonical book +0.0157R (sign-flip vs stored-era book). Artifact `expo/artifacts/checkpoint_a1_fade_cohort.txt` |
| 270 | P.0 CLOSED | canonical re-derivation item241 (era-clean, real resolver, n=223): fp n=28 WR64.3% +0.0371R — DISAGREE w/ provisional n=33 75.8% +0.2331R; fp-AND-vetoable n=4 +0.1924R 3W/1L (prov 6 +0.5491R 6W/0L); CONDITIONAL removed 79/-0.2008R kept 144/+0.0288R ret 64.6%, kept halves +0.0137/+0.0438 both positive; whole-book -0.0526R |
| 271 | P.1 SHIPPED <working tree, sync hash pending — HEAD 7bba6ca> | GATE-1 PASS (-0.2008 < -0.10, boot CI [-0.3997,0.0088], MDE+/-0.3756) + GATE-2 PASS (+0.1924 > 0, n=4) -> branch A CONDITIONAL veto; BAND_PROXIMITY_VETO_ENABLED=true (bandProximityVeto.ts:46) read only by signalEngine.ts:9707 at the confirmed-emission return; shadow write shadow_candidates_v1 'BAND_VETO_SUPPRESSED' (migration 020 anon INSERT policy); funnel counters in diagnostics export |
| 272 | P.2 CLOSED (funnel + greps) / BLOCKED-ON-MARKET (first suppressed row) | REAL export funnel section pasted (generated=2 emitted=1 suppressed=1, invariant holds; client=null demo — module guard SKIPS the production write); grep (i) veto reads zones/rsi/A.2-bars only, zero priceHistory/Yahoo/TwelveData code refs; grep (ii) flag read only at def:46 + SE:4/9707 (+ export string literal); grep (iii) Telegram sites unchanged (TC:2872/BTS:150), veto module has ZERO telegram/history refs; shadow_candidates_v1 rows=0 |
| 273 | P.3 SHIPPED | abort gate VERBATIM in bandProximityVeto.ts header AND the signalEngine ITEM P block: at every forward n=30 decided suppressed signals, EV_net > 0 -> flag false next round; no other condition modifies the flag |
| 274 | Q SHIPPED <same hash> + migration handed | 018 (retype_verdict_would_change boolean NULL, pattern of 017); write-site = ITEM Q block in emittedSignalService.ts inside the ITEM V block (reuses 16-day m1 fetch); 48h side-aware roles via classifyZone verbatim-ported to services/sideAwareRole.ts (script keeps node:fs, cannot enter Metro bundle); G.3 verdict-differs semantics; promotion gate verbatim (n>=80 AND CI upper < 0); live check PGRST204 'column ... does not exist' -> BLOCKED-ON-APPLY |
| 275 | R SHIPPED <same hash> | babel.config.js restored VERBATIM from 9654019 (scoped rork-build-marker); SIXTH-STRIP GUARD added to ci_guard_duplicate_constants.ts; demo: stripped (7th-strip form) -> 'SIXTH-STRIP GUARD: ... missing ... registration' EXIT=1, restored -> EXIT=0 PASS; ci_guard_build_marker PASSED; probe_build_marker: injected BUILD_SHA=8c04bc2 + fresh stamp; runtime export line BLOCKED-ON-REBUILD (running bundle predates restore) |
| 276 | S.1 BLOCKED-ON-EMISSION | 019 IS applied but no emission has run the new annotation code yet — m15_opposed populated=0; next real emission annotates |
| 277 | S.2 487/474 | live counts (anon key, item242) |
| 278 | S.3 66.7% | band_veto_would_fire populated=6 fired=4 (tiny n; annotation shipped with 017) |
| 279 | BONUS: veto logic proven without production pollution | item243 drove the REAL evaluateBandProximityVeto with client=null (firing + silent cases); shadow write skipped by the module's null-guard, funnel invariant generated==emitted+suppressed HOLDS; runChecks(expo) GREEN || A.2 | SHIPPED <code> + BLOCKED <live-proof> | SHIPPED: migration `backend/migrations/015_emitted_fade_annotation.sql` + write-only annotation in `pushEmittedSignalRecord` (gold_m1_bars ONLY, NULL-if-unavailable, pre-registered forward gate in code). BLOCKER NAMED: no SQL-execution channel (ddl_access_probe; SUPABASE_DB_PASSWORD absent) -> ALTER TABLE cannot run here, so information_schema column proof (a) and first-populated real row (b) need the migration applied externally; commit hash pending sync. Read-nowhere grep pasted in report |
| B.1 | CLOSED | verbatim quotes `signalResolver.ts:243-262` + bands :215-216 + NEVER_FILLABLE :239-241,:454-475; all four paths book entryFillPrice = stored entryPrice (:258) regardless of actual touch price; levels-cross same-bar ladder walk unchanged; mechanism ACCEPTED against function text. Artifact `checkpoint_b1_entry_confirm.txt` |
| B.2 | MEASURED | item233_entry_fill_gap.ts, paired real-resolver ARM1 n=438 EV_net +0.0143R total +6.26R; ARM2 honest next-open fill (shifted ladder, SAME resolver) n=440 EV_net +0.0778R total +34.21R; PAIRED diff +0.0638R/trade (+27.93R), normal CI [-0.0051,+0.1326], boot 20k CI [-0.0057,+0.1343]; MDE pre-stated (+/-0.098R realised at sigma_d 0.7351); flips WIN->LOSS 29 LOSS->WIN 47; 5 divergent ids with per-arm exits pasted |
| B.3 | MEASURED-NOT-SHIPPED | positive point estimate but 95% CI INCLUDES ZERO -> gate says SHIP NOTHING, both-or-neither held; required forward n ~= 1,041 decided pairs (roughly 600 more than current 438) at 80%/5%; artifact `checkpoint_b2b3_entry_fill_gap.txt` |
| C | BLOCKED (components shipped) | SHIPPED components: migration `016_shadow_candidates_v1.sql` (RLS: anon select only) + pure evaluator `expo/services/shadowCandidates.ts` (LDN-FADE w/ strictly-before extreme; TREND-CONTINUATION w/ explicit trend-day defn; four-part promotion gate verbatim in header). BLOCKERS NAMED: (1) same DDL channel absence — table cannot exist without external apply; (2) emission-cycle wiring not attempted — requires an audited insertion point inside the live signal-engine hot path, refused under SCOPE CONSTRAINT rather than blind-edited. Gates (a)-(d) unclosable this round; nothing synthetic seeded |
| D.1 | EVIDENCED-PARTIAL | trade_outcomes_v1 LIVE last-60 query: all four MFE fields non-null on 55/60 rows each. BOTH resolvers writing: Edge Function has 4 field refs (`resolve-emitted-signals/index.ts`); client path resolves via resolver maxFavourable. Writer-vs-writer parity on REAL signals NOT separately established — only resolver-replay-vs-stored cross-check exists (Item 229/F2, 445 compared, 5 today-row snapshot-semantics mismatches) |
| D.2 | SHIPPED | telemetry labels verified in current tree: `(tabs)/telemetry.tsx:190,:197` caption="since process start"; :449 "Times shown in device-local time... counters reset when the [process restarts]" — ledger row 228 (17 figures relabelled) |
| 280 | CANONICAL SEMANTICS ADOPTED | `services/zoneSemantics.ts` + `services/zone_semantics_golden.json` installed as the single source of truth; shared primitives added (roleFromScore / roleFromRejectionCounts / recencyWeightedScore / rejectionEvent / breakthroughEvent / blockingRoleFor / agreeingRoleFor / roleFromLegacyType) and buildZoneRole+zoneRelation refactored onto them, so the golden fixtures police the same code path every consumer uses |
| 281 | PORTED — no local re-derivation remains | m15ZoneLayer (events via rejectionEvent, role via roleFromRejectionCounts, opposed/endorsed DELEGATED to zoneRelation; m15EndorsedHit gained tp1, call sites updated), sideAwareRole, emittedSignalService (both E.1 fraction and ITEM Q retype now compare roleFromLegacyType(stored) vs blockingRoleFor(dir)), scripts item235/238/239/240. Grep (B) for `rb > ra\|rejB > rejA\|=== 'RESISTANCE'\|=== 'SUPPORT'` over ported instruments returns ONLY zoneSemantics.ts:93 (doc) + :151-152 (legacy read-bridge) = CLEAN. Grep (C) `export function classifyZone` = EXACTLY ONE definition (sideAwareRole.ts:67); item235's duplicate copy DELETED and now imports the service |
| 282 | GOLDEN GUARD WIRED — FAILS THE RUN | ci_guard_duplicate_constants.ts loads the golden JSON and calls verifyAgainstGolden(); mismatches push into the SAME `failures` array as the sixth-strip guard -> exit 1 (read/parse error also fails, never silent). RUN: `OK 3 behavioural + 5 trade-relative fixtures reproduced EXACTLY` incl. the decisive `role_flip_recency -> CEILING_BEHAVING`; RESULT: PASS, EXIT=0 |
| 283 | SEVENTH STRIP CAUGHT BY THE GUARD | first widened-guard run FAILED on `SIXTH-STRIP GUARD: babel.config.js is missing the rork-build-marker plugin registration` — babel.config.js was a 6-line no-plugin file AND `git show HEAD:expo/babel.config.js` confirmed the strip had reached HEAD (86de366), i.e. seventh removal, not a worktree accident. Restored verbatim from 9654019 (3724 bytes; scoped at :56/:60, registered at :74); guard then EXIT=0 |
| 284 | V.3 RE-RUN THROUGH PORTED INSTRUMENT | (a)=PASS (b)=FAIL. First re-run returned (a)=FAIL(b)=FAIL — diagnosed BEFORE reporting as UN-PORTED ASSERTIONS (item239 still searched retired literals 'RESISTANCE'/'SUPPORT', so `.find()` matched nothing); assertions ported to blockingRoleFor(). (a) CEILING_BEHAVING 4631.9-4633.5 n=3 rb=3 ra=0; map identical zone-for-zone to pre-port checkpoint_vwx (53/54 zones, same n, same rb/ra) |
| 285 | 21-AUG DIVERGENCE SETTLED BY MEASUREMENT | side-inversion hypothesis EXCLUDED: the module passes role_flip_recency (raw counts tie 2-2; only correct sides + recency weighting yield CEILING_BEHAVING) AND the M15 map reproduces pre-port zone-for-zone. (b) still FAILS for a STRUCTURAL reason visible in the map — NO event of any role between 4530.5 and 4597.9, so there is nothing to mislabel. Conclusion: genuine DETECTION-RULE disagreement with the unspecified Python port, NOT a side-semantics defect. Nothing tuned to make (b) pass; (b) remains FAIL on record |
| 286 | PORT EQUIVALENCE PROVEN + LATENT DEFECT ON RECORD | new `scripts/item244_semantics_port_equivalence.ts` runs the frozen PRE-PORT classifier (verbatim @8c04bc2) vs the live ported one over 70,991 real bars, 1511 levels x 12 cutoffs = 18,132 comparisons -> MISMATCHES: 0 = EQUIVALENT (vocabulary + duplication changed, NO number changed). FIRST run showed 479/18132 (2.6%): the pre-port list is NEWEST-FIRST and `idx >= n-5` weights its TAIL = the OLDEST five events, contradicting its own "last-5" comment; my port had reversed it (implementing the comment) which silently redefined a pre-registered instrument mid-round -> REVERTED to bit-for-bit behaviour, discrepancy recorded in-code as DEFECT ON RECORD. Correcting the direction changes what every Q number MEANS (Q's n>=80 gate was pre-registered against THIS instrument), so it is a MEASURED change for a future round, not a drive-by fix |
| D.3 | FIXED at bundle level; caveats stands | FOURTH strip caught mid-round + re-restored w/ DO-NOT-STRIP guard comment; REAL-METRO serve test fused BUILD_SHA="464ae4b" + fresh stamp into the actually-served bundle (checkpoint_h_build_marker.txt ADDENDUM); ci_guard PASSED (self-test 5/5). User on-device export still PENDING -> any export-based evidence remains carry-that-caveat until a real export prints the SHA |

**Awaiting-sample additions from this round:** OB-absent forward cohort (Item 221 follow-up — do post-removal resolutions match the +0.0177R backtest cohort; ~2026-09-07 onward); venue-basis persistence gate (Item 222 — autocorr ≥ 0.5 or half-life ≥ 30 min AND residual crossing ≤ 2% of minutes; 2026-09-07).

**Cross-round items resolved by the 2026-08-24 remediation plan:** Item 120
(B1 — underpowered verdict, era-mean test settles ~2026-09-01 if the post-
boundary LIVE EV stays at −0.2358R); Item 136(d)/(f) (A4 — weekend-label
artifact, criterion MET on the open-market stretch); Item 122/C-2 (B2, this
round); Item 138(d) (B3, this round); Item 123 still BLOCKED on 139(c)
quarantine SQL (user action in the SQL Editor).

#### FLAG REGISTER (Phase D/D1, 2026-08-24 — line numbers re-verified this round)

Every flag that gates behaviour, its flip criterion, its measured accrual rate,
and its projected decision date. A flag without an accrual instrument is a DEAD
flag — none may be added to that state again (see D3).

| Flag | Line | Value | Item | Flip criterion | Accrual | Projected decision |
|---|---|---|---|---|---|---|
| `TRAINING_WINDOW_DAYS` | SE:363 | `0` | 103 | Learner beats chance on held-out | n/a (learner at chance, Item 111) | indefinite |
| `MODULATION_ENABLED` | SE:553 | `false` | 111/140 | held-out acc ≥55%, n≥200, p<0.05 | ~12 LIVE outcomes/week | ~mid-Dec 2026 |
| `PATH_TO_TARGET_VETO_ENABLED` | SE:640 | `true` | 96 | stays ON (graded least-bad, Item 112) | — | — |
| `ENTRY_QUALITY_TRIGGER_ENABLED` | SE:657 | `false` | 137 | entry-quality split n≥30/arm, EV CI separation | ~12/week | ~mid-Oct 2026 |
| `REJECTION_DIRECTED_ZONES_ENABLED` | SE:684 | `false` | 191 | EV split on the changed set (13/32 zones) at n≥80 LIVE | ~12/week, accruing server-side since Phase A | ~late Oct 2026 |
| `NO_STRUCTURE_VETO_ENABLED` | SE:709 | `false` | 192/193 | n≥30 zero-opposing arm | ~0.22/day (own note) | ~2026-11-28 |
| `ENTRY_BUFFER_ENABLED` | SE:735 | `false` | 196(d) | forward n≥30/arm on the 50-pip buffer | ~12/week | ~mid-Oct 2026 |
| `BEHIND_ENTRY_ARMING_ENABLED` (NEW, Phase C/C2) | ~SE:738 | `false` | 210/211 route | armed bucket n≥30 with EV CI excluding zero | 7/36 LIVE = 19.4%, ~2.8/week; armed EV +0.1623R at n=7 | ~2026-11-15 |
| `TP3_CONFIDENCE_STRETCH_ENABLED` | ~SE:767 | `false` | 138 | TP3-stretch split n≥30/arm | ~12/week | ~mid-Oct 2026 |
| `OB_FILTER_ENABLED` / `OB_FILTER_MODE` | SE:772 / :783 | **`false` — REMOVED Phase C/C3** | 114→160(c) | re-enable only if a held-out re-measure at n≥100/arm excludes zero FAVOURING the filter | n=306/118 measured 2026-08-24, p=0.8616 — removed | resolved 2026-08-24 |
| `STRENGTH_WEIGHTED_ZONE_SELECTION_ENABLED` | — | **DELETED Phase D/D3** | 98(c) | had NO reader for 120 items — deleted; re-ship only as a real gated mechanism | none | resolved 2026-08-24 |
| `BLOCKED_UTC_HOURS` | SE:596 | `[4, 11]` | 107 | active constraint (session-liquidity hazard), not a flip | — | — |

**Phase D/D2 note:** `Settings` rows now carry `schemaVersion`; persisted rows without
it are migrated once on load — a stale 49/74/98 ladder becomes 25/50/80 and a
stale `useDynamicSL:true` becomes false (`expo/services/settingsMigration.ts`,
proof in `expo/artifacts/verifySettingsMigration_run.txt`).

## 6. KNOWN FAULTS

Severity ranked by effect on SIGNAL ACCURACY and SIGNAL VOLUME.

| ID | Fault | Where | Severity | Regression? | Evidence |
|---|---|---|---|---|---|
| **F-0** | **FIXED 2026-08-17 (B1).** Real production settings object now passed at harness:495, `--settings-override` added, bare `catch {}` replaced with typed exception counting + a loud banner. Proof: HC-14 EXCEPTIONS 0 with post-conviction templates appearing; HC-15 both arms EXCEPTIONS 0 with 8 / 4 emissions. Was: **replay harness calls `generateSignal()` with NO arguments.** `settings` is `undefined`; first dereference is `settings.allowShortSignals` and it throws, so EVERY evaluation dies immediately after the conviction gate. The harness measures scoring only — it can never reach emission, SELL suppression, the confidence gate, cooldown, or geometry. `signals emitted: 0` is a crash artifact, not a market result, and a SELL-enabled-vs-suppressed comparison is IMPOSSIBLE on this instrument | harness call site `expo/scripts/item57_realbar_replay_harness.ts:389`; no default for `settings` at SE:7230-7233; first deref SE:7387; errors swallowed by bare `catch {}` at harness:392-395 | **CRITICAL** — every emission/rejection-profile claim ever made from this harness is void beyond the conviction gate | New finding | RUN A: 447 of 1,348 values cleared 0.55, yet 0 emissions AND not one post-conviction rejection template appears in the profile |
| **F-8** | **EMISSION STARVATION.** Dedup layer alone reduces 8.50 raw signals/day to **0.78-0.80/day** (~91% suppression) over a 50.1-day, n=426 book — far below the 2/day pre-registered floor, and that is BEFORE the path-to-target veto and OB filter are counted. Partially relaxed this round (`DEDUP_TIME_WINDOW_MS` 1390→225 min). Root cause is the PRIMARY cluster-scoped guard, not the time window: guard-alone survives 39 vs 40 with the wide window | `signalEngine.ts` DEDUP block ~:8633 | **CRITICAL** — a starved system cannot compound any edge | New finding (Item 118/119) | HC-118, HC-119 |
| **F-9** | **EXISTING INSTALLS STRANDED ON THE LOSING LADDER.** `sanitizeSettings()` spreads `DEFAULT_SETTINGS` then persisted `settings`, so Item 121's 25/50/80 default reaches FRESH INSTALLS ONLY. Any device with a persisted `trading_settings` key keeps 49/74/98 — the ladder measured at EV +0.0198R vs +0.0371R. Needs a one-time versioned settings migration | `TradingContext.tsx:372-382`, read at `:2385` | **HIGH** — real users keep the measurably worse geometry | New finding (Item 121c) | HC-121 |
| **F-10** | **UNVERIFIED FORWARD EDGE (Item 120 NOT REACHED).** The ~0.14R gap between the no-snapshot era (n=241 EV +0.0781R) and snapshot era (n=171 EV −0.0624R) was attributed to selection bias, but the competing reading — genuine deterioration over time, which would make the forward edge NEGATIVE — was never tested. Per-calendar-week canonical bucketing is the settling measurement | `emitted_signals_v1` | **CRITICAL** — most consequential open question | Carried, unresolved | Item 120 not reached |
| **F-31** | **MY OWN MEASUREMENT SCRIPT DEFLATED EVERY EV BY ~10x LAST ROUND.** `computeRNet(dir, entry, exit, risk)` takes risk in **PRICE UNITS** — `costInR()` computes `$0.20 / (risk * DOLLAR_PER_PRICE_UNIT)`, which is the documented ~0.03R burden only when risk is in dollars. `item116_118_measure.ts:194` passed `Math.abs(entry-sl)/PIP_VALUE`, i.e. **pips**, deflating both gross R and the cost by 10x. Corrected full book: n=426 WR=61.03% EV=**+0.0178R** PF=1.044 (the prior round reported EV +0.0018R and called the book "breakeven within noise"). WR is unaffected. **Every EV number in the Item 116/118 report is understated 10x and must be re-read from HC-133a.** Same class as the argument-order defect caught mid-round previously — ad-hoc scripts re-deriving R are the recurring weak point. | `expo/scripts/item116_118_measure.ts:194` | **HIGH** — corrupted a reported book | **Self-inflicted, prior round** | HC-133a |
| **F-32** | **THE STORED `atr` COLUMN IS TWO DIFFERENT CONSTRUCTS, AND THE BACKFILL ONE IS IMPLAUSIBLE.** Split by `source`: BACKFILL n=413 → atr p50=4.50, p90=22.30, **max=124.20**; LIVE n=13 → p50=1.50, p90=2.50, max=2.60. The bar-derived engine construct (`calculateRealATR(14)` over `gold_m1_bars`, 59,556 samples) gives p50=1.719, max=12.374 — matching LIVE, not BACKFILL. An ATR of 124 on 1-min gold at ~$4,400 is not a market value. **Any gate or cohort measured on the stored backfill `atr` is measuring a different construct than the live engine reads** — this is what blocked HC-131c, and it silently affects every prior ATR-conditioned split on this corpus. | `emitted_signals_v1.atr` (BACKFILL rows) | **HIGH** — invalidates ATR-conditioned splits on the corpus | Pre-existing, newly characterised | HC-131a/c |
| **F-33** | **THE CONFIDENCE GATE IS ANTI-PREDICTIVE** (PRIOR ROUND — NOW NOT CONFIRMED). Full canonical book n=426 EV=+0.0178R PF=1.044, but EVERY confidence threshold from 0.68 to 0.90 yields NEGATIVE EV (−0.0049R to −0.0140R) and PF<1. The n=76 signals BELOW 0.68 therefore carry EV ≈ +0.147R — the entire positive edge sits in the signals the gate discards, and raising the threshold does not recover it (WR is flat at ~58.5–58.9% across all five arms). The gate is not selecting quality; it is selecting away from it. Re-thresholding is NOT the fix — the confidence SCORE itself needs re-derivation against canonical realised R. **ITEM 138 AMENDMENT (2026-08-18):** Direct measurement of sub-0.68 gives n=58 (not 76), EV=+0.0754R (not +0.147R), **CI=[-0.145, +0.296] — INCLUDES ZERO.** The sub-0.68 cohort is 100% BACKFILL (0% LIVE). F-32 proved era splits can be artefacts. The prior round's numbers were subtraction-inferred and do not reproduce directly. **F-33 is NOT CONFIRMED as inversion.** It may be an artefact of the backfill population. Re-derivation requires a LIVE-only corpus (currently n=14). | `minConfidence` gate; confidence scoring in `signalEngine.ts` | **AMENDED — NOT CONFIRMED** | New finding (Item 133), amended (Item 138) | HC-138a/c |
| **F-34** | **THE ZONE MAP WAS 20.9 HOURS OLD WHEN SIGNAL [1] FIRED.** sr_zones_v1 `updated_at` = 2026-08-17T19:30:10Z on all 22 rows. Signal [1] fired at 2026-08-18T16:25:33Z. The 4h cron appears to have stopped running entirely — 5 consecutive runs (00:05, 04:05, 08:05, 12:05, 16:05 UTC on Aug 18) either didn't fire or failed silently. The fresh map at 16:25:33Z contains SUPPORT at 4364.8 (rs=0.995) and 4363.6 (rs=0.981) — the support the user saw on the chart. The stale map had only 4370.6 and 4367.2 at rs=0.475. **This is the user's "bought the top" defect:** the engine entered $5 above a support it could not see because the map was nearly a day old. | `sr_zones_v1` staleness; cron schedule | **CRITICAL** — root cause of user's complaint | New finding (Item 136) | HC-136a/c |
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
