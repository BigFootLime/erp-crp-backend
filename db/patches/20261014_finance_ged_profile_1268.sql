-- Retain the legacy production GED guard while adding the canonical metadata
-- needed by private Finance documents. No document, link or client is copied.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF to_regclass('public.ged_document_links') IS NULL THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 canonical link table required';
 END IF;
 IF to_regclass('public.ged_entity_types') IS NULL AND NOT EXISTS(
  SELECT 1 FROM pg_trigger WHERE tgrelid='public.ged_document_links'::regclass
   AND tgname='trg_ged_validate_canonical_entity_link_20' AND NOT tgisinternal AND tgenabled<>'D'
   AND tgfoid=to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()')) THEN
  RAISE EXCEPTION 'FINANCE-GED-1268 qualified legacy or closed GED profile required';
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.finance_ged_profile_state_1268(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),registry_created boolean NOT NULL);
INSERT INTO public.finance_ged_profile_state_1268(singleton,registry_created)
 VALUES(true,to_regclass('public.ged_entity_types') IS NULL) ON CONFLICT(singleton) DO NOTHING;
REVOKE ALL ON public.finance_ged_profile_state_1268 FROM PUBLIC,cerp_app;
CREATE TABLE IF NOT EXISTS public.ged_entity_types(
 entity_type text PRIMARY KEY CHECK(entity_type ~ '^[A-Z][A-Z0-9_]{1,63}$'),label text NOT NULL,
 module_key text NOT NULL,target_table text NOT NULL,target_pk_column text NOT NULL,
 sort_order integer NOT NULL DEFAULT 100,is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
-- This is the same public entity contract as the existing closed profile.
INSERT INTO public.ged_entity_types(entity_type,label,module_key,target_table,target_pk_column,sort_order,is_active)
VALUES
 ('CLIENT','Client','clients','clients','client_id',10,true),
 ('FOURNISSEUR','Fournisseur','fournisseurs','fournisseurs','id',20,true),
 ('ARTICLE','Article','stock','articles','id',30,true),
 ('PIECE_TECHNIQUE','Pièce technique','pieces-techniques','pieces_techniques','id',40,true),
 ('PIECE_TECHNIQUE_VERSION','Indice de pièce','pieces-techniques','piece_technique_versions','id',50,true),
 ('AFFAIRE','Affaire','affaires','affaire','id',60,true),
 ('DEVIS','Devis','devis','devis','id',65,true),
 ('COMMANDE_CLIENT','Commande client','commande-client','commande_client','id',70,true),
 ('COMMANDE_FOURNISSEUR','Commande fournisseur','commandes-fournisseurs','commande_fournisseur','id',75,true),
 ('OF','Ordre de fabrication','production','ordres_fabrication','id',80,true),
 ('BON_LIVRAISON','Bon de livraison','livraisons','bon_livraison','id',85,true),
 ('RECEPTION','Réception','receptions','receptions_fournisseurs','id',90,true),
 ('CONTROLE_QUALITE','Contrôle qualité','qualite','quality_control','id',100,true),
 ('MACHINE','Machine','production','machines','id',110,true),
 ('UTILISATEUR','Utilisateur','users','users','id',120,true),
 ('FACTURE','Facture','facturation','facture','id',125,true),
 ('AVOIR','Avoir','facturation','avoir','id',130,true)
ON CONFLICT(entity_type) DO NOTHING;
GRANT SELECT ON public.ged_entity_types TO cerp_app;
CREATE OR REPLACE FUNCTION public.fn_ged_finance_parent_guard_1268()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.entity_type='PROFORMA' THEN
  IF to_regclass('public.proforma_client') IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.proforma_client WHERE id::text=NEW.entity_id) THEN
   RAISE EXCEPTION 'GED_PROFORMA_PARENT_NOT_FOUND' USING ERRCODE='23503';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ged_finance_parent_guard_1268 ON public.ged_document_links;
CREATE TRIGGER trg_ged_finance_parent_guard_1268 BEFORE INSERT OR UPDATE OF entity_type,entity_id
 ON public.ged_document_links FOR EACH ROW EXECUTE FUNCTION public.fn_ged_finance_parent_guard_1268();
COMMIT;
