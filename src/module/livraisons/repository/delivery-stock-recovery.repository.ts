import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { beginStockCommand, completeStockCommand, type AuditContext } from "../../stock/repository/stock.repository";
import { lockStockLaneTopology, readStockLaneRoutingTx } from "../../stock/repository/stock-lane-routing.repository";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";
import { readOperationalLotQualityEligibility, assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { reserveProducedDeliveryDemands } from "../../production/repository/receipt-delivery-reservations.repository";
import { planDeliveryStockRecovery, type RecoveryStockCandidate } from "../domain/delivery-stock-recovery";
import { DELIVERY_RECOVERY_CONTEXT_SQL, DELIVERY_RECOVERY_STOCK_SQL } from "./delivery-stock-recovery.sql";
import { deliveryStockRecoveryResult } from "../validators/delivery-stock-recovery.validators";

type Db = Pick<PoolClient, "query">;
type Context = {
  allocation_id: number; allocation_version: number; commande_id: number; commande_ligne_id: number;
  livraison_affaire_id: number; ordered: string; delivered_projection: string; line_ordered: string;
  article_id: string; technical_version_id: string; unit: string | null; article_code: string;
  designation: string | null; indice: string; piece_client_id: string | null; client_id: string;
  commande_numero: string; customer_order_reference: string | null; order_type: string; command_status: string;
  client_name: string; client_code: string | null; affaire_reference: string; affair_status: string;
  delivery_readiness_state: string; ar_due_date: string | null; shipped: string; reserved: string;
  unreserved_prepared: string; invalid_prepared: boolean; reservation_state: unknown;
};
type Candidate = RecoveryStockCandidate & {
  location_id: string; lot_code: string; lot_status: string; expiry_at: string | null;
  lane: string | null; magasin_code: string; emplacement_code: string; source_scope: string;
  stock_version_id: string | null; version_compatible: boolean; old_documents: boolean;
  quality_evidence?: unknown;
};
const num = (value: string) => Number(value);
const conflict = (code: string, message: string): never => { throw new HttpError(409, code, message); };

async function readPlan(tx: Db, allocationId: number) {
  const context = (await tx.query<Context>(DELIVERY_RECOVERY_CONTEXT_SQL, [allocationId])).rows[0];
  if (!context) throw new HttpError(404, "DELIVERY_ALLOCATION_NOT_FOUND", "L'affaire ou son article technique est introuvable.");
  if (context.piece_client_id !== context.client_id)
    conflict("DELIVERY_STOCK_CLIENT_MISMATCH", "La pièce technique ne correspond pas au client de cette commande.");
  const unavailable = ['ANNULE','ANNULEE','CANCELLED'];
  if (context.order_type === "INTERNE" || unavailable.includes(context.affair_status) || unavailable.includes(context.command_status))
    conflict("DELIVERY_ALLOCATION_UNAVAILABLE", "Cette affaire ne peut pas recevoir de réservation de livraison.");
  if (context.invalid_prepared || parseCumpDecimal(context.shipped) !== parseCumpDecimal(context.delivered_projection))
    conflict("DELIVERY_COVERAGE_REVIEW_REQUIRED", "Vérifiez les BL de cette affaire avant de reprendre sa réservation.");
  const covered = parseCumpDecimal(context.shipped) + parseCumpDecimal(context.reserved) + parseCumpDecimal(context.unreserved_prepared);
  const ordered = parseCumpDecimal(context.ordered);
  if (covered > ordered || ordered > parseCumpDecimal(context.line_ordered))
    conflict("DELIVERY_COVERAGE_INVALID", "La couverture dépasse la quantité commandée. Vérifiez la répartition des affaires.");
  const routing = await readStockLaneRoutingTx(tx);
  if (routing.routing_status === "INVALID")
    conflict("STOCK_LANE_DESTINATION_UNAVAILABLE", "Corrigez la configuration des pistes de stock avant de réserver.");
  const raw = (await tx.query<Candidate>(DELIVERY_RECOVERY_STOCK_SQL,
    [context.article_id, context.technical_version_id, routing.routing_status === "CONFIGURING"])).rows;
  const qualities = new Map<string, Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  const candidates: Candidate[] = [];
  for (const row of raw) {
    let blocker: string | null = null, qualityAvailable = context.line_ordered;
    if (!['OLD','NEW'].includes(row.source_scope)) blocker = "Origine du stock à vérifier";
    else if (row.lot_status !== "LIBERE") blocker = "Lot non libéré par la qualité";
    else if (row.expiry_at && new Date(row.expiry_at).getTime() <= Date.now()) blocker = "Lot périmé";
    else if (!row.version_compatible && !(row.source_scope === 'OLD' && row.stock_version_id === null)) blocker = "Indice ou version incompatible";
    else if (row.source_scope === 'OLD' && !row.old_documents) blocker = "Dossier historique OLD à compléter";
    // OLD is explicitly historical, without invented NEW quality evidence. It
    // still retains its released lot state, expiry and server-document gate.
    else if (row.source_scope === 'NEW') {
      let quality = qualities.get(row.lot_id);
      if (!quality) {
        quality = await readOperationalLotQualityEligibility({ client: tx, lotId: row.lot_id,
          qty: num(context.line_ordered), unit: context.unit, purpose: 'RESERVE' });
        qualities.set(row.lot_id, quality);
      }
      qualityAvailable = quality.available.toFixed(3);
      // A partial release supplies only its finite entitlement. Quantity shortage
      // reduces the plan; every other quality refusal excludes the entire lot.
      const refusal = quality.eligibility.blocks.find(block => block.code !== 'QTY_NOT_RELEASED');
      blocker = refusal?.message ?? (quality.available <= 0 ? "Aucune quantité libérée disponible" : null);
    }
    candidates.push({ ...row, quality_available: qualityAvailable, blocker,
      quality_evidence: qualities.get(row.lot_id) ? {
        target: qualities.get(row.lot_id)!.evaluationTarget,
        evidence: qualities.get(row.lot_id)!.evidence,
        available: qualities.get(row.lot_id)!.available,
        blocks: qualities.get(row.lot_id)!.eligibility.blocks,
      } : null });
  }
  const missing = formatCumpDecimal(ordered-covered);
  const plan = planDeliveryStockRecovery(missing, candidates);
  // Timestamps of evaluation are deliberately excluded. Material quantities,
  // versions, evidence and routing are included, so a stale browser cannot write.
  const previewHash = createHash('sha256').update(JSON.stringify({ context, routing, candidates, plan })).digest('hex');
  const selected = new Map(plan.rows.map(row => [row.stock_batch_id, row.quantity]));
  return { context, candidates, plan, preview: {
    allocation_id: context.allocation_id, commande_id: context.commande_id, livraison_affaire_id: context.livraison_affaire_id,
    commande_numero: context.commande_numero, customer_order_reference: context.customer_order_reference,
    affaire_reference: context.affaire_reference, client_name: context.client_name, client_code: context.client_code,
    article_code: context.article_code, indice: context.indice, designation: context.designation, unit: context.unit,
    ar_due_date: context.ar_due_date, ordered_qty: num(context.ordered), shipped_qty: num(context.shipped),
    reserved_qty: num(context.reserved), prepared_without_reservation_qty: num(context.unreserved_prepared),
    uncovered_qty: num(missing), reservable_qty: num(plan.reserved_quantity), shortage_qty: num(plan.missing_quantity),
    preview_hash: previewHash, lane_status: routing.routing_status, candidate_limit_reached: raw.length === 200,
    lots: candidates.map(c => ({ lot_id: c.lot_id, lot_code: c.lot_code, stock_batch_id: c.stock_batch_id,
      scope: ['OLD','NEW'].includes(c.source_scope) ? c.source_scope : 'UNKNOWN', location: `${c.magasin_code} / ${c.emplacement_code}`,
      available_qty: Math.min(num(c.batch_available),num(c.level_available),num(c.quality_available)),
      proposed_qty: num(selected.get(c.stock_batch_id) ?? '0'), blocker: c.blocker })),
  } };
}

export async function repoPreviewDeliveryStockRecovery(allocationId: number) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = (await readPlan(tx, allocationId)).preview;
    await tx.query('COMMIT');
    return result;
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}

