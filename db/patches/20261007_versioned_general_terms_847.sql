-- Approved source PDFs stay in the existing GED; selections are append-only.
INSERT INTO public.ged_document_classes
 (class_key,domain,label,nature,allowed_mime_types,allowed_extensions,max_size_bytes,approvals_required,retention_months,hold_on_publish,is_active)
VALUES
 ('CERP_CGV','COMMERCIAL','Conditions générales de vente CERP','SOURCE',ARRAY['application/pdf'],ARRAY['pdf'],10485760,1,NULL,true,true),
 ('CERP_CGA','COMMERCIAL','Conditions générales d’achat CERP','SOURCE',ARRAY['application/pdf'],ARRAY['pdf'],10485760,1,NULL,true,true)
ON CONFLICT (class_key) DO NOTHING;

CREATE TABLE public.commercial_general_terms_selections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 entity_type text NOT NULL CHECK(entity_type IN ('devis','commande-client','commande-fournisseur')),
 entity_id text NOT NULL CHECK(length(entity_id) BETWEEN 1 AND 160),
 revision integer NOT NULL CHECK(revision>0),
 document_id uuid NOT NULL REFERENCES public.ged_documents(id) ON DELETE RESTRICT,
 version_id uuid NOT NULL REFERENCES public.ged_document_versions(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 idempotency_key uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 UNIQUE(entity_type,entity_id,revision)
);
CREATE TRIGGER commercial_general_terms_immutable_847 BEFORE UPDATE OR DELETE
 ON public.commercial_general_terms_selections FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
GRANT SELECT,INSERT ON public.commercial_general_terms_selections TO cerp_app;

-- Extend the audited vocabulary without dropping any earlier event category.
DO $$
DECLARE prior_definition text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior_definition FROM pg_constraint
 WHERE conrelid='public.ged_access_events'::regclass AND conname='ged_access_events_event_type_check';
 IF prior_definition IS NULL THEN RAISE EXCEPTION 'GED access event constraint missing'; END IF;
 ALTER TABLE public.ged_access_events DROP CONSTRAINT ged_access_events_event_type_check;
 EXECUTE 'ALTER TABLE public.ged_access_events ADD CONSTRAINT ged_access_events_event_type_check CHECK (('
   ||prior_definition||') OR event_type IN (''GENERAL_TERMS_SELECTED'',''GENERAL_TERMS_DOWNLOADED''))';
END $$;
