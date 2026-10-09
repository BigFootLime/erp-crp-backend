import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";
import { distributeReceiptToStockLanes, type ReceiptLaneDistribution, type ReceiptReservationAllocation } from "../domain/receipt-lane-distribution";

type Tx = Pick<PoolClient, "query">;
type ReservationSnapshot = Map<string, bigint>;

export async function assertReceiptLaneAssignmentsInstalled(tx: Tx): Promise<void> {
  const result = (await tx.query<{ installed: boolean }>(`SELECT
    to_regclass('public.production_receipt_lane_intents') IS NOT NULL
    AND to_regclass('public.production_receipt_lane_assignments') IS NOT NULL AS installed`)).rows[0];
  if (!result?.installed)
    throw new HttpError(409, "RECEIPT_LANE_ASSIGNMENTS_NOT_INSTALLED", "La réception attend la mise à jour des affectations de production.");
}

export async function snapshotReceiptReservations(tx: Tx, stockBatchId: string): Promise<ReservationSnapshot> {
  const rows = (await tx.query<{ id: string; quantity: string }>(
    `SELECT id::text,qty_reserved::text AS quantity FROM public.stock_reservations
      WHERE stock_batch_id=$1::uuid AND status='ACTIVE' ORDER BY id`, [stockBatchId])).rows;
  return new Map(rows.map(row => [row.id, parseCumpDecimal(row.quantity)]));
}

export async function calculateReceiptLaneAssignment(
  tx: Tx, stockBatchId: string, quantity: string, before: ReservationSnapshot,
): Promise<ReceiptLaneDistribution> {
  const rows = (await tx.query<{ id: string; quantity: string; delivery: boolean; assembly: boolean }>(
    `SELECT id::text,qty_reserved::text AS quantity,of_component_requirement_id IS NOT NULL AS assembly,
      commande_ligne_affaire_allocation_id IS NOT NULL AS delivery
      FROM public.stock_reservations WHERE stock_batch_id=$1::uuid AND status='ACTIVE' ORDER BY id`, [stockBatchId])).rows;
  const allocations: ReceiptReservationAllocation[] = [];
  for (const row of rows) {
    const delta = parseCumpDecimal(row.quantity) - (before.get(row.id) ?? 0n);
    if (delta <= 0n) continue;
    if (row.assembly === row.delivery)
      throw new HttpError(409, "RECEIPT_LANE_RESERVATION_AMBIGUOUS", "Une réservation de réception doit viser une livraison ou un assemblage précis.");
    allocations.push({ reservation_id: row.id, lane: row.assembly ? "ASSEMBLY" : "DELIVERY", quantity: formatCumpDecimal(delta) });
  }
  return distributeReceiptToStockLanes(quantity, allocations);
}

export async function registerReceiptLaneIntent(tx: Tx, receiptId: string): Promise<void> {
  await tx.query("INSERT INTO public.production_receipt_lane_intents(receipt_id) VALUES($1::uuid)", [receiptId]);
}

export async function recordReceiptLaneAssignment(
  tx: Tx, receiptId: string, distribution: ReceiptLaneDistribution, actorId: number, qualityDecision: unknown,
): Promise<void> {
  if (!qualityDecision || typeof qualityDecision !== "object") throw new Error("RECEIPT_LANE_QUALITY_EVIDENCE_REQUIRED");
  const receipt = (await tx.query<{ qty_ok: string }>(
    "SELECT qty_ok::text FROM public.of_receipts WHERE id=$1::uuid FOR UPDATE", [receiptId])).rows[0];
  if (!receipt) throw new Error("RECEIPT_LANE_INTENT_RECEIPT_MISSING");
  const attributed = (await tx.query<{ quantity: string }>(
    "SELECT COALESCE(sum(quantity),0)::text AS quantity FROM public.production_receipt_lane_assignments WHERE receipt_id=$1::uuid", [receiptId])).rows[0];
  if (parseCumpDecimal(attributed.quantity) + parseCumpDecimal(distribution.received_quantity) > parseCumpDecimal(receipt.qty_ok))
    throw new HttpError(409, "RECEIPT_LANE_ALREADY_ASSIGNED", "La réception ne peut pas être affectée deux fois.");
  await tx.query(`INSERT INTO public.production_receipt_lane_assignments(receipt_id,quantity,distribution,actor_user_id,quality_decision)
    VALUES($1::uuid,$2,$3::jsonb,$4,$5::jsonb)`, [receiptId, distribution.received_quantity, JSON.stringify(distribution), actorId, JSON.stringify(qualityDecision)]);
}
