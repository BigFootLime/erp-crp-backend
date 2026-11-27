import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";
import { lockStockLaneTopology } from "../../stock/repository/stock-lane-routing.repository";
import { routeReceiptLaneDistributionTx } from "../../stock/repository/receipt-lane-transfer.repository";
import { allocateReceivedQuantity } from "../domain/consolidation-rules";
import { reserveProducedDeliveryDemands } from "./receipt-delivery-reservations.repository";
import { assertReceiptLaneAssignmentsInstalled, calculateReceiptLaneAssignment, recordReceiptLaneAssignment, snapshotReceiptReservations } from "./receipt-lane-assignments.repository";
import { reserveUrgencyRecoveryReceiptTx } from "./urgency-recovery-receipt.repository";
import { enqueueProductionOfChanged, productionRealtimeActionFromAudit } from "./production-realtime.repository";

type ReleasedReceiptOutput = {
  receipt_id: string;
  of_id: number; article_id: string; location_id: string; stock_level_id: string;
  stock_batch_id: string; lot_id: string; movement_id: string; qty_ok: number;
  actor_user_id: number; quality_gate_already_held: boolean;
  order_type: string | null; internal_order_purpose: string | null;
  commande_ligne_id: number | null; livraison_affaire_id: number | null;
};



export async function reserveReleasedReceiptOutput(tx: Pick<PoolClient, "query">, args: ReleasedReceiptOutput) {
  const grouped = await reserveConsolidatedReceipt(tx, args);
  if (grouped) return grouped;
  const recovery = await reserveUrgencyRecoveryReceiptTx(tx, args);
  if (recovery) return recovery;
  const component = await reserveProducedComponentForParentOf(tx, { ...args, component_of_id: args.of_id });
  if (component.matched) return component;
  if (args.order_type === "INTERNE")
    return args.internal_order_purpose === "CONTRACT" ? reserveInternalContractReceiptForCustomers(tx, args) : null;
  return args.commande_ligne_id !== null
    ? reserveProducedQtyForCommandeLine(tx, { ...args, commande_ligne_id: args.commande_ligne_id }) : null;
}



