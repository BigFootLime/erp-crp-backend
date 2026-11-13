SELECT count(*) AS families, count(nom_diminutif) AS configured_abbreviations,
  count(*) FILTER(WHERE code !~ '^FPS_[0-9]{6}$') AS invalid_codes
FROM public.surface_finish_families;
SELECT count(*) AS orphan_finishes FROM public.surface_finishes f
LEFT JOIN public.surface_finish_families fam ON fam.code=f.family_code WHERE fam.code IS NULL;
SELECT code,legacy_code,label,nom_diminutif FROM public.surface_finish_families ORDER BY code;
