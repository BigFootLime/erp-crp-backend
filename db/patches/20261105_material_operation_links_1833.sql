BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
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
     AND ((o.type_operation='SOUS_TRAITANCE' AND NEW.type_achat='TRAITEMENT') OR (o.type_operation='DECOUPE' AND NEW.type_achat='MATIERE')) AND NEW.phase=o.phase
  ) THEN RAISE EXCEPTION 'PURCHASE_OPERATION_SCOPE: opération incompatible avec le dossier' USING ERRCODE='23514'; END IF;
  IF TG_OP<>'DELETE' AND NEW.gamme_operation_id IS NOT NULL AND NEW.type_achat='MATIERE' AND NOT EXISTS(SELECT 1 FROM public.articles WHERE id=NEW.article_id AND article_category='matiere') THEN RAISE EXCEPTION 'PURCHASE_MATERIAL_ARTICLE_INVALID: choisir un article matière' USING ERRCODE='23514'; END IF;
  IF TG_OP<>'DELETE' AND NEW.gamme_operation_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.gamme_operation_finitions f WHERE f.gamme_operation_id=NEW.gamme_operation_id AND f.achat_ligne_id=NEW.id AND f.article_id IS DISTINCT FROM NEW.article_id) THEN RAISE EXCEPTION 'PURCHASE_FINISH_ARTICLE_LOCKED: modifier la finition dans la gamme' USING ERRCODE='23514'; END IF;
  UPDATE public.piece_version_preparation SET approved_source_hash=NULL,approved_at=NULL,approved_by=NULL,version=version+1,updated_at=now() WHERE piece_technique_version_id=target;
  UPDATE public.ordres_fabrication SET technical_readiness='INCOMPLETE',technical_submitted_at=NULL,technical_submitted_by=NULL,updated_at=now()
   WHERE piece_technique_id=v.piece_technique_id AND statut='BROUILLON' AND technical_snapshot_sha256 IS NULL
     AND COALESCE(NULLIF(technical_preparation->>'selected_version_id','')::uuid,NULLIF(technical_preparation->>'selected_draft_version_id','')::uuid,piece_technique_version_id)=target;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.fn_sync_purchase_operation_1833() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.type_operation IS DISTINCT FROM OLD.type_operation AND EXISTS(SELECT 1 FROM public.pieces_techniques_achats p WHERE p.gamme_operation_id=NEW.id AND ((p.type_achat='MATIERE' AND NEW.type_operation IS DISTINCT FROM 'DECOUPE') OR (p.type_achat='TRAITEMENT' AND NEW.type_operation IS DISTINCT FROM 'SOUS_TRAITANCE'))) THEN RAISE EXCEPTION 'OPERATION_PURCHASE_LINKED: retirer le rattachement avant de changer le type' USING ERRCODE='23514'; END IF;
 IF NEW.phase IS DISTINCT FROM OLD.phase THEN
  UPDATE public.pieces_techniques_achats SET phase=NEW.phase WHERE gamme_operation_id=NEW.id AND phase IS DISTINCT FROM NEW.phase;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sync_purchase_operation_1833 ON public.pieces_techniques_operations;
CREATE TRIGGER sync_purchase_operation_1833 AFTER UPDATE OF phase,type_operation ON public.pieces_techniques_operations
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_purchase_operation_1833();

COMMIT;
