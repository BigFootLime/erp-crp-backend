-- 20260721_clients_compta_fields.sql
-- Référentiel client : ajout de 2 champs comptables sans équivalent existant.
--
-- STRICTEMENT ADDITIF : aucune colonne existante modifiée/supprimée, aucune ligne
-- détruite, idempotent (IF NOT EXISTS partout). L'application actuelle fonctionne
-- inchangée sans ce patch ; le read-back backend lit déjà ces colonnes de façon
-- défensive (to_jsonb(c)->>'...') donc le code peut coexister avec ou sans patch.
-- Ordre de release : appliquer ce patch (cerp_test d'abord) AVANT de déployer le code
-- qui écrit ces colonnes.
-- Verify   : db/patches/support/20260721_clients_compta_fields.verify.sql
-- Rollback : db/patches/support/20260721_clients_compta_fields.rollback.sql
--
-- Contenu :
--   1. compte_tiers     — compte tiers comptable (compte auxiliaire du grand livre,
--                         pour le rapprochement comptabilité). Distinct du client_code
--                         CERP (identité fonctionnelle générée serveur, ADR-0013).
--   2. groupe_financier — groupe de consolidation financière (société mère / groupe
--                         de facturation), pour regrouper plusieurs clients.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS compte_tiers text NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS groupe_financier text NULL;

COMMIT;
