import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { isLotExpired } from '../../qualite/domain/lot-shelf-life';
import { readOperationalLotQualityEligibility } from '../../qualite/repository/quality-operational-gate.repository';
import { planDeliveryUrgency, type UrgencyDonor } from '../domain/delivery-urgency';
import { readDeliveryStockRecoveryPlan } from './delivery-stock-recovery.repository';
import { DELIVERY_URGENCY_DONORS_SQL } from './delivery-urgency.sql';

export type DeliveryUrgencyDonor = UrgencyDonor & {
  reservation_version: number; allocation_version: number; commande_id: number; commande_ligne_id: number;
  livraison_affaire_id: number; commande_numero: string; customer_order_reference: string | null;
  affaire_reference: string; initial_ar_due_date: string; promise_version: number;
  lot_id: string; lot_code: string; lot_status: string; expiry_at: string | null;
  source_scope: string; stock_version_id: string | null; old_documents: boolean;
  piece_technique_id: string; technical_version_id: string;
};

export async function readDeliveryUrgencyPlan(tx: Pick<PoolClient, 'query'>, allocationId: number, requestedQuantity?: string) {
    const recovery = await readDeliveryStockRecoveryPlan(tx, allocationId);
    const { context, preview } = recovery;
    if (preview.lane_status !== 'ACTIVE')
      throw new HttpError(409, 'URGENCY_LANES_NOT_CONFIGURED', 'Configurez les trois pistes de stock avant une demande de prélèvement urgent.');
    const today = (await tx.query<{ day: string }>("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS day")).rows[0].day;
    const raw = (await tx.query<DeliveryUrgencyDonor>(DELIVERY_URGENCY_DONORS_SQL,
      [context.client_id, context.article_id, context.technical_version_id, allocationId])).rows;
    const qualityByLot = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
    const donors: DeliveryUrgencyDonor[] = [];
    for (const row of raw.slice(0, 200)) {
      let blocker: string | null = null;
      if (!['OLD', 'NEW'].includes(row.source_scope)) blocker = 'Origine du lot à vérifier';
      else if (row.lot_status !== 'LIBERE') blocker = 'Lot non libéré par la qualité';
      else if (isLotExpired(row.expiry_at, new Date())) blocker = 'Lot périmé';
      else if (row.source_scope === 'OLD' && !row.old_documents) blocker = 'Dossier historique OLD manquant';
      else if (row.source_scope === 'NEW') {
        let quality = qualityByLot.get(row.lot_id);
        if (!quality) {
          // This is a reassignment of an existing commitment, not a new quality entitlement.
          // qty=0 checks that all existing commitments still fit the current release.
          quality = await readOperationalLotQualityEligibility({ client: tx, lotId: row.lot_id,
            qty: 0, unit: context.unit, purpose: 'RESERVE' });
          qualityByLot.set(row.lot_id, quality);
        }
        if (!quality.eligibility.allowed) blocker = quality.eligibility.blocks[0]?.message ?? 'Lot bloqué par la qualité';
      }
      donors.push({ ...row, blocker,
        version_compatible: row.version_compatible || (row.source_scope === 'OLD' && row.stock_version_id === null) });
    }
    const plan = planDeliveryUrgency({ allocation_id: allocationId, client_id: context.client_id,
      article_id: context.article_id, requested_quantity: requestedQuantity ?? String(preview.uncovered_qty),
      uncovered_quantity: String(preview.uncovered_qty), free_quantity: recovery.plan.reserved_quantity, today, donors });
    const byId = new Map(donors.map(donor => [donor.reservation_id, donor]));
    const result = { ...plan, allocation_id: allocationId, commande_id: context.commande_id,
      livraison_affaire_id: context.livraison_affaire_id, client_id: context.client_id,
      client_name: context.client_name, client_code: context.client_code,
      article_code: context.article_code, designation: context.designation, indice: context.indice, unit: context.unit,
      candidate_limit_reached: raw.length > 200, free_stock_limit_reached: preview.candidate_limit_reached,
      preview_hash: createHash('sha256').update(JSON.stringify({ recovery: preview.preview_hash, donors, plan, today })).digest('hex'),
      donors: plan.rows.map(row => { const source = byId.get(row.reservation_id)!;
        return { ...row, commande_id: source.commande_id, commande_numero: source.commande_numero,
          customer_order_reference: source.customer_order_reference, livraison_affaire_id: source.livraison_affaire_id,
          affaire_reference: source.affaire_reference, lot_id: source.lot_id, lot_code: source.lot_code,
          source_scope: source.source_scope, initial_ar_due_date: source.initial_ar_due_date }; }),
    };
    const { rows: _rows, ...response } = result;
    return { context, donors, response };
}

export async function repoPreviewDeliveryUrgency(allocationId: number, requestedQuantity?: string) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { response } = await readDeliveryUrgencyPlan(tx, allocationId, requestedQuantity);
    await tx.query('COMMIT');
    return response;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
