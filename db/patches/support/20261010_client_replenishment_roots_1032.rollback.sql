-- Only an unused installation can be removed. OFs and evidence are never deleted here.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.client_contract_replenishment_roots,public.client_contract_replenishment_launches IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots)
    OR EXISTS(SELECT 1 FROM public.client_contract_replenishment_launches) THEN
    RAISE EXCEPTION 'Replenishment launch evidence exists; rollback forbidden';
  END IF;
END $$;
DROP TABLE public.client_contract_replenishment_roots;
DROP TABLE public.client_contract_replenishment_launches;
DROP FUNCTION public.fn_client_replenishment_root_identity_1032();
COMMIT;
