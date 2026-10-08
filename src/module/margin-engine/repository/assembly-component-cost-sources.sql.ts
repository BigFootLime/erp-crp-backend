/** Assembly components are distinct from raw material. Their applied stock
 * price is declared, never inferred from a supplier quote or a child OF margin. */
export const OF_MARGIN_ASSEMBLY_COMPONENT_SOURCES_SQL = `
  SELECT concat('stock-consumption:',line.id::text) AS key,'PURCHASE'::text AS category,
    CASE WHEN proof.commands=1 AND proof.matches AND line.unit_cost>=0
      THEN round(abs(line.qty)*line.unit_cost,6)::text ELSE NULL END AS amount_ht,
    CASE WHEN proof.commands=1 AND proof.matches THEN 'ASSEMBLY_COMPONENT_APPLIED_STOCK_COST'
      ELSE 'ASSEMBLY_COMPONENT_COST_PROOF_MISSING' END::text AS source_type,
    movement.id::text AS source_ref,movement.posted_at::text AS observed_at,
    CASE WHEN proof.commands=1 AND proof.matches THEN 'DECLARED' ELSE 'UNKNOWN' END::text AS source_reliability,
    line.currency::text AS currency,abs(line.qty)::text AS quantity,
    'STOCK_MOVEMENT_LINE'::text AS source_document_type,line.id::text AS source_document_ref,
    CASE WHEN proof.commands=1 AND proof.matches
      THEN 'Sous-pièce mise en montage : quantité physique × coût stock appliqué et déclaré ; CUMP non vérifié.'
      ELSE 'Sortie de composant sans mise en montage et consommation cohérentes ; coût à rapprocher.' END::text AS definition
  FROM public.stock_movement_lines line JOIN public.stock_movements movement ON movement.id=line.movement_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS commands,bool_and(COALESCE(
      movement.movement_type::text='OUT' AND reservation.of_id=$1 AND reservation.article_id=line.article_id AND reservation.lot_id=line.lot_id
      AND reservation.qty_consumed>=abs(line.qty) AND reservation.material_need_id IS NULL
      AND reservation.source_type='OF_COMPONENT' AND reservation.source_id=requirement.id::text
      AND requirement.consuming_of_id=$1 AND requirement.component_article_id=line.article_id
      AND requirement.parent_piece_technique_version_id=of_order.piece_technique_version_id
      AND upper(btrim(article.unite))=upper(btrim(line.unite))
      AND child.request_payload->>'ofId'=$1::text AND child.request_payload->>'componentRequirementId'=requirement.id::text
      AND child.request_payload->>'reservationId'=reservation.id::text
      AND child.request_payload->'quantity'=to_jsonb(abs(line.qty)) AND child.result_payload->'quantity'=to_jsonb(abs(line.qty))
      AND(SELECT count(*) FROM public.stock_movement_lines owned WHERE owned.movement_id=movement.id)=1
      AND(SELECT count(*) FROM public.of_material_consumptions consumption
        WHERE consumption.stock_movement_id=movement.id AND consumption.stock_movement_line_id=line.id
          AND consumption.of_id=$1 AND consumption.reservation_id=reservation.id
          AND consumption.article_id=line.article_id AND consumption.lot_id=line.lot_id AND consumption.qty=abs(line.qty)
          AND consumption.status='POSTED' AND consumption.compensates_id IS NULL AND consumption.compensated_by_id IS NULL)=1
      AND(SELECT count(*) FROM public.stock_command_receipts parent
        WHERE parent.actor_user_id=child.actor_user_id AND parent.command_type='RESERVATION_CONSUME'
          AND parent.resource_type='ordres_fabrication' AND parent.resource_id=$1::text
          AND parent.request_payload->>'kind'='ASSEMBLY_COMPONENTS' AND parent.request_payload->>'ofId'=$1::text AND parent.result_payload->>'ofId'=$1::text
          AND child.idempotency_key=parent.idempotency_key||':'||reservation.id::text
          AND parent.result_payload->>'operationId'=child.request_payload->>'operationId'
          AND parent.result_payload->'movements' @> jsonb_build_array(jsonb_build_object(
            'requirementId',requirement.id::text,'reservationId',reservation.id::text,
            'stockMovementId',movement.id::text,'quantity',abs(line.qty))))=1,false)) AS matches
    FROM public.stock_command_receipts child
    LEFT JOIN public.stock_reservations reservation ON reservation.id::text=child.resource_id
    LEFT JOIN public.of_component_requirements requirement ON requirement.id=reservation.of_component_requirement_id
    LEFT JOIN public.ordres_fabrication of_order ON of_order.id=requirement.consuming_of_id
    LEFT JOIN public.articles article ON article.id=reservation.article_id
    WHERE child.command_type='RESERVATION_CONSUME' AND child.resource_type='stock_reservation'
      AND child.request_payload->>'kind'='COMPONENT' AND child.result_payload->>'stockMovementId'=movement.id::text
  ) proof ON true
  WHERE movement.source_document_type='OF' AND movement.source_document_id=$1::bigint::text
    AND movement.status::text='POSTED' AND movement.movement_type::text IN('OUT','SCRAP')
    AND movement.reason_code='PRELEVEMENT_COMPOSANT' AND line.qty<>0
    AND NOT EXISTS(SELECT 1 FROM public.stock_movements inverse WHERE inverse.reversal_of_id=movement.id AND inverse.status::text='POSTED')
    AND NOT EXISTS(SELECT 1 FROM public.of_material_consumptions consumption WHERE consumption.stock_movement_line_id=line.id
      AND(consumption.status<>'POSTED' OR consumption.compensates_id IS NOT NULL OR consumption.compensated_by_id IS NOT NULL))
  ORDER BY key
`;
