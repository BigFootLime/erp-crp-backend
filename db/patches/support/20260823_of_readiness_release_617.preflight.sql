\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
DO $preflight$
BEGIN
  IF to_regclass('public.ordres_fabrication') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION '#617 preflight: OF and users tables are required';
  END IF;
  IF to_regprocedure('gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION '#617 preflight: gen_random_uuid() is required';
  END IF;
  IF to_regclass('public.of_release_decisions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.of_release_decisions
      GROUP BY of_id HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION '#617 preflight: duplicate historical decisions must be reconciled before adding the one-release-per-OF constraint';
    END IF;
  END IF;
END $preflight$;
SELECT to_regclass('public.of_release_decisions') IS NOT NULL AS already_applied,
       count(*) AS existing_ofs, count(*) FILTER (WHERE statut IN ('EN_COURS','EN_PAUSE')) AS already_executing_ofs
FROM public.ordres_fabrication;
COMMIT;
