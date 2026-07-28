-- Rapport de reprise historique 20260728_surface_finish_library_210 — LECTURE SEULE.
--
-- ⚠️ AUCUN BACKFILL N'EST FAIT NI PROPOSÉ AUTOMATIQUEMENT.
-- Ce script CLASSE les articles Traitement et les lignes d'achat existants pour
-- qu'un humain décide, dossier par dossier. Il ne modifie rien, ne relie rien,
-- ne recode rien, ne supprime rien.
--
-- Classement produit :
--   EXACT_PROBABLE : la ligne d'achat TRAITEMENT désigne une seule opération
--                    SOUS_TRAITANCE de la même pièce et le même numéro de phase.
--   AMBIGU         : plusieurs opérations SOUS_TRAITANCE candidates, ou aucune
--                    correspondance de phase fiable.
--   INCOMPATIBLE   : la ligne porte un article qui n'est pas un article de
--                    catégorie `traitement`.
--   NON_LIE        : article Traitement sans aucune ligne d'achat, ou ligne sans
--                    article — rien à rattacher sans décision métier.
--
-- Rappel : le numéro de phase N'EST PAS un lien. Un « EXACT_PROBABLE » reste une
-- hypothèse à valider, jamais une reprise automatique.

\echo '=== 1) Lignes d''achat TRAITEMENT : classement des candidats ==='

WITH lignes AS (
  SELECT
    a.id                AS achat_id,
    a.piece_technique_id,
    a.phase,
    a.article_id,
    a.designation,
    a.type_achat
  FROM public.pieces_techniques_achats a
  WHERE a.type_achat = 'TRAITEMENT'
),
candidats AS (
  SELECT
    l.achat_id,
    l.piece_technique_id,
    l.phase,
    l.article_id,
    l.designation,
    COUNT(o.id) FILTER (WHERE o.type_operation = 'SOUS_TRAITANCE')                       AS ops_sous_traitance,
    COUNT(o.id) FILTER (WHERE o.type_operation = 'SOUS_TRAITANCE' AND o.phase = l.phase) AS ops_meme_phase,
    MIN(o.id::text) FILTER (WHERE o.type_operation = 'SOUS_TRAITANCE' AND o.phase = l.phase) AS operation_candidate
  FROM lignes l
  LEFT JOIN public.pieces_techniques_operations o
    ON o.piece_technique_id = l.piece_technique_id
  GROUP BY l.achat_id, l.piece_technique_id, l.phase, l.article_id, l.designation
)
SELECT
  c.achat_id,
  c.piece_technique_id,
  c.phase,
  c.article_id,
  art.code                                   AS article_code,
  art.article_category,
  left(COALESCE(c.designation, ''), 60)      AS designation_extrait,
  c.ops_sous_traitance,
  c.ops_meme_phase,
  c.operation_candidate,
  CASE
    WHEN c.article_id IS NOT NULL AND art.article_category IS DISTINCT FROM 'traitement' THEN 'INCOMPATIBLE'
    WHEN c.article_id IS NULL                                                            THEN 'NON_LIE'
    WHEN c.phase IS NULL                                                                 THEN 'AMBIGU'
    WHEN c.ops_meme_phase = 1                                                            THEN 'EXACT_PROBABLE'
    WHEN c.ops_meme_phase > 1                                                            THEN 'AMBIGU'
    WHEN c.ops_sous_traitance = 0                                                        THEN 'NON_LIE'
    ELSE 'AMBIGU'
  END                                        AS classement
FROM candidats c
LEFT JOIN public.articles art ON art.id = c.article_id
ORDER BY classement, c.piece_technique_id, c.phase NULLS LAST;

\echo '=== 2) Synthèse par classement ==='

WITH lignes AS (
  SELECT a.id, a.piece_technique_id, a.phase, a.article_id
  FROM public.pieces_techniques_achats a
  WHERE a.type_achat = 'TRAITEMENT'
),
candidats AS (
  SELECT
    l.id,
    l.article_id,
    l.phase,
    COUNT(o.id) FILTER (WHERE o.type_operation = 'SOUS_TRAITANCE')                       AS ops_sous_traitance,
    COUNT(o.id) FILTER (WHERE o.type_operation = 'SOUS_TRAITANCE' AND o.phase = l.phase) AS ops_meme_phase
  FROM lignes l
  LEFT JOIN public.pieces_techniques_operations o ON o.piece_technique_id = l.piece_technique_id
  GROUP BY l.id, l.article_id, l.phase
)
SELECT
  CASE
    WHEN c.article_id IS NOT NULL AND art.article_category IS DISTINCT FROM 'traitement' THEN 'INCOMPATIBLE'
    WHEN c.article_id IS NULL                                                            THEN 'NON_LIE'
    WHEN c.phase IS NULL                                                                 THEN 'AMBIGU'
    WHEN c.ops_meme_phase = 1                                                            THEN 'EXACT_PROBABLE'
    WHEN c.ops_meme_phase > 1                                                            THEN 'AMBIGU'
    WHEN c.ops_sous_traitance = 0                                                        THEN 'NON_LIE'
    ELSE 'AMBIGU'
  END        AS classement,
  COUNT(*)   AS lignes
FROM candidats c
LEFT JOIN public.articles art ON art.id = c.article_id
GROUP BY 1
ORDER BY 1;

\echo '=== 3) Articles Traitement orphelins (aucune ligne d''achat) ==='

SELECT
  a.id            AS article_id,
  a.code,
  left(a.designation, 70) AS designation_extrait,
  a.family_code,
  a.is_active,
  a.created_at
FROM public.articles a
WHERE a.article_category = 'traitement'
  AND NOT EXISTS (
    SELECT 1 FROM public.pieces_techniques_achats pa WHERE pa.article_id = a.id
  )
ORDER BY a.created_at;

\echo '=== 4) Opérations SOUS_TRAITANCE sans exigence de finition ==='

SELECT
  o.id            AS operation_id,
  o.gamme_id,
  o.piece_technique_id,
  o.phase,
  left(o.designation, 70) AS designation_extrait
FROM public.pieces_techniques_operations o
WHERE o.type_operation = 'SOUS_TRAITANCE'
  AND o.gamme_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.gamme_operation_finitions f WHERE f.gamme_operation_id = o.id
  )
ORDER BY o.piece_technique_id, o.phase NULLS LAST;
