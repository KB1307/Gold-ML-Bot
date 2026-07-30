-- shadow_signals_v1: durable store of suppressed SELL signals.
-- Service-role writes; RLS SELECT-only for anon/authenticated.
-- Lets the suppression decision be re-evaluated against real forward data.

CREATE TABLE IF NOT EXISTS public.shadow_signals_v1 (
  id              BIGSERIAL PRIMARY KEY,
  signal_id       TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction       TEXT        NOT NULL DEFAULT 'SELL',
  entry           NUMERIC(10,1) NOT NULL,
  sl              NUMERIC(10,1) NOT NULL,
  tp1             NUMERIC(10,1) NOT NULL,
  tp2             NUMERIC(10,1) NOT NULL,
  tp3             NUMERIC(10,1) NOT NULL,
  confidence      NUMERIC(5,4)  NOT NULL,
  entry_shifted   NUMERIC(10,1) NOT NULL,
  sl_shifted      NUMERIC(10,1) NOT NULL,
  tp1_shifted     NUMERIC(10,1) NOT NULL,
  tp2_shifted     NUMERIC(10,1) NOT NULL,
  tp3_shifted     NUMERIC(10,1) NOT NULL,
  sl_multiplier   NUMERIC(4,2)  NOT NULL,
  atr             NUMERIC(10,2) NOT NULL,
  regime          TEXT        NOT NULL,
  session_name    TEXT        NOT NULL,
  hour_utc        INTEGER     NOT NULL,
  sr_zones_snapshot  JSONB,
  attention_scores   JSONB,
  htf_trend       TEXT,
  ltf_trend       TEXT,
  rsi             NUMERIC(6,2),
  feature_schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_shadow_signals_created_at ON public.shadow_signals_v1 (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_signals_hour_utc ON public.shadow_signals_v1 (hour_utc);
CREATE INDEX IF NOT EXISTS idx_shadow_signals_session ON public.shadow_signals_v1 (session_name);

ALTER TABLE public.shadow_signals_v1 ENABLE ROW LEVEL SECURITY;

-- SELECT-only for anon and authenticated; writes via service-role key only.
CREATE POLICY "shadow_signals_select_all" ON public.shadow_signals_v1
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "shadow_signals_no_insert_public" ON public.shadow_signals_v1
  FOR INSERT TO anon, authenticated WITH CHECK (false);

CREATE POLICY "shadow_signals_no_update_public" ON public.shadow_signals_v1
  FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);

CREATE POLICY "shadow_signals_no_delete_public" ON public.shadow_signals_v1
  FOR DELETE TO anon, authenticated USING (false);
