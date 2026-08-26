-- ITEM 224 (Checkpoint A) — MAX FAVOURABLE EXCURSION, SPLIT AT THE EXIT BOUNDARY.
--
-- THE DEFECT THESE COLUMNS REPAIR. Both resolvers deliberately take the ADVERSE
-- side inside a single bar (client signalResolver.ts:293-318 open-distance
-- heuristic; edge resolve-emitted-signals/index.ts:410-470 lock-before-targets),
-- so when one bar spans both the SL-side level and a still-unbanked TP level the
-- TP touch is DISCARDED — currentTargetsHit is forced to 1/2 and the higher
-- target is never recorded. Everything after the terminal bar is discarded too:
-- Item 204 measured 105/151 = 69.5% of SL_AFTER_BE exits reaching TP2+ later in
-- the same 8h window, a fact the corpus could not express.
--
-- WHY FOUR COLUMNS AND NOT TWO. A single MFE that straddles the exit answers
-- neither question. BEFORE-EXIT is CAPTURABLE — it is what a different exit rule
-- could actually have banked, and it is the fork this item was raised to settle.
-- AFTER-EXIT is COUNTERFACTUAL — the position was already closed, so it is
-- evidence about continuation (Item 204), never about realisable P&L. A reader
-- handed one "2.1R" column could not tell which of those they were holding.
-- The boundary is the TERMINAL BAR, inclusive on the before-exit side.
--
-- ORDERING-INDEPENDENT BY CONSTRUCTION. Both pairs are a max/touched-level SCAN
-- over bars. They never guess intra-bar sequence, which is precisely why the two
-- resolvers can compute them IDENTICALLY even though their terminal LABELS
-- legitimately differ on same-bar ambiguity. That divergence class is documented
-- and is NOT addressed here.
--
-- ADDITIVE ONLY. No terminal status, result, exit_price, pnl or realized_r is
-- touched by this migration or by the writers that fill these columns. R
-- accounting is unchanged; the conservative adverse-side rule stays exactly as
-- it is. These columns are OBSERVATIONAL and feed no gate, no score and no
-- ladder.

ALTER TABLE public.trade_outcomes_v1
  ADD COLUMN IF NOT EXISTS max_favourable_target_reached_before_exit SMALLINT;

ALTER TABLE public.trade_outcomes_v1
  ADD COLUMN IF NOT EXISTS max_favourable_excursion_before_exit_r REAL;

ALTER TABLE public.trade_outcomes_v1
  ADD COLUMN IF NOT EXISTS max_favourable_target_after_exit SMALLINT;

ALTER TABLE public.trade_outcomes_v1
  ADD COLUMN IF NOT EXISTS max_favourable_excursion_after_exit_r REAL;

COMMENT ON COLUMN public.trade_outcomes_v1.max_favourable_target_reached_before_exit IS
  'ITEM 224: highest target level (0/1/2/3) touched by a completed bar from entry fill through the TERMINAL BAR INCLUSIVE. CAPTURABLE — this is what a different exit rule could actually have banked. Ordering-independent touched-level scan; never a same-bar sequence guess. Observational: feeds no gate, score or ladder.';

COMMENT ON COLUMN public.trade_outcomes_v1.max_favourable_excursion_before_exit_r IS
  'ITEM 224: max favourable excursion in R units (signed, favourable-positive, GROSS of execution cost) from entry fill through the TERMINAL BAR INCLUSIVE. CAPTURABLE. R basis = |entry - sl| from the emitted row, the same risk denominator realized_r uses.';

COMMENT ON COLUMN public.trade_outcomes_v1.max_favourable_target_after_exit IS
  'ITEM 224: highest target level (0/1/2/3) touched AFTER the terminal bar, through the end of the pinned 8h resolution window. COUNTERFACTUAL — the position was already closed, so this is continuation evidence (Item 204), NOT realisable P&L. Never quote it as capturable.';

COMMENT ON COLUMN public.trade_outcomes_v1.max_favourable_excursion_after_exit_r IS
  'ITEM 224: max favourable excursion in R units AFTER the terminal bar, through the end of the pinned 8h resolution window. COUNTERFACTUAL — continuation evidence only (Item 204). Never quote it as capturable.';
