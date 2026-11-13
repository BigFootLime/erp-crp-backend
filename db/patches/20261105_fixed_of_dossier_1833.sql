-- User-authorized dossier completion: keep the OF revision, protect frozen snapshots.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE public.pieces_techniques_achats ADD COLUMN IF NOT EXISTS gamme_operation_id uuid
  REFERENCES public.pieces_techniques_operations(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS pt_achats_operation_1833_idx ON public.pieces_techniques_achats(gamme_operation_id) WHERE gamme_operation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_guard_version_purchase_712() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v public.piece_technique_versions; target uuid;
BEGIN
 target:=CASE WHEN TG_OP='DELETE' THEN OLD.piece_technique_version_id ELSE NEW.piece_technique_version_id END;
 IF TG_OP='UPDATE' AND OLD.piece_technique_version_id IS NOT NULL AND OLD.piece_technique_version_id IS DISTINCT FROM NEW.piece_technique_version_id THEN
  RAISE EXCEPTION 'PURCHASE_VERSION_IMMUTABLE: copier la ligne dans le nouveau dossier' USING ERRCODE='23514';
 END IF;
 IF target IS NOT NULL THEN
  SELECT * INTO v FROM public.piece_technique_versions WHERE id=target FOR UPDATE;
  IF v.id IS NULL OR v.piece_technique_id IS DISTINCT FROM (CASE WHEN TG_OP='DELETE' THEN OLD.piece_technique_id ELSE NEW.piece_technique_id END) THEN
   RAISE EXCEPTION 'PURCHASE_VERSION_SCOPE: dossier étranger à la pièce' USING ERRCODE='23514';
  END IF;
  IF v.statut='OBSOLETE' THEN RAISE EXCEPTION 'PURCHASE_VERSION_LOCKED: ancien dossier en lecture seule' USING ERRCODE='23514'; END IF;
  IF TG_OP<>'DELETE' AND NEW.gamme_operation_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM public.pieces_techniques_operations o JOIN public.gammes g ON g.id=o.gamme_id
   WHERE o.id=NEW.gamme_operation_id AND o.piece_technique_id=v.piece_technique_id AND g.piece_technique_version_id=target
     AND o.type_operation='SOUS_TRAITANCE' AND NEW.type_achat='TRAITEMENT' AND NEW.phase=o.phase
  ) THEN RAISE EXCEPTION 'PURCHASE_OPERATION_SCOPE: opération incompatible avec le dossier' USING ERRCODE='23514'; END IF;
  UPDATE public.piece_version_preparation SET approved_source_hash=NULL,approved_at=NULL,approved_by=NULL,version=version+1,updated_at=now() WHERE piece_technique_version_id=target;
  UPDATE public.ordres_fabrication SET technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,updated_at=now()
   WHERE piece_technique_id=v.piece_technique_id AND statut='BROUILLON' AND technical_snapshot_sha256 IS NULL
     AND COALESCE(NULLIF(technical_preparation->>'selected_version_id','')::uuid,NULLIF(technical_preparation->>'selected_draft_version_id','')::uuid,piece_technique_version_id)=target;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sync_purchase_operation_1833() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phase IS DISTINCT FROM OLD.phase THEN
  UPDATE public.pieces_techniques_achats SET phase=NEW.phase WHERE gamme_operation_id=NEW.id AND phase IS DISTINCT FROM NEW.phase;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_purchase_operation_1833 ON public.pieces_techniques_operations;
CREATE TRIGGER sync_purchase_operation_1833 AFTER UPDATE OF phase ON public.pieces_techniques_operations
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_purchase_operation_1833();

ALTER TABLE public.pieces_techniques_operations DROP CONSTRAINT IF EXISTS pt_operations_taux_source_ck;
ALTER TABLE public.pieces_techniques_operations ADD CONSTRAINT pt_operations_taux_source_ck
 CHECK(taux_horaire_source IS NULL OR taux_horaire_source IN ('CENTRE_FRAIS','HISTORIQUE_LEGACY','ABSENT','OPERATION'));

-- Identity is pinned; technical completeness is still validated before freezing.
UPDATE public.ordres_fabrication o SET technical_preparation=COALESCE(o.technical_preparation,'{}'::jsonb)||jsonb_build_object(
 'version_selection_mode','MANUAL','selected_version_id',COALESCE(NULLIF(o.technical_preparation->>'selected_version_id',''),NULLIF(o.technical_preparation->>'selected_draft_version_id',''),o.piece_technique_version_id::text)),updated_at=now()
 WHERE o.statut='BROUILLON' AND o.technical_snapshot_sha256 IS NULL AND COALESCE(o.technical_readiness,'')<>'VALIDATED' AND COALESCE(o.technical_preparation->>'version_selection_mode','AUTO')<>'MANUAL'
 AND COALESCE(NULLIF(o.technical_preparation->>'selected_version_id',''),NULLIF(o.technical_preparation->>'selected_draft_version_id',''),o.piece_technique_version_id::text) IS NOT NULL;

-- Add the final-client link to already issued active PS articles, without removing existing links.
INSERT INTO public.article_client_links(article_id,client_id,created_by)
 SELECT a.id,p.client_id,a.created_by FROM public.articles a JOIN public.articles_traitement t ON t.article_id=a.id
 JOIN public.pieces_techniques p ON p.id=t.piece_technique_id WHERE a.is_active AND a.article_category='traitement' AND p.client_id IS NOT NULL
 ON CONFLICT DO NOTHING;
UPDATE public.articles a SET commercial_scope='CLIENTS',updated_at=now()
 FROM public.articles_traitement t JOIN public.pieces_techniques p ON p.id=t.piece_technique_id
 WHERE a.id=t.article_id AND a.is_active AND p.client_id IS NOT NULL AND a.commercial_scope IS DISTINCT FROM 'CLIENTS';
COMMIT;
