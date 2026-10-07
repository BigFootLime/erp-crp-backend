/** Frozen engineering and live execution are captured in one statement before archival. */
export const OF_TRAVELER_SOURCE_SQL = `
WITH RECURSIVE ancestors(lot_id,ancestor_id) AS (
  SELECT r.lot_id,r.lot_id FROM public.stock_reservations r
    WHERE r.lot_id IS NOT NULL AND (r.of_id=$1 OR (r.source_type='OF' AND r.source_id=$1::text))
  UNION
  SELECT a.lot_id,e.parent_lot_id FROM ancestors a
    JOIN public.stock_lot_genealogy_edges e ON e.child_lot_id=a.ancestor_id
)
SELECT jsonb_build_object(
  'of',jsonb_build_object('id',o.id,'numero',o.numero,'status',o.statut,'quantity',o.quantite_lancee,
    'technical_hash',o.technical_snapshot_sha256,'version_id',o.piece_technique_version_id,
    'reference',COALESCE(o.technical_snapshot->'piece'->>'code',p.code_piece),
    'designation',COALESCE(o.technical_snapshot->'piece'->>'designation',p.designation),
    'plan',o.technical_snapshot->'version'->>'plan_reference','indice',o.technical_snapshot->'version'->>'indice_externe',
    'version',o.technical_snapshot->'version'->>'version_interne','snapshot',o.technical_snapshot,
    'client',COALESCE(c.company_name,p.client_name),'client_code',COALESCE(c.client_code,p.code_client),
    'commande',cc.numero,'customer_due',cl.delai_client,'internal_due',cl.delai_interne),
  'operations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',op.id,'phase',op.phase,'label',op.designation,
    'status',op.status,'machine',COALESCE(m.display_name,m.name),'reglage_h',op.tp,'piece_h',op.tf_unit,
    'good',COALESCE(q.good,0),'scrap',COALESCE(q.scrap,0),'pending',COALESCE(q.pending,0),'rework',COALESCE(q.rework,0)) ORDER BY op.phase,op.id)
    FROM public.of_operations op LEFT JOIN public.machines m ON m.id=op.machine_id
    LEFT JOIN LATERAL(SELECT sum(d.qty_good) AS good,sum(d.qty_scrap) AS scrap,
      sum(d.qty_pending_control) AS pending,sum(d.qty_rework) AS rework
      FROM public.production_quantity_declarations d WHERE d.operation_id=op.id) q ON true
    WHERE op.of_id=o.id AND (op.revision_id IS NULL OR EXISTS(
      SELECT 1 FROM public.of_revisions rev WHERE rev.id=op.revision_id AND rev.statut='ACTIVE'))),'[]'::jsonb),
  'visas',COALESCE((SELECT jsonb_agg(jsonb_build_object('phase',op.phase,'initials',v.initials,'at',v.visa_at,
    'operator',u.username,'status',v.statut,'good',v.quantite_bonne,'scrap',v.quantite_rebut,
    'control',v.controle_initials,'note',v.comment) ORDER BY op.phase,v.visa_at,v.id)
    FROM public.of_operation_visas v JOIN public.of_operations op ON op.id=v.of_operation_id
    LEFT JOIN public.users u ON u.id=v.user_id WHERE op.of_id=o.id AND v.revoked_at IS NULL
    AND (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions rev WHERE rev.id=op.revision_id AND rev.statut='ACTIVE'))),'[]'::jsonb),
  'reservations',COALESCE((SELECT jsonb_agg(jsonb_build_object('lot',l.lot_code,'reference',a.code,
    'reserved',r.qty_reserved,'consumed',r.qty_consumed,'unit',COALESCE(n.unit,a.unite),'status',r.status,
    'root_lots',(SELECT string_agg(DISTINCT root.lot_code,', ' ORDER BY root.lot_code) FROM ancestors an
      JOIN public.lots root ON root.id=an.ancestor_id WHERE an.lot_id=l.id
      AND NOT EXISTS(SELECT 1 FROM public.stock_lot_genealogy_edges e WHERE e.child_lot_id=root.id)))
    ORDER BY l.lot_code,r.id)
    FROM public.stock_reservations r JOIN public.lots l ON l.id=r.lot_id JOIN public.articles a ON a.id=r.article_id
    LEFT JOIN public.of_material_needs n ON n.id=r.material_need_id
    WHERE (r.of_id=o.id OR (r.source_type='OF' AND r.source_id=o.id::text)) AND (r.status IN ('ACTIVE','CONSUMED') OR r.qty_consumed>0)),'[]'::jsonb),
  'debits',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'phase',op.phase,'kind',d.quantity_kind,
    'good',q.qty_good,'scrap',q.qty_scrap,'actor',u.username,'at',d.created_at,'note',d.note,
    'compensates',d.compensates_id,'corrected_by',(SELECT corrected.id FROM public.production_material_debits corrected WHERE corrected.compensates_id=d.id LIMIT 1)) ORDER BY d.created_at,d.id)
    FROM public.production_material_debits d JOIN public.production_quantity_declarations q ON q.id=d.declaration_id
    JOIN public.of_operations op ON op.id=d.operation_id JOIN public.users u ON u.id=d.created_by WHERE d.of_id=o.id),'[]'::jsonb),
  'cuts',COALESCE((SELECT jsonb_agg(jsonb_build_object('debit_id',d.id,'lot',l.lot_code,'cut',s.cut_qty,
    'actual',s.actual_qty,'discarded',s.discarded_qty,'closed',s.bar_closed,'unit',n.unit,'movement',s.stock_movement_id)
    ORDER BY d.created_at,d.id,l.lot_code,s.reservation_id)
    FROM public.production_material_debit_sources s JOIN public.production_material_debits d ON d.id=s.debit_id
    JOIN public.stock_reservations r ON r.id=s.reservation_id JOIN public.lots l ON l.id=r.lot_id
    JOIN public.of_material_needs n ON n.id=s.need_id WHERE d.of_id=o.id),'[]'::jsonb),
  'remnants',COALESCE((SELECT jsonb_agg(jsonb_build_object('debit_id',r.debit_id,'lot',l.lot_code,'quantity',r.quantity,
    'unit',r.unit,'dimensions',r.dimensions,'movement',r.stock_movement_id) ORDER BY r.created_at,r.id)
    FROM public.production_material_remnants r JOIN public.production_material_debits d ON d.id=r.debit_id
    JOIN public.lots l ON l.id=r.lot_id WHERE d.of_id=o.id),'[]'::jsonb),
  'declarations',COALESCE((SELECT jsonb_agg(jsonb_build_object('phase',op.phase,'good',d.qty_good,'scrap',d.qty_scrap,
    'pending',d.qty_pending_control,'rework',d.qty_rework,'actor',u.username,'at',d.declared_at,
    'compensates',d.compensates_id,'reason',COALESCE(d.compensation_reason,d.scrap_reason_code,d.note)) ORDER BY d.declared_at,d.id)
    FROM public.production_quantity_declarations d LEFT JOIN public.of_operations op ON op.id=d.operation_id
    JOIN public.users u ON u.id=d.declared_by WHERE d.of_id=o.id),'[]'::jsonb)
) AS source
FROM public.ordres_fabrication o LEFT JOIN public.pieces_techniques p ON p.id=o.piece_technique_id
LEFT JOIN public.clients c ON c.client_id=o.client_id LEFT JOIN public.commande_client cc ON cc.id=o.commande_id
LEFT JOIN public.commande_ligne cl ON cl.id=o.commande_ligne_id WHERE o.id=$1
`;
