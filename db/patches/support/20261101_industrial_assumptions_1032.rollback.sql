BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.industrial_pic_targets) OR EXISTS(SELECT 1 FROM public.industrial_policies WHERE transit_calendar_days IS NOT NULL) OR EXISTS(SELECT 1 FROM public.industrial_contract_rules WHERE use_history) THEN RAISE EXCEPTION 'Retain PIC configuration before rollback'; END IF; END $$;
DROP TABLE public.industrial_pic_targets;
ALTER TABLE public.industrial_contract_rules DROP COLUMN use_history;
ALTER TABLE public.industrial_policies DROP COLUMN transit_calendar_days;
COMMIT;
