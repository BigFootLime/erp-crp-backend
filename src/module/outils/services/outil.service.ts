import crypto from "node:crypto"
import db from "../../../config/database"
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction"
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"
import { deleteStoredImageFile } from "../../../utils/imageStorage"
import { HttpError } from "../../../utils/httpError"
import { outilRepository } from "../repository/outil.repository"
import type { OutillageImportBatchSummary, OutillageRecentMovement, OutilPricingResponse } from "../types/outil.types"
import type {
  CreateOutilInput,
  UpdateOutilInput,
} from "../validators/outil.validator"

type SortieStockPayload = {
  id_outil: number
  quantite: number
  utilisateur: string
  user_id?: number | null
  reason?: string | null
  source?: string | null
  note?: string | null
  affaire_id?: number | null
}

type RetourStockPayload = SortieStockPayload

type ReapproPayload = {
  id_outil: number
  quantite: number
  prix: number
  id_fournisseur: number
  utilisateur: string
  user_id?: number | null
  reason?: string | null
  source?: string | null
  note?: string | null
  affaire_id?: number | null
}

type ScanSortiePayload = {
  reference_fabricant: string
  quantite: number
  utilisateur: string
  user_id?: number | null
  reason?: string | null
  source?: string | null
  note?: string | null
  affaire_id?: number | null
}

type ScanEntreePayload = {
  reference_fabricant: string
  quantite: number
  utilisateur: string
  prix?: number
  id_fournisseur?: number
  user_id?: number | null
  reason?: string | null
  source?: string | null
  note?: string | null
  affaire_id?: number | null
}

type InventaireSetPayload = {
  id_outil: number
  new_qty: number
  utilisateur: string
  user_id?: number | null
  reason?: string | null
  source?: string | null
  note?: string | null
}

function assertPositiveInt(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(422, "INVALID_ID", `${label} invalide`)
}

function assertPositiveNumber(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(422, "INVALID_NUMBER", `${label} invalide (doit etre > 0)`)
}

function assertNonNegativeNumber(n: number, label: string) {
  if (!Number.isFinite(n) || n < 0) throw new HttpError(422, "INVALID_NUMBER", `${label} invalide (doit etre >= 0)`)
}

function assertUser(utilisateur: string) {
  if (!utilisateur) throw new HttpError(401, "UNAUTHORIZED", "Utilisateur requis")
}

function normalizeTaxonomyLabel(value: string) {
  return value.trim().toLocaleUpperCase("fr-FR")
}

