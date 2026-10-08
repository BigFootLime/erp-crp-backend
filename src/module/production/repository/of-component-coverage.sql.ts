export const OF_COMPONENT_CONTEXT_SQL = `
  SELECT o.numero AS number, o.quantite_lancee::float8 AS quantity, o.statut::text AS "executionStatus",
    COALESCE(o.piece_technique_version_id, NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
      NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid)::text AS "versionId",
    (COALESCE(v.manufacturing_mode='ASSEMBLY',false) OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) op
      WHERE op->>'type_operation'='ASSEMBLAGE')) AS assembly,
    (SELECT c.producer_of_id::bigint::int FROM public.production_consolidation_allocations a
      JOIN public.production_consolidations c ON c.id=a.consolidation_id
      WHERE a.source_of_id=o.id AND a.state='ACTIVE' AND c.state='ACTIVE') AS "producerId"
  FROM public.ordres_fabrication o LEFT JOIN public.piece_technique_versions v
    ON v.id=COALESCE(o.piece_technique_version_id,NULLIF(o.technical_preparation->>'selected_version_id','')::uuid,
      NULLIF(o.technical_preparation->>'selected_draft_version_id','')::uuid)
  WHERE o.id=$1
`;

export const OF_COMPONENT_REQUIREMENTS_SQL = `
  SELECT n.id::text,n.component_kind AS kind,n.status,n.action,n.structure_path AS path,
    n.component_article_id::text AS "articleId",n.component_piece_technique_id::text AS "pieceId",
    n.parent_piece_technique_version_id::text AS "parentVersionId",
    COALESCE(original.source_of_id,n.consuming_of_id)::bigint::int AS "sourceOfId",
    COALESCE(p.designation,a.designation,p.code_piece,a.code,n.structure_path) AS label,a.unite AS unit,
    child.id::bigint::int AS "childOfId",child.numero AS "childNumber",child.statut::text AS "childStatus",
    n.required_qty::float8 AS required,n.quantity_per_parent::text AS "quantityPerParent",
    COALESCE(consumed.quantity,0)::float8 AS "consumedQuantity",n.updated_at::text AS "updatedAt"
  FROM public.of_component_requirements n LEFT JOIN public.articles a ON a.id=n.component_article_id
  LEFT JOIN public.pieces_techniques p ON p.id=n.component_piece_technique_id
  LEFT JOIN public.ordres_fabrication child ON child.id=n.component_of_id
  LEFT JOIN LATERAL (
    SELECT transfer.source_of_id FROM public.production_consolidation_component_transfers transfer
    JOIN public.production_consolidations grouped ON grouped.id=transfer.consolidation_id
    WHERE transfer.requirement_id=n.id AND grouped.state='ACTIVE' AND grouped.producer_of_id=n.consuming_of_id
  ) original ON true
  LEFT JOIN LATERAL (
    SELECT sum(consumption.qty) AS quantity
    FROM public.of_material_consumptions consumption
    JOIN public.stock_reservations reservation ON reservation.id=consumption.reservation_id
    JOIN public.stock_movements movement ON movement.id=consumption.stock_movement_id
    JOIN public.stock_movement_lines line ON line.id=consumption.stock_movement_line_id
      AND line.movement_id=movement.id AND line.article_id=reservation.article_id
      AND line.lot_id IS NOT DISTINCT FROM reservation.lot_id AND abs(line.qty)=consumption.qty
    WHERE reservation.of_component_requirement_id=n.id AND reservation.of_id=n.consuming_of_id
      AND reservation.article_id=n.component_article_id AND consumption.of_id=n.consuming_of_id
      AND movement.source_document_type='OF' AND movement.source_document_id=n.consuming_of_id::text
      AND movement.reason_code='PRELEVEMENT_COMPOSANT' AND movement.status::text='POSTED'
      AND movement.movement_type::text='OUT' AND consumption.status='POSTED'
      AND consumption.compensates_id IS NULL AND consumption.compensated_by_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.stock_movements reversal
        WHERE reversal.reversal_of_id=movement.id AND reversal.status::text='POSTED')
  ) consumed ON true
  WHERE n.consuming_of_id=$1 AND n.status<>'CANCELLED' ORDER BY n.structure_path,n.id
`;

export const OF_COMPONENT_RESERVATIONS_SQL = `
  SELECT r.id::text,r.of_component_requirement_id::text AS "requirementId",r.lot_id::text AS "lotId",
    l.lot_code AS "lotCode",r.source_scope AS scope,GREATEST(0,r.qty_reserved-r.qty_consumed)::float8 AS quantity,
    r.row_version AS "rowVersion",
    (l.lot_status='LIBERE' AND b.qty_total-b.qty_depreciated>=b.qty_reserved AND r.article_id=l.article_id
      AND r.article_id=n.component_article_id AND r.of_id=n.consuming_of_id
      AND r.material_need_id IS NULL AND r.source_type='OF_COMPONENT' AND r.source_id=n.id::text) AS physical,
    r.updated_at::text AS "updatedAt"
  FROM public.stock_reservations r JOIN public.of_component_requirements n ON n.id=r.of_component_requirement_id
  LEFT JOIN public.stock_batches b ON b.id=r.stock_batch_id LEFT JOIN public.lots l ON l.id=r.lot_id
  WHERE n.consuming_of_id=$1 AND n.status<>'CANCELLED' AND r.status='ACTIVE'
    AND(r.expires_at IS NULL OR r.expires_at>statement_timestamp()) ORDER BY r.lot_id,r.id
`;

export const OF_ASSEMBLY_OPERATIONS_SQL = `
  SELECT op.id::text,op.phase,op.designation AS label,op.status::text
  FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id
  WHERE op.of_id=$1 AND op.status::text<>'CANCELLED'
    AND(op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r
      WHERE r.id=op.revision_id AND r.statut='ACTIVE'))
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) frozen
      WHERE frozen->>'phase'=op.phase::text AND frozen->>'type_operation'='ASSEMBLAGE')
  ORDER BY op.phase,op.id
`;
