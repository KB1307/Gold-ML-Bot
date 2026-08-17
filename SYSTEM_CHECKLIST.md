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
| HC-12 | Not performed — `resolveSignalWithBars` still not exercisable from this environment | **BLOCKED** |
| HC-13 | **RE-RUN CLEAN.** Zone batch stamp `2026-08-17T08:26:46.289Z` verified IDENTICAL before (08:55:52Z) and after (09:06:20Z) both arms; 22 rows, max `reaction_strength` 0.9990, 9/22 ≥ 0.30 (ARMED) at both checks; no `refresh-sr-zones` invocation in the window | **PASS** |
| HC-14 | **B1 harness fix proof** — `--step 600`, EXCEPTIONS **0 of 23**, and post-conviction templates appear for the first time: confidence gate 19, blocked-hour 2, counter-trend confirmation 1, zone-confluence quality gate 1 | **PASS** |
| HC-15 | **A/B pair, `--step 25`, same pinned tape** — arm A `allowShortSignals=true`: 542 attempts, **8 emissions**, EXCEPTIONS 0. Arm B `false`: 542 attempts, **4 emissions**, EXCEPTIONS 0. Identical WS distribution (mean 0.5748, pass 269/539 = 49.9%) and byte-identical rejection profiles | **PASS** |
| HC-16 | **Execution-cost impact** (n=339 with a real \|entry−sl\| distance): EV +0.0714R at \$0.00, +0.0618R at \$0.05, **+0.0331R at \$0.20**; mean cost 0.0382R; breakeven round-trip **\$0.373** | **PASS** |
| HC-17 | **NaN drift root cause**: 287 of 401 `trade_outcomes_v1` rows carry a COMPLETELY EMPTY `features` object; only 114 have `rsi`/`atr`/`volumeRatio`/`dxyChange`. Denominator is `historicalImportance + 0.01` ≥ 0.01, so division-by-zero is impossible | **PASS — absent features, not bad arithmetic** |
| HC-18 | **Resolver-window divergence 8h vs 24h**, 120 most recent candidates of 400: first terminal event inside 8h **118**, in the 8h..24h band **0**, none within 24h **2** → divergence **0/120 = 0.00%** | **PASS** |
| HC-19 | **Label layer**: stored WIN 160 vs `realized_r > 0` 136; stored WIN with non-positive R = **24, ALL with `realized_r = NULL`**; stored LOSS with positive R = **0**. All 24 are inside the 61 `direction = NULL` rows (ts `2026-07-01`..`2026-07-06`, all 61 present in `emitted_signals_v1`) | **PASS — SL_AFTER_BE REFUTED** |
| HC-20 | **Corpus pagination**: `OUTCOMES_PAGE_SIZE = 500`, PostgREST cap 1000, caller limit **300** → 300 < 500 → one page. The cap was a caller argument, never a PostgREST limit | **PASS — root cause established** |

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
| **F-5** | **FIXED 2026-08-17 (B7).** `useDynamicSL` default flipped TRUE → **FALSE** at `TradingContext.tsx:54`, matching what Item 19 actually measured. Still toggleable from Settings (`settings.tsx:669`); sanitize at `:363` and the live path at SE:7748 are untouched. | `TradingContext.tsx:54` | **HIGH** — SL geometry | **Was a regression of Item 19** | §3 |
| **F-6** | 16 rows permanently `unresolvable`; resolver `resolved:0` on a live run | resolver response | MEDIUM — silently shrinks the book | Pre-existing | HC-1 |
| **F-7** | **RESOLVED 2026-08-17.** `pg_policies` returns all five policies (HC-10). RLS is configured as intended; my behavioural probe was simply the wrong instrument. | — | — | No | HC-10 |
| **F-8** | **FIXED 2026-08-17 (B8).** Root cause: all 24 disagreeing rows have `realized_r = NULL`, and **zero** rows have a positive R labelled LOSS — so **SL_AFTER_BE is REFUTED** as the cause. F-8 and F-9 are ONE defect. Fix: `canonicalResult()` in `learningStore.ts` now derives the label from the R sign on BOTH the write path (`toRemoteRow`) and the read path (`mapRemoteRow`), so label and R can no longer diverge; a label with no R behind it is logged as `LABEL_WITHOUT_EVIDENCE` instead of passing silently. | `learningStore.ts` `canonicalResult`/`toRemoteRow`/`mapRemoteRow` | MEDIUM | Pre-existing | HC-19 |
| **F-9** | **OPEN (characterised, not fixed).** 61 rows with `direction = NULL` **and** `realized_r = NULL`; ts range `2026-07-01T22:42Z`..`2026-07-06T03:40Z`; all 61 present in `emitted_signals_v1`; none has `pnl = 0` or `entry == exit`. A bounded legacy-writer defect, not an ongoing one — no row after 2026-07-06 has it. Backfilling them is a data migration, out of B8's authorised scope. | `trade_outcomes_v1` | MEDIUM — removes 61 rows from every per-direction split | Pre-existing, bounded | HC-19 |
| **F-10** | `TIER0_UNAVAILABLE` counter was structurally dead in EVERY historical run (harness patched `console.log`; engine emits via `console.warn`) | fixed 2026-08-17 in harness; engine sites `srZoneTier0Service.ts:227`, SE:3594, SE:3599 | HIGH (historical) — every "TIER0_UNAVAILABLE=0 ⇒ comparable" claim rested on a dead instrument | Instrument defect | §7, Correction 7 |
| **F-11** | **CLOSED 2026-08-17.** A/B pair re-run with the zone batch stamp verified identical before and after both arms and no `refresh-sr-zones` call in the window. | — | LOW (process) | New | HC-13 |
| **F-12** | **FIXED 2026-08-17 (B2).** Corpus pull was capped at 300. Root cause was NOT a PostgREST limit: `OUTCOMES_PAGE_SIZE = 500` and the cap is 1000, but the CALLER passed `{ limit: 300 }` (SE:7080) and the parameter default was also 300 (`learningStore.ts:996`) — 300 < 500, so the loop exited after one page. `MAX_STORED_OUTCOMES = 300` was a second, independent truncation of the merged corpus. Now `CORPUS_PULL_LIMIT = 5000` and `MAX_STORED_OUTCOMES = 2000`. The `truncatedByLimit` flag is retained — it is the only reason this was visible. | SE:307, SE:7080 | **HIGH** — starved the learner of ~100 resolved outcomes and capped every corpus/drift/retrain claim at 300 | Pre-existing | HC-20 |
| **F-13** | **OPEN — THE ML LAYER IS DEAD (confirmed, no longer provisional).** Last training `2026-08-11T12:06:34Z`, corpus size at training **53**, `rsi_weight = -1.000000` (re-pinned at the extreme, not Item 64's −0.684). Modulation `1 + 2.5(−1.000) = −1.5` → clamped to **0** by `LEARNED_MODULATION_MIN`, so the RSI family contributes exactly zero to live scoring. The training PREDATES Item 64, so the widened `CONSUMED_MODEL_WEIGHTS` set has NEVER been exercised by a retrain. Diagnosis in §5/C1; no weight or trigger changed (report-only). | `learningStore` weights; SE:322/335/336 | **CRITICAL** for accuracy | Pre-existing | C1 |
| **F-14** | **FIXED 2026-08-17 (B4).** NaN drift was classified CRITICAL (`NaN < 0.3` false, `NaN < 0.6` false → else-branch), permanently pinning "Retraining recommended: YES" and making Item 64(c)'s per-feature trigger unable to discriminate. Root cause measured first: **287 of 401 corpus rows carry a COMPLETELY EMPTY `features` object**; only 114 have `rsi`/`atr`/`volumeRatio`/`dxyChange`. Not division by zero — the denominator is `historicalImportance + 0.01` ≥ 0.01, and `sentiment` (the one feature read through a `?? 0` guard) was the one feature that stayed finite. New `INSUFFICIENT_DATA` status; excluded from the retrain trigger. | SE:5065-5135, SE:6797; `types/trading.ts:347` | **HIGH** | Pre-existing | HC-17 |
| **F-15** | **FIXED 2026-08-17 (B3).** All 40 push failures were Postgres `21000 "ON CONFLICT DO UPDATE command cannot affect row a second time"` — one duplicated `signal_id` in a batch fails the whole 50-row chunk. The existing dedupe at `:431-439` was insufficient: it ran on the outcome OBJECTS rather than the ROWS actually sent, and it kept the FIRST occurrence (the stale queued copy) over the fresh one. Now deduped at the network boundary on `String(row.signal_id)`, keeping the LAST occurrence, with a `BATCH_DEDUPE` warning. Queue/retry semantics unchanged; failed-chunk queueing now resolves by `signal_id` instead of a positional slice. | `learningStore.ts` pre-upsert | **HIGH** — blocked corpus writes | Pre-existing | B3 |
| **F-16** | **OPEN — reconcile block is self-inconsistent.** `local=100 / remote=300 / local_only=83 / remote_only=289` implies 17 shared from one side and 11 from the other, and contradicts SECTION 2's own "local corpus total after last hydrate: 300" two lines above. Diagnosis in §5/C2. Report-only this round. | `learningStore.ts:1070-1085` | MEDIUM | Pre-existing | C2 |
| **F-17** | **OPEN — F6 criterion 4 is REFUTED on its own pre-registered threshold.** Stand-aside rate **5.40%** (1,427 / 26,414) against the project's own 5% refutation line, up from 2.37% on 13 Aug. Threshold deliberately NOT changed. Diagnosis in §5/C3. | SE:2353; `diagnosticsExport.ts:713-745` | **HIGH** — directional layer status | Newly crossed | C3 |
| **F-19** | **OPEN — unaccounted TIER_0 fallback.** SECTION 7 warns "0 failed read(s), 1 generation pass fell back to TIER_1_LOCAL" while every failure-reason counter reads 0. Cause identified: `maybeRefreshTier0SRZones()` is throttled and **fire-and-forget** (SE:3564-3600), so `tier0SRZones` is still `null` on the first pass(es) before the very first fetch resolves. `detectSRZones` then takes the `tier0Fresh === false` branch (SE:3637-3652) and calls `recordTier0FallbackUse()` — which increments `tier1FallbackUses` — while `recordFailure()` was never reached, so no reason counter moved. A cold-start fallback, not a read failure. | SE:3564-3652; `srZoneTier0Service.ts:143` | MEDIUM | Pre-existing | C4 |

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
