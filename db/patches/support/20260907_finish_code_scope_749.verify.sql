-- Read the actual deployed acceptance expression; never allocate a number for verification.
WITH definition AS (
  SELECT substring(prosrc from 'v_scope !~ ''([^'']+)''') AS scope_pattern
  FROM pg_proc WHERE oid = 'public.fn_next_issued_code_value(text)'::regprocedure
), examples(scope, expected) AS (
  VALUES ('CLI', true), ('FOU', true), ('MCH', true), ('MET', true), ('FIN', true),
    ('ART:MP', true), ('OF:2026', true), ('PC:2026', true), ('MEX:2026', true),
    ('MIA:2026', true), ('BCF:2026', true), ('UNKNOWN', false), ('FIN:2026', false),
    ('ART:', false), ('OF:26', false), ('', false)
)
SELECT current_database() AS database_name,
       bool_and((scope ~ scope_pattern) = expected) AS scopes_verified,
       count(*) AS examples_checked
FROM definition CROSS JOIN examples;
