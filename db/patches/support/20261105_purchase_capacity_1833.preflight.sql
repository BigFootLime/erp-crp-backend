SELECT count(*) AS legacy_over_capacity FROM (SELECT piece_technique_id,piece_technique_version_id FROM public.pieces_techniques_achats WHERE type_achat='MATIERE' GROUP BY 1,2 HAVING count(*)>2) s;
SELECT conname FROM pg_constraint WHERE conrelid='public.gamme_operation_finitions'::regclass AND contype='u';
