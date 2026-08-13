import type { PoolClient } from "pg"

import { HttpError } from "../../../utils/httpError"

type Queryable = Pick<PoolClient, "query">

export type FulfillmentState = {
  has_lines: boolean
  has_ready_delivery: boolean
  fully_shipped: boolean
  fully_invoiced: boolean
}

const INVOICE_LEDGER_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const

export async function loadCommandeFulfillmentState(tx: Queryable, commandeId: number): Promise<FulfillmentState> {
  const result = await tx.query<FulfillmentState>(
    `
      WITH shipped_by_line AS (
        SELECT delivery_line.commande_ligne_id, COALESCE(SUM(delivery_line.quantite), 0)::numeric AS quantity
        FROM public.bon_livraison_ligne delivery_line
        JOIN public.bon_livraison delivery ON delivery.id = delivery_line.bon_livraison_id
        WHERE delivery.commande_id = $1
          AND delivery.statut IN ('SHIPPED', 'DELIVERED')
          AND delivery_line.commande_ligne_id IS NOT NULL
        GROUP BY delivery_line.commande_ligne_id
      ),
      invoiced_by_delivery_line AS (
        SELECT source.source_line_id, COALESCE(SUM(source.quantity_consumed), 0)::numeric AS quantity
        FROM public.facture_source_allocations source
        JOIN public.facture invoice ON invoice.id = source.facture_id
        WHERE source.source_type = 'DELIVERY_LINE'
          AND source.allocation_status = 'CONSUMED'
          AND invoice.statut = ANY($2::text[])
        GROUP BY source.source_line_id
      )
      SELECT
        EXISTS(SELECT 1 FROM public.commande_ligne line WHERE line.commande_id = $1) AS has_lines,
        EXISTS(
          SELECT 1 FROM public.bon_livraison delivery
          WHERE delivery.commande_id = $1 AND delivery.statut IN ('READY', 'SHIPPED', 'DELIVERED')
        ) AS has_ready_delivery,
        NOT EXISTS(
          SELECT 1 FROM public.commande_ligne line
          LEFT JOIN shipped_by_line shipped ON shipped.commande_ligne_id = line.id
          WHERE line.commande_id = $1
            AND COALESCE(shipped.quantity, 0) + 0.000000001 < line.quantite
        ) AS fully_shipped,
        NOT EXISTS(
          SELECT 1 FROM public.bon_livraison_ligne delivery_line
          JOIN public.bon_livraison delivery ON delivery.id = delivery_line.bon_livraison_id
          LEFT JOIN invoiced_by_delivery_line invoiced ON invoiced.source_line_id = delivery_line.id::text
          WHERE delivery.commande_id = $1
            AND delivery.statut IN ('SHIPPED', 'DELIVERED')
            AND COALESCE(invoiced.quantity, 0) + 0.000000001 < delivery_line.quantite
        ) AS fully_invoiced
    `,
    [commandeId, [...INVOICE_LEDGER_STATUSES]],
  )
  const state = result.rows[0] ?? {
    has_lines: false,
    has_ready_delivery: false,
    fully_shipped: false,
    fully_invoiced: false,
  }
  return {
    ...state,
    fully_shipped: state.has_lines && state.fully_shipped,
    fully_invoiced: state.has_lines && state.fully_shipped && state.fully_invoiced,
  }
}

export async function assertCommandeHasActiveOf(tx: Queryable, commandeId: number): Promise<void> {
  const linkedOf = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM public.ordres_fabrication
       WHERE commande_id = $1 AND statut::text <> 'ANNULE'
     ) AS exists`,
    [commandeId],
  )
  if (linkedOf.rows[0]?.exists !== true) {
    throw new HttpError(
      409,
      "PLANNING_REQUIRES_OF",
      "Aucun OF actif n'est lié à cette commande. Relancez le contrôle OLD/NEW et la génération avant de valider le planning.",
    )
  }
}

export async function assertCommandeProductionStarted(tx: Queryable, commandeId: number): Promise<void> {
  const result = await tx.query<{ total: number; not_started: number }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE statut::text <> 'ANNULE')::int AS total,
        COUNT(*) FILTER (
          WHERE statut::text <> 'ANNULE'
            AND statut::text NOT IN ('EN_COURS','TERMINE','CLOTURE')
        )::int AS not_started
      FROM public.ordres_fabrication
      WHERE commande_id = $1
    `,
    [commandeId]
  )
  const state = result.rows[0] ?? { total: 0, not_started: 0 }
  if (state.total <= 0 || state.not_started > 0) {
    throw new HttpError(409, "PRODUCTION_START_REQUIRED", "Lancez tous les OF actifs dans le module Production avant de synchroniser la commande.")
  }
}

