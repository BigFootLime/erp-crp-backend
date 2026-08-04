-- Repli destructif uniquement pour les donnees de CE patch. Sauvegarder avant execution.
BEGIN;

DROP TRIGGER IF EXISTS trg_margin_recalculations_append_only ON public.margin_recalculations;
DROP TRIGGER IF EXISTS trg_margin_input_versions_append_only ON public.margin_input_versions;
DROP TRIGGER IF EXISTS trg_margin_rates_append_only ON public.margin_rates;
DROP TRIGGER IF EXISTS trg_margin_rate_versions_append_only ON public.margin_rate_versions;

DROP TABLE IF EXISTS public.margin_recalculations;
DROP TABLE IF EXISTS public.margin_input_versions;
DROP TABLE IF EXISTS public.margin_rates;
DROP TABLE IF EXISTS public.margin_rate_versions;
DROP FUNCTION IF EXISTS public.fn_margin_append_only();

COMMIT;