/** Preserve legacy grouped releases; new receipt intents also cover single OFs and assemblies. */
export async function reconcileReleasedConsolidationLot(tx: Pick<PoolClient, "query">, lotId: string, userId: number) {
  await lockStockLaneTopology(tx);
  await assertReceiptLaneAssignmentsInstalled(tx);
  await reconcileLegacyReleasedConsolidationLot(tx, lotId, userId);
  const pending = (await tx.query<{
    receipt_id: string; of_id: number; article_id: string; location_id: string; stock_level_id: string;
    stock_batch_id: string; movement_id: string; remaining: string; order_type: string | null;
    internal_order_purpose: string | null; commande_ligne_id: number | null; livraison_affaire_id: number | null;
    of_status: string;
  }>(`SELECT r.id::text AS receipt_id,r.of_id::bigint::int,m.article_id::text,r.location_id::text,
    r.stock_level_id::text,r.stock_batch_id::text,r.stock_movement_id::text AS movement_id,
    (r.qty_ok-COALESCE(done.quantity,0))::text AS remaining,c.order_type,c.internal_order_purpose,
    o.commande_ligne_id::bigint::int,o.affaire_id::bigint::int AS livraison_affaire_id,o.statut::text AS of_status
    FROM public.production_receipt_lane_intents intent JOIN public.of_receipts r ON r.id=intent.receipt_id
    JOIN public.stock_movements m ON m.id=r.stock_movement_id
    JOIN public.ordres_fabrication o ON o.id=r.of_id LEFT JOIN public.commande_client c ON c.id=o.commande_id
    JOIN public.lots lot ON lot.id=r.lot_id AND lot.lot_status='LIBERE'
    LEFT JOIN LATERAL(SELECT sum(quantity) AS quantity FROM public.production_receipt_lane_assignments a
      WHERE a.receipt_id=r.id) done ON true
    WHERE r.lot_id=$1::uuid AND m.status='POSTED' AND r.qty_ok>COALESCE(done.quantity,0)
    ORDER BY r.created_at,r.id FOR UPDATE OF r`, [lotId])).rows;
  for (const receipt of pending) {
    let gate;
    try { gate = await assertOperationalLotQualityEligibility({ client: tx, lotId, qty: 0, purpose: "RESERVE" }); }
    catch (error) { if (error instanceof HttpError && error.code === "QUALITY_NOT_ELIGIBLE") return; throw error; }
    // FREE attributions count as well: another Quality event must never attribute them again.
    const attributed = (await tx.query<{ quantity: string }>(`SELECT (
      COALESCE((SELECT sum(a.quantity) FROM public.production_receipt_lane_assignments a
        JOIN public.of_receipts r ON r.id=a.receipt_id WHERE r.lot_id=$1::uuid),0)
      +COALESCE((SELECT sum(a.quantity) FROM public.production_consolidation_receipt_allocations a
        WHERE a.lot_id=$1::uuid AND NOT EXISTS(SELECT 1 FROM public.of_receipts r
          JOIN public.production_receipt_lane_intents intent ON intent.receipt_id=r.id
          WHERE r.stock_movement_id=a.movement_id)),0))::text AS quantity`, [lotId])).rows[0];
    // The existing Quality API exposes numbers; normalise its floating additions
    // at the decimal helper's precision before subtracting canonical numeric text.
    const released = parseCumpDecimal(gate.target.qty_released.toFixed(12));
    const releasedRemaining = released - parseCumpDecimal(attributed.quantity);
    const entitlement = released - parseCumpDecimal(gate.target.qty_consumed.toFixed(12))
      - parseCumpDecimal(gate.already_committed_qty.toFixed(12));
    const stock = (await tx.query<{ available: string }>(`SELECT
      GREATEST(0,LEAST(sb.qty_total-sb.qty_reserved-sb.qty_depreciated,
        sl.qty_total-sl.qty_reserved-sl.qty_depreciated))::text AS available
      FROM public.stock_batches sb JOIN public.stock_levels sl ON sl.id=sb.stock_level_id
      WHERE sb.id=$1::uuid AND sb.lot_id=$2::uuid AND sl.id=$3::uuid AND sl.location_id=$4::uuid
      FOR UPDATE OF sl,sb`, [receipt.stock_batch_id, lotId, receipt.stock_level_id, receipt.location_id])).rows[0];
    if (!stock || releasedRemaining <= 0n || entitlement <= 0n) continue;
    const available = [parseCumpDecimal(receipt.remaining), releasedRemaining,
      entitlement, parseCumpDecimal(stock.available)];
    const maximum = available.reduce((minimum, item) => item < minimum ? item : minimum);
    // Receipt/reservation ledgers store numeric(18,3). Never round a smaller
    // Quality entitlement upward into an attributable physical quantity.
    const amount = maximum - maximum % 1_000_000_000n;
    if (amount <= 0n) continue;
    const quantity = formatCumpDecimal(amount);
    const assignmentGate = await assertOperationalLotQualityEligibility({ client: tx, lotId, qty: Number(quantity), purpose: "RESERVE" });
    const before = await snapshotReceiptReservations(tx, receipt.stock_batch_id);
    if (receipt.of_status !== "ANNULE")
      await reserveReleasedReceiptOutput(tx, { ...receipt, qty_ok: Number(quantity), lot_id: lotId,
        actor_user_id: userId, quality_gate_already_held: true });
    const allocation = await calculateReceiptLaneAssignment(tx, receipt.stock_batch_id, quantity, before);
    const distribution = await routeReceiptLaneDistributionTx(tx, { ...receipt, lot_id: lotId, distribution: allocation },
      { user_id: userId, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null,
        page_key: "production", client_session_id: null });
    await recordReceiptLaneAssignment(tx, receipt.receipt_id, distribution, userId, assignmentGate);
    const audit = await repoInsertAuditLog({ tx, user_id: userId, ip: null, user_agent: null,
      device_type: null, os: null, browser: null, body: { event_type: "ACTION",
        action: "production.of.receipt.assigned", page_key: "production", entity_type: "ordres_fabrication",
        entity_id: String(receipt.of_id), details: { receipt_id: receipt.receipt_id, lot_id: lotId, distribution } } });
    if (!audit) throw new Error("PRODUCTION_RECEIPT_ASSIGNMENT_AUDIT_INSERT_FAILED");
    await enqueueProductionOfChanged(tx, { ofId: String(receipt.of_id), auditId: audit.id,
      action: productionRealtimeActionFromAudit("production.of.receipt.assigned"), occurredAt: audit.created_at });
  }
}



