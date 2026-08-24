import crypto from "node:crypto"
import type { PoolClient } from "pg"

import pool from "../../../config/database"
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction"
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"
import { HttpError } from "../../../utils/httpError"
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository"
import { assertOperationalLotQualityEligibility } from "../../qualite/repository/quality-operational-gate.repository"
import { syncCommandeAfterShipment } from "../../commande-client/repository/commande-fulfillment.repository"
import { hashStockCommand, normalizeIdempotencyKey } from "../../stock/domain/stock-command"
import {
  assertStockConsumptionAllowed,
  lockStockStates,
  stockTargetKey,
  type LockedStockState,
  type StockLockTarget,
} from "../../stock/repository/stock.repository"
import type {
  BonLivraisonDeliveryProof,
  BonLivraisonShipmentPreview,
  BonLivraisonShipResult,
  ShipmentPreviewAllocation,
  ShipmentPreviewBlocker,
  ShipmentPreviewPack,
} from "../types/livraisons.types"
import type {
  LivraisonProofBodyDTO,
  ShipLivraisonBodyDTO,
} from "../validators/livraisons.validators"
import {
  deliveryLotIsConsumable,
  deliveryQuantitiesMatch,
  deliveryQuantityAvailable,
  shipmentConfirmationMatches,
  shipmentBillingBoundary,
  shipmentReceiptDecision,
} from "../domain/livraisons-policy"
import type { DeliveryQualityRelease } from "../domain/quality-release-gate"
import { repoGetDeliveryQualityRelease } from "./quality-release.repository"
import { queueCreationPdfArchive } from "../../../shared/authoritative-documents/authoritative-document.service"
import { buildShippedDeliveryArtifactInput } from "../services/delivery-authoritative-document"

type Queryable = Pick<PoolClient, "query">

type HeaderRow = {
  id: string
  numero: string
  statut: "DRAFT" | "READY" | "SHIPPED" | "DELIVERED" | "CANCELLED"
  row_version: number
  commande_id: string | null
  affaire_id: string | null
  order_type: string | null
  ar_sent_at: string | null
}

type LineRow = {
  id: string
  ordre: number
  quantite: number
  commande_ligne_id: number | null
  quantite_commandee: number | null
  quantite_expediee: number | null
  quantite_restante: number | null
}

type AllocationRow = {
  id: string
  bon_livraison_ligne_id: string
  line_order: number
  line_quantity: number
  article_id: string
  lot_id: string | null
  lot_article_id: string | null
  lot_status: string | null
  magasin_id: string | null
  stock_scope: "OLD" | "NEW" | null
  emplacement_id: number | null
  location_id: string | null
  stock_level_id: string | null
  stock_batch_id: string | null
  reservation_id: string | null
  reservation_status: string | null
  reservation_quantity: number | null
  stock_movement_line_id: string | null
  quantite: number
  unite: string | null
  qty_on_hand: number | null
  qty_reserved: number | null
  qty_depreciated: number | null
  pick_confirmed: boolean
}

type ShipmentSnapshot = {
  header: HeaderRow
  lines: LineRow[]
  allocations: AllocationRow[]
  document_pack: ShipmentPreviewPack | null
}

type AllocationGroup = {
  key: string
  article_id: string
  stock_level_id: string
  stock_batch_id: string | null
  lot_id: string | null
  magasin_id: string
  stock_scope: "OLD" | "NEW" | null
  emplacement_id: number
  unite: string | null
  quantity: number
  own_reserved: number
  allocations: AllocationRow[]
}

const EPSILON = 1e-9

async function loadShipmentSnapshot(
  client: Queryable,
  bonLivraisonId: string,
  forUpdate = false
): Promise<ShipmentSnapshot | null> {
  const header = await client.query<HeaderRow>(
    `
      SELECT
        delivery.id::text AS id,
        delivery.numero,
        delivery.statut,
        delivery.row_version::int AS row_version,
        delivery.commande_id::text AS commande_id,
        delivery.affaire_id::text AS affaire_id,
        command.order_type,
        command.ar_sent_at::text AS ar_sent_at
      FROM public.bon_livraison delivery
      LEFT JOIN public.commande_client command ON command.id = delivery.commande_id
      WHERE delivery.id = $1::uuid
      ${forUpdate ? "FOR UPDATE OF delivery" : ""}
    `,
    [bonLivraisonId]
  )
  const row = header.rows[0] ?? null
  if (!row) return null

  const lines = await client.query<LineRow>(
    `
      SELECT
        line.id::text AS id,
        line.ordre,
        line.quantite::float8 AS quantite,
        line.commande_ligne_id,
        remainder.quantite_commandee::float8 AS quantite_commandee,
        remainder.quantite_expediee::float8 AS quantite_expediee,
        remainder.quantite_restante::float8 AS quantite_restante
      FROM public.bon_livraison_ligne line
      LEFT JOIN public.v_bon_livraison_reliquats_226 remainder
        ON remainder.commande_ligne_id = line.commande_ligne_id
      WHERE line.bon_livraison_id = $1::uuid
      ORDER BY line.ordre, line.id
      ${forUpdate ? "FOR UPDATE OF line" : ""}
    `,
    [bonLivraisonId]
  )

  const allocations = await client.query<AllocationRow>(
    `
      SELECT
        allocation.id::text AS id,
        allocation.bon_livraison_ligne_id::text AS bon_livraison_ligne_id,
        line.ordre AS line_order,
        line.quantite::float8 AS line_quantity,
        allocation.article_id::text AS article_id,
        allocation.lot_id::text AS lot_id,
        lot.article_id::text AS lot_article_id,
        lot.lot_status,
        allocation.magasin_id::text AS magasin_id,
        magasin.stock_scope::text AS stock_scope,
        allocation.emplacement_id::int AS emplacement_id,
        allocation.location_id::text AS location_id,
        allocation.stock_level_id::text AS stock_level_id,
        allocation.stock_batch_id::text AS stock_batch_id,
        allocation.reservation_id::text AS reservation_id,
        reservation.status AS reservation_status,
        reservation.qty_reserved::float8 AS reservation_quantity,
        allocation.stock_movement_line_id::text AS stock_movement_line_id,
        allocation.quantite::float8 AS quantite,
        allocation.unite,
        level.qty_total::float8 AS qty_on_hand,
        level.qty_reserved::float8 AS qty_reserved,
        level.qty_depreciated::float8 AS qty_depreciated,
        COALESCE(latest_pick.event_type = 'PICK_CONFIRMED', false) AS pick_confirmed
      FROM public.bon_livraison_ligne_allocations allocation
      JOIN public.bon_livraison_ligne line
        ON line.id = allocation.bon_livraison_ligne_id
      LEFT JOIN public.lots lot ON lot.id = allocation.lot_id
      LEFT JOIN public.stock_levels level ON level.id = allocation.stock_level_id
      LEFT JOIN public.magasins magasin ON magasin.id = allocation.magasin_id
      LEFT JOIN public.stock_reservations reservation ON reservation.id = allocation.reservation_id
      LEFT JOIN LATERAL (
        SELECT event.event_type
        FROM public.bon_livraison_event_log event
        WHERE event.bon_livraison_id = line.bon_livraison_id
          AND event.event_type IN ('PICK_CONFIRMED', 'PICK_RESET')
          AND event.new_values->>'allocation_id' = allocation.id::text
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT 1
      ) latest_pick ON TRUE
      WHERE line.bon_livraison_id = $1::uuid
      ORDER BY line.ordre, allocation.id
      ${forUpdate ? "FOR UPDATE OF allocation" : ""}
    `,
    [bonLivraisonId]
  )

  const pack = await client.query<ShipmentPreviewPack>(
    `
      SELECT
        id::text AS version_id,
        version,
        checksum_sha256,
        quality_release_state,
        quality_release_preview_sha256,
        quality_policy_sha256
      FROM public.bon_livraison_pack_versions
      WHERE bon_livraison_id = $1::uuid
        AND status = 'GENERATED'
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT 1
    `,
    [bonLivraisonId]
  )

  return {
    header: row,
    lines: lines.rows,
    allocations: allocations.rows,
    document_pack: pack.rows[0] ?? null,
  }
}

