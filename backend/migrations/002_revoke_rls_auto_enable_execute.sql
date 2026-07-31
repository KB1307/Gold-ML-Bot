-- Gate 3 fix: Revoke public execute on the SECURITY DEFINER function rls_auto_enable().
--
-- Supabase's advisor flags that public.rls_auto_enable() is a SECURITY DEFINER
-- function executable by BOTH anon and authenticated roles. A SECURITY DEFINER
-- function runs with the definer's elevated privileges regardless of caller —
-- so a publicly-executable one is a privilege-escalation surface that can bypass
-- the RLS we deliberately set on gold_m1_bars, sr_zones_v1, and shadow_signals_v1.
--
-- This function was auto-created by Supabase's platform (not by our migrations)
-- as an event trigger helper. It is not needed by the application at runtime —
-- it runs at migration/deploy time under the service role. We revoke EXECUTE
-- from PUBLIC, anon, and authenticated so untrusted callers cannot invoke it.
-- The service role (which bypasses RLS entirely) retains access.

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM authenticated;

-- Verify: confirm execute is revoked
-- (run this manually in the Supabase SQL Editor to confirm)
-- SELECT proname, prosecdef, proacl
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE proname = 'rls_auto_enable' AND n.nspname = 'public';
