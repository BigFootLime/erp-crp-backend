-- Issue #187 — l'unicité d'un courriel de contact appartient au client.
-- Ce patch ne modifie aucune valeur métier : il remplace uniquement la
-- contrainte globale historique par une unicité normalisée des contacts actifs
-- d'un même client.

BEGIN;

DO $$
DECLARE
  legacy_constraint_definition text;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #187 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION 'Patch #187 refusé : table public.contacts absente';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.contacts
     WHERE client_id IS NOT NULL
       AND email IS NOT NULL
       AND btrim(email) <> ''
       AND archived_at IS NULL
     GROUP BY client_id, lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Patch #187 refusé : doublons de courriel actifs déjà présents dans un même client';
  END IF;

  SELECT pg_get_constraintdef(oid)
    INTO legacy_constraint_definition
    FROM pg_constraint
   WHERE conrelid = 'public.contacts'::regclass
     AND conname = 'contacts_email_key';

  IF legacy_constraint_definition IS NOT NULL
     AND legacy_constraint_definition <> 'UNIQUE (email)' THEN
    RAISE EXCEPTION
      'Patch #187 refusé : définition inattendue pour contacts_email_key : %',
      legacy_constraint_definition;
  END IF;
END
$$;

ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_client_email_active_key
  ON public.contacts (client_id, lower(btrim(email)))
  WHERE client_id IS NOT NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
    AND archived_at IS NULL;

COMMIT;
