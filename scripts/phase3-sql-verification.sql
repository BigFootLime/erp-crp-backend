-- Phase 3 verification helpers
-- Usage (psql):
--   \set commande_id 123
--   \set location_id 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'  -- optional
--   \i scripts/phase3-sql-verification.sql

\echo 'Commande:' :commande_id

/* -------------------------------------------------------------------------- */
/* 1) Affaires links                                                          */
/* -------------------------------------------------------------------------- */

SELECT
  cta.id,
  cta.commande_id,
  cta.affaire_id,
  cta.role,
  cta.commentaire,
  cta.date_conversion
FROM public.commande_to_affaire cta
WHERE cta.commande_id = :commande_id
ORDER BY cta.id ASC;

/* -------------------------------------------------------------------------- */
/* 2) Allocation snapshot                                                     */
/* -------------------------------------------------------------------------- */

SELECT
  a.commande_id,
  a.commande_ligne_id,
  a.livraison_affaire_id,
  a.production_affaire_id,
  a.article_ref_id,
  a.article_legacy_id,
  a.qty_ordered,
  a.qty_from_stock,
  a.qty_reserved,
  a.qty_to_produce,
  a.allocation_mode,
  a.created_at,
  a.updated_at
FROM public.commande_ligne_affaire_allocation a
WHERE a.commande_id = :commande_id
ORDER BY a.commande_ligne_id ASC;

/* -------------------------------------------------------------------------- */
/* 3) Reservations created for this commande (source_id = commande_ligne_id)  */
/* -------------------------------------------------------------------------- */

SELECT
  sr.id,
  sr.article_id,
  sr.location_id,
  sr.qty_reserved,
  sr.source_type,
  sr.source_id,
  sr.status,
  sr.created_by,
  sr.created_at
FROM public.stock_reservations sr
WHERE sr.source_type = 'COMMANDE_LIGNE'
  AND sr.source_id IN (
    SELECT cl.id::text
    FROM public.commande_ligne cl
    WHERE cl.commande_id = :commande_id
  )
ORDER BY sr.created_at ASC;

/* -------------------------------------------------------------------------- */
/* 4) Stock levels snapshot for affected articles                             */
/* -------------------------------------------------------------------------- */

-- All locations
SELECT
  sl.id,
  sl.article_id,
  sl.location_id,
  sl.qty_total,
  sl.qty_reserved,
  (sl.qty_total - sl.qty_reserved) AS qty_available
FROM public.stock_levels sl
WHERE sl.article_id IN (
  SELECT a.article_ref_id
  FROM public.commande_ligne_affaire_allocation a
  WHERE a.commande_id = :commande_id
    AND a.article_ref_id IS NOT NULL
)
ORDER BY sl.article_id, sl.location_id;

-- Single location (requires: \set location_id '<uuid>')
SELECT
  sl.id,
  sl.article_id,
  sl.location_id,
  sl.qty_total,
  sl.qty_reserved,
  (sl.qty_total - sl.qty_reserved) AS qty_available
FROM public.stock_levels sl
WHERE sl.article_id IN (
  SELECT a.article_ref_id
  FROM public.commande_ligne_affaire_allocation a
  WHERE a.commande_id = :commande_id
    AND a.article_ref_id IS NOT NULL
)
  AND sl.location_id::text = :'location_id'
ORDER BY sl.article_id, sl.location_id;

/* -------------------------------------------------------------------------- */
/* 5) OF created for this commande                                            */
/* -------------------------------------------------------------------------- */

SELECT
  ofa.id,
  ofa.numero,
  ofa.affaire_id,
  ofa.commande_id,
  ofa.client_id,
  ofa.piece_technique_id,
  ofa.quantite_lancee,
  ofa.statut,
  ofa.priority,
  ofa.created_at,
  ofa.updated_at
FROM public.ordres_fabrication ofa
WHERE ofa.commande_id = :commande_id
ORDER BY ofa.id ASC;

/* -------------------------------------------------------------------------- */
/* 6) Domain events + audit logs                                               */
/* -------------------------------------------------------------------------- */

SELECT
  e.id,
  e.commande_id,
  e.event_type,
  e.user_id,
  e.created_at,
  e.old_values,
  e.new_values
FROM public.commande_client_event_log e
WHERE e.commande_id = :commande_id
ORDER BY e.created_at ASC;

SELECT
  a.id,
  a.created_at,
  a.user_id,
  a.event_type,
  a.action,
  a.page_key,
  a.entity_type,
  a.entity_id,
  a.path,
  a.details
FROM public.erp_audit_logs a
WHERE a.entity_type = 'commande_client'
  AND a.entity_id = :commande_id::text
ORDER BY a.created_at ASC;