export const outilService = {
  async getAllOutils() {
    return outilRepository.findAll()
  },

  async getControlCenterSummary() {
    return outilRepository.getControlCenterSummary()
  },

  async getRecentMovements(limit: number): Promise<OutillageRecentMovement[]> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20
    return outilRepository.getRecentMovements(safeLimit)
  },

  async getImportBatchesSummary(limit: number): Promise<OutillageImportBatchSummary> {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 5
    return outilRepository.getImportBatchesSummary(safeLimit)
  },

  async getAllFiltered(filters: {
    id_famille?: number
    id_geometrie?: number
    q?: string
    only_in_stock?: boolean
    limit?: number
    offset?: number
  }) {
    return outilRepository.findAllFiltered(filters)
  },

  async getLowStock() {
    return outilRepository.getLowStock()
  },

  async getOutil(id: number) {
    assertPositiveInt(id, "ID outil")
    const outil = await outilRepository.findById(id)
    if (!outil) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable")
    return outil
  },

  async getOutilPricing(id: number): Promise<OutilPricingResponse> {
    assertPositiveInt(id, "ID outil")
    const exists = await outilRepository.exists(id)
    if (!exists) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable")
    return outilRepository.getPricingAnalytics(id)
  },

  async getOutilByRefFabricant(reference_fabricant: string) {
    if (!reference_fabricant || typeof reference_fabricant !== "string") {
      throw new HttpError(422, "INVALID_REFERENCE", "Reference fabricant invalide")
    }
    return outilRepository.findByReferenceFabricant(reference_fabricant)
  },

  async createOutil(
    data: CreateOutilInput & {
      esquisse?: string | null
      plan?: string | null
      image?: string | null
      utilisateur: string
      user_id?: number | null
    }
  ) {
    assertUser(data.utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      const id_outil = await outilRepository.create(data, client)
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "created",
        module: "outillage",
        at: new Date().toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary"],
      }, {
        deduplicationKey: `outillage:outil:${id_outil}:created`,
      })
      return { id_outil }
    })
  },

  async updateOutil(
    id_outil: number,
    data: UpdateOutilInput & { esquisse?: string | null; plan?: string | null; image?: string | null }
  ) {
    assertPositiveInt(id_outil, "ID outil")
    // One id per requested mutation: retries inside the commit verifier retain
    // this key, while a later A -> B -> A update receives a distinct event.
    const realtimeMutationId = crypto.randomUUID()

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      await outilRepository.update(id_outil, data, client)
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date().toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary"],
      }, {
        deduplicationKey: `outillage:outil:${id_outil}:updated:${realtimeMutationId}`,
      })
      return { id_outil }
    })
  },

  async deleteOutil(id_outil: number) {
    assertPositiveInt(id_outil, "ID outil")

    const client = await db.connect()
    const deletedAssets = await withRealtimeOutboxTransaction(client, async () => {
      const assets = await outilRepository.delete(id_outil, client)
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "deleted",
        module: "outillage",
        at: new Date().toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements"],
      }, {
        deduplicationKey: `outillage:outil:${id_outil}:deleted`,
      })
      return assets
    })
    // Storage cleanup happens after the durable delete and must never turn a
    // committed business mutation into a retryable 5xx.
    await Promise.allSettled([
      deleteStoredImageFile(deletedAssets.image),
      deleteStoredImageFile(deletedAssets.plan),
      deleteStoredImageFile(deletedAssets.esquisse),
    ])
    return { success: true }
  },

  async sortieStock(payload: SortieStockPayload) {
    const { id_outil, quantite, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      await outilRepository.removeFromStock(client, id_outil, quantite)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "sortie",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? null,
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { success: true }
    })
  },

  async retourStock(payload: RetourStockPayload) {
    const { id_outil, quantite, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      const exists = await outilRepository.exists(id_outil)
      if (!exists) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable")

      await outilRepository.addToStock(client, id_outil, quantite)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "entr\u00e9e",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "retour_outil",
        source: payload.source ?? "retour",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { success: true }
    })
  },

  async reapprovisionner(payload: ReapproPayload) {
    const { id_outil, quantite, prix, id_fournisseur, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertNonNegativeNumber(prix, "prix")
    assertPositiveInt(id_fournisseur, "id_fournisseur")
    assertUser(utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      await outilRepository.addToStock(client, id_outil, quantite)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "entrée",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "reappro",
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
        id_fournisseur,
        prix_unitaire: prix,
      })
      await outilRepository.insertHistoriquePrix(client, id_outil, prix, id_fournisseur)
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements", "outil-pricing"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { success: true }
    })
  },

  async scanSortie(payload: ScanSortiePayload) {
    const { reference_fabricant, quantite, utilisateur } = payload

    if (!reference_fabricant) throw new HttpError(422, "INVALID_REFERENCE", "reference_fabricant requis")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client)
      if (!outil) throw new HttpError(404, "OUTIL_NOT_FOUND", `Aucun outil pour la reference fabricant: ${reference_fabricant}`)

      const id_outil = Number(outil.id_outil)
      await outilRepository.removeFromStock(client, id_outil, quantite)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "sortie",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "scan",
        source: payload.source ?? "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { id_outil, reference_fabricant, quantite }
    })
  },

  async scanEntree(payload: ScanEntreePayload) {
    const { reference_fabricant, quantite, utilisateur } = payload

    if (!reference_fabricant) throw new HttpError(422, "INVALID_REFERENCE", "reference_fabricant requis")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const hasSupplierPricing = payload.prix !== undefined || payload.id_fournisseur !== undefined
    if (hasSupplierPricing) {
      if (payload.prix === undefined || payload.id_fournisseur === undefined) {
        throw new HttpError(422, "SUPPLIER_PRICE_REQUIRED", "Le fournisseur et le prix doivent etre renseignes ensemble")
      }
      assertNonNegativeNumber(Number(payload.prix), "prix")
      assertPositiveInt(Number(payload.id_fournisseur), "id_fournisseur")
    }

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client)
      if (!outil) throw new HttpError(404, "OUTIL_NOT_FOUND", `Aucun outil pour la reference fabricant: ${reference_fabricant}`)

      const id_outil = Number(outil.id_outil)
      await outilRepository.addToStock(client, id_outil, quantite)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite,
        type: "entrée",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "scan",
        source: payload.source ?? "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
        id_fournisseur: payload.id_fournisseur ?? null,
        prix_unitaire: payload.prix ?? null,
      })

      if (payload.prix !== undefined && payload.id_fournisseur !== undefined) {
        await outilRepository.insertHistoriquePrix(client, id_outil, Number(payload.prix), Number(payload.id_fournisseur))
      }
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements", "outil-pricing"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { id_outil, reference_fabricant, quantite }
    })
  },

  async inventaireSet(payload: InventaireSetPayload) {
    const { id_outil, new_qty, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertNonNegativeNumber(new_qty, "new_qty")
    assertUser(utilisateur)

    const client = await db.connect()
    return withRealtimeOutboxTransaction(client, async () => {
      await outilRepository.setStockAbsolute(client, id_outil, new_qty)
      const movement = await outilRepository.logMouvementStock(client, {
        id_outil,
        quantite: Number(new_qty),
        type: "inventaire",
        utilisateur,
        user_id: payload.user_id ?? null,
        reason: payload.reason ?? "inventaire",
        source: payload.source ?? "manual",
        note: payload.note ?? null,
        affaire_id: null,
      })
      await enqueueEntityChanged(client, {
        entityType: "OUTIL",
        entityId: String(id_outil),
        action: "updated",
        module: "outillage",
        at: new Date(movement.date).toISOString(),
        invalidateKeys: ["outils", "outils-low-stock", "outils-summary", "outils-recent-movements"],
      }, { deduplicationKey: `outillage:movement:${movement.id}` })
      return { success: true }
    })
  },
}

