BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

ALTER TABLE public.gamme_operation_finitions ADD COLUMN IF NOT EXISTS slot smallint NOT NULL DEFAULT 1;
ALTER TABLE public.gamme_operation_finitions DROP CONSTRAINT gamme_operation_finitions_operation_uq;
ALTER TABLE public.gamme_operation_finitions ADD CONSTRAINT gamme_operation_finitions_operation_slot_uq UNIQUE(gamme_operation_id,slot);
ALTER TABLE public.gamme_operation_finitions ADD CONSTRAINT gamme_operation_finitions_slot_check CHECK(slot IN (1,2));
CREATE UNIQUE INDEX gamme_operation_finitions_operation_article_uq ON public.gamme_operation_finitions(gamme_operation_id,article_id) WHERE article_id IS NOT NULL;

DROP INDEX public.pt_achats_gamme_operation_traitement_uq;
CREATE UNIQUE INDEX pt_achats_gamme_operation_traitement_article_uq ON public.pieces_techniques_achats(gamme_operation_id,article_id) WHERE gamme_operation_id IS NOT NULL AND type_achat='TRAITEMENT' AND article_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_guard_purchase_capacity_1833() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Serialize concurrent additions for one technical dossier, including bulk imports.
 IF NEW.piece_technique_version_id IS NOT NULL THEN
  PERFORM 1 FROM public.piece_technique_versions WHERE id=NEW.piece_technique_version_id FOR UPDATE;
 ELSE
  PERFORM 1 FROM public.pieces_techniques WHERE id=NEW.piece_technique_id FOR UPDATE;
 END IF;
 IF NEW.type_achat='MATIERE' AND (TG_OP='INSERT' OR OLD.type_achat IS DISTINCT FROM NEW.type_achat OR OLD.piece_technique_id IS DISTINCT FROM NEW.piece_technique_id OR OLD.piece_technique_version_id IS DISTINCT FROM NEW.piece_technique_version_id) AND
   (SELECT count(*) FROM public.pieces_techniques_achats p WHERE p.piece_technique_id=NEW.piece_technique_id AND p.piece_technique_version_id IS NOT DISTINCT FROM NEW.piece_technique_version_id AND p.type_achat='MATIERE' AND p.id<>NEW.id)>=2 THEN
  RAISE EXCEPTION 'MATERIAL_LIMIT_REACHED: Deux matières premières au maximum par dossier de pièce.' USING ERRCODE='23514';
 END IF;
 IF NEW.type_achat='TRAITEMENT' AND NEW.gamme_operation_id IS NOT NULL THEN
  PERFORM 1 FROM public.pieces_techniques_operations WHERE id=NEW.gamme_operation_id FOR UPDATE;
  IF (SELECT count(*) FROM public.pieces_techniques_achats p WHERE p.gamme_operation_id=NEW.gamme_operation_id AND p.type_achat='TRAITEMENT' AND p.id<>NEW.id)>=2 THEN
   RAISE EXCEPTION 'OPERATION_FINISH_LIMIT_REACHED: Deux procédés spéciaux au maximum sur une opération.' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_purchase_capacity_1833 BEFORE INSERT OR UPDATE ON public.pieces_techniques_achats FOR EACH ROW EXECUTE FUNCTION public.fn_guard_purchase_capacity_1833();
COMMIT;
