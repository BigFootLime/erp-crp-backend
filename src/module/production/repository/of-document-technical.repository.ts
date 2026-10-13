import type { DbQueryer, OfRevisionRow } from "./of-versioning.repository";
import {
  documentUuid, ofDocumentComponent, ofDocumentExecution, ofDocumentFrozenDocuments, ofDocumentFrozenMaterialExemption,
  ofDocumentFrozenNomenclature, ofDocumentFrozenPurchases,
  resolveOfDocumentTechnicalSource, type WorkshopDocumentMaterial, type WorkshopDocumentMaterialDebit, type WorkshopDocumentTechnicalEvidence,
} from "../domain/of-document-technical-source";

/** Read only the data the workshop document needs; supplier prices and private storage paths never enter its payload. */
export async function readOfDocumentTechnical(tx: DbQueryer, ofId: number, revision: OfRevisionRow) {
  const root = (await tx.query<{ snapshot: unknown; hash: string | null; quantity: number }>(
    "SELECT technical_snapshot AS snapshot,technical_snapshot_sha256 AS hash,quantite_lancee::float8 AS quantity FROM public.ordres_fabrication WHERE id=$1", [ofId])).rows[0];
  const source = resolveOfDocumentTechnicalSource({ revisionStatus: revision.statut, revisionHash: revision.snapshot_sha256,
    revisionSnapshot: revision.snapshot, rootHash: root?.hash ?? null, rootSnapshot: root?.snapshot });
  const purchases = ofDocumentFrozenPurchases(source);
  const frozenBom = ofDocumentFrozenNomenclature(source).map(row => ({ ...row,
    id: documentUuid(row.id), child_piece_technique_id: documentUuid(row.child_piece_technique_id),
    child_piece_technique_version_id: documentUuid(row.child_piece_technique_version_id), child_article_id: documentUuid(row.child_article_id),
  }));
  // Older dossiers froze the BOM identifiers only. Recover identity from the generated structure and the pinned
  // child version, never from the child's latest PT revision. New dossiers carry their readable identity directly.
  const componentRows = frozenBom.length ? (await tx.query<Record<string, unknown>>(`
    SELECT b.id,b.repere,b.quantite,b.child_piece_technique_id,
      COALESCE(b.reference,child_snapshot.snapshot#>>'{version,plan_reference}',cv.plan_reference,
        structure.piece_code,a.code) AS reference,
      COALESCE(b.indice,child_snapshot.snapshot#>>'{version,indice_externe}',cv.indice) AS indice,
      COALESCE(b.designation,child_snapshot.snapshot#>>'{piece,designation}',structure.piece_designation,a.designation) AS designation,
      COALESCE(b.unit,a.unite,CASE WHEN b.child_piece_technique_id IS NOT NULL THEN 'pièce' END) AS unit
    FROM jsonb_to_recordset($3::jsonb) AS b(id uuid,repere text,quantite numeric,reference text,indice text,designation text,unit text,
      child_piece_technique_id uuid,child_piece_technique_version_id uuid,child_article_id uuid)
    LEFT JOIN LATERAL(SELECT n.component_of_id,n.component_piece_technique_version_id FROM public.of_component_requirements n
      WHERE n.consuming_of_id=$1 AND n.parent_piece_technique_version_id=$2::uuid AND n.status<>'CANCELLED'
        AND ((b.child_piece_technique_id IS NOT NULL AND n.component_piece_technique_id=b.child_piece_technique_id)
          OR (b.child_piece_technique_id IS NULL AND n.component_article_id=b.child_article_id))
        AND (b.child_piece_technique_version_id IS NULL OR n.component_piece_technique_version_id=b.child_piece_technique_version_id)
        AND n.quantity_per_parent=b.quantite ORDER BY n.created_at,n.id LIMIT 1) requirement ON true
    LEFT JOIN public.piece_technique_versions cv ON cv.id=COALESCE(b.child_piece_technique_version_id,requirement.component_piece_technique_version_id)
    LEFT JOIN LATERAL(SELECT s.snapshot FROM public.of_technical_snapshots s
      WHERE s.of_id=requirement.component_of_id AND s.piece_technique_version_id=cv.id ORDER BY s.created_at DESC LIMIT 1) child_snapshot ON true
    LEFT JOIN LATERAL(SELECT s.piece_code,s.piece_designation FROM public.of_structure_snapshot s
      WHERE s.parent_of_id=$1 AND s.source_bom_line_id=b.id ORDER BY s.created_at DESC LIMIT 1) structure ON true
    LEFT JOIN public.articles a ON a.id=b.child_article_id`, [ofId, source.technicalVersionId, JSON.stringify(frozenBom)])).rows : [];
  const componentById = new Map(componentRows.map(row => [row.id, row]));
  const nomenclature = frozenBom.map(row => ofDocumentComponent(row.id ? componentById.get(row.id) ?? row : row, Number(root?.quantity)));
  const operations = (await tx.query<{ phase: number; status: string; good: number; scrap: number; pending: number; rework: number }>(
    `SELECT op.phase,op.status::text,COALESCE(q.good,0)::float8 AS good,COALESCE(q.scrap,0)::float8 AS scrap,
      COALESCE(q.pending,0)::float8 AS pending,COALESCE(q.rework,0)::float8 AS rework
      FROM public.of_operations op LEFT JOIN public.production_operation_quantities q ON q.operation_id=op.id
      WHERE op.of_id=$1 AND op.revision_id=$2::uuid ORDER BY op.phase,op.id`, [ofId, revision.id])).rows;
  const executions = Object.fromEntries(operations.map(operation => [operation.phase, ofDocumentExecution(operation)]));

  const needs = source.technicalVersionId ? (await tx.query<{
    id: string; source_ref: string; designation: string; reference: string | null; phase: number | null; required_qty: number;
    unit: string | null; requirements: {
      grade: string | null; condition: string | null; dimensions: Record<string, number>; certificates: string[]; manualChecks: string[] };
    debit_rule: { form?: string; unitsPerBlank?: number; kerfPerBlank?: number } | null; confirmed: boolean;
  }>(`SELECT n.id::text,n.source_ref,n.designation,a.code AS reference,op.phase,n.required_qty::float8,n.unit,n.requirements,n.debit_rule,
      (n.specification_reviewed_at IS NOT NULL AND n.operation_id IS NOT NULL AND n.unit IS NOT NULL AND n.debit_rule IS NOT NULL) AS confirmed
      FROM public.of_material_needs n LEFT JOIN public.articles a ON a.id=n.article_id
      LEFT JOIN public.of_operations op ON op.id=n.operation_id AND op.of_id=n.of_id AND op.revision_id=$2::uuid
      WHERE n.of_id=$1 AND n.need_kind='MATIERE' AND n.technical_version_id=$3::uuid AND n.technical_hash=$4
        AND n.superseded_at IS NULL AND (n.operation_id IS NULL OR op.id IS NOT NULL) ORDER BY n.created_at,n.id`,
    [ofId, revision.id, source.technicalVersionId, source.hash])).rows : [];
  const byPurchase = new Map(needs.map(need => [need.source_ref, need]));
  const materials: WorkshopDocumentMaterial[] = purchases.filter(purchase => purchase.type_achat === "MATIERE").map(purchase => {
    const need = byPurchase.get(String(purchase.id));
    const rule = need?.debit_rule;
    return {
      needId: need?.id ?? null, reference: need?.reference ?? null, designation: need?.designation ?? String(purchase.designation ?? purchase.nom ?? "Matière à préparer"),
      phase: need?.phase ?? null, requiredQuantity: need ? Number(need.required_qty) : null, unit: need?.unit ?? (typeof purchase.unite_prix === "string" ? purchase.unite_prix : null),
      grade: need?.requirements?.grade ?? null, condition: need?.requirements?.condition ?? null,
      dimensions: need?.requirements?.dimensions ?? {}, certificates: need?.requirements?.certificates ?? [], manualChecks: need?.requirements?.manualChecks ?? [],
      form: rule?.form ?? null, debitPerBlank: rule?.unitsPerBlank !== undefined && Number.isFinite(rule.unitsPerBlank)
        ? Number(rule.unitsPerBlank) + Number(rule.kerfPerBlank ?? 0) : null, confirmed: need?.confirmed === true,
    };
  });
  const needIds = materials.flatMap(material => material.needId ? [material.needId] : []);
  const debits = needIds.length ? (await tx.query<WorkshopDocumentMaterialDebit>(`
    SELECT op.phase,l.lot_code AS lot,
      CASE WHEN b.public_number IS NULL THEN NULL ELSE 'BAR-'||lpad(b.public_number::text,greatest(6,length(b.public_number::text)),'0') END AS bar,
      n.unit,COALESCE((event.source->>'cutMm')::float8+(event.source->>'discardedMm')::float8+(event.source->>'extraMm')::float8,s.actual_qty,abs(m.qty))::float8 AS actual,
      COALESCE((event.source->>'cutMm')::float8,s.cut_qty,s.actual_qty,abs(m.qty))::float8 AS cut,
      COALESCE((event.source->>'discardedMm')::float8,s.discarded_qty,0)::float8 AS discarded,
      (event.after_state->>'remainingMm')::float8 AS remaining,s.bar_closed AS closed,
      CASE WHEN COALESCE(event.event_count,1)=1 THEN s.yield_good::float8 END AS "quantityGood",
      CASE WHEN COALESCE(event.event_count,1)=1 THEN s.yield_scrap::float8 END AS "quantityScrap",
      d.quantity_kind AS "quantityKind",d.created_at::text AS "recordedAt"
      FROM public.production_material_debits d JOIN public.of_operations op ON op.id=d.operation_id AND op.of_id=d.of_id AND op.revision_id=$2::uuid
      JOIN public.production_material_debit_sources s ON s.debit_id=d.id AND s.need_id=ANY($3::uuid[])
      JOIN public.of_material_needs n ON n.id=s.need_id JOIN public.stock_movements m ON m.id=s.stock_movement_id
      JOIN public.stock_reservations r ON r.id=s.reservation_id JOIN public.lots l ON l.id=r.lot_id
      LEFT JOIN LATERAL(SELECT e.bar_id,e.after_state,source,count(*) OVER() AS event_count
        FROM public.stock_material_bar_events e CROSS JOIN LATERAL jsonb_array_elements(COALESCE(e.after_state->'sources','[]')) source
        WHERE e.command_key=d.command_key AND e.action='CUT' AND source->>'reservationId'=s.reservation_id::text) event ON true
      LEFT JOIN public.stock_material_bars b ON b.id=event.bar_id
      WHERE d.of_id=$1 AND d.compensates_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.production_material_debits c WHERE c.compensates_id=d.id)
      ORDER BY d.created_at,d.id,l.lot_code,b.public_number`, [ofId, revision.id, needIds])).rows : [];
  const correctionCount = Number((await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM public.production_material_debits d JOIN public.of_operations op ON op.id=d.operation_id
      WHERE d.of_id=$1 AND op.of_id=$1 AND op.revision_id=$2::uuid AND d.compensates_id IS NOT NULL`, [ofId, revision.id])).rows[0]?.count ?? 0);
  const evidence: WorkshopDocumentTechnicalEvidence = {
    source: { kind: source.kind, hash: source.hash, technicalVersionId: source.technicalVersionId }, materials, debits, correctionCount,
    materialNotRequired: ofDocumentFrozenMaterialExemption(source), nomenclature,
    documents: ofDocumentFrozenDocuments(source),
    purchases: purchases.filter(purchase => purchase.type_achat !== "MATIERE").map(purchase => ({
      type: String(purchase.type_achat ?? "ACHAT"), designation: String(purchase.designation ?? purchase.nom ?? "Prestation à compléter"),
      phase: typeof purchase.phase === "number" ? purchase.phase : null,
      quantityPerPiece: typeof purchase.quantite === "number" ? purchase.quantite : null,
      unit: typeof purchase.unite_prix === "string" ? purchase.unite_prix : null,
    })),
  };
  return { source, evidence, executions, decoupeNotRequired: ofDocumentFrozenMaterialExemption(source) };
}
