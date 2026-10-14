import type { PoolClient } from "pg"
import { HttpError } from "../../../utils/httpError"
import { readProformaFunding } from "../../facturation/repository/proforma-read.repository"
import { readProformaOrderSources, proformaOrderSourceRevision } from "../../facturation/repository/proforma-source.repository"
import { deliveryPrepaymentBoundary, type DeliveryPrepaymentSource } from "../domain/delivery-prepayment-boundary"

type Queryer = Pick<PoolClient, "query">
type SourceIdentity = { line_id: string; allocation_id: string | null; inconsistent: boolean }

async function readSourceIdentities(tx: Queryer, deliveryId: string): Promise<SourceIdentity[]> {
  return (await tx.query<SourceIdentity>(`
    SELECT line.id::text AS line_id,
      COALESCE(allocated.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)::text AS allocation_id,
      (source.id IS NULL OR source.commande_ligne_id IS DISTINCT FROM line.commande_ligne_id OR
        (allocated.commande_ligne_affaire_allocation_id IS NOT NULL AND reservation.commande_ligne_affaire_allocation_id IS NOT NULL
          AND allocated.commande_ligne_affaire_allocation_id<>reservation.commande_ligne_affaire_allocation_id)) AS inconsistent
    FROM public.bon_livraison_ligne line
    LEFT JOIN public.bon_livraison_ligne_allocations allocated ON allocated.bon_livraison_ligne_id=line.id
    LEFT JOIN public.stock_reservations reservation ON reservation.id=allocated.reservation_id
    LEFT JOIN public.commande_ligne_affaire_allocation source ON source.id=
      COALESCE(allocated.commande_ligne_affaire_allocation_id,reservation.commande_ligne_affaire_allocation_id)
    WHERE line.bon_livraison_id=$1::uuid ORDER BY line.id,allocated.id
  `, [deliveryId])).rows
}

function allocationIds(identities: readonly SourceIdentity[]): number[] {
  const ids = identities.flatMap(row => row.allocation_id === null ? [] : [Number(row.allocation_id)])
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new HttpError(409, "DELIVERY_PREPAYMENT_SOURCE_INVALID", "L'identité d'une affaire doit être vérifiée.")
  }
  return [...new Set(ids)].sort((a,b)=>a-b)
}

/** Acquire before any BL/reservation row, including on cancellation/reset paths. */
export async function lockDeliveryPrepaymentRead(tx: Queryer): Promise<void> {
  // The epoch row rejects stale SERIALIZABLE snapshots after a Finance writer
  // committed while this transaction waited for the advisory shared lock.
  try { await tx.query("SELECT public.fn_lock_delivery_prepayment_read_1268()") }
  catch (error) { throwPrepaymentSnapshotChange(error) }
}

function throwPrepaymentSnapshotChange(error: unknown): never {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "40001") {
    throw new HttpError(409,"DELIVERY_PREPAYMENT_REFRESH_REQUIRED","Les données de livraison ont changé : actualisez le BL avant de continuer.")
  }
  throw error
}

/** Canonical order -> contract -> affair -> BL lock order, with source recheck. */
export async function lockDeliveryPrepaymentSources(tx: Queryer, deliveryId: string): Promise<void> {
  try {
  await lockDeliveryPrepaymentRead(tx)
  const before = await readSourceIdentities(tx, deliveryId)
  const ids = allocationIds(before)
  if (ids.length) await readProformaOrderSources(tx, ids, true)
  await tx.query("SELECT id FROM public.bon_livraison WHERE id=$1::uuid FOR UPDATE", [deliveryId])
  const after = await readSourceIdentities(tx, deliveryId)
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new HttpError(409, "DELIVERY_PREPAYMENT_SOURCE_CHANGED", "Le BL a changé : actualisez sa préparation.")
  }
  } catch (error) { throwPrepaymentSnapshotChange(error) }
}

export type DeliveryPrepaymentControl = {
  group_key: string
  blockers: ReturnType<typeof deliveryPrepaymentBoundary>["blockers"]
  affairs: Array<{
    allocation_id: number
    affaire_reference: string | null
    commande_id: string
    requirement: DeliveryPrepaymentSource["requirement"]
    proforma_id: string | null
    proforma_reference: string | null
    document_status: DeliveryPrepaymentSource["documentStatus"]
    source_unchanged: boolean
    billing_parts: Awaited<ReturnType<typeof readProformaFunding>>
  }>
}

/** The caller owns the read snapshot or mutation transaction. No paid flag. */
export async function readDeliveryPrepaymentBoundary(tx: Queryer, deliveryId: string): Promise<DeliveryPrepaymentControl> {
  const identities = await readSourceIdentities(tx, deliveryId)
  const ids = allocationIds(identities)
  const sources = ids.length ? await readProformaOrderSources(tx, ids, false) : []
  const funding = await readProformaFunding(tx, sources.flatMap(source => source.bound_proforma_id ? [source.bound_proforma_id] : []))
  const affairs = sources.map(source => ({
    allocation_id: source.allocation_id, affaire_reference: source.affaire_reference ?? null,
    commande_id: source.commande_id, requirement: source.order_type === "INTERNE" ? "NOT_REQUIRED" as const : source.prepayment_requirement ?? "UNCONFIRMED",
    proforma_id: source.bound_proforma_id ?? null, proforma_reference: source.bound_proforma_reference ?? null,
    document_status: (source.bound_proforma_status ?? null) as DeliveryPrepaymentSource["documentStatus"],
    source_unchanged: Boolean(source.bound_proforma_source_revision &&
      source.bound_proforma_source_revision === proformaOrderSourceRevision(source, source.currency)),
    billing_parts: funding.filter(part => part.proforma_id === source.bound_proforma_id && part.allocation_id === source.allocation_id),
  }))
  const boundary = deliveryPrepaymentBoundary({
    sources: affairs.map(affair => ({ allocationId: affair.allocation_id, requirement: affair.requirement,
      proformaId: affair.proforma_id, documentStatus: affair.document_status,
      sourceUnchanged: affair.source_unchanged, billingParts: affair.billing_parts })),
    hasUnboundLines: identities.some(row => row.inconsistent || row.allocation_id === null),
  })
  return { group_key: boundary.groupKey, blockers: boundary.blockers, affairs }
}

export async function assertDeliveryPrepaymentBoundary(tx: Queryer, deliveryId: string): Promise<DeliveryPrepaymentControl> {
  const control = await readDeliveryPrepaymentBoundary(tx, deliveryId)
  if (control.blockers.length) {
    throw new HttpError(409, "DELIVERY_PREPAYMENT_BLOCKED", control.blockers[0]!.message, { blockers: control.blockers, prepayment: control })
  }
  return control
}
