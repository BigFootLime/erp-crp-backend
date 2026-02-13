import { HttpError } from "../../../utils/httpError"

import type { BonLivraisonStatut } from "../types/livraisons.types"
import type {
  CreateLivraisonBodyDTO,
  CreateLivraisonLineBodyDTO,
  ListLivraisonsQueryDTO,
  LivraisonStatusBodyDTO,
  UpdateLivraisonBodyDTO,
  UpdateLivraisonLineBodyDTO,
} from "../validators/livraisons.validators"

import {
  repoAddLivraisonLine,
  repoAttachLivraisonDocuments,
  repoCreateLivraison,
  repoCreateLivraisonFromCommande,
  repoDeleteLivraisonLine,
  repoGetLivraisonDetail,
  repoGetLivraisonStatut,
  repoListLivraisons,
  repoRemoveLivraisonDocument,
  repoUpdateLivraisonHeader,
  repoUpdateLivraisonLine,
  repoUpdateLivraisonStatus,
} from "../repository/livraisons.repository"

function assertEditable(statut: BonLivraisonStatut, action: string) {
  if (statut === "DRAFT" || statut === "READY") return
  throw new HttpError(409, "LOCKED", `${action} is not allowed when statut=${statut}`)
}

function assertAllowedTransition(from: BonLivraisonStatut, to: BonLivraisonStatut) {
  const allowed: Record<BonLivraisonStatut, BonLivraisonStatut[]> = {
    DRAFT: ["READY", "CANCELLED"],
    READY: ["SHIPPED", "CANCELLED"],
    SHIPPED: ["DELIVERED"],
    DELIVERED: [],
    CANCELLED: [],
  }

  if (from === to) return
  if (allowed[from].includes(to)) return
  throw new HttpError(409, "INVALID_TRANSITION", `Invalid transition from ${from} to ${to}`)
}

export async function svcListLivraisons(filters: ListLivraisonsQueryDTO) {
  return repoListLivraisons(filters)
}

export async function svcGetLivraison(id: number) {
  return repoGetLivraisonDetail(id)
}

export async function svcCreateLivraison(dto: CreateLivraisonBodyDTO, userId: number) {
  return repoCreateLivraison(dto, userId)
}

export async function svcCreateLivraisonFromCommande(commandeId: number, userId: number) {
  return repoCreateLivraisonFromCommande(commandeId, userId)
}

export async function svcUpdateLivraisonHeader(id: number, patch: UpdateLivraisonBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return null

  // Allow only reception signature fields when delivered.
  if (statut === "DELIVERED") {
    const keys = Object.keys(patch) as Array<keyof UpdateLivraisonBodyDTO>
    const allowedKeys: Array<keyof UpdateLivraisonBodyDTO> = ["reception_nom_signataire", "reception_date_signature"]
    const forbidden = keys.filter((k) => !allowedKeys.includes(k))
    if (forbidden.length) {
      throw new HttpError(409, "LOCKED", `Only reception fields can be updated when statut=${statut}`)
    }
  } else {
    assertEditable(statut, "Update")
  }

  return repoUpdateLivraisonHeader(id, patch, userId)
}

export async function svcAddLivraisonLine(id: number, dto: CreateLivraisonLineBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  assertEditable(statut, "Add line")
  return repoAddLivraisonLine(id, dto, userId)
}

export async function svcUpdateLivraisonLine(id: number, lineId: number, patch: UpdateLivraisonLineBodyDTO, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return null
  assertEditable(statut, "Update line")
  return repoUpdateLivraisonLine(id, lineId, patch, userId)
}

export async function svcDeleteLivraisonLine(id: number, lineId: number, userId: number) {
  const statut = await repoGetLivraisonStatut(id)
  if (!statut) return false
  assertEditable(statut, "Delete line")
  return repoDeleteLivraisonLine(id, lineId, userId)
}

export async function svcUpdateLivraisonStatus(id: number, body: LivraisonStatusBodyDTO, userId: number) {
  const current = await repoGetLivraisonStatut(id)
  if (!current) throw new HttpError(404, "BON_LIVRAISON_NOT_FOUND", "Bon de livraison not found")
  assertAllowedTransition(current, body.statut)
  return repoUpdateLivraisonStatus(id, body.statut, userId, { commentaire: body.commentaire ?? null })
}

export async function svcAttachLivraisonDocuments(params: {
  bonLivraisonId: number
  documents: Array<{ originalname: string; path: string; mimetype: string }>
  type?: string | null
  userId: number
}) {
  return repoAttachLivraisonDocuments({
    bonLivraisonId: params.bonLivraisonId,
    documents: params.documents,
    type: params.type ?? null,
    userId: params.userId,
  })
}

export async function svcRemoveLivraisonDocument(params: { bonLivraisonId: number; documentId: string; userId: number }) {
  return repoRemoveLivraisonDocument(params)
}
