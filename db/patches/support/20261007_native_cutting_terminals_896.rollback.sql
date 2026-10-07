-- Rehearsal only. Retain the additive kind when rolling back the application.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.cerp_terminals WHERE kind='CUTTING')
 THEN RAISE EXCEPTION 'Native cutting terminal history exists; keep the additive constraint'; END IF;
END $$;
ALTER TABLE public.cerp_terminals DROP CONSTRAINT cerp_terminals_kind_check;
ALTER TABLE public.cerp_terminals ADD CONSTRAINT cerp_terminals_kind_check
 CHECK(kind IN('OPERATOR','TOOLING','MATERIAL','ARTICLES','RECEPTION','OF_PROCUREMENT')) NOT VALID;
ALTER TABLE public.cerp_terminals VALIDATE CONSTRAINT cerp_terminals_kind_check;
ROLLBACK;
