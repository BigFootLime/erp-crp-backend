export const ASSEMBLY_WITHDRAWALS_SQL = `SELECT receipt.correlation_id::text AS id,
  receipt.created_at::text AS "createdAt",receipt.result_payload AS result,
  EXISTS(SELECT 1 FROM public.stock_command_receipts correction
    WHERE correction.command_type='MOVEMENT_COMPENSATE' AND correction.resource_type='ordres_fabrication'
      AND correction.resource_id=receipt.resource_id AND correction.request_payload->>'kind'='ASSEMBLY_COMPONENT_RETURN'
      AND correction.request_payload->>'withdrawalId'=receipt.correlation_id::text) AS returned
  FROM public.stock_command_receipts receipt
  WHERE receipt.command_type='RESERVATION_CONSUME' AND receipt.resource_type='ordres_fabrication'
    AND receipt.resource_id=$1::text AND receipt.request_payload->>'kind'='ASSEMBLY_COMPONENTS'
    AND receipt.request_payload->>'ofId'=$1::text
    AND($2::uuid IS NULL OR receipt.correlation_id=$2::uuid)
  ORDER BY receipt.created_at DESC,receipt.correlation_id LIMIT 50`;

export const ASSEMBLY_RETURN_MOVEMENTS_SQL = `SELECT item."requirementId",item."sourceOfId",item."reservationId",
  item."stockMovementId",item.quantity::float8 AS quantity,
  reservation.lot_id::text AS "lotId",lot.lot_code AS "lotCode",article.designation AS label,
  reservation.row_version AS "reservationVersion",reservation.status AS "reservationStatus",
  reservation.qty_consumed::float8 AS consumed,article.unite AS unit,
  (reservation.status IN('ACTIVE','CONSUMED') AND(reservation.expires_at IS NULL OR reservation.expires_at>now())
    AND reservation.qty_consumed>=item.quantity AND lot.lot_status='LIBERE'
    AND batch.lot_id=reservation.lot_id AND batch.stock_level_id=level.id
    AND reservation.article_id=lot.article_id AND reservation.article_id=requirement.component_article_id
    AND reservation.material_need_id IS NULL AND reservation.source_type='OF_COMPONENT'
    AND reservation.source_id=requirement.id::text AND requirement.status<>'CANCELLED'
    AND requirement.parent_piece_technique_version_id=of_order.piece_technique_version_id
    AND line.article_id=reservation.article_id AND line.lot_id=reservation.lot_id AND abs(line.qty)=item.quantity
    AND line.unite=article.unite AND emplacement.location_id=reservation.location_id
    AND movement.status::text='POSTED' AND movement.movement_type::text='OUT'
    AND movement.reason_code='PRELEVEMENT_COMPOSANT' AND movement.source_document_type='OF'
    AND movement.source_document_id=$1::text
    AND NOT EXISTS(SELECT 1 FROM public.stock_movements inverse WHERE inverse.reversal_of_id=movement.id AND inverse.status::text<>'CANCELLED')
    AND EXISTS(SELECT 1 FROM public.stock_command_receipts child
      WHERE child.actor_user_id=receipt.actor_user_id AND child.command_type='RESERVATION_CONSUME'
        AND child.resource_type='stock_reservation' AND child.resource_id=reservation.id::text
        AND child.request_payload->>'kind'='COMPONENT' AND child.request_payload->>'ofId'=$1::text
        AND child.request_payload->>'componentRequirementId'=requirement.id::text
        AND child.request_payload->>'operationId'=receipt.result_payload->>'operationId'
        AND child.result_payload->>'stockMovementId'=movement.id::text
        AND child.result_payload->'quantity'=to_jsonb(item.quantity))
    AND(SELECT count(*) FROM public.of_material_consumptions proof
      WHERE proof.stock_movement_id=movement.id AND proof.stock_movement_line_id=line.id
        AND proof.of_id=$1 AND proof.reservation_id=reservation.id AND proof.article_id=line.article_id
        AND proof.lot_id=line.lot_id AND proof.qty=item.quantity AND proof.status='POSTED'
        AND proof.compensates_id IS NULL AND proof.compensated_by_id IS NULL)=1
  ) AS correctable
  FROM public.stock_command_receipts receipt
  CROSS JOIN LATERAL jsonb_to_recordset(receipt.result_payload->'movements') item(
    "requirementId" uuid,"sourceOfId" bigint,"reservationId" uuid,"stockMovementId" uuid,quantity numeric)
  JOIN public.stock_reservations reservation ON reservation.id=item."reservationId" AND reservation.of_id=$1
  JOIN public.of_component_requirements requirement ON requirement.id=item."requirementId"
    AND requirement.id=reservation.of_component_requirement_id AND requirement.consuming_of_id=$1
  JOIN public.ordres_fabrication of_order ON of_order.id=$1
  JOIN public.stock_movements movement ON movement.id=item."stockMovementId"
  JOIN public.stock_movement_lines line ON line.movement_id=movement.id
  JOIN public.articles article ON article.id=reservation.article_id
  LEFT JOIN public.lots lot ON lot.id=reservation.lot_id
  LEFT JOIN public.stock_batches batch ON batch.id=reservation.stock_batch_id
  LEFT JOIN public.stock_levels level ON level.article_id=reservation.article_id AND level.location_id=reservation.location_id
  LEFT JOIN public.emplacements emplacement ON emplacement.id=line.src_emplacement_id AND emplacement.magasin_id=line.src_magasin_id
  WHERE receipt.correlation_id=$2::uuid AND receipt.command_type='RESERVATION_CONSUME'
    AND receipt.resource_type='ordres_fabrication' AND receipt.resource_id=$1::text
    AND receipt.request_payload->>'kind'='ASSEMBLY_COMPONENTS' AND receipt.request_payload->>'ofId'=$1::text
  ORDER BY reservation.lot_id,reservation.id,movement.id`;

