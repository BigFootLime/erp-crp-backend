import type { PoolClient } from "pg";
import { createHash, randomUUID } from "crypto";

import pool from "../../../config/database";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import type { AuditContext } from "./production.repository";
import {
  enqueueProductionOfChanged,
  productionRealtimeActionFromAudit,
} from "./production-realtime.repository";
import type { OfReceiptBodyDTO } from "../validators/production.validators";
import { ofStatutAllowsReceipt, type OfStatut } from "../domain/of-status";
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository";
import { allocateReceivedQuantity } from "../domain/consolidation-rules";

async function reserveConsolidatedReceipt(
  client: Pick<PoolClient, "query">,
  args: {
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
    await client.query<{ id: string }>(
      `SELECT id::text FROM public.production_consolidations WHERE producer_of_id=$1 AND state='ACTIVE' FOR UPDATE`,
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
  const distribution = allocateReceivedQuantity(
    rows,
    Math.min(Math.max(0, args.qty_ok - applied), args.max_allocate ?? Infinity),
  );
  let reserved = 0;
  const reservationIds: string[] = [];
  for (const allocated of distribution.allocations) {
    const source = rows.find((r) => r.id === allocated.allocation_id)!;
    const component = await reserveProducedComponentForParentOf(client, {
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
              livraison_affaire_id: source.affaire_id,
              qty_ok: allocated.quantity,
            })
          : null;
    if (reservation?.reservation_id) {
      reservationIds.push(reservation.reservation_id);
      reserved += reservation.qty_reserved;
    }
    await client.query(
      `INSERT INTO public.production_consolidation_receipt_allocations(allocation_id,movement_id,lot_id,quantity) VALUES($1::uuid,$2::uuid,$3::uuid,$4) ON CONFLICT(allocation_id,movement_id) DO UPDATE SET quantity=production_consolidation_receipt_allocations.quantity+excluded.quantity`,
      [source.id, args.movement_id, args.lot_id, allocated.quantity],
    );
    await client.query(
      "UPDATE public.production_consolidation_allocations SET received_quantity=received_quantity+$2 WHERE id=$1::uuid",
      [source.id, allocated.quantity],
    );
  }
  return {
    matched: true,
    reservation_id: reservationIds[0] ?? null,
    reservation_ids: reservationIds,
    qty_reserved: reserved,
  };
}

/** Revisit real posted receipts when Quality releases a previously quarantined
 * producer lot. No stock entry is created; allocation deltas remain idempotent. */
export async function reconcileReleasedConsolidationLot(
  tx: Pick<PoolClient, "query">,
  lotId: string,
  userId: number,
) {
  const receipts = (
    await tx.query<{
      of_id: number;
      article_id: string;
      location_id: string;
      stock_level_id: string;
      stock_batch_id: string;
      movement_id: string;
      qty_ok: number;
    }>(
      `SELECT r.of_id::bigint::int,m.article_id::text,sl.location_id::text,r.stock_level_id::text,r.stock_batch_id::text,r.stock_movement_id::text AS movement_id,r.qty_ok::float8
    FROM public.of_receipts r JOIN public.stock_movements m ON m.id=r.stock_movement_id
    JOIN public.production_consolidations c ON c.producer_of_id=r.of_id AND c.state='ACTIVE'
    JOIN public.stock_batches sb ON sb.id=r.stock_batch_id JOIN public.stock_levels sl ON sl.id=r.stock_level_id
    JOIN public.lots l ON l.id=sb.lot_id AND l.lot_status='LIBERE'
    WHERE sb.lot_id=$1::uuid AND m.status='POSTED' ORDER BY r.created_at,r.id`,
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

export type OfReceiptContext = {
  of: {
    id: number;
    numero: string;
    piece_technique_id: string;
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
    statut: string;
    updated_at: string;
    affaire_id: number | null;
    commande_id: number | null;
    commande_ligne_id: number | null;
    order_type: string | null;
    client_code: string | null;
  };
  article_id: string;
  unite: string | null;
  received_qty_ok: number;
  qty_ok_receivable: number;
  default_location_id: string | null;
  output_lots: Array<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>;
  existing_lots: Array<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_on_hand: number;
    updated_at: string;
  }>;
  locations: {
    magasins: Array<{ id: string; code: string; name: string; is_active: boolean }>;
    emplacements: Array<{ id: number; magasin_id: string; code: string; name: string | null; location_id: string }>;
  };
};

export type OfReceiptResult = {
  receipt_id: string;
  lot_id: string;
  lot_code: string;
  stock_movement_id: string;
  movement_no: string;
  qty_ok: number;
  qty_scrap: number;
  qty_rework: number;
  quality_status: string;
  reservation_id: string | null;
  reserved_qty: number;
  non_conformity_id: string | null;
  idempotent_replay: boolean;
};

export type OfTraceability = {
  output_lots: OfReceiptContext["output_lots"];
  receipts: Array<{
    receipt_id: string | null;
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
    qty_scrap: number;
    qty_rework: number;
    quality_status: string | null;
    reservation_id: string | null;
    non_conformity_id: string | null;
    lot_id: string | null;
    lot_code: string | null;
    magasin_id: string | null;
    magasin_code: string | null;
    magasin_name: string | null;
    emplacement_id: number | null;
    emplacement_code: string | null;
    location_id: string | null;
  }>;
};

function movementNoFromSeq(n: number): string {
  const padded = String(n).padStart(8, "0");
  return `SM-${padded}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptRequestHash(ofId: number, body: OfReceiptBodyDTO): string {
  return createHash("sha256").update(canonicalJson({ of_id: ofId, ...body })).digest("hex");
}

async function reserveMovementNo(client: Pick<PoolClient, "query">): Promise<string> {
  const res = await client.query<{ n: string }>("SELECT nextval('public.stock_movement_no_seq')::text AS n");
  const raw = res.rows[0]?.n;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error("Failed to reserve stock movement number");
  return movementNoFromSeq(n);
}

async function insertAuditLog(tx: Pick<PoolClient, "query">, audit: AuditContext, entry: {
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details?: Record<string, unknown> | null;
}) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: audit.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: audit.path,
    client_session_id: audit.client_session_id,
    details: entry.details ?? null,
  };

  const inserted = await repoInsertAuditLog({
    user_id: audit.user_id,
    body,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
  if (entry.entity_type === "ordres_fabrication" && entry.entity_id) {
    if (!inserted) throw new Error("PRODUCTION_RECEIPT_AUDIT_INSERT_FAILED");
    await enqueueProductionOfChanged(tx, {
      ofId: entry.entity_id,
      auditId: inserted.id,
      action: productionRealtimeActionFromAudit(entry.action),
      occurredAt: inserted.created_at,
    });
  }
}

async function resolveArticleForPieceTechnique(client: Pick<PoolClient, "query">, pieceTechniqueId: string): Promise<{ id: string; unite: string | null }> {
  const res = await client.query<{ id: string; unite: string | null }>(
    `
      SELECT id::text AS id, unite
      FROM public.articles
      WHERE piece_technique_id = $1::uuid
        AND article_type = 'PIECE_TECHNIQUE'
        AND is_active = true
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
    [pieceTechniqueId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    throw new HttpError(409, "STOCK_ARTICLE_NOT_FOUND", "Aucun article de stock n'est configure pour cette piece technique");
  }
  return row;
}

export async function reserveProducedQtyForCommandeLine(
  client: Pick<PoolClient, "query">,
  args: {
    commande_ligne_id: number;
    article_id: string;
    location_id: string;
    stock_level_id: string;
    stock_batch_id: string;
    lot_id: string;
    qty_ok: number;
    actor_user_id: number;
    of_id?: number | null;
    /** Caller already holds the canonical Quality lock for this lot. */
    quality_gate_already_held?: boolean;
    livraison_affaire_id?: number | null;
    source_scope?: string;
  }
): Promise<{ reservation_id: string; qty_reserved: number } | null> {
  if (!Number.isFinite(args.qty_ok) || args.qty_ok <= 0) return null;

  const lineRes = await client.query<{ quantite: number; article_id: string | null }>(
    `
      SELECT
        quantite::float8 AS quantite,
        article_id::text AS article_id
      FROM public.commande_ligne
      WHERE id = $1::bigint
      FOR UPDATE
    `,
    [args.commande_ligne_id]
  );
  const line = lineRes.rows[0] ?? null;
  if (!line) return null;
  if (line.article_id && line.article_id !== args.article_id) {
    throw new HttpError(409, "ARTICLE_MISMATCH", "La ligne de commande n'est pas liee a l'article recu en stock");
  }
  const allocationRes = await client.query<{ id: number; livraison_affaire_id: number }>(
    `
      SELECT id::bigint::int AS id, livraison_affaire_id::bigint::int AS livraison_affaire_id
      FROM public.commande_ligne_affaire_allocation
      WHERE commande_ligne_id = $1::bigint
        AND ($2::bigint IS NULL OR livraison_affaire_id = $2::bigint)
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [args.commande_ligne_id, args.livraison_affaire_id ?? null]
  );
  const businessAllocation = allocationRes.rows[0] ?? null;
  if (!businessAllocation) {
    throw new HttpError(409, "COMMANDE_ALLOCATION_NOT_FOUND", "La réception OF ne peut pas réserver un besoin sans allocation de livraison.");
  }

  const currentReservedRes = await client.query<{ qty_reserved: number }>(
    `
      SELECT COALESCE(SUM(qty_reserved), 0)::float8 AS qty_reserved
      FROM public.stock_reservations
      WHERE source_type = 'COMMANDE_LIGNE'
        AND source_id = $1
        AND status = 'ACTIVE'
    `,
    [String(args.commande_ligne_id)]
  );

  const plannedDeliveryRes = await client.query<{ qty_planned: number }>(
    `
      SELECT COALESCE(SUM(line.quantite), 0)::float8 AS qty_planned
      FROM public.bon_livraison_ligne line
      JOIN public.bon_livraison delivery ON delivery.id = line.bon_livraison_id
      WHERE line.commande_ligne_id = $1::bigint
        AND delivery.statut <> 'CANCELLED'
    `,
    [args.commande_ligne_id]
  );

  const orderedQty = Number(line.quantite);
  const alreadyReserved = Number(currentReservedRes.rows[0]?.qty_reserved ?? 0);
  const alreadyPlannedForDelivery = Number(plannedDeliveryRes.rows[0]?.qty_planned ?? 0);
  const remainingToReserve = Math.max(0, orderedQty - alreadyReserved - alreadyPlannedForDelivery);
  const qtyToReserve = Math.min(args.qty_ok, remainingToReserve);
  if (qtyToReserve <= 0) return null;

  // Automatic order-line reservation is still a stock reservation. Re-check
  // its exact produced lot under the receipt transaction; a previously
  // released existing lot may have been quarantined or exhausted meanwhile.
  if (!args.quality_gate_already_held) {
    await assertOperationalLotQualityEligibility({
      client,
      lotId: args.lot_id,
      qty: qtyToReserve,
      purpose: "RESERVE",
    });
  }

  const stockLevelRes = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT qty_total::float8 AS qty_total, qty_reserved::float8 AS qty_reserved
      FROM public.stock_levels
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [args.stock_level_id]
  );
  const stockLevel = stockLevelRes.rows[0] ?? null;
  if (!stockLevel) {
    throw new HttpError(409, "STOCK_LEVEL_NOT_FOUND", "Niveau de stock introuvable pour la reservation automatique");
  }

  const availableQty = Number(stockLevel.qty_total) - Number(stockLevel.qty_reserved);
  if (availableQty + 1e-9 < qtyToReserve) {
    throw new HttpError(409, "INSUFFICIENT_STOCK", "Le stock produit n'est pas encore disponible pour la reservation automatique");
  }

  await client.query(
    `
      UPDATE public.stock_levels
      SET qty_reserved = qty_reserved + $2,
          updated_at = now(),
          updated_by = $3
      WHERE id = $1::uuid
    `,
    [args.stock_level_id, qtyToReserve, args.actor_user_id]
  );

  const stockBatchRes = await client.query<{ qty_total: number; qty_reserved: number }>(
    `
      SELECT qty_total::float8 AS qty_total, qty_reserved::float8 AS qty_reserved
      FROM public.stock_batches
      WHERE id = $1::uuid AND lot_id = $2::uuid
      FOR UPDATE
    `,
    [args.stock_batch_id, args.lot_id]
  );
  const stockBatch = stockBatchRes.rows[0] ?? null;
  if (!stockBatch) {
    throw new HttpError(409, "STOCK_BATCH_NOT_FOUND", "Lot de stock introuvable pour la reservation automatique");
  }
  const batchAvailableQty = Number(stockBatch.qty_total) - Number(stockBatch.qty_reserved);
  if (batchAvailableQty + 1e-9 < qtyToReserve) {
    throw new HttpError(409, "INSUFFICIENT_LOT_STOCK", "Le lot produit n'est pas disponible pour la reservation automatique");
  }
  await client.query(
    `
      UPDATE public.stock_batches
      SET qty_reserved = qty_reserved + $2
      WHERE id = $1::uuid
    `,
    [args.stock_batch_id, qtyToReserve]
  );

  const existingReservation = await client.query<{ id: string }>(
    `
      SELECT id::text AS id
      FROM public.stock_reservations
      WHERE article_id = $1::uuid
        AND location_id = $2::uuid
        AND source_type = 'COMMANDE_LIGNE'
        AND source_id = $3
        AND lot_id = $4::uuid
        AND stock_batch_id = $5::uuid
        AND commande_ligne_affaire_allocation_id = $6::bigint
        AND status = 'ACTIVE'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `,
    [args.article_id, args.location_id, String(args.commande_ligne_id), args.lot_id, args.stock_batch_id, businessAllocation.id]
  );

  const existingId = existingReservation.rows[0]?.id ?? null;
  if (existingId) {
    await client.query(
      `
        UPDATE public.stock_reservations
        SET qty_reserved = qty_reserved + $2,
            commande_ligne_id = COALESCE(commande_ligne_id, $4::bigint),
            commande_ligne_affaire_allocation_id = COALESCE(commande_ligne_affaire_allocation_id, $5::bigint),
            livraison_affaire_id = COALESCE(livraison_affaire_id, $6::bigint),
            stock_level_id = COALESCE(stock_level_id, $7::uuid),
            source_scope = $9,
            of_id = COALESCE(of_id, $8::bigint),
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [existingId, qtyToReserve, args.actor_user_id, args.commande_ligne_id, businessAllocation.id,
        businessAllocation.livraison_affaire_id, args.stock_level_id, args.of_id ?? null, args.source_scope ?? 'NEW']
    );
    return { reservation_id: existingId, qty_reserved: qtyToReserve };
  }

  const insertReservation = await client.query<{ id: string }>(
    `
      INSERT INTO public.stock_reservations (
        article_id,
        location_id,
        qty_reserved,
        source_type,
        source_id,
        commande_ligne_id,
        status,
        lot_id,
        stock_batch_id,
        commande_ligne_affaire_allocation_id,
        livraison_affaire_id,
        stock_level_id,
        of_id,
        source_scope,
        created_by,
        updated_by
      ) VALUES (
        $1::uuid,$2::uuid,$3,'COMMANDE_LIGNE',$4::text,$4::bigint,'ACTIVE',$5::uuid,$6::uuid,
        $7::bigint,$8::bigint,$9::uuid,$10::bigint,$12,$11,$11
      )
      RETURNING id::text AS id
    `,
    [
      args.article_id,
      args.location_id,
      qtyToReserve,
      String(args.commande_ligne_id),
      args.lot_id,
      args.stock_batch_id,
      businessAllocation.id,
      businessAllocation.livraison_affaire_id,
      args.stock_level_id,
      args.of_id ?? null,
      args.actor_user_id,
      args.source_scope ?? 'NEW',
    ]
  );

  const reservationId = insertReservation.rows[0]?.id ?? null;
  return reservationId ? { reservation_id: reservationId, qty_reserved: qtyToReserve } : null;
}

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
  let remaining = args.qty_ok;
  let reservedQty = 0;
  const reservationIds: string[] = [];
  for (const allocation of allocations.rows) {
    if (remaining <= 1e-9) break;
    const requested = Math.min(remaining, Number(allocation.remaining_qty));
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
    reservationIds.push(reserved!.reservation_id);
    reservedQty += applied;
    remaining -= applied;
  }
  return reservationIds.length
    ? { reservation_id: reservationIds[0]!, qty_reserved: reservedQty, reservation_ids: reservationIds }
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

export async function resolveUnitIdForArticle(
  client: Pick<PoolClient, "query">,
  articleId: string,
  preferredUnitCode: string | null | undefined
): Promise<{ unit_id: string; unit_code: string }> {
  const preferred = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null;

  let code: string | null = preferred;
  if (!code) {
    const a = await client.query<{ unite: string | null }>(
      `SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`,
      [articleId]
    );
    code = a.rows[0]?.unite?.trim() ? a.rows[0].unite!.trim() : null;
  }

  code = canonicalizeStockUnitCode(code);
  if (!code) {
    throw new HttpError(422, "UNIT_REQUIRED", "Veuillez renseigner l'unite pour la mise en stock");
  }

  const u = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.units WHERE lower(code::text) = lower($1) LIMIT 1`,
    [code]
  );
  const unitId = u.rows[0]?.id;
  if (!unitId) {
    throw new HttpError(422, "UNIT_NOT_FOUND", "Unite inconnue");
  }
  return { unit_id: unitId, unit_code: code };
}

async function resolveEmplacementByLocationId(
  client: Pick<PoolClient, "query">,
  locationId: string
): Promise<{ magasin_id: string; emplacement_id: number; location_id: string; warehouse_id: string }> {
  const res = await client.query<{ magasin_id: string; emplacement_id: number; location_id: string; warehouse_id: string; magasin_is_active: boolean }>(
    `
      SELECT
        e.magasin_id::text AS magasin_id,
        e.id::bigint AS emplacement_id,
        e.location_id::text AS location_id,
        l.warehouse_id::text AS warehouse_id,
        COALESCE(m.is_active, true) AS magasin_is_active
      FROM public.emplacements e
      JOIN public.locations l ON l.id = e.location_id
      LEFT JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.location_id = $1::uuid
      LIMIT 1
    `,
    [locationId]
  );

  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(400, "INVALID_LOCATION", "Emplacement introuvable pour ce lieu (location_id)");
  if (!row.magasin_is_active) throw new HttpError(409, "MAGASIN_INACTIVE", "Le magasin selectionne est desactive");

  return {
    magasin_id: row.magasin_id,
    emplacement_id: Number(row.emplacement_id),
    location_id: row.location_id,
    warehouse_id: row.warehouse_id,
  };
}

async function ensureInternalOrderReceiptDestination(
  client: Pick<PoolClient, "query">,
  params: { client_code: string; actor_user_id: number }
): Promise<{ magasin_id: string; emplacement_id: number; location_id: string; warehouse_id: string }> {
  const clientCode = params.client_code.trim();
  if (!clientCode) {
    throw new HttpError(422, "INTERNAL_ORDER_CLIENT_CODE_REQUIRED", "La pièce technique doit porter un numéro client pour définir son emplacement NEW-PF.");
  }

  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`internal-stock-destination:${clientCode}`]);
  const magasinRes = await client.query<{ id: string; warehouse_id: string; code: string }>(
    `
      SELECT id::text AS id, warehouse_id::text AS warehouse_id, COALESCE(code, code_magasin)::text AS code
      FROM public.magasins
      WHERE COALESCE(code, code_magasin) = 'NEW-PF'
        AND is_active = true
      LIMIT 1
      FOR UPDATE
    `
  );
  const magasin = magasinRes.rows[0] ?? null;
  if (!magasin?.warehouse_id) {
    throw new HttpError(503, "NEW_PF_MAGASIN_REQUIRED", "Le magasin actif NEW-PF doit être configuré et lié à un entrepôt.");
  }

  const locationCode = `NEW-PF-${clientCode}`;
  const locationRes = await client.query<{ id: string }>(
    `
      INSERT INTO public.locations (warehouse_id, code, description)
      VALUES ($1::uuid,$2::citext,$3)
      ON CONFLICT (warehouse_id, code)
      DO UPDATE SET description = COALESCE(public.locations.description, EXCLUDED.description)
      RETURNING id::text AS id
    `,
    [magasin.warehouse_id, locationCode, `Stock produit fini client ${clientCode}`]
  );
  const locationId = locationRes.rows[0]?.id;
  if (!locationId) throw new Error("Failed to ensure internal order stock location");

  const emplacementRes = await client.query<{ id: number; location_id: string | null }>(
    `
      INSERT INTO public.emplacements (
        magasin_id, code, name, is_scrap, is_active, location_id,
        location_type, allow_inbound, allow_outbound, restrictions, created_by, updated_by
      )
      VALUES ($1::uuid,$2,$3,false,true,$4::uuid,'STORAGE',true,true,'{}'::jsonb,$5,$5)
      ON CONFLICT (magasin_id, code)
      DO UPDATE SET
        location_id = COALESCE(public.emplacements.location_id, EXCLUDED.location_id),
        is_active = true,
        allow_inbound = true,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING id::int AS id, location_id::text AS location_id
    `,
    [magasin.id, clientCode, `Client ${clientCode}`, locationId, params.actor_user_id]
  );
  const emplacement = emplacementRes.rows[0] ?? null;
  if (!emplacement || emplacement.location_id !== locationId) {
    throw new HttpError(409, "INTERNAL_ORDER_DESTINATION_CONFLICT", `L'emplacement NEW-PF ${clientCode} est lié à un autre lieu de stock.`);
  }

  return {
    magasin_id: magasin.id,
    emplacement_id: Number(emplacement.id),
    location_id: locationId,
    warehouse_id: magasin.warehouse_id,
  };
}

async function ensureStockLevel(
  client: Pick<PoolClient, "query">,
  args: {
    article_id: string;
    unit_id: string;
    warehouse_id: string;
    location_id: string;
    actor_user_id: number;
  }
): Promise<string> {
  const existing = await client.query<{ id: string; unit_id: string; warehouse_id: string }>(
    `
      SELECT
        id::text AS id,
        unit_id::text AS unit_id,
        warehouse_id::text AS warehouse_id
      FROM public.stock_levels
      WHERE article_id = $1::uuid AND location_id = $2::uuid
    `,
    [args.article_id, args.location_id]
  );
  const row = existing.rows[0] ?? null;
  if (row) {
    if (row.unit_id !== args.unit_id) throw new HttpError(409, "STOCK_LEVEL_UNIT_MISMATCH", "Stock level unit mismatch");
    if (row.warehouse_id !== args.warehouse_id) throw new HttpError(409, "STOCK_LEVEL_WAREHOUSE_MISMATCH", "Stock level warehouse mismatch");
    return row.id;
  }

  await client.query(
    `
      INSERT INTO public.stock_levels (
        article_id, unit_id, warehouse_id, location_id,
        managed_in_stock,
        created_by, updated_by
      )
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true,$5,$5)
      ON CONFLICT (article_id, location_id) DO NOTHING
    `,
    [args.article_id, args.unit_id, args.warehouse_id, args.location_id, args.actor_user_id]
  );

  const after = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.stock_levels WHERE article_id = $1::uuid AND location_id = $2::uuid`,
    [args.article_id, args.location_id]
  );
  const id = after.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure stock level");
  return id;
}

async function ensureStockBatchId(client: Pick<PoolClient, "query">, args: { stock_level_id: string; lot_id: string }): Promise<string> {
  const lot = await client.query<{ lot_code: string }>(`SELECT lot_code FROM public.lots WHERE id = $1::uuid`, [args.lot_id]);
  const lotCode = lot.rows[0]?.lot_code;
  if (!lotCode) throw new HttpError(400, "INVALID_LOT", "Lot introuvable");

  await client.query(
    `
      INSERT INTO public.stock_batches (stock_level_id, batch_code, lot_id)
      VALUES ($1::uuid,$2,$3::uuid)
      ON CONFLICT (stock_level_id, batch_code) DO NOTHING
    `,
    [args.stock_level_id, lotCode, args.lot_id]
  );

  const b = await client.query<{ id: string; lot_id: string | null }>(
    `SELECT id::text AS id, lot_id::text AS lot_id
     FROM public.stock_batches
     WHERE stock_level_id = $1::uuid AND batch_code = $2
     FOR UPDATE`,
    [args.stock_level_id, lotCode]
  );
  const row = b.rows[0] ?? null;
  const id = row?.id;
  if (!id) throw new Error("Failed to ensure stock batch");
  if (row.lot_id && row.lot_id !== args.lot_id) {
    throw new HttpError(409, "STOCK_BATCH_LOT_MISMATCH", "Le lot de stock est deja rattache a un autre lot interne");
  }
  if (!row.lot_id) {
    await client.query(`UPDATE public.stock_batches SET lot_id = $2::uuid WHERE id = $1::uuid`, [id, args.lot_id]);
  }
  return id;
}

async function insertMovementEvent(client: Pick<PoolClient, "query">, args: {
  movement_id: string;
  event_type: string;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  user_id: number;
}) {
  await client.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id,
        event_type,
        old_values,
        new_values,
        user_id,
        created_by,
        updated_by
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$5,$5)
    `,
    [args.movement_id, args.event_type, args.old_values, args.new_values, args.user_id]
  );
}

export async function repoGetOfReceiptContext(params: { of_id: number }): Promise<OfReceiptContext> {
  type OfRow = {
    id: string;
    numero: string;
    piece_technique_id: string;
    article_id: string | null;
    piece_code: string;
    piece_designation: string;
    quantite_lancee: number;
    quantite_bonne: number;
    statut: string;
    updated_at: string;
    affaire_id: number | null;
    commande_id: number | null;
    commande_ligne_id: number | null;
    order_type: string | null;
    client_code: string | null;
  };

  const ofRes = await pool.query<OfRow>(
    `
      SELECT
        o.id::text AS id,
        o.numero,
        o.piece_technique_id::text AS piece_technique_id,
        o.article_id::text AS article_id,
        pt.code AS piece_code,
        pt.designation AS piece_designation,
        o.quantite_lancee::float8 AS quantite_lancee,
        o.quantite_bonne::float8 AS quantite_bonne,
        o.statut::text AS statut,
        o.updated_at::text AS updated_at,
        o.affaire_id::bigint::int AS affaire_id,
        o.commande_id::bigint::int AS commande_id,
        o.commande_ligne_id::bigint::int AS commande_ligne_id,
        commande.order_type::text AS order_type,
        pt.code_client::text AS client_code
      FROM public.ordres_fabrication o
      JOIN public.pieces_techniques pt ON pt.id = o.piece_technique_id
      LEFT JOIN public.commande_client commande ON commande.id = o.commande_id
      WHERE o.id = $1::bigint
      LIMIT 1
    `,
    [params.of_id]
  );
  const ofRow = ofRes.rows[0] ?? null;
  if (!ofRow) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");

  const ofId = Number(ofRow.id);
  if (!Number.isFinite(ofId)) throw new Error("Invalid OF id");

  const article = ofRow.article_id
    ? {
        id: ofRow.article_id,
        unite: (
          await pool.query<{ unite: string | null }>(`SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`, [ofRow.article_id])
        ).rows[0]?.unite ?? null,
      }
    : await resolveArticleForPieceTechnique(pool, ofRow.piece_technique_id);
  const outputLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        ool.qty_ok::float8 AS qty_ok,
        ool.qty_scrap::float8 AS qty_scrap,
        ool.qty_rework::float8 AS qty_rework,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
  );
  const existingLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_on_hand: number;
    updated_at: string;
  }>(
    `
      SELECT
        l.id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        COALESCE(SUM(sb.qty_total), 0)::float8 AS qty_on_hand,
        l.updated_at::text AS updated_at
      FROM public.lots l
      LEFT JOIN public.stock_batches sb ON sb.lot_id = l.id
      WHERE l.article_id = $1::uuid
      GROUP BY l.id, l.lot_code, l.lot_status, l.updated_at
      ORDER BY l.updated_at DESC, l.lot_code ASC
      LIMIT 200
    `,
    [article.id]
  );

  const receivedQty = outputLotsRes.rows.reduce((acc, r) => acc + (Number.isFinite(r.qty_ok) ? r.qty_ok : 0), 0);
  const qtyOkReceivable = Math.max(0, Number(ofRow.quantite_bonne) - receivedQty);

  const defaultSetting = await pool.query<{ value_text: string | null }>(
    `SELECT value_text FROM public.erp_settings WHERE key = 'stock.default_receipt_location' LIMIT 1`
  );
  const configuredDefaultLocationId = defaultSetting.rows[0]?.value_text ?? null;
  const internalLocationId = ofRow.order_type === "INTERNE" && ofRow.client_code
    ? (
        await pool.query<{ location_id: string }>(
          `
            SELECT emplacement.location_id::text AS location_id
            FROM public.emplacements emplacement
            JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
            WHERE COALESCE(magasin.code, magasin.code_magasin) = 'NEW-PF'
              AND emplacement.code = $1
              AND emplacement.is_active = true
              AND emplacement.location_id IS NOT NULL
            LIMIT 1
          `,
          [ofRow.client_code]
        )
      ).rows[0]?.location_id ?? null
    : null;
  const defaultLocationId = internalLocationId ?? configuredDefaultLocationId;

  const magasinsRes = await pool.query<{ id: string; code: string; name: string; is_active: boolean }>(
    `
      SELECT
        m.id::text AS id,
        m.code,
        m.name,
        m.is_active
      FROM public.magasins m
      WHERE m.is_active = true
      ORDER BY m.name ASC, m.code ASC
    `
  );

  const emplacementsRes = await pool.query<{ id: number; magasin_id: string; code: string; name: string | null; location_id: string }>(
    `
      SELECT
        e.id::bigint AS id,
        e.magasin_id::text AS magasin_id,
        e.code,
        e.name,
        e.location_id::text AS location_id
      FROM public.emplacements e
      JOIN public.magasins m ON m.id = e.magasin_id
      WHERE e.is_active = true
        AND m.is_active = true
        AND e.location_id IS NOT NULL
      ORDER BY e.magasin_id ASC, e.code ASC
    `
  );

  return {
    of: {
      id: ofId,
      numero: ofRow.numero,
      piece_technique_id: ofRow.piece_technique_id,
      piece_code: ofRow.piece_code,
      piece_designation: ofRow.piece_designation,
      quantite_lancee: Number(ofRow.quantite_lancee),
      quantite_bonne: Number(ofRow.quantite_bonne),
      statut: ofRow.statut,
      updated_at: ofRow.updated_at,
      affaire_id: ofRow.affaire_id === null ? null : Number(ofRow.affaire_id),
      commande_id: ofRow.commande_id === null ? null : Number(ofRow.commande_id),
      commande_ligne_id: ofRow.commande_ligne_id === null ? null : Number(ofRow.commande_ligne_id),
      order_type: ofRow.order_type,
      client_code: ofRow.client_code,
    },
    article_id: article.id,
    unite: article.unite,
    received_qty_ok: receivedQty,
    qty_ok_receivable: qtyOkReceivable,
    default_location_id: defaultLocationId,
    output_lots: outputLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_ok: Number(r.qty_ok),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      updated_at: r.updated_at,
    })),
    existing_lots: existingLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_on_hand: Number(r.qty_on_hand),
      updated_at: r.updated_at,
    })),
    locations: {
      magasins: magasinsRes.rows.map((m) => ({ id: m.id, code: m.code, name: m.name, is_active: m.is_active })),
      emplacements: emplacementsRes.rows.map((e) => ({
        id: Number(e.id),
        magasin_id: e.magasin_id,
        code: e.code,
        name: e.name,
        location_id: e.location_id,
      })),
    },
  };
}

