-- ROLLBACK for 20260709_hr_time_events_append_only.sql   (SUPERUSER ONLY)
--
-- Restaure l'état mutable : cerp_app redevient owner de hr_time_events avec tous les
-- privilèges, et le trigger/fonction append-only sont retirés.
--
--   sudo -u postgres psql -d <db> -f db/privileged/20260709_hr_time_events_append_only.rollback.sql
--
-- Non destructif : aucune ligne n'est modifiée ni supprimée.

BEGIN;

DROP TRIGGER IF EXISTS trg_hr_time_events_no_update ON public.hr_time_events;
DROP TRIGGER IF EXISTS trg_hr_time_events_no_delete ON public.hr_time_events;
DROP TRIGGER IF EXISTS trg_hr_time_events_no_truncate ON public.hr_time_events;
DROP FUNCTION IF EXISTS public.hr_time_events_prevent_mutation();

DO $rb$
BEGIN
  IF to_regclass('public.hr_time_events') IS NULL THEN
    RAISE NOTICE 'rollback: public.hr_time_events absente — rien à faire';
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE public.hr_time_events OWNER TO cerp_app';
  EXECUTE 'GRANT ALL ON public.hr_time_events TO cerp_app';
END
$rb$;

COMMIT;