export const outilSupportService = {
  getFamilles: () => outilRepository.getFamilles(),
  createFamille: (nom_famille: string, image_path: string | null) =>
    outilRepository.createFamille(normalizeTaxonomyLabel(nom_famille), image_path),
  updateFamille: (id_famille: number, nom_famille: string, image_path?: string | null) =>
    outilRepository.updateFamille(id_famille, normalizeTaxonomyLabel(nom_famille), image_path),
  getFabricants: () => outilRepository.getFabricants(),
  getFournisseurs: (fabricantId?: number) => outilRepository.getFournisseurs(fabricantId),
  createFabricant: (nom: string, logo: string | null, fournisseurs: number[]) =>
    outilRepository.createFabricant(nom, logo, fournisseurs),
  updateFabricant: (id_fabricant: number, nom: string, logo: string | null, fournisseurs: number[]) =>
    outilRepository.updateFabricant(id_fabricant, nom, logo, fournisseurs),
  createFournisseur: (data: {
    nom: string
    adresse_ligne?: string
    house_no?: string
    postcode?: string
    city?: string
    country?: string
    phone_num?: string
    email?: string
    nom_commercial?: string
  }) => outilRepository.createFournisseur(data),
  updateFournisseur: (id_fournisseur: number, data: {
    nom: string
    adresse_ligne?: string
    house_no?: string
    postcode?: string
    city?: string
    country?: string
    phone_num?: string
    email?: string
    nom_commercial?: string
  }) => outilRepository.updateFournisseur(id_fournisseur, data),
  getGeometries: (id_famille?: number) => outilRepository.getGeometries(id_famille),
  createGeometrie: (nom_geometrie: string, id_famille: number, image_path: string | null) =>
    outilRepository.createGeometrie(normalizeTaxonomyLabel(nom_geometrie), id_famille, image_path),
  updateGeometrie: (id_geometrie: number, nom_geometrie: string, id_famille: number, image_path?: string | null) =>
    outilRepository.updateGeometrie(id_geometrie, normalizeTaxonomyLabel(nom_geometrie), id_famille, image_path),
  getRevetements: (id_fabricant?: number) => outilRepository.getRevetements(id_fabricant),
  getAretes: (id_geometrie?: number) => outilRepository.getAretes(id_geometrie),
  createRevetement: (nom: string, id_fabricant: number) => outilRepository.createRevetement(nom, id_fabricant),
}
