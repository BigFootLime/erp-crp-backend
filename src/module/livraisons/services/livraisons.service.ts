import { HttpError } from "../../../utils/httpError"

import type { BonLivraisonStatut } from "../types/livraisons.types"
import { isLivraisonTransitionAllowed } from "../domain/livraisons-policy"
import type {
  CreateLivraisonBodyDTO,
  CreateLivraisonAllocationBodyDTO,
  CreateLivraisonLineBodyDTO,
  ListLivraisonsQueryDTO,
  LivraisonStatusBodyDTO,
  LivraisonProofBodyDTO,
  ShipLivraisonBodyDTO,
  UpdateLivraisonBodyDTO,
  UpdateLivraisonLineBodyDTO,
} from "../validators/livraisons.validators"

import {
  repoAddLivraisonLine,
  repoAttachLivraisonDocuments,
  repoCreateLivraison,
  repoCreateLivraisonLineAllocation,
  repoCreateLivraisonFromCommande,
  repoDeleteLivraisonLineAllocation,
  repoDeleteLivraisonLine,
  repoGetLivraisonDetail,
  repoGetLivraisonStatut,
  repoListLivraisons,
  repoRemoveLivraisonDocument,
  repoUpdateLivraisonHeader,
  repoUpdateLivraisonLine,
  repoUpdateLivraisonStatus,
} from "../repository/livraisons.repository"
import {
  repoCreateLivraisonProof,
  repoGetLivraisonShipmentPreview,
  repoShipLivraison,
} from "../repository/livraisons-shipment.repository"

function assertEditable(statut: BonLivraisonStatut, action: string) {
  if (statut === "DRAFT" || statut === "READY") return
  throw new HttpError(409, "LOCKED", `${action} is not allowed when statut=${statut}`)
}

function assertDraft(statut: BonLivraisonStatut, action: string) {
  if (statut === "DRAFT") return
  throw new HttpError(409, "LOCKED", `${action} is only allowed when statut=DRAFT`)
}

function assertAllowedTransition(from: BonLivraisonStatut, to: BonLivraisonStatut) {
  if (isLivraisonTransitionAllowed(from, to)) return
  throw new HttpError(409, "INVALID_TRANSITION", `Invalid transition from ${from} to ${to}`)
}

export async function svcListLivraisons(filters: ListLivraisonsQueryDTO) {
  return repoListLivraisons(filters)
}

export async function svcGetLivraison(id: string) {
  return repoGetLivraisonDetail(id)
}

export async function svcCreateLivraison(dto: CreateLivraisonBodyDTO, userId: number) {
  return repoCreateLivraison(dto, userId)
}

export async function svcCreateLivraisonFromCommande(commandeId: number, userId: number) {
  return repoCreateLivraisonFromCommande(commandeId, userId)
}

export async function svcUpdateLivraisonHeader(id: string, patch: UpdateLivraisonBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return null

  assertEditable(statut, "Update")
  return repoUpdateLivraisonHeader(id, patch, userId)
}

export async function svcAddLivraisonLine(id: string, dto: CreateLivraisonLineBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  assertDraft(statut, "Add line")
  return repoAddLivraisonLine(id, dto, userId)
}

export async function svcUpdateLivraisonLine(id: string, lineId: string, patch: UpdateLivraisonLineBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return null
  assertDraft(statut, "Update line")
  return repoUpdateLivraisonLine(id, lineId, patch, userId)
}

export async function svcDeleteLivraisonLine(id: string, lineId: string, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return false
  assertDraft(statut, "Delete line")
  return repoDeleteLivraisonLine(id, lineId, userId)
}

export async function svcCreateLivraisonLineAllocation(id: string, lineId: string, dto: CreateLivraisonAllocationBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  assertDraft(statut, "Allocate line")
  return repoCreateLivraisonLineAllocation(id, lineId, dto, userId)
}

export async function svcDeleteLivraisonLineAllocation(id: string, lineId: string, allocationId: string, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return false
  assertDraft(statut, "Delete allocation")
  return repoDeleteLivraisonLineAllocation(id, lineId, allocationId, userId)
}

export async function svcUpdateLivraisonStatus(id: string, body: LivraisonStatusBodyDTO, userId: number) {
  const current = await repoGetLivraisonStatut(id)
  if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  assertAllowedTransition(current, body.statut)
  if (
    current === "READY" &&
    body.statut === "CANCELLED" &&
    !body.commentaire?.trim()
  ) {
    throw new HttpError(
      422,
      "CANCELLATION_REASON_REQUIRED",
      "Un motif est obligatoire pour annuler une préparation READY."
    )
  }
  return repoUpdateLivraisonStatus(id, body.statut, userId, { commentaire: body.commentaire ?? null })
}

export async function svcGetLivraisonShipmentPreview(id: string) {
  const preview = await repoGetLivraisonShipmentPreview(id)
  if (!preview) {
    throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  }
  return preview
}

export function svcShipLivraison(
  id: string,
  body: ShipLivraisonBodyDTO,
  userId: number,
  idempotencyKey: string
) {
  return repoShipLivraison(id, body, userId, idempotencyKey)
}

export function svcCreateLivraisonProof(
  id: string,
  body: LivraisonProofBodyDTO,
  userId: number
) {
  return repoCreateLivraisonProof(id, body, userId)
}

export async function svcAttachLivraisonDocuments(params: {
  bonLivraisonId: string
  documents: Array<{ originalname: string; path: string; mimetype: string; size: number }>
  type?: string | null
  userId: number
}) {
  const statut = await repoGetLivraisonStatut(params.bonLivraisonId)
  if (!statut) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  if (statut === "DELIVERED" || statut === "CANCELLED") {
    throw new HttpError(409, "LOCKED", `Document upload is not allowed when statut=${statut}`)
  }
  return repoAttachLivraisonDocuments({
    bonLivraisonId: params.bonLivraisonId,
    documents: params.documents,
    type: params.type ?? null,
    userId: params.userId,
  })
}

export async function svcRemoveLivraisonDocument(params: { bonLivraisonId: string; documentId: string; userId: number }) {
  const statut = await repoGetLivraisonStatut(params.bonLivraisonId)
  if (!statut) return false
  if (statut !== "DRAFT") {
    throw new HttpError(409, "DOCUMENT_IMMUTABLE", "Un document ne peut être retiré qu’au statut DRAFT.")
  }
  return repoRemoveLivraisonDocument(params)
}
