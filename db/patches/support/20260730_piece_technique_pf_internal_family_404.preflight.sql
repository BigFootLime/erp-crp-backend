-- #404 — lecture seule avant application.
SELECT current_database() AS database, current_user AS role, now() AS checked_at;

SELECT to_regclass('public.pieces_families') IS NOT NULL AS pieces_families_present;

SELECT id::text, code, designation, type_famille, section
FROM public.pieces_families
WHERE upper(btrim(code)) = 'PF'
ORDER BY created_at ASC, id ASC;
