/** The command records every partial withdrawal. A reservation's latest
 * movement pointer cannot reconstruct previous withdrawals, especially without
 * a tracked lot. Global pack depletion has no OF attribution. */
export const OF_MARGIN_CONSUMABLE_SOURCES_SQL = `
  SELECT concat('stock-consumption:', line.id::text) AS key,
    'PURCHASE'::text AS category,
    CASE WHEN proof.command_count=1 AND proof.matches AND line.unit_cost>=0
      THEN round(abs(line.qty)*line.unit_cost,6)::text ELSE NULL END AS amount_ht,
    CASE WHEN proof.command_count=1 AND proof.matches THEN 'CONSUMABLE_WITHDRAWAL_STOCK_COST'
      ELSE 'CONSUMABLE_WITHDRAWAL_PROOF_MISSING' END::text AS source_type,
    movement.id::text AS source_ref, movement.posted_at::text AS observed_at,
    CASE WHEN proof.command_count=1 AND proof.matches THEN 'DECLARED' ELSE 'UNKNOWN' END::text AS source_reliability,
    line.currency::text AS currency, abs(line.qty)::text AS quantity,
    'STOCK_MOVEMENT_LINE'::text AS source_document_type, line.id::text AS source_document_ref,
    CASE WHEN proof.command_count=1 AND proof.matches
      THEN 'Prélèvement OF de consommable : quantité physique × coût unitaire appliqué et déclaré ; CUMP non vérifié.'
      ELSE 'Prélèvement de consommable sans commande canonique cohérente ; rapprochement nécessaire.' END::text AS definition
  FROM public.stock_movement_lines line
  JOIN public.stock_movements movement ON movement.id=line.movement_id
  LEFT JOIN LATERAL (
    SELECT count(*) AS command_count,
      bool_and(COALESCE(reservation.of_id=command.of_id AND reservation.article_id=line.article_id
        AND reservation.lot_id IS NOT DISTINCT FROM line.lot_id
        AND reservation.qty_consumed>=abs(line.qty)
        AND need.need_kind='CONSOMMABLE' AND need.consumption_mode='UNIT'
        AND upper(btrim(need.unit))=upper(btrim(line.unite))
        AND CASE WHEN jsonb_typeof(command.response->'quantity')='number'
          THEN (command.response->>'quantity')::numeric=abs(line.qty) ELSE false END
        AND (SELECT count(*)=1 FROM public.stock_movement_lines owned WHERE owned.movement_id=movement.id),false)) AS matches
    FROM public.consumable_commands command
    LEFT JOIN public.stock_reservations reservation ON reservation.id::text=command.response->>'reservationId'
    LEFT JOIN public.of_material_needs need ON need.id=reservation.material_need_id
    WHERE command.of_id=$1::bigint AND command.command_type='WITHDRAW'
      AND command.response->>'stockMovementId'=movement.id::text
  ) proof ON true
  WHERE movement.source_document_type='OF' AND movement.source_document_id=$1::bigint::text
    AND movement.status::text='POSTED' AND movement.movement_type::text IN ('OUT','SCRAP')
    AND movement.reason_code='PRELEVEMENT_CONSOMMABLE' AND line.qty<>0
    AND NOT EXISTS (SELECT 1 FROM public.stock_movements reversal
      WHERE reversal.reversal_of_id=movement.id AND reversal.status::text='POSTED')
    AND NOT EXISTS (SELECT 1 FROM public.of_material_consumptions consumed
      WHERE consumed.stock_movement_line_id=line.id AND (consumed.status<>'POSTED'
        OR consumed.compensates_id IS NOT NULL OR consumed.compensated_by_id IS NOT NULL))
  ORDER BY key
`;