async function reserveConsolidatedReceipt(
  client: Pick<PoolClient, "query">,
  args: {
    receipt_id: string;
    of_id: number;
    article_id: string;
    location_id: string;
    stock_level_id: string;
    stock_batch_id: string;
    lot_id: string;
    movement_id: string;
    qty_ok: number;
    actor_user_id: number;
    quality_gate_already_held: boolean;
    max_allocate?: number;
  },
) {
  const group = (
    await client.query<{ id:string; quantity_semantics:string; producer_own_quantity:number|null }>(
      `SELECT id::text,to_jsonb(g)->>'quantity_semantics' AS quantity_semantics,
        (to_jsonb(g)->>'producer_own_quantity')::float8 AS producer_own_quantity
        FROM public.production_consolidations g WHERE producer_of_id=$1 AND state='ACTIVE' FOR UPDATE`,
      [args.of_id],
    )
  ).rows[0];
  if (!group) return null;
  const rows = (
    await client.query<{
      id: string;
      source_of_id: number;
      quantity: number;
      received_quantity: number;
      due_date: string | null;
      commande_ligne_id: number | null;
      affaire_id: number | null;
      order_type: string | null;
    }>(
      `SELECT a.id::text,a.source_of_id::bigint::int,a.quantity::float8,a.received_quantity::float8,a.due_date::text,o.commande_ligne_id::bigint::int,o.affaire_id::bigint::int,c.order_type
     FROM public.production_consolidation_allocations a JOIN public.ordres_fabrication o ON o.id=a.source_of_id LEFT JOIN public.commande_client c ON c.id=o.commande_id
     WHERE a.consolidation_id=$1::uuid AND a.state='ACTIVE' ORDER BY a.due_date,a.id FOR UPDATE OF a`,
      [group.id],
    )
  ).rows;
  const applied = Number(
    (
      await client.query(
        "SELECT COALESCE(sum(quantity),0)::float8 AS quantity FROM public.production_consolidation_receipt_allocations WHERE movement_id=$1::uuid",
        [args.movement_id],
      )
    ).rows[0].quantity,
  );
  const reservationIds: string[] = [];
  let reserved = 0;
  if (group.quantity_semantics==='EXISTING_SURPLUS_V1') {
    const own=(await client.query<{line_id:number; delivery_id:number; reserved_by_producer:number}>(`SELECT
        a.commande_ligne_id::int AS line_id,a.livraison_affaire_id::int AS delivery_id,
        COALESCE((SELECT sum(r.qty_reserved) FROM public.stock_reservations r
          WHERE r.commande_ligne_affaire_allocation_id=a.id AND r.of_id=o.id AND r.status IN ('ACTIVE','CONSUMED')),0)::float8 AS reserved_by_producer
      FROM public.ordres_fabrication o JOIN public.commande_ligne_affaire_allocation a ON a.commande_ligne_id=o.commande_ligne_id
        AND o.affaire_id IN (a.livraison_affaire_id,a.production_affaire_id) WHERE o.id=$1`,[args.of_id])).rows;
    if(own.length!==1)throw new HttpError(409,'CONSOLIDATION_OWN_DELIVERY_CHANGED','L’affaire initiale du producteur doit être vérifiée.');
    const maximum=Math.min(args.qty_ok, args.max_allocate??Infinity, Math.max(0,(group.producer_own_quantity??0)-own[0].reserved_by_producer));
    if(maximum>0){
      const result=await reserveProducedQtyForCommandeLine(client,{...args,qty_ok:maximum,commande_ligne_id:own[0].line_id,livraison_affaire_id:own[0].delivery_id});
      if(result){reserved=result.qty_reserved;reservationIds.push(...result.reservation_ids);}
    }
  }
  const distribution = allocateReceivedQuantity(
    rows,
    Math.max(0,Math.min(group.quantity_semantics==='EXISTING_SURPLUS_V1' ? args.qty_ok : args.qty_ok-applied,args.max_allocate??Infinity)-reserved),
  );
  for (const allocated of distribution.allocations) {
    const source = rows.find((r) => r.id === allocated.allocation_id)!;
    const existingDelivery=group.quantity_semantics==='EXISTING_SURPLUS_V1'&&source.commande_ligne_id!==null
      ? (await client.query<{id:number}>(`SELECT livraison_affaire_id::int AS id FROM public.commande_ligne_affaire_allocation
        WHERE commande_ligne_id=$1 AND $2::bigint IN (livraison_affaire_id,production_affaire_id)`,[source.commande_ligne_id,source.affaire_id])).rows : null;
    if (existingDelivery&&existingDelivery.length!==1)
      throw new HttpError(409,'CONSOLIDATION_DELIVERY_CHANGED','Vérifiez l’affaire de livraison de l’OF couvert.');
    const recovery = await reserveUrgencyRecoveryReceiptTx(client, {
      ...args, of_id: source.source_of_id, qty_ok: allocated.quantity,
    });
    const component = recovery ?? await reserveProducedComponentForParentOf(client, {
      ...args,
      component_of_id: source.source_of_id,
      qty_ok: allocated.quantity,
    });
    const reservation = component.matched
      ? component
      : source.order_type === "INTERNE"
        ? await reserveInternalContractReceiptForCustomers(client, {
            ...args,
            of_id: source.source_of_id,
            qty_ok: allocated.quantity,
          })
        : source.commande_ligne_id !== null
          ? await reserveProducedQtyForCommandeLine(client, {
              ...args,
              of_id: source.source_of_id,
              commande_ligne_id: source.commande_ligne_id,
              livraison_affaire_id: existingDelivery?.[0].id??source.affaire_id,
              qty_ok: allocated.quantity,
            })
          : null;
    if (reservation?.reservation_id) {
      reservationIds.push(...reservation.reservation_ids);
      reserved += reservation.qty_reserved;
    }
    const credited=group.quantity_semantics==='EXISTING_SURPLUS_V1' ? reservation?.qty_reserved??0 : allocated.quantity;
    if (credited<=0) continue;
    await client.query(
      `INSERT INTO public.production_consolidation_receipt_allocations(allocation_id,movement_id,lot_id,quantity) VALUES($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT(allocation_id,movement_id) DO UPDATE SET quantity=production_consolidation_receipt_allocations.quantity+excluded.quantity`,
      [source.id, args.movement_id, args.lot_id, credited],
    );
    await client.query(
      "UPDATE public.production_consolidation_allocations SET received_quantity=received_quantity+$2 WHERE id=$1::uuid",
      [source.id, credited],
    );
  }
  return {
    matched: true,
    reservation_id: reservationIds[0] ?? null,
    reservation_ids: [...new Set(reservationIds)],
    qty_reserved: reserved,
  };
}