export async function assertCommandeProductionCompleted(tx: Queryable, commandeId: number): Promise<void> {
  const result = await tx.query<{ total: number; incomplete: number }>(
    `
      SELECT
        COUNT(*) FILTER (WHERE statut::text <> 'ANNULE')::int AS total,
        COUNT(*) FILTER (
          WHERE statut::text <> 'ANNULE'
            AND statut::text NOT IN ('TERMINE','CLOTURE')
        )::int AS incomplete
      FROM public.ordres_fabrication
      WHERE commande_id = $1
    `,
    [commandeId]
  )
  const state = result.rows[0] ?? { total: 0, incomplete: 0 }
  if (state.total <= 0 || state.incomplete > 0) {
    throw new HttpError(409, "PRODUCTION_NOT_COMPLETE", "Tous les OF actifs, y compris les OF enfants, doivent être terminés ou clôturés.")
  }
}

export async function assertCommandeQualityReleased(tx: Queryable, commandeId: number): Promise<void> {
  const result = await tx.query<{ total: number; unreleased: number; open_nc: number }>(
    `
      WITH active_of AS (
        SELECT id, GREATEST(COALESCE(quantite_bonne, 0), 0)::numeric AS qty_required
        FROM public.ordres_fabrication
        WHERE commande_id = $1 AND statut::text <> 'ANNULE'
      ), release_evidence AS (
        SELECT decision.object_id AS of_id,
               decision.qty,
               decision.decision,
               decision.verdict
        FROM public.quality_release_decision decision
        WHERE decision.object_type = 'OF'
          AND decision.object_id IN (SELECT id::text FROM active_of)

        UNION ALL

        SELECT control.of_id::text AS of_id,
               decision.qty,
               decision.decision,
               decision.verdict
        FROM public.quality_release_decision decision
        JOIN public.quality_control control ON control.id = decision.quality_control_id
        WHERE control.of_id IN (SELECT id FROM active_of)
          AND control.trigger_type = 'LOT_RELEASE'
          AND control.delivery_allocation_id IS NOT NULL
          AND decision.object_type = control.source_type
          AND decision.object_id = control.source_id
      ), released AS (
        SELECT of_id AS object_id,
          COALESCE(SUM(qty) FILTER (
            WHERE decision IN ('FULL','PARTIAL') AND verdict IN ('CONFORME','PARTIEL')
          ), 0)::numeric AS qty_released
        FROM release_evidence
        GROUP BY of_id
      )
      SELECT
        (SELECT COUNT(*)::int FROM active_of) AS total,
        (SELECT COUNT(*)::int
         FROM active_of target
         LEFT JOIN released decision ON decision.object_id = target.id::text
         WHERE decision.object_id IS NULL OR decision.qty_released + 0.000000001 < target.qty_required
        ) AS unreleased,
        (SELECT COUNT(*)::int
         FROM public.non_conformity nc
         WHERE nc.of_id IN (SELECT id FROM active_of)
           AND nc.status::text NOT IN ('CLOSED','CANCELLED')
        ) AS open_nc
    `,
    [commandeId]
  )
  const state = result.rows[0] ?? { total: 0, unreleased: 0, open_nc: 0 }
  if (state.total <= 0 || state.unreleased > 0 || state.open_nc > 0) {
    throw new HttpError(409, "QUALITY_RELEASE_REQUIRED", "Chaque OF actif doit être couvert par une décision de libération qualité et aucune non-conformité ne doit rester ouverte.")
  }
}

export async function assertCommandeHasPreparedDelivery(tx: Queryable, commandeId: number): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId)
  if (!state.has_ready_delivery) {
    throw new HttpError(
      409,
      "DELIVERY_PREPARATION_REQUIRED",
      "Aucun bon de livraison prêt n'est lié à cette commande. Préparez le BL et ses réservations avant ce changement de statut.",
    )
  }
}

export async function assertCommandeFullyShipped(tx: Queryable, commandeId: number): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId)
  if (!state.fully_shipped) {
    throw new HttpError(
      409,
      "DELIVERY_NOT_COMPLETE",
      "La commande ne peut pas être déclarée livrée : toutes les quantités doivent d'abord sortir du stock via un BL expédié.",
    )
  }
}

export async function assertCommandeFullyInvoiced(tx: Queryable, commandeId: number): Promise<void> {
  const state = await loadCommandeFulfillmentState(tx, commandeId)
  if (!state.fully_invoiced) {
    throw new HttpError(
      409,
      "INVOICE_NOT_COMPLETE",
      "La commande ne peut pas être déclarée facturée : toutes les lignes expédiées doivent être couvertes par une facture émise.",
    )
  }
}
