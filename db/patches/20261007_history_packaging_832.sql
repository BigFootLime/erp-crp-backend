-- Additive historical evidence and explicit packaging for newly prepared dossiers.
ALTER TABLE public.pieces_techniques_operations ALTER COLUMN tp TYPE numeric(16,6), ALTER COLUMN tf_unit TYPE numeric(16,6);
ALTER TABLE public.piece_technique_versions ADD COLUMN IF NOT EXISTS copied_from_version_id uuid REFERENCES public.piece_technique_versions(id);
ALTER TABLE public.piece_technique_versions ADD COLUMN IF NOT EXISTS change_level text NOT NULL DEFAULT 'MAJOR' CHECK(change_level IN('MAJOR','MINOR'));
ALTER TABLE public.piece_technique_versions ADD COLUMN IF NOT EXISTS packaging_policy jsonb NOT NULL DEFAULT '{"mode":"GLOBAL","lotSize":null}'::jsonb;
ALTER TABLE public.piece_technique_versions ADD CONSTRAINT packaging_policy_832_ck CHECK(
  COALESCE(jsonb_typeof(packaging_policy)='object' AND packaging_policy->>'mode' IN('GLOBAL','UNIT','LOT') AND
  CASE WHEN packaging_policy->>'mode'='LOT' THEN CASE WHEN jsonb_typeof(packaging_policy->'lotSize')='number' THEN (packaging_policy->>'lotSize')::numeric BETWEEN 1 AND 1000000 AND (packaging_policy->>'lotSize')::numeric=trunc((packaging_policy->>'lotSize')::numeric) ELSE false END ELSE packaging_policy->'lotSize'='null'::jsonb END,false));
CREATE TABLE public.old_stock_document_references(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lot_id uuid NOT NULL REFERENCES public.lots(id),
  type text NOT NULL CHECK(type IN('PLAN','CERTIFICAT_MP','CERTIFICAT_TRAITEMENT','CONTROLE','AUTRE')),
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 3 AND 200),location text NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>=10),created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL UNIQUE,request_hash text NOT NULL);
CREATE INDEX old_stock_documents_lot_832_idx ON public.old_stock_document_references(lot_id,created_at);
CREATE TRIGGER old_stock_documents_immutable_832 BEFORE UPDATE OR DELETE ON public.old_stock_document_references FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TABLE public.finished_lot_packaging(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lot_id uuid NOT NULL REFERENCES public.lots(id),of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  policy_snapshot jsonb NOT NULL,portion_quantities jsonb NOT NULL,quantity integer NOT NULL CHECK(quantity>0),technical_hash text NOT NULL,
  reason text NOT NULL,created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),idempotency_key uuid NOT NULL UNIQUE,request_hash text NOT NULL);
CREATE INDEX finished_lot_packaging_lot_832_idx ON public.finished_lot_packaging(lot_id);
CREATE TRIGGER finished_lot_packaging_immutable_832 BEFORE UPDATE OR DELETE ON public.finished_lot_packaging FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TABLE public.finished_packaging_print_intents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),packaging_id uuid NOT NULL REFERENCES public.finished_lot_packaging(id),reason text NOT NULL,created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),idempotency_key uuid NOT NULL UNIQUE);
CREATE TRIGGER finished_packaging_print_immutable_832 BEFORE UPDATE OR DELETE ON public.finished_packaging_print_intents FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
GRANT SELECT,INSERT ON public.old_stock_document_references,public.finished_lot_packaging,public.finished_packaging_print_intents TO cerp_app;
-- Only an approved chain of minor changes permits use of an earlier revision.
-- Stock keeps its physical version; a major boundary is never crossed.
CREATE VIEW public.v_technical_stock_compatibility_832 AS
WITH RECURSIVE compatible(target_version_id,stock_version_id,path) AS (
 SELECT id,id,ARRAY[id] FROM public.piece_technique_versions
 UNION ALL
 SELECT c.target_version_id,source.id,c.path||source.id FROM compatible c
 JOIN public.piece_technique_versions current ON current.id=c.stock_version_id
 JOIN public.piece_technique_versions source ON source.id=current.copied_from_version_id
 WHERE current.change_level='MINOR' AND current.impact_interchangeabilite=false
 AND current.statut IN('APPLICABLE','OBSOLETE') AND source.statut IN('APPLICABLE','OBSOLETE')
 AND current.piece_technique_id=source.piece_technique_id
 AND upper(btrim(current.indice))=upper(btrim(source.indice)) AND NOT source.id=ANY(c.path)
) SELECT target_version_id,stock_version_id FROM compatible;
GRANT SELECT ON public.v_technical_stock_compatibility_832 TO cerp_app;
CREATE TABLE public.finished_packaging_voids(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),packaging_id uuid NOT NULL UNIQUE REFERENCES public.finished_lot_packaging(id),
 reason text NOT NULL CHECK(length(btrim(reason))>=10),created_by integer NOT NULL REFERENCES public.users(id),created_at timestamptz NOT NULL DEFAULT now(),idempotency_key uuid NOT NULL UNIQUE,request_hash text NOT NULL);
CREATE TRIGGER finished_packaging_void_immutable_832 BEFORE UPDATE OR DELETE ON public.finished_packaging_voids FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
GRANT SELECT,INSERT ON public.finished_packaging_voids TO cerp_app;
