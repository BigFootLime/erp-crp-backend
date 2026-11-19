SELECT count(*) AS operations FROM public.pieces_techniques_operations;
SELECT count(*) AS frozen_orders
FROM public.ordres_fabrication WHERE technical_snapshot_sha256 IS NOT NULL;
SELECT code, designation, machine_family_code, statut
FROM public.centres_frais
WHERE upper(btrim(code)) IN ('CF-FRAISAGE','CF-FRAISAGE-TRAD','CF-TOURNAGE','CF-TOURNAGE-TRAD',
  'CF-DECOUPE','CF-MAIN-OEUVRE','CF-PROGRAMMATION')
ORDER BY code;
