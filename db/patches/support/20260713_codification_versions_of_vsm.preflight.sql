-- Read-only preflight for 20260713_codification_versions_of_vsm.sql.
-- Required before cerp_test and cerp_prod.  It performs no UPDATE, INSERT,
-- DDL or sequence allocation.  Any ambiguous client/plan/index mapping must
-- be resolved explicitly: this patch never guesses a mapping automatically.

BEGIN TRANSACTION READ ONLY;

-- Required source objects and the current migration state.
SELECT
  to_regclass('public.piece_technique_versions') IS NOT NULL AS has_piece_versions,
  to_regclass('public.pieces_techniques') IS NOT NULL AS has_pieces_techniques,
  to_regclass('public.clients') IS NOT NULL AS has_clients,
  to_regclass('public.ordres_fabrication') IS NOT NULL AS has_ordres_fabrication,
  to_regclass('public.quality_control') IS NOT NULL AS has_quality_control,
  to_regclass('public.code_sequences') IS NOT NULL AS has_legacy_code_sequences,
  to_regclass('public.of_technical_snapshots') IS NOT NULL AS has_of_snapshot_table,
  to_regclass('public.project_evidence_files') IS NOT NULL AS has_evidence_file_table,
  to_regclass('public.codification_141_piece_version_baseline') IS NOT NULL AS codification_141_applied;

-- Version rows that cannot receive CLIENT-PLAN-INDICE safely.
SELECT
  v.id::text AS version_id,
  v.piece_technique_id::text AS piece_technique_id,
  v.indice,
  v.plan_reference,
  COALESCE(c.client_code, pt.code_client) AS client_code,
  CASE
    WHEN btrim(COALESCE(c.client_code, pt.code_client, '')) = '' THEN 'CLIENT_CODE_MISSING'
    WHEN btrim(COALESCE(v.plan_reference, '')) = '' THEN 'PLAN_REFERENCE_MISSING'
    WHEN btrim(COALESCE(v.indice, '')) = '' THEN 'EXTERNAL_INDEX_MISSING'
    ELSE 'OK'
  END AS mapping_status
FROM public.piece_technique_versions v
JOIN public.pieces_techniques pt ON pt.id = v.piece_technique_id
LEFT JOIN public.clients c ON c.client_id = pt.client_id
WHERE btrim(COALESCE(c.client_code, pt.code_client, '')) = ''
   OR btrim(COALESCE(v.plan_reference, '')) = ''
   OR btrim(COALESCE(v.indice, '')) = ''
ORDER BY v.piece_technique_id, v.created_at, v.id;

-- Historical customer-index collisions are reported, not repaired.  They are
-- expected only after the old unique key has deliberately been removed.
SELECT
  piece_technique_id::text AS piece_technique_id,
  indice,
  count(*)::int AS version_count,
  array_agg(id::text ORDER BY created_at, id) AS version_ids
FROM public.piece_technique_versions
GROUP BY piece_technique_id, indice
HAVING count(*) > 1
ORDER BY version_count DESC, piece_technique_id, indice;

-- Inputs containing no usable alphanumeric segment would produce an invalid
-- code even when non-empty, so review them before application.
SELECT
  v.id::text AS version_id,
  COALESCE(c.client_code, pt.code_client) AS client_code,
  v.plan_reference,
  v.indice
FROM public.piece_technique_versions v
JOIN public.pieces_techniques pt ON pt.id = v.piece_technique_id
LEFT JOIN public.clients c ON c.client_id = pt.client_id
WHERE regexp_replace(COALESCE(c.client_code, pt.code_client, ''), '[^A-Za-z0-9]+', '', 'g') = ''
   OR regexp_replace(COALESCE(v.plan_reference, ''), '[^A-Za-z0-9]+', '', 'g') = ''
   OR regexp_replace(COALESCE(v.indice, ''), '[^A-Za-z0-9]+', '', 'g') = ''
ORDER BY v.id;

-- OF records already in use: they stay historical and are not auto-linked to
-- a version/snapshot.  Review this count before making the new OF contract mandatory.
SELECT
  count(*)::bigint AS total_of,
  min(created_at) AS oldest_of,
  max(created_at) AS newest_of
FROM public.ordres_fabrication;

-- Existing sequence counters are only observed.  The patch seeds the native
-- non-reusable allocator forward; it does not reset per-year/family counters.
SELECT code_key, next_value
FROM public.code_sequences
ORDER BY code_key;

SELECT
  count(*)::bigint AS quality_controls,
  count(*) FILTER (WHERE control_date IS NULL)::bigint AS missing_control_date
FROM public.quality_control;

ROLLBACK;
