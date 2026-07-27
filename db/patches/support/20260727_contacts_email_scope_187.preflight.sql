\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Preflight #187 refusé hors cerp_test (base actuelle : %)', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION 'Preflight #187 refusé : table public.contacts absente';
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
    RAISE EXCEPTION 'Preflight #187 refusé : doublons de courriel actifs dans un même client';
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

SELECT
  conname,
  pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.contacts'::regclass
  AND conname = 'contacts_email_key';
