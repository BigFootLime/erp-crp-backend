BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.quote_margin_source_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  devis_id bigint NOT NULL REFERENCES public.devis(id) ON DELETE RESTRICT,
  quote_version integer NOT NULL CHECK(quote_version>0),
  line_id bigint REFERENCES public.devis_ligne(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK(scope_type IN ('DEVIS','DEVIS_LINE')),
  scope_ref text NOT NULL,
  capture_kind text NOT NULL CHECK(capture_kind IN ('ISSUED','RECORDED_SENT')),
  input_snapshot jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  captured_by integer REFERENCES public.users(id) ON DELETE RESTRICT,
  UNIQUE(scope_type,scope_ref),
  CHECK((scope_type='DEVIS' AND line_id IS NULL AND scope_ref=devis_id::text)
    OR (scope_type='DEVIS_LINE' AND line_id IS NOT NULL AND scope_ref=line_id::text)),
  CHECK((input_snapshot->>'scope_type') IS NOT DISTINCT FROM scope_type AND (input_snapshot->>'scope_ref') IS NOT DISTINCT FROM scope_ref
    AND (input_snapshot->>'basis') IS NOT DISTINCT FROM 'QUOTED' AND jsonb_typeof(input_snapshot->'costs') IS NOT DISTINCT FROM 'array')
);
CREATE INDEX quote_margin_source_snapshots_quote_idx ON public.quote_margin_source_snapshots(devis_id);
CREATE FUNCTION public.fn_quote_margin_source_guard_941() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Quote margin source snapshots are immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.devis d WHERE d.id=NEW.devis_id AND d.statut::text='ENVOYE'
    AND COALESCE(d.version_number,1)=NEW.quote_version)
    OR (NEW.line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.devis_ligne l WHERE l.id=NEW.line_id AND l.devis_id=NEW.devis_id)) THEN
    RAISE EXCEPTION 'Quote margin capture must match the sent commercial revision' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_margin_source_snapshots_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.quote_margin_source_snapshots FOR EACH ROW EXECUTE FUNCTION public.fn_quote_margin_source_guard_941();
ALTER TABLE public.quote_margin_source_snapshots OWNER TO cerp_app;
ALTER FUNCTION public.fn_quote_margin_source_guard_941() OWNER TO cerp_app;
-- No retrospective reconstruction from today's technical dossier.
COMMIT;
