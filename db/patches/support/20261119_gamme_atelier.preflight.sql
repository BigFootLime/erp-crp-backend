SELECT count(*) AS operations FROM public.pieces_techniques_operations;
SELECT count(*) AS frozen_orders
FROM public.ordres_fabrication WHERE technical_snapshot_sha256 IS NOT NULL;
SELECT code, designation, machine_family_code, statut
FROM public.centres_frais
WHERE upper(btrim(code)) IN ('CF-FRAISAGE','CF-FRAISAGE-TRAD','CF-TOURNAGE','CF-TOURNAGE-TRAD',
  'CF-DECOUPE','CF-MAIN-OEUVRE','CF-PROGRAMMATION')
ORDER BY code;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (VALUES ('CF-FRAISAGE','F'),('CF-FRAISAGE-TRAD','FTRAD'),('CF-TOURNAGE','T'),
      ('CF-TOURNAGE-TRAD','TTRAD'),('CF-DECOUPE','DECOUPE')) AS expected(code,family)
    JOIN public.centres_frais cf ON upper(btrim(cf.code))=expected.code
    WHERE cf.machine_family_code IS DISTINCT FROM expected.family OR cf.statut IS DISTINCT FROM 'ACTIF'
  ) THEN
    RAISE EXCEPTION 'An existing machining cost centre has an unexpected machine family or status';
  END IF;
END $$;
