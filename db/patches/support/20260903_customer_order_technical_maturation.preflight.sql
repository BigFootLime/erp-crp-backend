SELECT
  to_regclass('public.affaire') IS NOT NULL AS has_affaire,
  to_regclass('public.ordres_fabrication') IS NOT NULL AS has_of,
  to_regclass('public.of_technical_snapshots') IS NOT NULL AS has_snapshot_companion;

SELECT statut::text, count(*)
FROM public.ordres_fabrication
WHERE technical_snapshot IS NULL
GROUP BY statut::text
ORDER BY statut::text;
