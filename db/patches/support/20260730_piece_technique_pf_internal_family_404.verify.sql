-- #404 — lecture seule après application.
SELECT count(*) = 1 AS one_internal_pf_family
FROM public.pieces_families
WHERE upper(btrim(code)) = 'PF';

SELECT id::text, code, designation, type_famille, section
FROM public.pieces_families
WHERE upper(btrim(code)) = 'PF';
