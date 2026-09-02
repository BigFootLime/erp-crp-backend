DO $$
BEGIN
  IF current_database() !~* 'test' THEN
    RAISE EXCEPTION 'Patch #698 preflight is restricted to a test database';
  END IF;
  IF to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_ligne') IS NULL
     OR to_regclass('public.devis_ligne') IS NULL
     OR to_regclass('public.piece_technique_versions') IS NULL
     OR to_regclass('public.lots') IS NULL THEN
    RAISE EXCEPTION 'Patch #698 prerequisites are missing';
  END IF;
END $$;

SELECT
  current_database() AS database_name,
  (SELECT count(*) FROM public.commande_client) AS commandes_before,
  (SELECT count(*) FROM public.commande_ligne) AS lignes_before,
  (SELECT count(*) FROM public.lots WHERE piece_technique_version_id IS NULL) AS unscoped_lots_before;

