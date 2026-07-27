\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Preflight #190 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION 'Preflight #190 refusé : table public.contacts absente';
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
    RAISE EXCEPTION 'Preflight #190 refusé : doublons exacts de contacts actifs';
  END IF;
END
$$;

SELECT
  current_database() AS database_name,
  count(*) AS contacts_total,
  count(*) FILTER (
    WHERE client_id IS NOT NULL
      AND email IS NOT NULL
      AND btrim(email) <> ''
      AND archived_at IS NULL
  ) AS contacts_actifs_avec_courriel
FROM public.contacts;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'contacts'
  AND indexname IN (
    'contacts_client_email_active_key',
    'contacts_client_email_identity_active_key'
  )
ORDER BY indexname;

SELECT count(*) AS same_client_shared_email_groups
FROM (
  SELECT client_id, lower(btrim(email))
    FROM public.contacts
   WHERE client_id IS NOT NULL
     AND email IS NOT NULL
     AND btrim(email) <> ''
     AND archived_at IS NULL
   GROUP BY client_id, lower(btrim(email))
  HAVING count(*) > 1
) shared;
