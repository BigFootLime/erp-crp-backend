-- 20260710_hr_users_role_responsable_rh.sql
-- T5 (#119) — Élargit users_role_check pour autoriser le rôle « Responsable RH ».
-- ADDITIF & SÛR : n'ajoute qu'une valeur permise (élargissement d'un CHECK ⇒ aucune ligne existante
-- ne peut devenir invalide). Idempotent (DROP IF EXISTS + recréation). Ne supprime aucun rôle existant.
-- Contexte : le validateur applicatif autorisait déjà « Responsable RH » mais la contrainte DB non,
-- empêchant la création d'un tel utilisateur (écart ouvert en T4).

BEGIN;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check CHECK (
    (role)::text = ANY (ARRAY[
      'Directeur'::text,
      'Employee'::text,
      'Administrateur Systeme et Reseau'::text,
      'Responsable Qualité'::text,
      'Secretaire'::text,
      'Responsable Programmation'::text,
      'Responsable RH'::text
    ])
  );

COMMIT;
