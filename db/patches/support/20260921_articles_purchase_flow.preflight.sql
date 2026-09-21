-- Read-only prerequisite inventory. Every row must be ready before deployment.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $$ DECLARE missing text; BEGIN
WITH required(table_name, column_name) AS (VALUES
 ('articles','id'), ('articles_matiere_families','code'),
 ('articles_matiere','client_proprietaire_id'), ('clients','client_id'),
 ('fournisseur_catalogue','prix_unitaire'), ('fournisseur_catalogue','pricing_basis'),
 ('fournisseur_catalogue','prix_multiple'), ('fournisseur_catalogue','updated_at'),
 ('commande_fournisseur_ligne','frais_ht'), ('commande_fournisseur_ligne','receipt_stock_managed'),
 ('article_category_link','category_code'), ('article_procurement_profile','preferred_catalogue_id'),
 ('pieces_techniques','id'), ('piece_technique_versions','piece_technique_id'),
 ('articles_traitement','finish_revision_id'), ('surface_finish_revisions','finish_id'),
 ('surface_finishes','family_code'), ('reception_fournisseur_lignes','processing_policy'))
SELECT string_agg(r.table_name || '.' || r.column_name, ', ') INTO missing
FROM required r WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c
 WHERE c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name);
IF missing IS NOT NULL THEN RAISE EXCEPTION 'Articles purchase flow prerequisites missing: %', missing; END IF;
END $$;
WITH required(table_name, column_name) AS (VALUES
 ('articles','id'), ('articles_matiere_families','code'),
 ('articles_matiere','client_proprietaire_id'), ('clients','client_id'),
 ('fournisseur_catalogue','prix_unitaire'), ('fournisseur_catalogue','pricing_basis'),
 ('fournisseur_catalogue','prix_multiple'), ('fournisseur_catalogue','updated_at'),
 ('commande_fournisseur_ligne','frais_ht'), ('commande_fournisseur_ligne','receipt_stock_managed'),
 ('article_category_link','category_code'), ('article_procurement_profile','preferred_catalogue_id'),
 ('pieces_techniques','id'), ('piece_technique_versions','piece_technique_id'),
 ('articles_traitement','finish_revision_id'), ('surface_finish_revisions','finish_id'),
 ('surface_finishes','family_code'), ('reception_fournisseur_lignes','processing_policy'))
SELECT r.table_name, r.column_name, EXISTS(
 SELECT 1 FROM information_schema.columns c
 WHERE c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
) AS ready FROM required r ORDER BY r.table_name,r.column_name;
COMMIT;
