-- #896. No terminal, PIN or production data is created by this patch.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.cerp_terminals DROP CONSTRAINT cerp_terminals_kind_check;
ALTER TABLE public.cerp_terminals ADD CONSTRAINT cerp_terminals_kind_check
  CHECK(kind IN('OPERATOR','TOOLING','MATERIAL','ARTICLES','RECEPTION','OF_PROCUREMENT','CUTTING')) NOT VALID;
ALTER TABLE public.cerp_terminals VALIDATE CONSTRAINT cerp_terminals_kind_check;
COMMIT;