function buildGroups(rows: AllocationRow[]): AllocationGroup[] {
  const groups = new Map<string, AllocationGroup>()
  for (const row of rows) {
    if (
      !row.magasin_id ||
      !row.emplacement_id ||
      !row.location_id ||
      !row.stock_level_id
    ) {
      continue
    }
    const key = `${row.article_id}:${row.stock_level_id}:${row.stock_batch_id ?? "-"}:${row.stock_scope ?? "UNKNOWN"}`
    const current = groups.get(key) ?? {
      key,
      article_id: row.article_id,
      stock_level_id: row.stock_level_id,
      stock_batch_id: row.stock_batch_id,
      lot_id: row.lot_id,
      magasin_id: row.magasin_id,
      stock_scope: row.stock_scope,
      emplacement_id: row.emplacement_id,
      unite: row.unite,
      quantity: 0,
      own_reserved: 0,
      allocations: [],
    }
    current.quantity += row.quantite
    current.own_reserved += row.reservation_status === "ACTIVE"
      ? Number(row.reservation_quantity ?? 0)
      : 0
    current.allocations.push(row)
    groups.set(key, current)
  }
  return [...groups.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function buildPreview(
  snapshot: ShipmentSnapshot,
  qualityRelease: DeliveryQualityRelease | null = null,
  enforceQuality = false,
  enforcePicking = false,
  enforceAcknowledgement = false
): BonLivraisonShipmentPreview {
  const blockers: ShipmentPreviewBlocker[] = []
  const byLine = new Map<string, AllocationRow[]>()
  for (const allocation of snapshot.allocations) {
    const rows = byLine.get(allocation.bon_livraison_ligne_id) ?? []
    rows.push(allocation)
    byLine.set(allocation.bon_livraison_ligne_id, rows)
  }

  if (snapshot.header.statut !== "READY") {
    blockers.push({
      code: "SHIPMENT_NOT_READY",
      message: "Le bon de livraison doit être au statut READY avant expédition.",
    })
  }
  if (
    enforceAcknowledgement &&
    snapshot.header.commande_id !== null &&
    String(snapshot.header.order_type ?? "").toUpperCase() !== "INTERNE" &&
    !snapshot.header.ar_sent_at
  ) {
    blockers.push({
      code: "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED",
      message: "L’AR client doit être envoyé avant la livraison et la sortie physique du stock.",
    })
  }
  if (!snapshot.lines.length) {
    blockers.push({ code: "LINES_REQUIRED", message: "Le bon de livraison ne contient aucune ligne." })
  }
  if (!snapshot.document_pack) {
    blockers.push({
      code: "DOCUMENT_PACK_REQUIRED",
      message: "Un pack documentaire figé doit être généré avant l’expédition.",
    })
  }
  if (enforceQuality) {
    if (!qualityRelease || (qualityRelease.state !== "READY" && qualityRelease.state !== "DEROGATED")) {
      const qualityReasons = qualityRelease?.reasons ?? []
      if (qualityReasons.length) {
        for (const reason of qualityReasons) {
          blockers.push({ code: reason.code, message: reason.message })
        }
      } else {
        blockers.push({
          code: "QUALITY_RELEASE_UNKNOWN",
          message: "La décision Qualité canonique est indisponible.",
        })
      }
    }
    if (
      snapshot.document_pack &&
      (!qualityRelease ||
        !snapshot.document_pack.quality_release_preview_sha256 ||
        snapshot.document_pack.quality_release_preview_sha256 !== qualityRelease.preview_sha256 ||
        snapshot.document_pack.quality_release_state !== qualityRelease.state ||
        snapshot.document_pack.quality_policy_sha256 !== qualityRelease.policy?.rules_sha256)
    ) {
      blockers.push({
        code: "DOCUMENT_PACK_QUALITY_STALE",
        message: "Le pack documentaire ne correspond plus à l'état Qualité courant et doit être régénéré.",
      })
    }
  }

  for (const line of snapshot.lines) {
    const allocations = byLine.get(line.id) ?? []
    if (!allocations.length) {
      blockers.push({
        code: "ALLOCATIONS_REQUIRED",
        message: `La ligne ${line.ordre} ne possède aucune allocation.`,
        line_id: line.id,
      })
      continue
    }
    const allocated = allocations.reduce((sum, allocation) => sum + allocation.quantite, 0)
    if (!deliveryQuantitiesMatch(line.quantite, allocated)) {
      blockers.push({
        code: "ALLOCATION_QUANTITY_MISMATCH",
        message: `La ligne ${line.ordre} doit être allouée exactement à hauteur de ${line.quantite}.`,
        line_id: line.id,
      })
    }
  }

  const previewAllocations: ShipmentPreviewAllocation[] = []
  for (const allocation of snapshot.allocations) {
    if (
      !allocation.magasin_id ||
      !allocation.emplacement_id ||
      !allocation.location_id ||
      !allocation.stock_level_id
    ) {
      blockers.push({
        code: "ALLOCATION_SOURCE_REQUIRED",
        message: "Une allocation ne possède pas de source magasin/emplacement complète.",
        allocation_id: allocation.id,
        line_id: allocation.bon_livraison_ligne_id,
      })
      continue
    }
    if (allocation.lot_id && allocation.lot_article_id !== allocation.article_id) {
      blockers.push({
        code: "LOT_ARTICLE_MISMATCH",
        message: "Le lot alloué ne correspond pas à l’article.",
        allocation_id: allocation.id,
      })
    }
    if (!deliveryLotIsConsumable(allocation.lot_id, allocation.lot_status)) {
      blockers.push({
        code: "LOT_NOT_RELEASED",
        message: `Le lot alloué n’est pas libéré (${allocation.lot_status ?? "statut inconnu"}).`,
        allocation_id: allocation.id,
      })
    }
    if (allocation.lot_id && !allocation.stock_batch_id) {
      blockers.push({
        code: "STOCK_BATCH_MISSING",
        message: "Le lot ne possède pas de batch de stock sur l’emplacement alloué.",
        allocation_id: allocation.id,
      })
    }
    if (!allocation.reservation_id || allocation.reservation_status !== "ACTIVE") {
      blockers.push({
        code: "ACTIVE_RESERVATION_REQUIRED",
        message: "L’allocation doit être couverte par une réservation active.",
        allocation_id: allocation.id,
      })
    }
    if (
      allocation.reservation_quantity !== null &&
      Math.abs(allocation.reservation_quantity - allocation.quantite) > EPSILON
    ) {
      blockers.push({
        code: "RESERVATION_QUANTITY_MISMATCH",
        message: "La réservation ne couvre pas exactement la quantité allouée.",
        allocation_id: allocation.id,
      })
    }
    if (allocation.stock_movement_line_id) {
      blockers.push({
        code: "ALLOCATION_ALREADY_SHIPPED",
        message: "L’allocation est déjà liée à une sortie de stock.",
        allocation_id: allocation.id,
      })
    }
    if (enforcePicking && !allocation.pick_confirmed) {
      blockers.push({
        code: "PREPARATION_CONFIRMATION_REQUIRED",
        message: "Le prélèvement physique de cette allocation doit être validé avant expédition.",
        allocation_id: allocation.id,
        line_id: allocation.bon_livraison_ligne_id,
      })
    }

    const available = deliveryQuantityAvailable({
      qty_on_hand: Number(allocation.qty_on_hand ?? 0),
      qty_reserved: Number(allocation.qty_reserved ?? 0),
      qty_depreciated: Number(allocation.qty_depreciated ?? 0),
      own_reservation:
        allocation.reservation_status === "ACTIVE"
          ? Number(allocation.reservation_quantity ?? 0)
          : 0,
    })
    if (available + EPSILON < allocation.quantite) {
      blockers.push({
        code: "INSUFFICIENT_STOCK",
        message: "Le disponible, réservation de ce BL incluse, est insuffisant.",
        allocation_id: allocation.id,
      })
    }

    previewAllocations.push({
      allocation_id: allocation.id,
      line_id: allocation.bon_livraison_ligne_id,
      line_order: allocation.line_order,
      article_id: allocation.article_id,
      lot_id: allocation.lot_id,
      magasin_id: allocation.magasin_id,
      emplacement_id: allocation.emplacement_id,
      location_id: allocation.location_id,
      stock_level_id: allocation.stock_level_id,
      stock_batch_id: allocation.stock_batch_id,
      reservation_id: allocation.reservation_id,
      quantity: allocation.quantite,
      unit: allocation.unite,
      quantity_available: Math.max(available, 0),
    })
  }

  const hashPayload = {
    bon_livraison_id: snapshot.header.id,
    status: snapshot.header.statut,
    row_version: snapshot.header.row_version,
    allocations: previewAllocations.map((allocation) => ({
      allocation_id: allocation.allocation_id,
      article_id: allocation.article_id,
      lot_id: allocation.lot_id,
      stock_level_id: allocation.stock_level_id,
      stock_batch_id: allocation.stock_batch_id,
      reservation_id: allocation.reservation_id,
      quantity: allocation.quantity,
      quantity_available: allocation.quantity_available,
      pick_confirmed: snapshot.allocations.find(
        (row) => row.id === allocation.allocation_id
      )?.pick_confirmed ?? false,
    })),
    blockers: blockers.map((blocker) => blocker.code).sort(),
    document_pack: snapshot.document_pack,
    quality_release: qualityRelease
      ? { state: qualityRelease.state, preview_sha256: qualityRelease.preview_sha256 }
      : null,
  }

  const reliquats = snapshot.lines.map((line) => ({
    line_id: line.id,
    commande_ligne_id: line.commande_ligne_id,
    quantity_ordered: line.quantite_commandee,
    quantity_already_shipped: line.quantite_expediee,
    quantity_remaining_before_shipment: line.quantite_restante,
    quantity_in_shipment: line.quantite,
    quantity_remaining_after_shipment:
      line.quantite_restante === null
        ? null
        : Math.max(line.quantite_restante - line.quantite, 0),
  }))
  const simulatedMovements = buildGroups(snapshot.allocations).map((group) => ({
    movement_type: "OUT" as const,
    article_id: group.article_id,
    lot_id: group.lot_id,
    magasin_id: group.magasin_id,
    emplacement_id: group.emplacement_id,
    stock_level_id: group.stock_level_id,
    stock_batch_id: group.stock_batch_id,
    quantity: group.quantity,
    unit: group.unite,
  }))

  return {
    bon_livraison_id: snapshot.header.id,
    numero: snapshot.header.numero,
    status: snapshot.header.statut,
    row_version: snapshot.header.row_version,
    preview_hash: hashStockCommand("DELIVERY_SHIPMENT_PREVIEW", hashPayload),
    can_ship: blockers.length === 0,
    blockers,
    allocations: previewAllocations,
    reliquats,
    simulated_movements: simulatedMovements,
    document_pack: snapshot.document_pack,
    quality_release: qualityRelease,
    totals: {
      lines: snapshot.lines.length,
      allocations: snapshot.allocations.length,
      quantity: snapshot.lines.reduce((sum, line) => sum + line.quantite, 0),
    },
  }
}

async function insertLivraisonEvent(
  client: Queryable,
  args: {
    bon_livraison_id: string
    event_type: string
    user_id: number
    old_values?: unknown
    new_values?: unknown
  }
) {
  const inserted = await client.query<{ id: string; created_at: string }>(
    `
      INSERT INTO public.bon_livraison_event_log (
        bon_livraison_id, event_type, old_values, new_values, user_id
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5)
      RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      args.bon_livraison_id,
      args.event_type,
      args.old_values === undefined ? null : JSON.stringify(args.old_values),
      args.new_values === undefined ? null : JSON.stringify(args.new_values),
      args.user_id,
    ]
  )
  const event = inserted.rows[0]
  if (!event) throw new Error("Failed to persist livraison event")
  await enqueueEntityChanged(client, {
    entityType: "BON_LIVRAISON",
    entityId: args.bon_livraison_id,
    action: args.event_type.includes("STATUS") || args.event_type.includes("PREPARATION") || args.event_type.includes("SHIPMENT")
      ? "status_changed"
      : "updated",
    module: "livraisons",
    at: event.created_at,
    invalidateKeys: ["livraisons:list", `livraisons:detail:${args.bon_livraison_id}`],
  }, { deduplicationKey: `livraison-event:${event.id}` })
}

async function insertMovementEvent(
  client: Queryable,
  args: {
    movement_id: string
    event_type: "CREATED" | "POSTED"
    old_values: unknown
    new_values: unknown
    user_id: number
    correlation_id: string
  }
) {
  await client.query(
    `
      INSERT INTO public.stock_movement_event_log (
        stock_movement_id, event_type, old_values, new_values, user_id, correlation_id
      )
      VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5,$6::uuid)
    `,
    [
      args.movement_id,
      args.event_type,
      JSON.stringify(args.old_values),
      JSON.stringify(args.new_values),
      args.user_id,
      args.correlation_id,
    ]
  )
}

async function reserveMovementNumber(client: Queryable): Promise<string> {
  const result = await client.query<{ value: string }>(
    `SELECT nextval('public.stock_movement_no_seq')::text AS value`
  )
  const numeric = Number(result.rows[0]?.value)
  if (!Number.isFinite(numeric)) throw new Error("Failed to reserve stock movement number")
  return `SM-${String(numeric).padStart(8, "0")}`
}

function adjustedForOwnReservation(
  state: LockedStockState,
  ownReserved: number
): LockedStockState {
  return {
    ...state,
    qty_reserved: Math.max(state.qty_reserved - ownReserved, 0),
  }
}

export async function repoGetLivraisonShipmentPreview(
  bonLivraisonId: string
): Promise<BonLivraisonShipmentPreview | null> {
  const snapshot = await loadShipmentSnapshot(pool, bonLivraisonId)
  if (!snapshot) return null
  const qualityRelease = await repoGetDeliveryQualityRelease(bonLivraisonId)
  return buildPreview(snapshot, qualityRelease, true, true, true)
}

export async function prepareLivraisonInTransaction(
  client: PoolClient,
  bonLivraisonId: string,
  userId: number
): Promise<void> {
  const snapshot = await loadShipmentSnapshot(client, bonLivraisonId, true)
  if (!snapshot) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  if (snapshot.header.statut === "READY") return
  if (snapshot.header.statut !== "DRAFT") {
    throw new HttpError(409, "INVALID_TRANSITION", "Only a DRAFT delivery can be prepared")
  }

  const draftPreview = buildPreview({
    ...snapshot,
    header: { ...snapshot.header, statut: "READY" },
    allocations: snapshot.allocations.map((allocation) => ({
      ...allocation,
      reservation_id: allocation.reservation_id ?? crypto.randomUUID(),
      reservation_status: allocation.reservation_id
        ? allocation.reservation_status
        : "ACTIVE",
      reservation_quantity: allocation.reservation_id
        ? allocation.reservation_quantity
        : allocation.quantite,
    })),
  })
  const relevantBlockers = draftPreview.blockers.filter(
    (blocker) =>
      blocker.code !== "ACTIVE_RESERVATION_REQUIRED" &&
      blocker.code !== "DOCUMENT_PACK_REQUIRED"
  )
  if (relevantBlockers.length) {
    throw new HttpError(
      409,
      "DELIVERY_PREPARATION_BLOCKED",
      "La préparation est bloquée par des allocations incomplètes ou non disponibles.",
      { blockers: relevantBlockers }
    )
  }

  const allocationsToReserve = snapshot.allocations.filter(
    (allocation) =>
      !allocation.reservation_id || allocation.reservation_status !== "ACTIVE"
  )
  const groups = buildGroups(allocationsToReserve)
  const targets: StockLockTarget[] = groups.map((group) => ({
    stock_level_id: group.stock_level_id,
    stock_batch_id: group.stock_batch_id,
  }))
  // Keep a single global lock order across all reservation writers: Quality
  // entitlement first, then stock state. This prevents a delivery preparation
  // racing a generic reservation from deadlocking on opposite lock order.
  for (const group of groups) {
    // Les allocations OLD sont des reprises historiques : elles restent
    // réservées et auditées, sans exiger un contrôle Qualité CERP inexistant.
    // Toute allocation NEW (ou de portée inconnue) reste fail-closed.
    if (group.stock_scope !== "OLD" && group.lot_id) {
      await assertOperationalLotQualityEligibility({
        client,
        lotId: group.lot_id,
        qty: group.quantity,
        unit: group.unite,
        purpose: "RESERVE",
      })
    }
  }
  const states = await lockStockStates(client, targets)
  for (const group of groups) {
    const state = states.get(stockTargetKey(group))
    if (!state) throw new Error("Locked stock state missing during delivery preparation")
    assertStockConsumptionAllowed(state, { movement_type: "RESERVE", qty: group.quantity })
  }

  const correlationId = crypto.randomUUID()
  for (const group of groups) {
    await client.query(
      `
        UPDATE public.stock_levels
        SET qty_reserved = qty_reserved + $2,
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [group.stock_level_id, group.quantity, userId]
    )
    if (group.stock_batch_id) {
      await client.query(
        `UPDATE public.stock_batches SET qty_reserved = qty_reserved + $2 WHERE id = $1::uuid`,
        [group.stock_batch_id, group.quantity]
      )
    }

    for (const allocation of group.allocations) {
      const reservation = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_reservations (
            article_id,
            location_id,
            lot_id,
            stock_batch_id,
            qty_reserved,
            source_type,
            source_id,
            commande_ligne_id,
            bon_livraison_ligne_id,
            affaire_id,
            status,
            reason,
            correlation_id,
            created_by,
            updated_by
          )
          SELECT
            $1::uuid,
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            'BON_LIVRAISON_LIGNE',
            line.id::text,
            line.commande_ligne_id,
            line.id,
            delivery.affaire_id,
            'ACTIVE',
            'Préparation du bon de livraison ' || delivery.numero,
            $7::uuid,
            $8,
            $8
          FROM public.bon_livraison_ligne line
          JOIN public.bon_livraison delivery ON delivery.id = line.bon_livraison_id
          WHERE line.id = $6::uuid
            AND delivery.id = $9::uuid
          RETURNING id::text AS id
        `,
        [
          allocation.article_id,
          allocation.location_id,
          allocation.lot_id,
          allocation.stock_batch_id,
          allocation.quantite,
          allocation.bon_livraison_ligne_id,
          correlationId,
          userId,
          bonLivraisonId,
        ]
      )
      const reservationId = reservation.rows[0]?.id
      if (!reservationId) throw new Error("Failed to create delivery stock reservation")
      await client.query(
        `
          UPDATE public.bon_livraison_ligne_allocations
          SET reservation_id = $2::uuid,
              updated_at = now(),
              updated_by = $3
          WHERE id = $1::uuid
        `,
        [allocation.id, reservationId, userId]
      )
    }
  }

  await client.query(
    `
      UPDATE public.stock_reservations reservation
      SET source_type = 'BON_LIVRAISON_LIGNE',
          source_id = allocation.bon_livraison_ligne_id::text,
          commande_ligne_id = line.commande_ligne_id,
          bon_livraison_ligne_id = allocation.bon_livraison_ligne_id,
          affaire_id = delivery.affaire_id,
          reason = 'Préparation du bon de livraison ' || delivery.numero,
          correlation_id = COALESCE(reservation.correlation_id, $2::uuid),
          updated_at = now(),
          updated_by = $3
      FROM public.bon_livraison_ligne_allocations allocation
      JOIN public.bon_livraison_ligne line
        ON line.id = allocation.bon_livraison_ligne_id
      JOIN public.bon_livraison delivery
        ON delivery.id = line.bon_livraison_id
      WHERE delivery.id = $1::uuid
        AND allocation.reservation_id = reservation.id
        AND reservation.status = 'ACTIVE'
    `,
    [bonLivraisonId, correlationId, userId]
  )

  await client.query(
    `
      UPDATE public.bon_livraison
      SET statut = 'READY',
          updated_at = now(),
          updated_by = $2
      WHERE id = $1::uuid
    `,
    [bonLivraisonId, userId]
  )
  await insertLivraisonEvent(client, {
    bon_livraison_id: bonLivraisonId,
    event_type: "PREPARATION_READY",
    user_id: userId,
    old_values: { statut: "DRAFT" },
    new_values: {
      statut: "READY",
      reservations_count: snapshot.allocations.length,
      reservations_reused: snapshot.allocations.length - allocationsToReserve.length,
      old_quality_bypass_allocations: allocationsToReserve.filter((allocation) => allocation.stock_scope === "OLD").length,
      correlation_id: correlationId,
    },
  })
}

export async function releaseLivraisonReservationsInTransaction(
  client: PoolClient,
  bonLivraisonId: string,
  userId: number,
  reason: string
): Promise<void> {
  const reservations = await client.query<{
    id: string
    stock_level_id: string
    stock_batch_id: string | null
    qty_reserved: number
  }>(
    `
      WITH target_reservation_ids AS (
        SELECT reservation.id
        FROM public.stock_reservations reservation
        JOIN public.bon_livraison_ligne line
          ON line.id = reservation.bon_livraison_ligne_id
        WHERE line.bon_livraison_id = $1::uuid
          AND reservation.status = 'ACTIVE'

        UNION

        SELECT reservation.id
        FROM public.bon_livraison_ligne_allocations allocation
        JOIN public.bon_livraison_ligne line
          ON line.id = allocation.bon_livraison_ligne_id
        JOIN public.stock_reservations reservation
          ON reservation.id = allocation.reservation_id
        WHERE line.bon_livraison_id = $1::uuid
          AND reservation.status = 'ACTIVE'
      )
      SELECT
        reservation.id::text AS id,
        level.id::text AS stock_level_id,
        reservation.stock_batch_id::text AS stock_batch_id,
        reservation.qty_reserved::float8 AS qty_reserved
      FROM target_reservation_ids target
      JOIN public.stock_reservations reservation ON reservation.id = target.id
      JOIN public.stock_levels level
        ON level.article_id = reservation.article_id
       AND level.location_id = reservation.location_id
      WHERE reservation.status = 'ACTIVE'
      ORDER BY level.id, reservation.stock_batch_id, reservation.id
      FOR UPDATE OF reservation
    `,
    [bonLivraisonId]
  )
  const reservationsById = new Map<string, (typeof reservations.rows)[number]>()
  for (const reservation of reservations.rows) {
    const existing = reservationsById.get(reservation.id)
    if (existing) {
      if (
        existing.stock_level_id !== reservation.stock_level_id ||
        existing.stock_batch_id !== reservation.stock_batch_id ||
        existing.qty_reserved !== reservation.qty_reserved
      ) {
        throw new Error("Conflicting stock targets for delivery reservation")
      }
      continue
    }
    reservationsById.set(reservation.id, reservation)
  }
  const targetReservations = [...reservationsById.values()]
  if (!targetReservations.length) return

  const grouped = new Map<string, { level: string; batch: string | null; qty: number }>()
  for (const reservation of targetReservations) {
    const key = `${reservation.stock_level_id}:${reservation.stock_batch_id ?? "-"}`
    const current = grouped.get(key) ?? {
      level: reservation.stock_level_id,
      batch: reservation.stock_batch_id,
      qty: 0,
    }
    current.qty += reservation.qty_reserved
    grouped.set(key, current)
  }
  const groups = [...grouped.values()].sort((left, right) =>
    `${left.level}:${left.batch ?? "-"}`.localeCompare(`${right.level}:${right.batch ?? "-"}`)
  )
  const states = await lockStockStates(
    client,
    groups.map((group) => ({ stock_level_id: group.level, stock_batch_id: group.batch }))
  )
  for (const group of groups) {
    const state = states.get(stockTargetKey({ stock_level_id: group.level, stock_batch_id: group.batch }))
    if (!state) throw new Error("Locked stock state missing while releasing delivery")
    assertStockConsumptionAllowed(state, { movement_type: "UNRESERVE", qty: group.qty })
    await client.query(
      `
        UPDATE public.stock_levels
        SET qty_reserved = qty_reserved - $2,
            updated_at = now(),
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [group.level, group.qty, userId]
    )
    if (group.batch) {
      await client.query(
        `UPDATE public.stock_batches SET qty_reserved = qty_reserved - $2 WHERE id = $1::uuid`,
        [group.batch, group.qty]
      )
    }
  }
  const released = await client.query(
    `
      UPDATE public.stock_reservations
      SET status = 'RELEASED',
          reason = $2,
          released_at = now(),
          released_by = $3,
          row_version = row_version + 1,
          updated_at = now(),
          updated_by = $3
      WHERE id = ANY($1::uuid[])
        AND status = 'ACTIVE'
    `,
    [targetReservations.map((row) => row.id), reason, userId]
  )
  if ((released.rowCount ?? 0) !== targetReservations.length) {
    throw new Error("Active delivery reservation count changed while releasing stock")
  }
}

