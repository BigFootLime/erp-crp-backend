export const RESERVATION_CONSUMPTION_SOURCE_SQL = `SELECT r.article_id::text,r.lot_id::text,r.stock_batch_id::text,s.id::text AS stock_level_id,e.magasin_id::text,e.id::int AS emplacement_id,a.unite AS unit,
    r.qty_reserved::float8,r.qty_consumed::float8,r.qty_prepared::float8,r.row_version,r.status,(r.expires_at IS NULL OR r.expires_at>now()) AS unexpired
    FROM public.stock_reservations r LEFT JOIN public.v_of_material_need_destinations destination ON destination.source_need_id=r.material_need_id
    LEFT JOIN public.of_material_needs n ON n.id=destination.target_need_id
    LEFT JOIN public.of_component_requirements component ON component.id=r.of_component_requirement_id
    JOIN public.stock_levels s ON s.article_id=r.article_id AND s.location_id=r.location_id
    LEFT JOIN public.stock_batches b ON b.id=r.stock_batch_id AND b.lot_id=r.lot_id AND b.stock_level_id=s.id
    JOIN public.emplacements e ON e.location_id=r.location_id JOIN public.articles a ON a.id=r.article_id
    WHERE r.id=$1::uuid AND r.of_id=$2 AND (
      (n.of_id=$2 AND n.need_kind=$4 AND n.superseded_at IS NULL AND (
        ($4='MATIERE' AND n.operation_id=$3::uuid AND b.id IS NOT NULL)
        OR($4='CONSOMMABLE' AND n.stock_managed AND n.consumption_mode='UNIT' AND a.stock_managed AND a.consumption_mode='UNIT'
          AND((r.lot_id IS NOT NULL AND b.id IS NOT NULL) OR(r.lot_id IS NULL AND NOT a.lot_tracking)))))
      OR($4='COMPONENT' AND component.id=$5::uuid AND component.consuming_of_id=$2
        AND component.component_article_id=r.article_id AND component.status<>'CANCELLED'
        AND r.material_need_id IS NULL AND r.source_type='OF_COMPONENT' AND r.source_id=component.id::text
        AND b.id IS NOT NULL))
    FOR UPDATE OF r`;

export const ASSEMBLY_CONSUMPTION_PROOF_SQL = `SELECT consumption.id FROM public.of_material_consumptions consumption
    JOIN public.stock_reservations reservation ON reservation.id=consumption.reservation_id
    JOIN public.stock_movements movement ON movement.id=consumption.stock_movement_id
    WHERE consumption.stock_movement_id=$1::uuid AND consumption.of_id=$2
      AND reservation.id=$3::uuid AND reservation.of_component_requirement_id=$4::uuid
      AND consumption.article_id=reservation.article_id AND consumption.lot_id=reservation.lot_id
      AND consumption.qty=$5 AND consumption.status='POSTED'
      AND movement.status::text='POSTED' AND movement.movement_type::text='OUT'
      AND movement.reason_code='PRELEVEMENT_COMPOSANT'
      AND consumption.compensates_id IS NULL AND consumption.compensated_by_id IS NULL`;
