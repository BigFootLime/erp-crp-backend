-- Issue #190 — une adresse fonctionnelle peut être partagée par plusieurs
-- personnes distinctes d'un même client.
-- Ce patch ne modifie aucune donnée métier. Il remplace l'unicité
-- (client, courriel) par l'unicité de l'identité normalisée du contact actif.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Patch #190 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION 'Patch #190 refusé : table public.contacts absente';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.contacts
     WHERE client_id IS NOT NULL
       AND email IS NOT NULL
       AND btrim(email) <> ''
       AND archived_at IS NULL
     GROUP BY
       client_id,
       lower(btrim(email)),
       lower(btrim(coalesce(first_name, ''))),
       lower(btrim(coalesce(last_name, '')))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Patch #190 refusé : doublons exacts de contacts actifs déjà présents';
  END IF;
END
$$;

DROP INDEX IF EXISTS public.contacts_client_email_active_key;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_client_email_identity_active_key
  ON public.contacts (
    client_id,
    lower(btrim(email)),
    lower(btrim(coalesce(first_name, ''))),
    lower(btrim(coalesce(last_name, '')))
  )
  WHERE client_id IS NOT NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
    AND archived_at IS NULL;

COMMIT;
