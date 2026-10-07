-- Durable supplierless demand. This ledger is neither a stock nor an order allocation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.production_purchase_preparations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL UNIQUE CHECK(scope_key ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('MATIERE','CONSOMMABLE')),
  mode text NOT NULL CHECK(mode IN ('OF','GLOBAL_PACK')),
  of_id bigint REFERENCES public.ordres_fabrication(id),
  source_ref uuid,
  need_id uuid REFERENCES public.of_material_needs(id),
  article_id uuid REFERENCES public.articles(id),
  destination_id uuid REFERENCES public.magasins(id),
  supplier_id uuid REFERENCES public.fournisseurs(id),
  technical_version_id uuid REFERENCES public.piece_technique_versions(id),
  technical_hash text CHECK(technical_hash IS NULL OR technical_hash ~ '^[a-f0-9]{64}$'),
  of_revision_id uuid REFERENCES public.of_revisions(id),
  designation text NOT NULL,
  unit text,
  missing_qty numeric(18,3) CHECK(missing_qty IS NULL OR missing_qty>=0),
  ordered_qty numeric(18,3) CHECK(ordered_qty IS NULL OR ordered_qty>=0),
  status text NOT NULL CHECK(status IN ('A_COMPLETER','A_COMMANDER','COUVERTE','PERIMEE')),
  actions jsonb NOT NULL CHECK(jsonb_typeof(actions)='array'),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  source_version text NOT NULL CHECK(source_version ~ '^[a-f0-9]{64}$'),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_by integer NOT NULL REFERENCES public.users(id),
  updated_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((mode='OF' AND of_id IS NOT NULL AND source_ref IS NOT NULL)
     OR (mode='GLOBAL_PACK' AND kind='CONSOMMABLE' AND of_id IS NULL AND source_ref IS NULL AND need_id IS NULL AND article_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS production_purchase_preparations_of_idx ON public.production_purchase_preparations(of_id,kind,status);
CREATE INDEX IF NOT EXISTS production_purchase_preparations_article_idx ON public.production_purchase_preparations(article_id,status);
CREATE OR REPLACE TRIGGER production_purchase_preparations_no_delete BEFORE DELETE ON public.production_purchase_preparations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TABLE IF NOT EXISTS public.production_purchase_preparation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preparation_id uuid NOT NULL REFERENCES public.production_purchase_preparations(id),
  actor_id integer NOT NULL REFERENCES public.users(id),
  event_type text NOT NULL CHECK(event_type IN ('PREPARED','REFRESHED','SUPERSEDED')),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_purchase_preparation_events_parent_idx ON public.production_purchase_preparation_events(preparation_id,created_at,id);
CREATE OR REPLACE TRIGGER production_purchase_preparation_events_immutable BEFORE UPDATE OR DELETE ON public.production_purchase_preparation_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_purchase_preparations OWNER TO cerp_app;
ALTER TABLE public.production_purchase_preparation_events OWNER TO cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.production_purchase_preparations TO cerp_app;
GRANT SELECT,INSERT ON public.production_purchase_preparation_events TO cerp_app;
COMMIT;
