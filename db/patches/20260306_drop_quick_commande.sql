-- 20260306_drop_quick_commande.sql
--
-- Purpose
-- - Remove the quick-commande persistence tables (feature removed from code).
--
-- Safety
-- - Idempotent: safe to run multiple times.

BEGIN;

DROP TABLE IF EXISTS public.quick_commande_confirmations CASCADE;
DROP TABLE IF EXISTS public.quick_commande_previews CASCADE;

COMMIT;
