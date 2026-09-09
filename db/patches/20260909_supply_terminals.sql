-- #1047. Requires the opt-in terminal foundation #1038. No PIN or device is backfilled.
BEGIN;
ALTER TABLE public.cerp_terminals DROP CONSTRAINT cerp_terminals_kind_check;
ALTER TABLE public.cerp_terminals ADD CONSTRAINT cerp_terminals_kind_check
  CHECK(kind IN('OPERATOR','TOOLING','MATERIAL','ARTICLES','RECEPTION','OF_PROCUREMENT')) NOT VALID;
ALTER TABLE public.cerp_terminals VALIDATE CONSTRAINT cerp_terminals_kind_check;
ALTER TABLE public.cerp_terminals ADD CONSTRAINT cerp_terminals_warehouse_fk
  FOREIGN KEY(warehouse_id) REFERENCES public.magasins(id) NOT VALID;
ALTER TABLE public.cerp_terminals VALIDATE CONSTRAINT cerp_terminals_warehouse_fk;
COMMIT;
