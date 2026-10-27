BEGIN;

ALTER TABLE public.bon_livraison
  ADD COLUMN IF NOT EXISTS intercompany_request_id uuid
    REFERENCES public.cerp_intercompany_requests(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS intercompany_destination_snapshot jsonb;

ALTER TABLE public.bon_livraison
  DROP CONSTRAINT IF EXISTS bon_livraison_intercompany_destination_snapshot_ck;
ALTER TABLE public.bon_livraison
  ADD CONSTRAINT bon_livraison_intercompany_destination_snapshot_ck CHECK (
    (intercompany_request_id IS NULL AND intercompany_destination_snapshot IS NULL)
    OR (
      intercompany_request_id IS NOT NULL
      AND jsonb_typeof(intercompany_destination_snapshot) = 'object'
      AND intercompany_destination_snapshot ? 'recipient_name'
      AND intercompany_destination_snapshot ? 'address_line_1'
      AND intercompany_destination_snapshot ? 'postal_code'
      AND intercompany_destination_snapshot ? 'city'
    )
  );

CREATE OR REPLACE FUNCTION public.fn_guard_bon_livraison_intercompany_destination_1454()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.intercompany_request_id IS NOT NULL
     AND (NEW.intercompany_request_id, NEW.intercompany_destination_snapshot)
       IS DISTINCT FROM (OLD.intercompany_request_id, OLD.intercompany_destination_snapshot) THEN
    RAISE EXCEPTION 'Intercompany delivery destination snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_bon_livraison_intercompany_destination_1454 ON public.bon_livraison;
CREATE TRIGGER trg_guard_bon_livraison_intercompany_destination_1454
BEFORE UPDATE OF intercompany_request_id, intercompany_destination_snapshot ON public.bon_livraison
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_bon_livraison_intercompany_destination_1454();

CREATE INDEX IF NOT EXISTS bon_livraison_intercompany_request_1454_idx
  ON public.bon_livraison(intercompany_request_id)
  WHERE intercompany_request_id IS NOT NULL;

COMMIT;
