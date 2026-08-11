-- ITEM 52(a): emitted_signals_v1 — durable server-side record of EMITTED signals.
--
-- WHY THIS TABLE EXISTS. Corpus capture is 12.9% (51 durable rows / 396 emitted
-- signals). Item 49 assumed the cause was client-side RESOLUTION. It is not: the
-- cause is that EMISSION is never persisted anywhere server-side. The 396-signal
-- population exists only inside a client-side diagnostics export, so a resolver
-- has nothing to replay. Persisting every emission is the prerequisite for any
-- durable resolver, and it is what lifts capture toward 100%.
--
-- Deliberately mirrors shadow_signals_v1 (migration 001 + 003), which has been
-- writing reliably from the live client via the anon key since 2026-07-31 and
-- holds 413 rows. Same shape, same RLS posture, same write path — the only
-- proven durable client->Supabase pattern in this project.
--
-- DIFFERENCES from shadow_signals_v1, all deliberate:
--   * `source` column from the start (LIVE / SIMULATION / BACKFILL) so synthetic
--     and backfilled rows can never be silently mixed into a live corpus
--     measurement. Item 40 (weight contamination) is exactly what happens when
--     provenance is not recorded at write time.
--   * `direction` accepts BUY and SELL (shadow_signals_v1 is CHECK'd to SELL).
--   * UNIQUE on signal_id so the resolver and client can both upsert idempotently
--     without creating duplicate or conflicting rows.

CREATE TABLE IF NOT EXISTS public.emitted_signals_v1 (
  id              BIGSERIAL PRIMARY KEY,
  signal_id       TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  emitted_at      TIMESTAMPTZ NOT NULL,
  direction       TEXT        NOT NULL,
  entry           NUMERIC(10,1) NOT NULL,
  sl              NUMERIC(10,1) NOT NULL,
  tp1             NUMERIC(10,1) NOT NULL,
  tp2             NUMERIC(10,1) NOT NULL,
  tp3             NUMERIC(10,1) NOT NULL,
  confidence      NUMERIC(5,4)  NOT NULL,
  raw_confidence  NUMERIC(5,4),
  strength_diff   NUMERIC(6,4),
  sl_multiplier   NUMERIC(4,2),
  atr             NUMERIC(10,2),
  regime          TEXT,
  session_name    TEXT,
  hour_utc        INTEGER,
  htf_trend       TEXT,
  ltf_trend       TEXT,
  rsi             NUMERIC(6,2),
  sr_zones_snapshot JSONB,
  attention_scores  JSONB,
  -- Provenance. LIVE = real emission from the app; SIMULATION = sandbox/sim run;
  -- BACKFILL = reconstructed from a historical client-side export.
  source          TEXT        NOT NULL DEFAULT 'LIVE',
  feature_schema_version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT emitted_signals_direction_check CHECK (direction IN ('BUY', 'SELL')),
  CONSTRAINT emitted_signals_source_check CHECK (source IN ('LIVE', 'SIMULATION', 'BACKFILL'))
);

-- Idempotent upserts from both the client and the resolver.
CREATE UNIQUE INDEX IF NOT EXISTS uq_emitted_signals_signal_id
  ON public.emitted_signals_v1 (signal_id);

CREATE INDEX IF NOT EXISTS idx_emitted_signals_emitted_at
  ON public.emitted_signals_v1 (emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_emitted_signals_source
  ON public.emitted_signals_v1 (source);
CREATE INDEX IF NOT EXISTS idx_emitted_signals_session
  ON public.emitted_signals_v1 (session_name);

ALTER TABLE public.emitted_signals_v1 ENABLE ROW LEVEL SECURITY;

-- Same posture as shadow_signals_v1 after migration 003: anon may SELECT and
-- INSERT (the live client write path uses the public anon key), but NOT UPDATE
-- or DELETE, so a hostile client cannot alter or remove existing rows.
CREATE POLICY "emitted_signals_select_all" ON public.emitted_signals_v1
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "emitted_signals_insert_anon" ON public.emitted_signals_v1
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ── ITEM 52(d): pg_cron schedule for the resolver Edge Function ──────────────
-- Mirrors the refresh-sr-zones scheduling pattern: pg_cron + pg_net, no Rork
-- backend in the path. Run AFTER deploying the resolve-emitted-signals function.
-- Replace <PROJECT_REF> and <SERVICE_ROLE_KEY> before running.
--
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- CREATE EXTENSION IF NOT EXISTS pg_net;
--
-- SELECT cron.schedule(
--   'resolve-emitted-signals',
--   '*/15 * * * *',
--   $$
--   SELECT net.http_post(
--     url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/resolve-emitted-signals',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
--     body    := '{}'::jsonb
--   );
--   $$
-- );
