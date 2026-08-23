-- GED-203 — pièces jointes métier unifiées (clients, pièces, gammes et OF).
-- Preflight : support/20260824_ged_entity_attachments_203.preflight.sql
-- Validation : support/20260824_ged_entity_attachments_203.verify.sql
-- Rollback   : support/20260824_ged_entity_attachments_203.rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

INSERT INTO public.ged_document_classes
  (class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
   max_size_bytes, approvals_required, retention_months, hold_on_publish, is_active)
VALUES
  ('IMAGE_ENTITE', 'COMMERCIAL', 'Logo / image d’entité', 'SOURCE',
   ARRAY['image/jpeg','image/png','image/webp'],
   ARRAY['.jpg','.jpeg','.png','.webp'],
   10485760, 0, 120, false, true)
ON CONFLICT (class_key) DO NOTHING;

-- Les gammes deviennent un parent GED canonique. Le contrôle reste ciblé :
-- aucun vocabulaire historique inconnu n'est déclaré valide par accident.
CREATE OR REPLACE FUNCTION public.fn_ged_validate_gamme_entity_link_203()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_type = 'GAMME'
     AND NOT EXISTS (SELECT 1 FROM public.gammes g WHERE g.id::text = NEW.entity_id) THEN
    RAISE EXCEPTION 'GED_ENTITY_NOT_FOUND: GAMME %', NEW.entity_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ged_validate_gamme_entity_link_203 ON public.ged_document_links;
CREATE TRIGGER trg_ged_validate_gamme_entity_link_203
  BEFORE INSERT OR UPDATE OF entity_type, entity_id ON public.ged_document_links
  FOR EACH ROW EXECUTE FUNCTION public.fn_ged_validate_gamme_entity_link_203();

COMMIT;
