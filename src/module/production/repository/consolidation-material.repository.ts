import type { PoolClient } from 'pg';
import type { DossierDb } from './of-dossier.repository';
import type { AuditContext } from './production.repository';
import { readMaterialTx } from './of-material.repository';
import { readMaterialReservationAvailabilityTx } from './material-reservation-availability.repository';
import { readMaterialOriginPolicyTx } from './of-material-policy.repository';
import { assertMaterialOriginLimit, missingPhysicalMaterial } from '../domain/of-material-policy';
import { debitQuantity, materialPropertiesFingerprint, proposeMaterialCoverage, quantity } from '../domain/of-material';
import { repoCreateStockReservation } from '../../stock/repository/stock-reservation.repository';
import { HttpError } from '../../../utils/httpError';
import { aggregateConsolidationHoldsTx } from './consolidation-material-holds.repository';

/** Physical regrouping moves existing holds, never reserves their quantity a
 * second time. Source preparation is checked again inside the creation tx. */
export async function previewConsolidationMaterialTx(tx: DossierDb, sourceIds: number[], producerQuantity: number, lock = false) {
  let materials: Array<Awaited<ReturnType<typeof readMaterialTx>>> = [];
  for (const id of sourceIds) materials.push(await readMaterialTx(tx, id));
  if (lock) {
    const lotIds = [...new Set(materials.flatMap(m => m.needs.flatMap(n =>
      [...n.candidates.map(c => c.lot.id), ...n.reservations.flatMap(r => r.lot_id ? [String(r.lot_id)] : [])])))].sort();
    await tx.query('SELECT id FROM public.lots WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [lotIds]);
    materials = [];
    for (const id of sourceIds) materials.push(await readMaterialTx(tx, id));
  }
  const first = materials[0];
  for (const material of materials) {
    if (material.previousNeeds.length || material.needs.some(n => !n.id || !n.reviewed || !n.debitRule || !n.operationId || n.consumed > 0
      || n.reservations.some(r => !r.material_need_id)))
      throw new HttpError(409, 'CONSOLIDATION_MATERIAL_PREPARATION', 'Préparez et réservez la matière des OF sources avant regroupement.', { ofId: material.ofId });
    const available = await readMaterialReservationAvailabilityTx(tx, material);
    const missing = missingPhysicalMaterial(material.needs.map(n => ({ ...n,
      usableReserved: available.get(n.key)?.usable ?? 0, blockers: [...n.blockers, ...(available.get(n.key)?.blockers ?? [])] })));
    if (missing.length) throw new HttpError(409, 'CONSOLIDATION_MATERIAL_MISSING',
      'Le regroupement nécessite toute la matière physique réservée. Complétez les OF sources ou préparez un OF séparé.', { ofId: material.ofId, needs: missing });
  }
  const policy = await readMaterialOriginPolicyTx(tx, sourceIds, first.needs.flatMap(n => n.candidates.map(c => c.lot.id)));
  assertMaterialOriginLimit(policy, []);
  const proposedOrigins = new Set(policy.usedOrigins);
  const remainingBatches = new Map(first.needs.flatMap(n => n.candidates.map(c => [c.lot.batchId, c.available] as const)));
  const remainingQuality = new Map(first.needs.flatMap(n => n.candidates.map(c => [c.lot.id, c.lot.qualityAvailable ?? 0] as const)));
  const remainingLevels = new Map(first.needs.flatMap(n => n.candidates.flatMap(c => c.lot.stockLevelId ? [[c.lot.stockLevelId, c.lot.levelAvailable ?? 0] as const] : [])));
  const groups = first.needs.map(need => {
    const phase = first.operations.find(o => o.id === need.operationId)!.phase;
    const signature = (n: typeof need, phaseNumber: number) => materialPropertiesFingerprint({ articleId: n.articleId,
      unit: n.unit, requirements: n.requirements, debitRule: n.debitRule, phase: phaseNumber, supplyMode: n.supplyMode });
    const matching = materials.map(m => {
      const n = m.needs.find(item => item.key === need.key);
      if (!n || signature(n, m.operations.find(o => o.id === n.operationId)!.phase) !== signature(need, phase))
        throw new HttpError(409, 'CONSOLIDATION_MATERIAL_INCOMPATIBLE', 'Les exigences matière ou les règles de débit des OF diffèrent.', { ofId: m.ofId, sourceRef: need.key });
      return { ofId: m.ofId, need: n };
    });
    const required = debitQuantity(need.debitRule!, producerQuantity);
    const held = quantity(matching.reduce((sum, m) => sum + m.need.reserved, 0));
    const candidates = need.candidates.map(c => ({ ...c.lot, available: remainingBatches.get(c.lot.batchId) ?? 0,
      qualityAvailable: remainingQuality.get(c.lot.id) ?? 0,
      levelAvailable: c.lot.stockLevelId ? remainingLevels.get(c.lot.stockLevelId) : undefined }));
    const proposal = proposeMaterialCoverage([{ ...need, required, reserved: held, consumed: 0, expected: 0, receivedBlocked: 0 }],
      candidates, { maximumLots: policy.maximumLots, usedOrigins: proposedOrigins, originsByLot: policy.originsByLot })[0];
    if (proposal.purchaseMissing) throw new HttpError(409, 'CONSOLIDATION_MATERIAL_MISSING',
      'Le stock disponible dans les lots autorisés ne couvre pas toute la quantité regroupée.', { sourceRef: need.key, missing: proposal.purchaseMissing, unit: need.unit });
    for (const s of proposal.selections) {
      const lot = candidates.find(c => c.batchId === s.batchId)!;
      remainingBatches.set(s.batchId, quantity((remainingBatches.get(s.batchId) ?? 0) - s.quantity));
      remainingQuality.set(s.lotId, quantity((remainingQuality.get(s.lotId) ?? 0) - s.quantity));
      if (lot.stockLevelId) remainingLevels.set(lot.stockLevelId, quantity((remainingLevels.get(lot.stockLevelId) ?? 0) - s.quantity));
    }
    return { sourceRef: need.key, articleId: need.articleId!, designation: need.designation, unit: need.unit!, phase,
      requirements: need.requirements, debitRule: need.debitRule!, supplyMode: need.supplyMode,
      supplierId: need.supplierId, destinationId: need.destinationId, required,
      sources: matching.map(m => ({ ofId: m.ofId, needId: m.need.id!, reservations: m.need.reservations
        .filter(r => r.status === 'ACTIVE' && r.unexpired).map(r => String(r.id)) })),
      extra: proposal.selections.map(s => ({ ...s, lot: need.candidates.find(c => c.lot.batchId === s.batchId)!.lot })) };
  });
  if (materials.some(m => m.needs.length !== groups.length))
    throw new HttpError(409, 'CONSOLIDATION_MATERIAL_INCOMPATIBLE', 'Les besoins matière des OF sources diffèrent.');
  return { groups, policy, versions: materials.map(m => ({ ofId: m.ofId, version: m.version })) };
}

export async function transferConsolidationMaterialTx(tx: PoolClient, consolidationId: string, producerId: number,
  material: Awaited<ReturnType<typeof previewConsolidationMaterialTx>>, audit: AuditContext) {
  for (const group of material.groups) {
    const inserted = (await tx.query<{ id: string }>(`INSERT INTO public.of_material_needs
      (of_id,source_ref,technical_version_id,technical_hash,operation_id,article_id,designation,required_qty,unit,
       supply_mode,requirements,specification_reviewed_at,specification_reviewed_by,debit_rule,allow_partial,supplier_id,destination_id,created_by,updated_by)
      SELECT o.id,$2,o.piece_technique_version_id,o.technical_snapshot_sha256,op.id,$3::uuid,$4,$5,$6,
        $7,$8::jsonb,now(),$9,$10::jsonb,false,$11::uuid,$12::uuid,$9,$9
      FROM public.ordres_fabrication o JOIN public.of_operations op ON op.of_id=o.id AND op.phase=$13
      WHERE o.id=$1 RETURNING id::text`, [producerId, group.sourceRef, group.articleId, group.designation,
      group.required, group.unit, group.supplyMode, JSON.stringify(group.requirements), audit.user_id,
      JSON.stringify(group.debitRule), group.supplierId, group.destinationId, group.phase])).rows[0];
    if (!inserted) throw new HttpError(409, 'CONSOLIDATION_MATERIAL_OPERATION', 'L’opération consommatrice du regroupement est absente.');
    // Reserve only the surplus first, while source commitments still exist.
    // Aggregation then transfers their ownership without reserving them twice.
    const surplusReservationIds: string[]=[];
    for (const extra of group.extra) {
      const hold=await repoCreateStockReservation({ article_id: group.articleId,
        magasin_id: extra.lot.magasinId, emplacement_id: extra.lot.emplacementId, lot_id: extra.lotId,
        qty: extra.quantity, source: { source_type: 'OF', of_id: producerId }, reason: 'Matière du surplus du regroupement physique' },
      audit, `consolidation-material:${consolidationId}:${inserted.id}:${extra.batchId}`, tx, inserted.id);
      surplusReservationIds.push(hold.reservation.id);
    }
    await aggregateConsolidationHoldsTx(tx,{consolidationId,producerId,needId:inserted.id,articleId:group.articleId,
      sources:group.sources,surplusReservationIds},audit);
    for (const source of group.sources) {
      await tx.query(`INSERT INTO public.of_material_lot_checks(need_id,lot_id,requirements_hash,evidence,decided_by,decided_at,lot_properties_hash,manual_checks_confirmed)
        SELECT $1::uuid,lot_id,requirements_hash,evidence,decided_by,decided_at,lot_properties_hash,manual_checks_confirmed
        FROM public.of_material_lot_checks WHERE need_id=$2::uuid ON CONFLICT DO NOTHING`, [inserted.id, source.needId]);
    }
  }
}