export async function repoCreateOfReceipt(params: {
  of_id: number;
  body: OfReceiptBodyDTO;
  idempotency_key: string;
  audit: AuditContext;
}): Promise<OfReceiptResult> {
  const client = await pool.connect();
  const requestHash = receiptRequestHash(params.of_id, params.body);
  return withRealtimeOutboxTransaction(client, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `of-receipt:${params.audit.user_id}:${params.idempotency_key}`,
    ]);

    const replayRes = await client.query<{ request_hash: string; result_payload: OfReceiptResult }>(
      `
        SELECT request_hash, result_payload
        FROM public.of_receipts
        WHERE actor_user_id = $1
          AND idempotency_key = $2
        LIMIT 1
      `,
      [params.audit.user_id, params.idempotency_key]
    );
    const replay = replayRes.rows[0] ?? null;
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette cle d'idempotence a deja ete utilisee avec un contenu different."
        );
      }
      return { ...replay.result_payload, idempotent_replay: true };
    }

    const ofRes = await client.query<{
      numero: string;
      piece_technique_id: string;
      article_id: string | null;
      affaire_id: number | null;
      commande_id: number | null;
      commande_ligne_id: number | null;
      piece_technique_version_id: string | null;
      order_type: string | null;
      internal_order_purpose: string | null;
      client_code: string | null;
      quantite_bonne: number;
      statut: string;
      updated_at: string;
    }>(
      `
        SELECT
          fabrication.numero,
          fabrication.piece_technique_id::text AS piece_technique_id,
          fabrication.article_id::text AS article_id,
          fabrication.affaire_id::bigint::int AS affaire_id,
          fabrication.commande_id::bigint::int AS commande_id,
          fabrication.commande_ligne_id::bigint::int AS commande_ligne_id,
          fabrication.piece_technique_version_id::text AS piece_technique_version_id,
          commande.order_type::text AS order_type,
          commande.internal_order_purpose::text AS internal_order_purpose,
          piece.code_client::text AS client_code,
          fabrication.quantite_bonne::float8 AS quantite_bonne,
          fabrication.statut::text AS statut,
          fabrication.updated_at::text AS updated_at
        FROM public.ordres_fabrication fabrication
        JOIN public.pieces_techniques piece ON piece.id = fabrication.piece_technique_id
        LEFT JOIN public.commande_client commande ON commande.id = fabrication.commande_id
        WHERE fabrication.id = $1::bigint
        FOR UPDATE OF fabrication
      `,
      [params.of_id]
    );
    const ofRow = ofRes.rows[0] ?? null;
    if (!ofRow) throw new HttpError(404, "OF_NOT_FOUND", "Ordre de fabrication introuvable");

    if (Date.parse(ofRow.updated_at) !== Date.parse(params.body.expected_of_updated_at)) {
      throw new HttpError(
        409,
        "CONCURRENT_MODIFICATION",
        "L'OF a ete modifie depuis l'apercu. Rechargez les donnees avant de confirmer.",
        { expected: params.body.expected_of_updated_at, actual: ofRow.updated_at }
      );
    }

    // #170 : pas de réception sur un OF annulé/clôturé/non démarré.
    const ofStatut = ofRow.statut as OfStatut;
    if (!ofStatutAllowsReceipt(ofStatut)) {
      throw new HttpError(
        409,
        "OF_RECEIPT_STATUS_INVALID",
        `Impossible d'enregistrer une réception sur un OF au statut ${ofStatut}.`,
        { statut: ofStatut }
      );
    }

    // #170 : la réception est bornée par la quantité restante, recalculée DANS
    // la transaction après verrou de l'OF — deux réceptions concurrentes se
    // sérialisent sur ce verrou et la seconde est refusée si elle déborde.
    const receivedRes = await client.query<{ received: number }>(
      `SELECT COALESCE(SUM(qty_ok), 0)::float8 AS received FROM public.of_output_lots WHERE of_id = $1::bigint`,
      [params.of_id]
    );
    const alreadyReceived = Number(receivedRes.rows[0]?.received ?? 0);
    const receivable = Math.max(0, Number(ofRow.quantite_bonne) - alreadyReceived);
    if (params.body.qty_ok > receivable + 1e-9) {
      throw new HttpError(
        422,
        "OF_RECEIPT_EXCEEDS_RECEIVABLE",
        `Quantité reçue (${params.body.qty_ok}) supérieure au restant à réceptionner (${receivable}).`,
        { requested: params.body.qty_ok, receivable, already_received: alreadyReceived, quantite_bonne: Number(ofRow.quantite_bonne) }
      );
    }

    const article = ofRow.article_id
      ? {
          id: ofRow.article_id,
          unite: (
            await client.query<{ unite: string | null }>(`SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`, [ofRow.article_id])
          ).rows[0]?.unite ?? null,
        }
      : await resolveArticleForPieceTechnique(client, ofRow.piece_technique_id);
    if (params.body.article_id && params.body.article_id !== article.id) {
      throw new HttpError(400, "ARTICLE_MISMATCH", "L'article selectionne ne correspond pas a la piece technique de l'OF");
    }

    const unit = await resolveUnitIdForArticle(client, article.id, params.body.unite ?? null);
    const isInternalOrder = ofRow.order_type === "INTERNE";
    const map = isInternalOrder
      ? await ensureInternalOrderReceiptDestination(client, {
          client_code: ofRow.client_code ?? "",
          actor_user_id: params.audit.user_id,
        })
      : params.body.location_id
        ? await resolveEmplacementByLocationId(client, params.body.location_id)
        : (() => {
            throw new HttpError(422, "RECEIPT_LOCATION_REQUIRED", "Sélectionnez l'emplacement de mise en stock.");
          })();
    const stockLevelId = await ensureStockLevel(client, {
      article_id: article.id,
      unit_id: unit.unit_id,
      warehouse_id: map.warehouse_id,
      location_id: map.location_id,
      actor_user_id: params.audit.user_id,
    });

    let lotId: string;
    let lotCode: string;
    let qualityDecision: Awaited<ReturnType<typeof assertOperationalLotQualityEligibility>> | null = null;
    if (params.body.lot_mode === "EXISTING") {
      const rawLotId = params.body.lot_id ?? null;
      if (!rawLotId) throw new HttpError(422, "LOT_REQUIRED", "Veuillez selectionner un lot");
      const lot = await client.query<{ id: string; lot_code: string; lot_status: string | null; piece_technique_version_id: string | null }>(
        `
          SELECT id::text AS id, lot_code, lot_status, piece_technique_version_id::text AS piece_technique_version_id
          FROM public.lots
          WHERE id = $1::uuid AND article_id = $2::uuid
          LIMIT 1
        `,
        [rawLotId, article.id]
      );
      const row = lot.rows[0] ?? null;
      if (!row) throw new HttpError(400, "INVALID_LOT", "Lot introuvable pour cet article");

      if (
        row.piece_technique_version_id
        && ofRow.piece_technique_version_id
        && row.piece_technique_version_id !== ofRow.piece_technique_version_id
      ) {
        throw new HttpError(
          409,
          "LOT_TECHNICAL_VERSION_MISMATCH",
          "Ce lot appartient à un autre indice technique et ne peut pas recevoir cette production."
        );
      }
      if (!row.piece_technique_version_id && ofRow.piece_technique_version_id) {
        await client.query(
          `UPDATE public.lots
           SET piece_technique_version_id = $2::uuid, updated_at = now(), updated_by = $3
           WHERE id = $1::uuid AND piece_technique_version_id IS NULL`,
          [row.id, ofRow.piece_technique_version_id, params.audit.user_id]
        );
      }

      const lotStatus = row.lot_status ?? "LIBERE";
      if (lotStatus !== params.body.quality_status) {
        throw new HttpError(
          409,
          "LOT_QUALITY_STATUS_MISMATCH",
          `Le lot existant est au statut ${lotStatus}; la reception demandee est ${params.body.quality_status}.`
        );
      }

      if (params.body.quality_status === "LIBERE") {
        qualityDecision = await assertOperationalLotQualityEligibility({
          client,
          lotId: row.id,
          qty: params.body.qty_ok,
          purpose: "RESERVE",
        });
      }

      lotId = row.id;
      lotCode = row.lot_code;
    } else {
      // A newly produced lot has no independent control/release evidence yet.
      // It must enter the ledger in quarantine and be released afterwards by
      // the Quality 360 workflow; accepting LIBERE here would be a bypass.
      if (params.body.quality_status === "LIBERE") {
        throw new HttpError(
          409,
          "QUALITY_RECEIPT_RELEASE_REQUIRES_CONTROL",
          "Une nouvelle réception OF doit être mise en quarantaine jusqu'à la décision de libération Qualité."
        );
      }
      if (params.body.lot_number?.trim()) {
        throw new HttpError(400, "LOT_CODE_SERVER_MANAGED", "Le numéro de lot interne est attribué automatiquement.");
      }
      const code = await generateTransactionalBusinessCode(client, { prefix: "LOT" });
      try {
        const ins = await client.query<{ id: string }>(
          `
            INSERT INTO public.lots (
              article_id, lot_code, lot_status, lot_status_note, notes,
              piece_technique_version_id, created_by, updated_by
            )
            VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7,$7)
            RETURNING id::text AS id
          `,
          [
            article.id,
            code,
            params.body.quality_status,
            params.body.quality_reason ?? null,
            params.body.commentaire ?? null,
            ofRow.piece_technique_version_id,
            params.audit.user_id,
          ]
        );
        const id = ins.rows[0]?.id;
        if (!id) throw new Error("Failed to create lot");
        lotId = id;
        lotCode = code;
      } catch (err) {
        const e = err as { code?: unknown } | null;
        if (e?.code === "23505") {
          throw new HttpError(409, "LOT_EXISTS", "Un lot avec ce numero existe deja pour cet article");
        }
        throw err;
      }
    }

    const stockBatchId = await ensureStockBatchId(client, { stock_level_id: stockLevelId, lot_id: lotId });
    const movementNo = await reserveMovementNo(client);

    const movementIns = await client.query<{ id: string }>(
      `
        INSERT INTO public.stock_movements (
          movement_type,
          article_id,
          stock_level_id,
          stock_batch_id,
          qty,
          currency,
          notes,
          user_id,
          movement_no,
          status,
          effective_at,
          source_document_type,
          source_document_id,
          reason_code,
          idempotency_key,
          created_by,
          updated_by
        )
        VALUES (
          'IN'::public.movement_type,
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4,
          'EUR',
          $5,
          $6,
          $7,
          'DRAFT',
          now(),
          'OF',
          $8,
          'OF_RECEIPT',
          $9,
          $6,
          $6
        )
        RETURNING id::text AS id
      `,
      [
        article.id,
        stockLevelId,
        stockBatchId,
        params.body.qty_ok,
        params.body.commentaire ?? null,
        params.audit.user_id,
        movementNo,
        String(params.of_id),
        `of-receipt:${params.audit.user_id}:${params.idempotency_key}`,
      ]
    );
    const movementId = movementIns.rows[0]?.id;
    if (!movementId) throw new Error("Failed to create stock movement");

    await client.query(
      `
        INSERT INTO public.stock_movement_lines (
          movement_id,
          line_no,
          article_id,
          lot_id,
          qty,
          unite,
          dst_magasin_id,
          dst_emplacement_id,
          note,
          created_by,
          updated_by
        )
        VALUES ($1::uuid,1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::bigint,$8,$9,$9)
      `,
      [
        movementId,
        article.id,
        lotId,
        params.body.qty_ok,
        unit.unit_code,
        map.magasin_id,
        map.emplacement_id,
        params.body.commentaire ?? null,
        params.audit.user_id,
      ]
    );

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "CREATED",
      old_values: null,
      new_values: { status: "DRAFT", movement_type: "IN", movement_no: movementNo },
      user_id: params.audit.user_id,
    });

    await client.query(
      `
        UPDATE public.stock_movements
        SET
          status = 'POSTED',
          posted_at = now(),
          posted_by = $2,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [movementId, params.audit.user_id]
    );

    await insertMovementEvent(client, {
      movement_id: movementId,
      event_type: "POSTED",
      old_values: { status: "DRAFT" },
      new_values: { status: "POSTED" },
      user_id: params.audit.user_id,
    });

    await client.query(
      `
        INSERT INTO public.of_output_lots (
          of_id,
          lot_id,
          qty_ok,
          qty_scrap,
          qty_rework,
          created_by,
          updated_by
        )
        VALUES ($1::bigint,$2::uuid,$3,$4,$5,$6,$6)
        ON CONFLICT (of_id, lot_id)
        DO UPDATE SET
          qty_ok = public.of_output_lots.qty_ok + EXCLUDED.qty_ok,
          qty_scrap = public.of_output_lots.qty_scrap + EXCLUDED.qty_scrap,
          qty_rework = public.of_output_lots.qty_rework + EXCLUDED.qty_rework,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
      `,
      [
        params.of_id,
        lotId,
        params.body.qty_ok,
        params.body.qty_scrap,
        params.body.qty_rework,
        params.audit.user_id,
      ]
    );

    let nonConformityId: string | null = null;
    if (params.body.quality_status === "BLOQUE" || params.body.qty_scrap > 0 || params.body.qty_rework > 0) {
      const ncRes = await client.query<{ id: string }>(
        `
          INSERT INTO public.non_conformity (
            affaire_id,
            of_id,
            piece_technique_id,
            lot_id,
            description,
            severity,
            status,
            detected_by,
            created_by,
            updated_by
          )
          VALUES (
            $1::bigint,
            $2::bigint,
            $3::uuid,
            $4::uuid,
            $5,
            $6::public.quality_nc_severity,
            'OPEN'::public.quality_nc_status,
            $7,
            $7,
            $7
          )
          RETURNING id::text AS id
        `,
        [
          ofRow.affaire_id,
          params.of_id,
          ofRow.piece_technique_id,
          lotId,
          params.body.quality_reason ??
            `Ecart constate a la reception de production: rebut ${params.body.qty_scrap}, retouche ${params.body.qty_rework}.`,
          params.body.quality_status === "BLOQUE" ? "MAJOR" : "MINOR",
          params.audit.user_id,
        ]
      );
      nonConformityId = ncRes.rows[0]?.id ?? null;
      if (!nonConformityId) throw new Error("Failed to create production non-conformity");
    }

    const consolidationReservation = params.body.quality_status === 'LIBERE'
      ? await reserveConsolidatedReceipt(client,{of_id:params.of_id,article_id:article.id,location_id:map.location_id,stock_level_id:stockLevelId,stock_batch_id:stockBatchId,
          lot_id:lotId,movement_id:movementId,qty_ok:params.body.qty_ok,actor_user_id:params.audit.user_id,quality_gate_already_held:qualityDecision!==null}) : null;
    const componentReservation = !consolidationReservation && params.body.quality_status === "LIBERE"
      ? await reserveProducedComponentForParentOf(client, {
          component_of_id: params.of_id,
          article_id: article.id,
          location_id: map.location_id,
          stock_level_id: stockLevelId,
          stock_batch_id: stockBatchId,
          lot_id: lotId,
          qty_ok: params.body.qty_ok,
          actor_user_id: params.audit.user_id,
          quality_gate_already_held: qualityDecision !== null,
        })
      : { matched: false, reservation_id: null, qty_reserved: 0, reservation_ids: [] };

    const autoReservation = consolidationReservation ?? (componentReservation.matched
      ? componentReservation
      : isInternalOrder && ofRow.internal_order_purpose === "CONTRACT" && params.body.quality_status === "LIBERE"
        ? await reserveInternalContractReceiptForCustomers(client, {
            of_id: params.of_id,
            article_id: article.id,
            location_id: map.location_id,
            stock_level_id: stockLevelId,
            stock_batch_id: stockBatchId,
            lot_id: lotId,
            qty_ok: params.body.qty_ok,
            actor_user_id: params.audit.user_id,
            quality_gate_already_held: qualityDecision !== null,
          })
        : !isInternalOrder && params.body.quality_status === "LIBERE" && typeof ofRow.commande_ligne_id === "number"
        ? await reserveProducedQtyForCommandeLine(client, {
            commande_ligne_id: ofRow.commande_ligne_id,
            article_id: article.id,
            location_id: map.location_id,
            stock_level_id: stockLevelId,
            stock_batch_id: stockBatchId,
            lot_id: lotId,
            qty_ok: params.body.qty_ok,
            actor_user_id: params.audit.user_id,
            of_id: params.of_id,
            quality_gate_already_held: qualityDecision !== null,
          })
        : null);

    const receiptId = randomUUID();
    const receiptResult: OfReceiptResult = {
      receipt_id: receiptId,
      lot_id: lotId,
      lot_code: lotCode,
      stock_movement_id: movementId,
      movement_no: movementNo,
      qty_ok: params.body.qty_ok,
      qty_scrap: params.body.qty_scrap,
      qty_rework: params.body.qty_rework,
      quality_status: params.body.quality_status,
      reservation_id: autoReservation?.reservation_id ?? null,
      reserved_qty: autoReservation?.qty_reserved ?? 0,
      non_conformity_id: nonConformityId,
      idempotent_replay: false,
    };

    await client.query(
      `
        UPDATE public.ordres_fabrication
        SET updated_at = clock_timestamp(),
            updated_by = $2
        WHERE id = $1::bigint
      `,
      [params.of_id, params.audit.user_id]
    );

    await client.query(
      `
        INSERT INTO public.of_receipts (
          id,
          of_id,
          actor_user_id,
          idempotency_key,
          request_hash,
          request_payload,
          result_payload,
          expected_of_updated_at,
          qty_ok,
          qty_scrap,
          qty_rework,
          quality_status,
          quality_reason,
          location_id,
          lot_id,
          stock_level_id,
          stock_batch_id,
          stock_movement_id,
          reservation_id,
          non_conformity_id
        )
        VALUES (
          $1::uuid,$2::bigint,$3,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz,
          $9,$10,$11,$12,$13,$14::uuid,$15::uuid,$16::uuid,$17::uuid,$18::uuid,
          $19::uuid,$20::uuid
        )
      `,
      [
        receiptId,
        params.of_id,
        params.audit.user_id,
        params.idempotency_key,
        requestHash,
        params.body,
        receiptResult,
        params.body.expected_of_updated_at,
        params.body.qty_ok,
        params.body.qty_scrap,
        params.body.qty_rework,
        params.body.quality_status,
        params.body.quality_reason ?? null,
        map.location_id,
        lotId,
        stockLevelId,
        stockBatchId,
        movementId,
        autoReservation?.reservation_id ?? null,
        nonConformityId,
      ]
    );

    const automaticReservationIds = autoReservation && "reservation_ids" in autoReservation
      ? autoReservation.reservation_ids
      : autoReservation?.reservation_id ? [autoReservation.reservation_id] : [];
    await insertAuditLog(client, params.audit, {
      action: "production.of.receipt",
      entity_type: "ordres_fabrication",
      entity_id: String(params.of_id),
      details: {
        lot_id: lotId,
        lot_code: lotCode,
        qty_ok: params.body.qty_ok,
        qty_scrap: params.body.qty_scrap,
        qty_rework: params.body.qty_rework,
        quality_status: params.body.quality_status,
        quality_reason: params.body.quality_reason ?? null,
        location_id: map.location_id,
        receipt_id: receiptId,
        stock_movement_id: movementId,
        movement_no: movementNo,
        commande_ligne_id: ofRow.commande_ligne_id ?? null,
        article_id: article.id,
        auto_reservation_id: autoReservation?.reservation_id ?? null,
        auto_reservation_ids: automaticReservationIds,
        auto_reserved_qty: autoReservation?.qty_reserved ?? 0,
        non_conformity_id: nonConformityId,
        idempotency_key: params.idempotency_key,
        quality_gate: qualityDecision,
      },
    });

    return receiptResult;
  });
}

export async function repoGetOfTraceability(params: { of_id: number }): Promise<OfTraceability> {
  const outputLotsRes = await pool.query<{
    lot_id: string;
    lot_code: string;
    lot_status: string;
    qty_ok: number;
    qty_scrap: number;
    qty_rework: number;
    updated_at: string;
  }>(
    `
      SELECT
        ool.lot_id::text AS lot_id,
        l.lot_code,
        l.lot_status,
        ool.qty_ok::float8 AS qty_ok,
        ool.qty_scrap::float8 AS qty_scrap,
        ool.qty_rework::float8 AS qty_rework,
        ool.updated_at::text AS updated_at
      FROM public.of_output_lots ool
      JOIN public.lots l ON l.id = ool.lot_id
      WHERE ool.of_id = $1::bigint
      ORDER BY ool.updated_at DESC, ool.id DESC
    `,
    [params.of_id]
  );

  const receiptsRes = await pool.query<{
    receipt_id: string | null;
    stock_movement_id: string;
    movement_no: string | null;
    status: string;
    posted_at: string | null;
    qty: number;
    qty_scrap: number;
    qty_rework: number;
    quality_status: string | null;
    reservation_id: string | null;
    non_conformity_id: string | null;
    lot_id: string | null;
    lot_code: string | null;
    magasin_id: string | null;
    magasin_code: string | null;
    magasin_name: string | null;
    emplacement_id: number | null;
    emplacement_code: string | null;
    location_id: string | null;
  }>(
    `
      SELECT
        r.id::text AS receipt_id,
        m.id::text AS stock_movement_id,
        m.movement_no,
        m.status,
        m.posted_at::text AS posted_at,
        m.qty::float8 AS qty,
        COALESCE(r.qty_scrap, 0)::float8 AS qty_scrap,
        COALESCE(r.qty_rework, 0)::float8 AS qty_rework,
        r.quality_status,
        r.reservation_id::text AS reservation_id,
        r.non_conformity_id::text AS non_conformity_id,
        ml.lot_id::text AS lot_id,
        l.lot_code,
        ml.dst_magasin_id::text AS magasin_id,
        mag.code AS magasin_code,
        mag.name AS magasin_name,
        ml.dst_emplacement_id::bigint AS emplacement_id,
        e.code AS emplacement_code,
        e.location_id::text AS location_id
      FROM public.stock_movements m
      LEFT JOIN public.of_receipts r ON r.stock_movement_id = m.id
      JOIN public.stock_movement_lines ml ON ml.movement_id = m.id
      LEFT JOIN public.lots l ON l.id = ml.lot_id
      LEFT JOIN public.emplacements e ON e.id = ml.dst_emplacement_id
      LEFT JOIN public.magasins mag ON mag.id = ml.dst_magasin_id
      WHERE m.source_document_type = 'OF'
        AND m.source_document_id = $1
        AND m.movement_type = 'IN'::public.movement_type
      ORDER BY m.posted_at DESC NULLS LAST, m.effective_at DESC, m.id DESC
      LIMIT 200
    `,
    [String(params.of_id)]
  );

  return {
    output_lots: outputLotsRes.rows.map((r) => ({
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      lot_status: r.lot_status,
      qty_ok: Number(r.qty_ok),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      updated_at: r.updated_at,
    })),
    receipts: receiptsRes.rows.map((r) => ({
      receipt_id: r.receipt_id,
      stock_movement_id: r.stock_movement_id,
      movement_no: r.movement_no,
      status: r.status,
      posted_at: r.posted_at,
      qty: Number(r.qty),
      qty_scrap: Number(r.qty_scrap),
      qty_rework: Number(r.qty_rework),
      quality_status: r.quality_status,
      reservation_id: r.reservation_id,
      non_conformity_id: r.non_conformity_id,
      lot_id: r.lot_id,
      lot_code: r.lot_code,
      magasin_id: r.magasin_id,
      magasin_code: r.magasin_code,
      magasin_name: r.magasin_name,
      emplacement_id: r.emplacement_id !== null ? Number(r.emplacement_id) : null,
      emplacement_code: r.emplacement_code,
      location_id: r.location_id,
    })),
  };
}