// A return is only available before any downstream use. Correcting a recorded
// output must use its own quality/transfer circuit first, never erase history.
export const ASSEMBLY_RETURN_DOWNSTREAM_SQL = `SELECT
  EXISTS(SELECT 1 FROM public.production_quantity_declarations declaration
    LEFT JOIN public.of_operations operation ON operation.id=declaration.operation_id
    WHERE declaration.of_id=$1 AND(operation.id IS NULL OR operation.phase>=$2)
      AND declaration.compensates_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.production_quantity_declarations correction WHERE correction.compensates_id=declaration.id)) AS declared,
  (EXISTS(SELECT 1 FROM public.of_receipts WHERE of_id=$1)
    OR EXISTS(SELECT 1 FROM public.of_output_lots WHERE of_id=$1)) AS received,
  EXISTS(SELECT 1 FROM public.production_transfer_batches transfer JOIN public.of_operations operation ON operation.id=transfer.operation_id
    WHERE operation.of_id=$1 AND operation.phase>=$2 AND transfer.released_quantity>0) AS transferred,
  (EXISTS(SELECT 1 FROM public.quality_control control LEFT JOIN public.of_operations operation ON operation.id=control.operation_id
      WHERE control.of_id=$1 AND(operation.id IS NULL OR operation.phase>=$2))
    OR EXISTS(SELECT 1 FROM public.of_quality_logs log LEFT JOIN public.of_operations operation ON operation.id=log.of_operation_id
      WHERE log.of_id=$1 AND(operation.id IS NULL OR operation.phase>=$2))
    OR EXISTS(SELECT 1 FROM public.quality_release_decision decision
      WHERE(decision.object_type='OF' AND decision.object_id=$1::text)
        OR(decision.object_type='OF_OPERATION' AND EXISTS(SELECT 1 FROM public.of_operations operation
          WHERE operation.id::text=decision.object_id AND operation.of_id=$1 AND operation.phase>=$2)))) AS quality,
  EXISTS(SELECT 1 FROM public.of_operations operation WHERE operation.of_id=$1 AND operation.phase>$2
    AND operation.status::text<>'CANCELLED' AND operation.started_at IS NOT NULL) AS successor,
  EXISTS(SELECT 1 FROM public.production_loss_complements complement
    JOIN public.of_operations operation ON operation.id=complement.source_operation_id
    JOIN public.ordres_fabrication of_order ON of_order.id=complement.complement_of_id
    WHERE operation.of_id=$1 AND operation.phase>=$2 AND of_order.statut::text<>'ANNULE') AS complemented`;