export async function repoReserveDeliveryStockRecovery(args: {
  allocationId: number; previewHash: string; reason: string; idempotencyKey: string; audit: AuditContext;
}) {
  const tx = await pool.connect();
  try { return await withRealtimeOutboxTransaction(tx, async () => {
    const command = await beginStockCommand(tx, { audit: args.audit, idempotency_key: args.idempotencyKey,
      command_type: 'RESERVATION_CREATE', request_payload: { delivery_stock_recovery: {
        allocation_id: args.allocationId, preview_hash: args.previewHash, reason: args.reason,
      } } });
    if (command.existing) return deliveryStockRecoveryResult.parse({ ...command.existing.result_payload, idempotent_replay: true });
    await lockStockLaneTopology(tx);
    const initial = await readPlan(tx, args.allocationId);
    if (initial.preview.preview_hash !== args.previewHash)
      conflict('DELIVERY_STOCK_PREVIEW_CHANGED', 'Le stock ou l’affaire a changé. Actualisez le contrôle avant de réserver.');
    if (!initial.plan.rows.length)
      conflict('DELIVERY_STOCK_NOT_AVAILABLE', 'Aucun stock compatible à réserver. Ouvrez la production ou complétez le contrôle qualité.');
    const selected = initial.plan.rows.map(row => ({ ...row, candidate: initial.candidates.find(c => c.stock_batch_id === row.stock_batch_id)! }));
    // Same order as the receipt writer: lot/quality first, then order allocation,
    // then stock. Never lock an allocation before requesting the quality lock.
    const byLot = new Map<string, { candidate: Candidate; quantity: bigint }>();
    for (const row of selected) {
      const entry = byLot.get(row.candidate.lot_id) ?? { candidate: row.candidate, quantity: 0n };
      entry.quantity += parseCumpDecimal(row.quantity); byLot.set(row.candidate.lot_id, entry);
    }
    for (const [lotId, entry] of [...byLot].sort(([a],[b]) => a.localeCompare(b))) {
      if (entry.candidate.source_scope === 'NEW') await assertOperationalLotQualityEligibility({
        client: tx, lotId, qty: num(formatCumpDecimal(entry.quantity)), unit: initial.context.unit, purpose: 'RESERVE',
      });
      else await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE', [lotId]);
    }
    // NOWAIT avoids a cycle with older order launch paths holding their order
    // before the quality gate. The user can refresh without a server error.
    await tx.query(`SELECT allocation.id FROM public.commande_ligne_affaire_allocation allocation
      JOIN public.commande_client command ON command.id=allocation.commande_id
      JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
      JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id
      JOIN public.articles article ON article.id=line.article_id
      JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
      JOIN public.pieces_techniques piece ON piece.id=technical.piece_technique_id
      WHERE allocation.id=$1::bigint FOR SHARE OF command,affair,article,technical,piece NOWAIT`, [args.allocationId]);
    await tx.query('SELECT id FROM public.commande_ligne WHERE id=$1::bigint FOR UPDATE NOWAIT', [initial.context.commande_ligne_id]);
    await tx.query('SELECT id FROM public.commande_ligne_affaire_allocation WHERE commande_ligne_id=$1::bigint ORDER BY id FOR UPDATE NOWAIT', [initial.context.commande_ligne_id]);
    await tx.query('SELECT id FROM public.stock_levels WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [selected.map(r => r.candidate.stock_level_id)]);
    await tx.query('SELECT id FROM public.stock_batches WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT', [selected.map(r => r.stock_batch_id)]);
    await tx.query(`SELECT location.id FROM public.locations location
      JOIN public.warehouses warehouse ON warehouse.id=location.warehouse_id
      JOIN public.emplacements emplacement ON emplacement.location_id=location.id
      JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
      WHERE location.id=ANY($1::uuid[]) ORDER BY location.id
      FOR SHARE OF location,warehouse,emplacement,magasin NOWAIT`, [selected.map(r => r.candidate.location_id)]);
    const current = await readPlan(tx, args.allocationId);
    if (current.preview.preview_hash !== args.previewHash)
      conflict('DELIVERY_STOCK_PREVIEW_CHANGED', 'Le stock ou l’affaire a changé. Actualisez le contrôle avant de réserver.');
    const reservationIds: string[] = [];
    for (const row of selected) {
      const reserved = await reserveProducedDeliveryDemands(tx, {
        commande_ligne_id: current.context.commande_ligne_id, livraison_affaire_id: current.context.livraison_affaire_id,
        article_id: current.context.article_id, location_id: row.candidate.location_id, stock_level_id: row.candidate.stock_level_id,
        stock_batch_id: row.stock_batch_id, lot_id: row.candidate.lot_id, qty_ok: num(row.quantity),
        source_scope: row.candidate.source_scope, actor_user_id: args.audit.user_id, quality_gate_already_held: true,
        reservation_reason: `Reprise de réservation : ${args.reason}`,
      });
      if (!reserved || parseCumpDecimal(String(reserved.qty_reserved)) !== parseCumpDecimal(row.quantity))
        conflict('DELIVERY_STOCK_PREVIEW_CHANGED', 'La couverture de la commande a changé. Actualisez le contrôle.');
      reservationIds.push(...reserved.reservation_ids);
    }
    const result = { allocation_id: args.allocationId, livraison_affaire_id: current.context.livraison_affaire_id,
      commande_id: current.context.commande_id, reserved_qty: num(current.plan.reserved_quantity),
      shortage_qty: num(current.plan.missing_quantity), reservation_ids: [...new Set(reservationIds)], idempotent_replay: false };
    await repoInsertAuditLog({ user_id: args.audit.user_id, ip: args.audit.ip, user_agent: args.audit.user_agent,
      device_type: args.audit.device_type, os: args.audit.os, browser: args.audit.browser, tx,
      body: { event_type: 'ACTION', action: 'DELIVERY_STOCK_RESERVATION_RECOVERED', entity_type: 'affaire',
        entity_id: String(current.context.livraison_affaire_id), page_key: args.audit.page_key, path: args.audit.path,
        client_session_id: args.audit.client_session_id,
        details: { ...result, reason: args.reason, preview_hash: args.previewHash, lots: current.preview.lots,
          quality: [...byLot.keys()].map(id => current.candidates.find(c => c.lot_id === id)?.quality_evidence),
          ar_due_date: current.context.ar_due_date, correlation_id: command.correlation_id } } });
    await enqueueEntityChanged(tx, { entityType: 'COMMANDE_CLIENT', entityId: String(current.context.commande_id),
      module: 'commandes-clients', action: 'updated', at: new Date().toISOString(),
      invalidateKeys: ['commandes:list',`commandes:detail:${current.context.commande_id}`,
        `affaires:detail:${current.context.livraison_affaire_id}`,'livraisons:list','stock:reservations'] },
      { deduplicationKey: `delivery-stock-recovery:${command.correlation_id}` });
    await completeStockCommand(tx, { audit: args.audit, command, command_type: 'RESERVATION_CREATE',
      resource_type: 'delivery_allocation', resource_id: String(args.allocationId), result_payload: result });
    return result;
  }); } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === '55P03' || code === '40P01')
      conflict('DELIVERY_STOCK_BUSY', 'Une autre opération utilise ce stock ou cette affaire. Actualisez avant de réserver.');
    throw error;
  }
}
