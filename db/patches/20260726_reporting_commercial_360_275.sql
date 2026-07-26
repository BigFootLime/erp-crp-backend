-- 20260726_reporting_commercial_360_275.sql
--
-- Issue #275 — Reporting commercial 360.
--
-- Contenu : INDEX UNIQUEMENT. Aucune table, aucune colonne, aucune contrainte,
-- aucune donnée. Le reporting est en lecture seule : il ne lui faut que des chemins
-- d'accès. Les agrégats parcourent quatre axes chauds absents des index existants :
--   - devis   : (statut, date_creation)     -> aucune indexation de date_creation
--   - commande: (date_commande)             -> aucune indexation
--   - BL      : (statut, date_expedition)   -> aucune indexation d'expédition
--   - pièces  : (statut, date_emission)     -> deux index simples, pas de composite
--
-- Sûreté
-- - Idempotent : `CREATE INDEX IF NOT EXISTS` uniquement.
-- - Non destructif : aucun DROP, DELETE, UPDATE, ALTER de données.
-- - Aucun index concurrent (le patch tourne dans une transaction, comme les autres).
-- - Ne crée aucune table : la question de l'appartenance à `cerp_app` ne se pose pas
--   (un index hérite du propriétaire de sa table).
--
-- Cible : cerp_test d'abord ; cerp_prod uniquement après validation humaine explicite.

BEGIN;

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'devis', 'commande_client', 'commande_ligne',
    'bon_livraison', 'bon_livraison_ligne',
    'facture', 'avoir', 'paiement',
    'paiement_allocations', 'avoir_source_allocations'
  ]
  LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION '#275 prerequisite missing: public.%', required_table;
    END IF;
  END LOOP;
END $$;

-- --- Devis : cohortes de création par statut ---------------------------------
CREATE INDEX IF NOT EXISTS devis_reporting_statut_creation_275_idx
  ON public.devis (statut, date_creation);

CREATE INDEX IF NOT EXISTS devis_reporting_open_275_idx
  ON public.devis (date_validite)
  WHERE statut = 'ENVOYE';

CREATE INDEX IF NOT EXISTS devis_reporting_user_275_idx
  ON public.devis (user_id)
  WHERE user_id IS NOT NULL;

-- --- Commandes : prises de commande et carnet --------------------------------
CREATE INDEX IF NOT EXISTS commande_client_reporting_date_275_idx
  ON public.commande_client (date_commande);

CREATE INDEX IF NOT EXISTS commande_client_reporting_client_date_275_idx
  ON public.commande_client (client_id, date_commande);

CREATE INDEX IF NOT EXISTS commande_ligne_reporting_delai_275_idx
  ON public.commande_ligne (delai_client)
  WHERE delai_client IS NOT NULL;

-- --- Livraisons : expéditions et réceptions ----------------------------------
CREATE INDEX IF NOT EXISTS bon_livraison_reporting_expedition_275_idx
  ON public.bon_livraison (statut, date_expedition);

CREATE INDEX IF NOT EXISTS bon_livraison_reporting_livraison_275_idx
  ON public.bon_livraison (statut, date_livraison);

-- --- Pièces financières : registre par période -------------------------------
CREATE INDEX IF NOT EXISTS facture_reporting_statut_emission_275_idx
  ON public.facture (statut, date_emission);

CREATE INDEX IF NOT EXISTS facture_reporting_client_emission_275_idx
  ON public.facture (client_id, date_emission);

CREATE INDEX IF NOT EXISTS facture_reporting_echeance_275_idx
  ON public.facture (date_echeance, statut)
  WHERE date_echeance IS NOT NULL;

CREATE INDEX IF NOT EXISTS avoir_reporting_statut_emission_275_idx
  ON public.avoir (statut, date_emission);

CREATE INDEX IF NOT EXISTS avoir_reporting_facture_275_idx
  ON public.avoir (facture_id)
  WHERE facture_id IS NOT NULL;

-- --- Règlements : encaissements et lettrage ----------------------------------
CREATE INDEX IF NOT EXISTS paiement_reporting_date_status_275_idx
  ON public.paiement (date_paiement, status);

CREATE INDEX IF NOT EXISTS paiement_reporting_client_date_275_idx
  ON public.paiement (client_id, date_paiement);

CREATE INDEX IF NOT EXISTS paiement_allocations_reporting_created_275_idx
  ON public.paiement_allocations (created_at);

CREATE INDEX IF NOT EXISTS avoir_source_allocations_reporting_created_275_idx
  ON public.avoir_source_allocations (created_at);

COMMENT ON INDEX public.devis_reporting_statut_creation_275_idx IS
  'Issue #275 — cohortes de devis par statut et date de création (Reporting commercial 360).';
COMMENT ON INDEX public.bon_livraison_reporting_expedition_275_idx IS
  'Issue #275 — volumes et ponctualité d''expédition (Reporting commercial 360).';
COMMENT ON INDEX public.facture_reporting_statut_emission_275_idx IS
  'Issue #275 — registre des factures par période (Reporting commercial 360).';

COMMIT;
