-- Rollback #275 — supprime UNIQUEMENT les 17 index créés par le patch.
--
-- Aucune donnée n'est touchée : le patch #275 n'en a créé aucune. Ce rollback
-- restaure exactement l'état antérieur des chemins d'accès ; les requêtes de
-- reporting continueront de fonctionner, simplement moins vite.

BEGIN;

DROP INDEX IF EXISTS public.devis_reporting_statut_creation_275_idx;
DROP INDEX IF EXISTS public.devis_reporting_open_275_idx;
DROP INDEX IF EXISTS public.devis_reporting_user_275_idx;
DROP INDEX IF EXISTS public.commande_client_reporting_date_275_idx;
DROP INDEX IF EXISTS public.commande_client_reporting_client_date_275_idx;
DROP INDEX IF EXISTS public.commande_ligne_reporting_delai_275_idx;
DROP INDEX IF EXISTS public.bon_livraison_reporting_expedition_275_idx;
DROP INDEX IF EXISTS public.bon_livraison_reporting_livraison_275_idx;
DROP INDEX IF EXISTS public.facture_reporting_statut_emission_275_idx;
DROP INDEX IF EXISTS public.facture_reporting_client_emission_275_idx;
DROP INDEX IF EXISTS public.facture_reporting_echeance_275_idx;
DROP INDEX IF EXISTS public.avoir_reporting_statut_emission_275_idx;
DROP INDEX IF EXISTS public.avoir_reporting_facture_275_idx;
DROP INDEX IF EXISTS public.paiement_reporting_date_status_275_idx;
DROP INDEX IF EXISTS public.paiement_reporting_client_date_275_idx;
DROP INDEX IF EXISTS public.paiement_allocations_reporting_created_275_idx;
DROP INDEX IF EXISTS public.avoir_source_allocations_reporting_created_275_idx;

DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260726_reporting_commercial_360_275.sql';

COMMIT;
