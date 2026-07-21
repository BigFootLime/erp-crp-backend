-- 20260721_affaire_360_hardening.sql
-- #169 — Durcissement ADDITIF du dossier Affaire 360. NON destructif, idempotent, rejouable.
--
-- Ajoute :
--   * affaire.is_principal (bool, def. false) : marque l'affaire PRINCIPALE d'une commande.
--   * affaire.archived_at (timestamptz)       : horodatage d'archivage, distinct de l'annulation
--     métier (statut ANNULEE). Prépare un archivage dédié (aujourd'hui l'archive passe ANNULEE).
--   * index unique partiel affaire_principal_par_commande_uniq : AU PLUS une affaire principale
--     par commande. Le split-livraison conserve plusieurs affaires non-principales.
--
-- Rappel schéma live (cerp_test, introspecté le 2026-07-21) : commande_to_affaire.role ne vaut
-- plus que NULL | 'LIVRAISON' (le rôle PRODUCTION a été retiré) — il n'existait donc AUCUNE
-- contrainte « une principale par commande ». Ce patch l'introduit de façon additive.
--
-- Aucun DROP/DELETE/UPDATE de données existantes. Toutes les affaires existantes gardent
-- is_principal=false : l'index partiel n'indexe aucune ligne existante -> zéro conflit, aucune
-- réécriture de table (ADD COLUMN ... DEFAULT constant est metadata-only en PG 11+).
--
-- NON inclus (suivi #169 volontaire, hors de ce patch) : le trigger d'invariant
-- « somme des allocations actives d'une ligne <= quantité commandée ». Un trigger BLOQUANT sur
-- commande_ligne_affaire_allocation doit d'abord être validé contre le moteur d'orchestration
-- commande (upsertCommandeAllocations) pour ne pas rejeter des écritures légitimes ; il fera
-- l'objet d'un patch dédié testé.

BEGIN;

ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS is_principal boolean NOT NULL DEFAULT false;

ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS affaire_principal_par_commande_uniq
  ON public.affaire (commande_id)
  WHERE is_principal AND commande_id IS NOT NULL;

COMMENT ON COLUMN public.affaire.is_principal IS
  '#169 : affaire principale de la commande (au plus une par commande, cf. index partiel).';
COMMENT ON COLUMN public.affaire.archived_at IS
  '#169 : horodatage d''archivage (aucune suppression physique), distinct du statut ANNULEE.';

COMMIT;