/** Revisit real posted receipts when Quality releases a previously quarantined
 * producer lot. No stock entry is created; allocation deltas remain idempotent. */
async function reconcileLegacyReleasedConsolidationLot(
  tx: Pick<PoolClient, "query">,
  lotId: string,
  userId: number,
) {
  const receipts = (
    await tx.query<{
      receipt_id: string;
      of_id: number;
      article_id: string;
      location_id: string;
      stock_level_id: string;
      stock_batch_id: string;
      movement_id: string;
      qty_ok: number;
    }>(
      `SELECT r.id::text AS receipt_id,r.of_id::bigint::int,m.article_id::text,sl.location_id::text,r.stock_level_id::text,r.stock_batch_id::text,r.stock_movement_id::text AS movement_id,r.qty_ok::float8
    FROM public.of_receipts r JOIN public.stock_movements m ON m.id=r.stock_movement_id
    JOIN public.production_consolidations c ON c.producer_of_id=r.of_id AND c.state='ACTIVE'
      AND to_jsonb(c)->>'quantity_semantics' IS DISTINCT FROM 'EXISTING_SURPLUS_V1'
    JOIN public.stock_batches sb ON sb.id=r.stock_batch_id JOIN public.stock_levels sl ON sl.id=r.stock_level_id
    JOIN public.lots l ON l.id=sb.lot_id AND l.lot_status='LIBERE'
    WHERE sb.lot_id=$1::uuid AND m.status='POSTED'
      AND NOT EXISTS(SELECT 1 FROM public.production_receipt_lane_intents intent WHERE intent.receipt_id=r.id)
    ORDER BY r.created_at,r.id`,
      [lotId],
    )
  ).rows;
  if (!receipts.length) return;
  for (const r of receipts) {
    let gate;
    try {
      gate = await assertOperationalLotQualityEligibility({
        client: tx,
        lotId,
        qty: 0,
        purpose: "RESERVE",
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === "QUALITY_NOT_ELIGIBLE")
        continue;
      throw error;
    }
    const entitlement = Math.max(
      0,
      gate.target.qty_released -
        gate.target.qty_consumed -
        gate.already_committed_qty,
    );
    const stock = (
      await tx.query<{ qty: number }>(
        `SELECT GREATEST(0,LEAST(sb.qty_total-sb.qty_reserved,sl.qty_total-sl.qty_reserved))::float8 AS qty FROM public.stock_batches sb JOIN public.stock_levels sl ON sl.id=sb.stock_level_id WHERE sb.id=$1::uuid FOR UPDATE OF sb,sl`,
        [r.stock_batch_id],
      )
    ).rows[0];
    // Manual source OFs can be allocated without a commercial reservation.
    // Count their attribution as well, so repeated partial releases cannot
    // assign more pieces than Quality has released for this physical lot.
    const attributed = Number(
      (
        await tx.query(
          `SELECT COALESCE(sum(quantity),0)::float8 AS qty FROM public.production_consolidation_receipt_allocations WHERE lot_id=$1::uuid`,
          [lotId],
        )
      ).rows[0].qty,
    );
    const amount = Math.min(
      entitlement,
      Math.max(0, gate.target.qty_released - attributed),
      stock?.qty ?? 0,
    );
    if (amount <= 0) continue;
    await reserveConsolidatedReceipt(tx, {
      ...r,
      lot_id: lotId,
      actor_user_id: userId,
      quality_gate_already_held: true,
      max_allocate: amount,
    });
  }
}



export const reserveProducedQtyForCommandeLine = reserveProducedDeliveryDemands;



async function reserveInternalContractReceiptForCustomers(
  client: Pick<PoolClient, "query">,
  args: {
    of_id: number;
    article_id: string;
    location_id: string;
    stock_level_id: string;
    stock_batch_id: string;
    lot_id: string;
    qty_ok: number;
    actor_user_id: number;
    quality_gate_already_held?: boolean;
  }
): Promise<{ reservation_id: string; qty_reserved: number; reservation_ids: string[] } | null> {
  if (!Number.isFinite(args.qty_ok) || args.qty_ok <= 0) return null;
  const allocations = await client.query<{
    id: string;
    commande_ligne_id: number;
    livraison_affaire_id: number | null;
    remaining_qty: number;
  }>(
    `SELECT allocation.id::text AS id,
            allocation.commande_ligne_id::bigint::int AS commande_ligne_id,
            allocation.livraison_affaire_id::bigint::int AS livraison_affaire_id,
            GREATEST(0, allocation.quantity - allocation.quantity_received)::float8 AS remaining_qty
       FROM public.internal_contract_of_allocations allocation
       JOIN public.commande_ligne line ON line.id = allocation.commande_ligne_id
      WHERE allocation.of_id = $1::bigint
        AND allocation.status IN ('ALLOCATED', 'PARTIALLY_RECEIVED')
        AND allocation.quantity_received < allocation.quantity
      ORDER BY COALESCE(line.delai_client, '9999-12-31'::date), allocation.created_at, allocation.id
      FOR UPDATE OF allocation`,
    [args.of_id]
  );
  let remaining = parseCumpDecimal(String(args.qty_ok));
  let reservedQty = 0n;
  const reservationIds: string[] = [];
  for (const allocation of allocations.rows) {
    if (remaining <= 0n) break;
    const allocationRemaining = parseCumpDecimal(String(allocation.remaining_qty));
    const requested = Number(formatCumpDecimal(remaining < allocationRemaining ? remaining : allocationRemaining));
    const reserved = await reserveProducedQtyForCommandeLine(client, {
      commande_ligne_id: allocation.commande_ligne_id,
      article_id: args.article_id,
      location_id: args.location_id,
      stock_level_id: args.stock_level_id,
      stock_batch_id: args.stock_batch_id,
      lot_id: args.lot_id,
      qty_ok: requested,
      actor_user_id: args.actor_user_id,
      of_id: args.of_id,
      livraison_affaire_id: allocation.livraison_affaire_id,
      quality_gate_already_held: args.quality_gate_already_held,
    });
    const applied = Number(reserved?.qty_reserved ?? 0);
    if (applied <= 0) continue;
    await client.query(
      `UPDATE public.internal_contract_of_allocations
          SET quantity_received = quantity_received + $2,
              status = CASE
                WHEN quantity_received + $2 >= quantity THEN 'RECEIVED'
                ELSE 'PARTIALLY_RECEIVED'
              END,
              updated_at = now()
        WHERE id = $1::uuid`,
      [allocation.id, applied]
    );
    reservationIds.push(...reserved!.reservation_ids);
    reservedQty += parseCumpDecimal(String(applied));
    remaining -= parseCumpDecimal(String(applied));
  }
  return reservationIds.length
    ? { reservation_id: reservationIds[0]!, qty_reserved: Number(formatCumpDecimal(reservedQty)), reservation_ids: [...new Set(reservationIds)] }
    : null;
}



type ComponentReceiptReservation = {
  matched: boolean;
  reservation_id: string | null;
  qty_reserved: number;
  reservation_ids: string[];
};



/**
 * A child OF produces a component for another OF, not the finished article
 * bought by the customer. Its released output is therefore reserved against
 * the exact component requirements of the consuming OF. Any surplus remains
 * ordinary NEW stock.
 */
export async function reserveProducedComponentForParentOf(
  client: Pick<PoolClient, "query">,
  args: {
    component_of_id: number;
    source_scope?: string;
    article_id: string;
    location_id: string;
    stock_level_id: string;
    stock_batch_id: string;
    lot_id: string;
    qty_ok: number;
    actor_user_id: number;
    quality_gate_already_held?: boolean;
  }
): Promise<ComponentReceiptReservation> {
  if (!Number.isFinite(args.qty_ok) || args.qty_ok <= 0) {
    return { matched: false, reservation_id: null, qty_reserved: 0, reservation_ids: [] };
  }

  const requirements = await client.query<{
    id: string;
    consuming_of_id: number;
    component_article_id: string | null;
    required_qty: number;
  }>(
    `SELECT requirement.id::text AS id,
            requirement.consuming_of_id::bigint::int AS consuming_of_id,
            requirement.component_article_id::text AS component_article_id,
            requirement.required_qty::float8 AS required_qty
       FROM public.of_component_requirements requirement
      WHERE requirement.component_of_id = $1::bigint
        AND requirement.status IN ('OPEN', 'COVERED')
      ORDER BY requirement.created_at, requirement.id
      FOR UPDATE`,
    [args.component_of_id]
  );
  if (!requirements.rows.length) {
    return { matched: false, reservation_id: null, qty_reserved: 0, reservation_ids: [] };
  }
  const mismatched = requirements.rows.find(
    (requirement) => requirement.component_article_id !== args.article_id
  );
  if (mismatched) {
    throw new HttpError(
      409,
      "ASSEMBLY_COMPONENT_ARTICLE_MISMATCH",
      "L'article produit par le sous-OF ne correspond pas au composant attendu par l'OF parent."
    );
  }

  const levelResult = await client.query<{ available_qty: number }>(
    `SELECT (qty_total - qty_reserved - qty_depreciated)::float8 AS available_qty
       FROM public.stock_levels
      WHERE id = $1::uuid
      FOR UPDATE`,
    [args.stock_level_id]
  );
  const batchResult = await client.query<{ available_qty: number }>(
    `SELECT (qty_total - qty_reserved)::float8 AS available_qty
       FROM public.stock_batches
      WHERE id = $1::uuid AND lot_id = $2::uuid
      FOR UPDATE`,
    [args.stock_batch_id, args.lot_id]
  );
  if (!levelResult.rows[0]) {
    throw new HttpError(409, "STOCK_LEVEL_NOT_FOUND", "Niveau de stock introuvable pour le composant produit.");
  }
  if (!batchResult.rows[0]) {
    throw new HttpError(409, "STOCK_BATCH_NOT_FOUND", "Lot de stock introuvable pour le composant produit.");
  }

  let remainingOutput = Math.min(
    args.qty_ok,
    Number(levelResult.rows[0].available_qty),
    Number(batchResult.rows[0].available_qty)
  );
  let reservedQty = 0;
  const reservationIds: string[] = [];

  for (const requirement of requirements.rows) {
    const coverageResult = await client.query<{ reserved_qty: number }>(
      `SELECT COALESCE(sum(reservation.qty_reserved), 0)::float8 AS reserved_qty
         FROM public.stock_reservations reservation
        WHERE reservation.of_component_requirement_id = $1::uuid
          AND reservation.status = 'ACTIVE'
          AND (reservation.expires_at IS NULL OR reservation.expires_at > statement_timestamp())`,
      [requirement.id]
    );
    const alreadyReserved = Number(coverageResult.rows[0]?.reserved_qty ?? 0);
    const missingQty = Math.max(0, Number(requirement.required_qty) - alreadyReserved);
    if (missingQty <= 1e-9) {
      await client.query(
        `UPDATE public.of_component_requirements
            SET status = 'COVERED', updated_at = now()
          WHERE id = $1::uuid`,
        [requirement.id]
      );
      continue;
    }
    if (remainingOutput <= 1e-9) break;

    const quantity = Math.min(missingQty, remainingOutput);
    if (!args.quality_gate_already_held) {
      await assertOperationalLotQualityEligibility({
        client,
        lotId: args.lot_id,
        qty: quantity,
        purpose: "RESERVE",
      });
    }

    const reservation = await client.query<{ id: string }>(
      `INSERT INTO public.stock_reservations (
         article_id, location_id, qty_reserved, source_type, source_id,
         status, lot_id, stock_batch_id, stock_level_id, source_scope,
         reason, of_id, of_component_requirement_id, created_by, updated_by
       ) VALUES (
         $1::uuid,$2::uuid,$3,'OF_COMPONENT',$4::uuid::text,'ACTIVE',$5::uuid,$6::uuid,$7::uuid,
         $11,$8,$9::bigint,$4::uuid,$10,$10
       )
       ON CONFLICT (of_component_requirement_id, stock_batch_id)
         WHERE status = 'ACTIVE'
           AND of_component_requirement_id IS NOT NULL
           AND stock_batch_id IS NOT NULL
       DO UPDATE SET
         qty_reserved = public.stock_reservations.qty_reserved + EXCLUDED.qty_reserved,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by
       RETURNING id::text AS id`,
      [
        args.article_id,
        args.location_id,
        quantity,
        requirement.id,
        args.lot_id,
        args.stock_batch_id,
        args.stock_level_id,
        `Production du sous-OF ${args.component_of_id} réservée pour l'OF ${requirement.consuming_of_id}`,
        requirement.consuming_of_id,
        args.actor_user_id,
        args.source_scope ?? 'NEW',
      ]
    );
    const reservationId = reservation.rows[0]?.id;
    if (!reservationId) throw new Error("ASSEMBLY_COMPONENT_RESERVATION_NOT_CREATED");
    reservationIds.push(reservationId);
    reservedQty += quantity;
    remainingOutput -= quantity;

    await client.query(
      `UPDATE public.of_component_requirements requirement
          SET status = CASE
                WHEN COALESCE((
                  SELECT sum(reservation.qty_reserved)
                    FROM public.stock_reservations reservation
                   WHERE reservation.of_component_requirement_id = requirement.id
                     AND reservation.status = 'ACTIVE'
                     AND (reservation.expires_at IS NULL OR reservation.expires_at > statement_timestamp())
                ), 0) + 0.000000001 >= requirement.required_qty
                  THEN 'COVERED'
                ELSE 'OPEN'
              END,
              updated_at = now()
        WHERE requirement.id = $1::uuid`,
      [requirement.id]
    );
  }

  if (reservedQty > 1e-9) {
    await client.query(
      `UPDATE public.stock_levels
          SET qty_reserved = qty_reserved + $2,
              updated_at = now(),
              updated_by = $3
        WHERE id = $1::uuid`,
      [args.stock_level_id, reservedQty, args.actor_user_id]
    );
    await client.query(
      `UPDATE public.stock_batches
          SET qty_reserved = qty_reserved + $2
        WHERE id = $1::uuid`,
      [args.stock_batch_id, reservedQty]
    );
  }

  return {
    matched: true,
    reservation_id: reservationIds[0] ?? null,
    qty_reserved: reservedQty,
    reservation_ids: reservationIds,
  };
}
