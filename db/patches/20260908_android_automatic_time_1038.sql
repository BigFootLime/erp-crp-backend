-- New explicit activity only: no historical pointage is reclassified.
BEGIN;
INSERT INTO public.production_activity_categories(code,label,counts_operator_time,counts_machine_time,is_productive,legacy_time_type,sort_order)
VALUES('AUTO_MACHINE','Machine en automatique',false,true,true,'MACHINE',25) ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.production_activity_categories WHERE code='AUTO_MACHINE' AND
   (counts_operator_time OR NOT counts_machine_time OR legacy_time_type IS DISTINCT FROM 'MACHINE')) THEN
   RAISE EXCEPTION 'AUTO_MACHINE already exists with incompatible accounting; manual review required';
 END IF;
END $$;
ALTER TABLE public.production_activity_categories ADD CONSTRAINT cerp_automatic_accounting
 CHECK(code<>'AUTO_MACHINE' OR (NOT counts_operator_time AND counts_machine_time AND legacy_time_type='MACHINE'));
ALTER TABLE public.production_pointages ADD CONSTRAINT cerp_automatic_machine_required
 CHECK(activity_code IS DISTINCT FROM 'AUTO_MACHINE' OR (machine_id IS NOT NULL AND time_type='MACHINE'));
DROP INDEX IF EXISTS public.production_pointages_running_operator_uniq;
CREATE UNIQUE INDEX production_pointages_running_operator_uniq ON public.production_pointages(operator_user_id)
 WHERE status='RUNNING' AND activity_code IS DISTINCT FROM 'AUTO_MACHINE';
-- Keep the historical tolerance of existing overlaps if the original exclusion
-- was not installed. New active personal segments still have the unique index.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.production_pointages'::regclass AND conname='production_pointages_operator_no_overlap') THEN
  ALTER TABLE public.production_pointages DROP CONSTRAINT production_pointages_operator_no_overlap;
  ALTER TABLE public.production_pointages ADD CONSTRAINT production_pointages_operator_no_overlap
   EXCLUDE USING gist(operator_user_id WITH =,tstzrange(start_ts,COALESCE(end_ts,'infinity'::timestamptz),'[)') WITH &&)
   WHERE(status IN('RUNNING','DONE') AND activity_code IS DISTINCT FROM 'AUTO_MACHINE');
 END IF;
END $$;
COMMIT;