export async function repoShipLivraison(
  bonLivraisonId: string,
  body: ShipLivraisonBodyDTO,
  userId: number,
  idempotencyKeyRaw: string
): Promise<BonLivraisonShipResult> {
  const client = await pool.connect()
  return withRealtimeOutboxTransaction(client, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
    const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyRaw)
    const requestPayload = { bon_livraison_id: bonLivraisonId, ...body }
    const requestHash = hashStockCommand("DELIVERY_SHIP", requestPayload)
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`delivery:${userId}:${idempotencyKey}`]
    )
    const existing = await client.query<{
      request_hash: string
      result_payload: BonLivraisonShipResult
    }>(
      `
        SELECT request_hash, result_payload
        FROM public.bon_livraison_command_receipts
        WHERE actor_user_id = $1
          AND idempotency_key = $2
        LIMIT 1
      `,
      [userId, idempotencyKey]
    )
    const receipt = existing.rows[0] ?? null
    const receiptDecision = shipmentReceiptDecision(receipt?.request_hash ?? null, requestHash)
    if (receiptDecision === "CONFLICT") {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Cette Idempotency-Key a déjà été utilisée avec une autre confirmation."
      )
    }
    if (receiptDecision === "REPLAY" && receipt) {
      return { ...receipt.result_payload, idempotent_replay: true }
    }

    const snapshot = await loadShipmentSnapshot(client, bonLivraisonId, true)
    if (!snapshot) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    const qualityRelease = await repoGetDeliveryQualityRelease(bonLivraisonId, client)
    const preview = buildPreview(snapshot, qualityRelease, true, true, true)
    if (
      !shipmentConfirmationMatches({
        expectedVersion: body.expected_version,
        actualVersion: preview.row_version,
        expectedPreviewHash: body.preview_hash,
        actualPreviewHash: preview.preview_hash,
      })
    ) {
      if (body.expected_version !== preview.row_version) {
        throw new HttpError(
          409,
          "CONCURRENT_MODIFICATION",
          "Le bon de livraison a changé depuis l’aperçu."
        )
      }
      throw new HttpError(
        409,
        "SHIPMENT_PREVIEW_CHANGED",
        "Les allocations ou le stock ont changé depuis l’aperçu."
      )
    }
    if (!preview.can_ship) {
      throw new HttpError(409, "SHIPMENT_BLOCKED", "L’expédition est bloquée.", {
        blockers: preview.blockers,
      })
    }

    const groups = buildGroups(snapshot.allocations)
    // The signed delivery-release aggregate is the shipping policy gate. Every
    // allocation is already backed by an ACTIVE reservation, so the per-lot
    // gate validates current Quality state without spending that entitlement a
    // second time.
    for (const group of groups) {
      if (group.lot_id) {
        await assertOperationalLotQualityEligibility({
          client,
          lotId: group.lot_id,
          qty: 0,
          unit: group.unite,
          purpose: "RESERVE",
        })
      }
    }
    const states = await lockStockStates(
      client,
      groups.map((group) => ({
        stock_level_id: group.stock_level_id,
        stock_batch_id: group.stock_batch_id,
      }))
    )
    for (const group of groups) {
      const state = states.get(stockTargetKey(group))
      if (!state) throw new Error("Locked stock state missing during shipment")
      assertStockConsumptionAllowed(adjustedForOwnReservation(state, group.own_reserved), {
        movement_type: "OUT",
        qty: group.quantity,
      })
    }

    const correlationId = crypto.randomUUID()
    const movementIds: string[] = []
    for (const group of groups) {
      const movementNumber = await reserveMovementNumber(client)
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO public.stock_movements (
            movement_no,
            movement_type,
            status,
            article_id,
            stock_level_id,
            stock_batch_id,
            qty,
            currency,
            effective_at,
            source_document_type,
            source_document_id,
            reason_code,
            notes,
            idempotency_key,
            correlation_id,
            user_id,
            created_by,
            updated_by
          )
          VALUES (
            $1,
            'OUT'::public.movement_type,
            'DRAFT',
            $2::uuid,
            $3::uuid,
            $4::uuid,
            $5,
            'EUR',
            now(),
            'BON_LIVRAISON',
            $6,
            'BON_LIVRAISON_SHIPMENT',
            $7,
            $8,
            $9::uuid,
            $10,
            $10,
            $10
          )
          RETURNING id::text AS id
        `,
        [
          movementNumber,
          group.article_id,
          group.stock_level_id,
          group.stock_batch_id,
          group.quantity,
          bonLivraisonId,
          `Expédition BL ${snapshot.header.numero}`,
          `delivery:${bonLivraisonId}:${group.key}`,
          correlationId,
          userId,
        ]
      )
      const movementId = inserted.rows[0]?.id
      if (!movementId) throw new Error("Failed to create delivery stock movement")
      movementIds.push(movementId)
      await insertMovementEvent(client, {
        movement_id: movementId,
        event_type: "CREATED",
        old_values: null,
        new_values: {
          status: "DRAFT",
          movement_type: "OUT",
          source_document_type: "BON_LIVRAISON",
          source_document_id: bonLivraisonId,
        },
        user_id: userId,
        correlation_id: correlationId,
      })

      let lineNumber = 1
      for (const allocation of group.allocations) {
        const movementLine = await client.query<{ id: string }>(
          `
            INSERT INTO public.stock_movement_lines (
              movement_id,
              line_no,
              article_id,
              lot_id,
              qty,
              unite,
              src_magasin_id,
              src_emplacement_id,
              note,
              created_by,
              updated_by
            )
            VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8::bigint,$9,$10,$10)
            RETURNING id::text AS id
          `,
          [
            movementId,
            lineNumber,
            allocation.article_id,
            allocation.lot_id,
            allocation.quantite,
            allocation.unite,
            allocation.magasin_id,
            allocation.emplacement_id,
            `BL ${snapshot.header.numero} — allocation ${allocation.id}`,
            userId,
          ]
        )
        const movementLineId = movementLine.rows[0]?.id
        if (!movementLineId) throw new Error("Failed to create delivery stock movement line")
        await client.query(
          `
            UPDATE public.bon_livraison_ligne_allocations
            SET stock_movement_line_id = $2::uuid,
                updated_at = now(),
                updated_by = $3
            WHERE id = $1::uuid
              AND stock_movement_line_id IS NULL
          `,
          [allocation.id, movementLineId, userId]
        )
        lineNumber += 1
      }

      await client.query(
        `
          UPDATE public.stock_movements
          SET status = 'POSTED',
              posted_at = now(),
              posted_by = $2,
              updated_at = now(),
              updated_by = $2
          WHERE id = $1::uuid
            AND status = 'DRAFT'
        `,
        [movementId, userId]
      )
      await insertMovementEvent(client, {
        movement_id: movementId,
        event_type: "POSTED",
        old_values: { status: "DRAFT" },
        new_values: { status: "POSTED" },
        user_id: userId,
        correlation_id: correlationId,
      })

      await client.query(
        `
          UPDATE public.stock_levels
          SET qty_reserved = qty_reserved - $2,
              updated_at = now(),
              updated_by = $3
          WHERE id = $1::uuid
        `,
        [group.stock_level_id, group.own_reserved, userId]
      )
      if (group.stock_batch_id) {
        await client.query(
          `UPDATE public.stock_batches SET qty_reserved = qty_reserved - $2 WHERE id = $1::uuid`,
          [group.stock_batch_id, group.own_reserved]
        )
      }
      await client.query(
        `
          UPDATE public.stock_reservations
          SET status = 'CONSUMED',
              reason = 'Consommée par expédition du BL ' || $2,
              consumed_at = now(),
              consumed_by = $3,
              consumed_stock_movement_id = $4::uuid,
              correlation_id = $5::uuid,
              updated_at = now(),
              updated_by = $3
          WHERE id = ANY($1::uuid[])
            AND status = 'ACTIVE'
        `,
        [
          group.allocations.map((allocation) => allocation.reservation_id),
          snapshot.header.numero,
          userId,
          movementId,
          correlationId,
        ]
      )
    }

    const updated = await client.query<{ row_version: number }>(
      `
        UPDATE public.bon_livraison
        SET statut = 'SHIPPED',
            date_expedition = COALESCE(date_expedition, CURRENT_DATE),
            updated_at = now(),
            updated_by = $2
        WHERE id = $1::uuid
          AND statut = 'READY'
        RETURNING row_version::int AS row_version
      `,
      [bonLivraisonId, userId]
    )
    const rowVersion = updated.rows[0]?.row_version
    if (!rowVersion) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Le statut du BL a changé pendant l’expédition.")
    }

    // SHIPPED is the legal/operational boundary. Queue exactly one official
    // artifact from the locked, persisted rows before the shipment commits.
    await queueCreationPdfArchive(client, await buildShippedDeliveryArtifactInput(client, {
      deliveryId: bonLivraisonId,
      actorUserId: userId,
      sourceRevision: `${rowVersion}:${correlationId}`,
    }))

    await insertLivraisonEvent(client, {
      bon_livraison_id: bonLivraisonId,
      event_type: "SHIPMENT_VALIDATED",
      user_id: userId,
      old_values: { statut: "READY" },
      new_values: {
        statut: "SHIPPED",
        stock_movement_ids: movementIds,
        document_pack: preview.document_pack,
        quality_release: {
          state: qualityRelease.state,
          preview_sha256: qualityRelease.preview_sha256,
          policy: qualityRelease.policy,
          derogation_ids: qualityRelease.derogation_ids,
        },
        correlation_id: correlationId,
        invoice_created: false,
        commentaire: body.commentaire ?? null,
      },
    })
    await client.query(
      `
        INSERT INTO public.erp_outbox_events (
          event_key,
          aggregate_type,
          aggregate_id,
          event_type,
          payload,
          correlation_id
        )
        VALUES ($1,'BON_LIVRAISON',$2,'DELIVERY.SHIPPED',$3::jsonb,$4::uuid)
        ON CONFLICT (event_key) DO NOTHING
      `,
      [
        `delivery.shipped:${bonLivraisonId}`,
        bonLivraisonId,
        JSON.stringify({
          bon_livraison_id: bonLivraisonId,
          numero: snapshot.header.numero,
          commande_id: snapshot.header.commande_id,
          affaire_id: snapshot.header.affaire_id,
          stock_movement_ids: movementIds,
          document_pack: preview.document_pack,
          quality_release: {
            state: qualityRelease.state,
            preview_sha256: qualityRelease.preview_sha256,
            policy: qualityRelease.policy,
            derogation_ids: qualityRelease.derogation_ids,
          },
          ...shipmentBillingBoundary(),
        }),
        correlationId,
      ]
    )
    await repoInsertAuditLog({
      user_id: userId,
      body: {
        event_type: "ACTION",
        action: "livraisons.shipped",
        page_key: "livraisons",
        entity_type: "bon_livraison",
        entity_id: bonLivraisonId,
        path: `/api/v1/livraisons/${bonLivraisonId}/ship`,
        client_session_id: null,
        details: {
          bon_livraison_numero: snapshot.header.numero,
          stock_movement_ids: movementIds,
          correlation_id: correlationId,
          invoice_created: false,
          quality_release_state: qualityRelease.state,
          quality_release_preview_sha256: qualityRelease.preview_sha256,
          quality_policy_id: qualityRelease.policy?.id ?? null,
          quality_policy_sha256: qualityRelease.policy?.rules_sha256 ?? null,
          quality_derogation_ids: qualityRelease.derogation_ids,
        },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx: client,
    })

    const commandeId = snapshot.header.commande_id === null
      ? null
      : Number(snapshot.header.commande_id)
    if (commandeId !== null && Number.isInteger(commandeId)) {
      await syncCommandeAfterShipment(client, commandeId, userId)
    }

    const result: BonLivraisonShipResult = {
      id: bonLivraisonId,
      statut: "SHIPPED",
      row_version: rowVersion,
      stock_movement_ids: movementIds,
      correlation_id: correlationId,
      idempotent_replay: false,
      billing_event: "DELIVERY.SHIPPED",
      invoice_created: false,
    }
    await client.query(
      `
        INSERT INTO public.bon_livraison_command_receipts (
          actor_user_id,
          idempotency_key,
          request_hash,
          command_type,
          bon_livraison_id,
          request_payload,
          result_payload,
          correlation_id
        )
        VALUES ($1,$2,$3,'SHIP',$4::uuid,$5::jsonb,$6::jsonb,$7::uuid)
      `,
      [
        userId,
        idempotencyKey,
        requestHash,
        bonLivraisonId,
        JSON.stringify(requestPayload),
        JSON.stringify(result),
        correlationId,
      ]
    )
    return result
  })
}

export async function repoListLivraisonProofs(
  bonLivraisonId: string,
  queryable: Queryable = pool
): Promise<BonLivraisonDeliveryProof[]> {
  const result = await queryable.query<BonLivraisonDeliveryProof>(
    `
      SELECT
        proof.id::text AS id,
        proof.bon_livraison_id::text AS bon_livraison_id,
        proof.proof_type,
        proof.delivered_at::text AS delivered_at,
        proof.received_by_name,
        proof.document_id::text AS document_id,
        document.document_name,
        proof.note,
        proof.correlation_id::text AS correlation_id,
        CASE
          WHEN actor.id IS NULL THEN NULL
          ELSE json_build_object(
            'id', actor.id,
            'username', actor.username,
            'name', actor.name,
            'surname', actor.surname,
            'label', trim(concat_ws(' ', actor.name, actor.surname, actor.username))
          )
        END AS created_by,
        proof.created_at::text AS created_at
      FROM public.bon_livraison_delivery_proofs proof
      LEFT JOIN public.documents_clients document ON document.id = proof.document_id
      LEFT JOIN public.users actor ON actor.id = proof.created_by
      WHERE proof.bon_livraison_id = $1::uuid
      ORDER BY proof.created_at DESC, proof.id DESC
    `,
    [bonLivraisonId]
  )
  return result.rows
}

export async function repoCreateLivraisonProof(
  bonLivraisonId: string,
  body: LivraisonProofBodyDTO,
  userId: number
): Promise<BonLivraisonDeliveryProof> {
  const client = await pool.connect()
  const proofId = await withRealtimeOutboxTransaction(client, async (client) => {
    const delivery = await client.query<{ statut: string }>(
      `SELECT statut FROM public.bon_livraison WHERE id = $1::uuid FOR UPDATE`,
      [bonLivraisonId]
    )
    const row = delivery.rows[0] ?? null
    if (!row) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
    if (row.statut !== "SHIPPED" && row.statut !== "DELIVERED") {
      throw new HttpError(409, "PROOF_NOT_ALLOWED", "Une preuve ne peut être ajoutée qu’après expédition.")
    }
    if (body.document_id) {
      const linked = await client.query<{ ok: number }>(
        `
          SELECT 1::int AS ok
          FROM public.bon_livraison_documents
          WHERE bon_livraison_id = $1::uuid
            AND document_id = $2::uuid
        `,
        [bonLivraisonId, body.document_id]
      )
      if (!linked.rows[0]?.ok) {
        throw new HttpError(
          409,
          "PROOF_DOCUMENT_NOT_LINKED",
          "Le document de preuve doit d’abord être rattaché au bon de livraison."
        )
      }
    }
    const correlationId = crypto.randomUUID()
    const inserted = await client.query<{ id: string }>(
      `
        INSERT INTO public.bon_livraison_delivery_proofs (
          bon_livraison_id,
          proof_type,
          delivered_at,
          received_by_name,
          document_id,
          note,
          correlation_id,
          created_by
        )
        VALUES ($1::uuid,$2,$3::timestamptz,$4,$5::uuid,$6,$7::uuid,$8)
        RETURNING id::text AS id
      `,
      [
        bonLivraisonId,
        body.proof_type,
        body.delivered_at,
        body.received_by_name ?? null,
        body.document_id ?? null,
        body.note ?? null,
        correlationId,
        userId,
      ]
    )
    const proofId = inserted.rows[0]?.id
    if (!proofId) throw new Error("Failed to create delivery proof")
    await insertLivraisonEvent(client, {
      bon_livraison_id: bonLivraisonId,
      event_type: "DELIVERY_PROOF_ADDED",
      user_id: userId,
      new_values: {
        proof_id: proofId,
        proof_type: body.proof_type,
        delivered_at: body.delivered_at,
        document_id: body.document_id ?? null,
        correlation_id: correlationId,
      },
    })
    await repoInsertAuditLog({
      user_id: userId,
      body: {
        event_type: "ACTION",
        action: "livraisons.delivery_proof.added",
        page_key: "livraisons",
        entity_type: "bon_livraison",
        entity_id: bonLivraisonId,
        path: `/api/v1/livraisons/${bonLivraisonId}/proofs`,
        client_session_id: null,
        details: {
          proof_id: proofId,
          proof_type: body.proof_type,
          document_id: body.document_id ?? null,
          correlation_id: correlationId,
        },
      },
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      tx: client,
    })
    return proofId
  })
  const proofs = await repoListLivraisonProofs(bonLivraisonId)
  const proof = proofs.find((item) => item.id === proofId)
  if (!proof) throw new Error("Failed to reload delivery proof")
  return proof
}
