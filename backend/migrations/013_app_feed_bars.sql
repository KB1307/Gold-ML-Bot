-- ITEM 214 / PHASE C-C1 — APP-FEED M1 BAR CAPTURE (fix prerequisite, additive only).
--
-- C1 MEASUREMENT (expo/artifacts/item214_venue_basis_run.txt, 2026-08-24):
-- the entry stamp (app feed) vs the Vantage bar close at the emission minute:
--   LIVE, current 25-pip ladder era (n=24): median |basis| = 28.4% of TP1
--   → pre-registered 20% structural threshold EXCEEDED.
--   The two failed 2026-08-24 BUYs: basis −$1.29 = 51.6% of TP1 and
--   +$1.38 = 55.2% of TP1 — a direct mechanical contribution to their SL hits.
-- The zone map is built in the VANTAGE frame; entries execute in the APP frame;
-- the frames disagree by a median $0.68 (p90 $1.52) while TP1 is $2.50.
--
-- WHY A TABLE, NOT AN IMMEDIATE FIX: whether the basis is a persistent level
-- (translatable into the zone map) or white noise (NOT translatable — a rigid
-- translation would add noise) is currently UNMEASURABLE because no durable
-- app-feed bar history exists. This table is that instrument. Once ~2 weeks of
-- app-feed bars accrue: measure basis autocorrelation/half-life; if persistent,
-- ship the frame translation with a pre-registered gate; if white noise, the
-- fix is single-venue geometry (widen TP1 beyond cross-venue noise or move the
-- whole stack to one venue).
--
-- WHAT THIS DOES NOT CHANGE: zero scoring change. The capture is write-only,
-- fire-and-forget, off the signal path. RLS mirrors the proven shadow_signals
-- anon-insert pattern (migration 003).

CREATE TABLE IF NOT EXISTS public.app_m1_bars (
  id          BIGSERIAL PRIMARY KEY,
  timestamp   TIMESTAMPTZ NOT NULL,
  open        NUMERIC(10,2) NOT NULL,
  high        NUMERIC(10,2) NOT NULL,
  low         NUMERIC(10,2) NOT NULL,
  close       NUMERIC(10,2) NOT NULL,
  source      TEXT NOT NULL DEFAULT 'APP_FEED',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_m1_bars_source_check CHECK (source IN ('APP_FEED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_m1_bars_timestamp
  ON public.app_m1_bars (timestamp);

CREATE INDEX IF NOT EXISTS idx_app_m1_bars_ts
  ON public.app_m1_bars (timestamp DESC);

ALTER TABLE public.app_m1_bars ENABLE ROW LEVEL SECURITY;

-- Idempotent (CREATE POLICY has no IF NOT EXISTS — Item 70 note).
DROP POLICY IF EXISTS "app_m1_bars_insert_anon" ON public.app_m1_bars;
DROP POLICY IF EXISTS "app_m1_bars_select_all" ON public.app_m1_bars;

CREATE POLICY "app_m1_bars_insert_anon" ON public.app_m1_bars
  FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "app_m1_bars_select_all" ON public.app_m1_bars
  FOR SELECT TO anon, authenticated USING (true);

COMMENT ON TABLE public.app_m1_bars IS
  'ITEM 214 / PHASE C-C1: 1-minute OHLC bars aggregated from the APP FEED (the venue entries actually execute on). gold_m1_bars is the Vantage MT5 feed the zone map is built from; measured cross-venue basis is 28.4% of TP1 (median) on the current ladder — this table is the prerequisite instrument for rebuilding the zone map on the entry venue and for measuring basis persistence.';
