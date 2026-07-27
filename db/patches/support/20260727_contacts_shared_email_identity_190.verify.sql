\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Vérification #190 refusée hors cerp_test (base actuelle : %)', current_database();
  END IF;
END
$$;

SELECT
  current_database() = 'cerp_test' AS is_test_database,
  NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.contacts'::regclass
       AND conname = 'contacts_email_key'
  ) AS global_email_constraint_removed,
  NOT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'contacts'
       AND indexname = 'contacts_client_email_active_key'
  ) AS client_email_only_index_removed,
  EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'contacts'
       AND indexname = 'contacts_client_email_identity_active_key'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
       AND indexdef LIKE '%client_id, lower(btrim((email)::text))%'
       AND indexdef LIKE '%lower(btrim((COALESCE(first_name%'
       AND indexdef LIKE '%lower(btrim((COALESCE(last_name%'
       AND indexdef LIKE '%archived_at IS NULL%'
  ) AS contact_identity_active_unique;

SELECT count(*) AS exact_active_contact_duplicates
FROM (
  SELECT
    client_id,
    lower(btrim(email)),
    lower(btrim(coalesce(first_name, ''))),
    lower(btrim(coalesce(last_name, '')))
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
) duplicates;

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
