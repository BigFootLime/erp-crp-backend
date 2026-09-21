BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $$ BEGIN
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND (
   (table_name='fournisseur_catalogue' AND column_name IN ('forfait_ht','minimum_facturation_ht','price_tiers')) OR
   (table_name='commande_fournisseur_ligne' AND column_name='catalogue_pricing_snapshot') OR
   table_name='article_subcontract_definition')) <> 14 THEN
   RAISE EXCEPTION 'Articles purchase flow: missing schema columns';
 END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.fournisseur_catalogue'::regclass
     AND conname LIKE 'fournisseur_catalogue_flow_%' AND convalidated) <> 3 THEN
   RAISE EXCEPTION 'Articles purchase flow: missing validated price constraints';
 END IF;
 IF NOT has_table_privilege('cerp_app','public.article_subcontract_definition','SELECT,INSERT,UPDATE,DELETE') THEN
   RAISE EXCEPTION 'Articles purchase flow: application cannot use subcontract definitions';
 END IF;
 IF EXISTS (SELECT 1 FROM public.article_subcontract_definition d
   JOIN public.piece_technique_versions v ON v.id=d.piece_technique_version_id
   WHERE v.piece_technique_id<>d.piece_technique_id) THEN
   RAISE EXCEPTION 'Articles purchase flow: inconsistent piece versions';
 END IF;
END $$;
SELECT code,designation,is_active FROM public.articles_matiere_families
 WHERE code IN ('TUBERECT','HEXA','L') ORDER BY code;
SELECT table_name,column_name,data_type FROM information_schema.columns
 WHERE table_schema='public' AND (
   (table_name='fournisseur_catalogue' AND column_name IN ('forfait_ht','minimum_facturation_ht','price_tiers')) OR
   (table_name='commande_fournisseur_ligne' AND column_name='catalogue_pricing_snapshot') OR
   table_name='article_subcontract_definition') ORDER BY table_name,column_name;
SELECT conname,convalidated FROM pg_constraint
 WHERE conrelid='public.fournisseur_catalogue'::regclass
 AND conname LIKE 'fournisseur_catalogue_flow_%' ORDER BY conname;
SELECT count(*) AS inconsistent_piece_versions
 FROM public.article_subcontract_definition d JOIN public.piece_technique_versions v ON v.id=d.piece_technique_version_id
 WHERE v.piece_technique_id<>d.piece_technique_id;
COMMIT;
