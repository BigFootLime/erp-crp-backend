-- Read-only verification for MD15 family counters and immutable equipment IDs.
BEGIN READ ONLY;

SELECT position('MTR:[A-Z0-9]{2,8}' IN prosrc) > 0 AS md15_scope_supported
FROM pg_proc
WHERE oid = 'public.fn_business_code_scope_sequence(text)'::regprocedure;

WITH expected(prefix, floor_value) AS (
  VALUES ('BF',65::bigint),('BL',21),('CA',4),('JP',7),('ME',26),('MES',2),
         ('MI',18),('OUT',7),('PC',58),('TF',110),('TFD',3),('TLD',50)
), sequences AS (
  SELECT replace(obj_description(c.oid,'pg_class'),'Business-code scope: MTR:','') AS prefix,
         s.last_value
  FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_sequences s ON s.schemaname=n.nspname AND s.sequencename=c.relname
  WHERE c.relkind='S' AND obj_description(c.oid,'pg_class') LIKE 'Business-code scope: MTR:%'
)
SELECT e.prefix, e.floor_value, s.last_value,
       COALESCE(s.last_value >= e.floor_value, false) AS floor_reserved
FROM expected e LEFT JOIN sequences s USING(prefix)
ORDER BY e.prefix;

SELECT position('OLD.code IS NOT NULL AND NEW.code IS DISTINCT FROM OLD.code' IN prosrc) > 0 AS equipment_code_immutable
FROM pg_proc
WHERE oid = 'public.fn_protect_metrologie_equipement_229()'::regprocedure;

ROLLBACK;
