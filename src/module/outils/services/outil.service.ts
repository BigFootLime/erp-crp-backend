import db from "../../../config/database"
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
    try {
      await client.query("BEGIN")
      const id_outil = await outilRepository.create(data, client)
      await client.query("COMMIT")
      return { id_outil }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async updateOutil(
    id_outil: number,
    data: UpdateOutilInput & { esquisse?: string | null; plan?: string | null; image?: string | null }
  ) {
    assertPositiveInt(id_outil, "ID outil")

    const client = await db.connect()
    try {
      await client.query("BEGIN")
      await outilRepository.update(id_outil, data, client)
      await client.query("COMMIT")
      return { id_outil }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async deleteOutil(id_outil: number) {
    assertPositiveInt(id_outil, "ID outil")

    const client = await db.connect()
    try {
      await client.query("BEGIN")
      const deletedAssets = await outilRepository.delete(id_outil, client)
      await client.query("COMMIT")

      await Promise.all([
        deleteStoredImageFile(deletedAssets.image),
        deleteStoredImageFile(deletedAssets.plan),
        deleteStoredImageFile(deletedAssets.esquisse),
      ])

      return { success: true }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async sortieStock(payload: SortieStockPayload) {
    const { id_outil, quantite, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      await outilRepository.removeFromStock(client, id_outil, quantite)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { success: true }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async retourStock(payload: RetourStockPayload) {
    const { id_outil, quantite, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      const exists = await outilRepository.exists(id_outil)
      if (!exists) throw new HttpError(404, "OUTIL_NOT_FOUND", "Outil introuvable")

      await outilRepository.addToStock(client, id_outil, quantite)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { success: true }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async reapprovisionner(payload: ReapproPayload) {
    const { id_outil, quantite, prix, id_fournisseur, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertPositiveNumber(quantite, "quantite")
    assertNonNegativeNumber(prix, "prix")
    assertPositiveInt(id_fournisseur, "id_fournisseur")
    assertUser(utilisateur)

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      await outilRepository.addToStock(client, id_outil, quantite)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { success: true }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async scanSortie(payload: ScanSortiePayload) {
    const { reference_fabricant, quantite, utilisateur } = payload

    if (!reference_fabricant) throw new HttpError(422, "INVALID_REFERENCE", "reference_fabricant requis")
    assertPositiveNumber(quantite, "quantite")
    assertUser(utilisateur)

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client)
      if (!outil) throw new HttpError(404, "OUTIL_NOT_FOUND", `Aucun outil pour la reference fabricant: ${reference_fabricant}`)

      const id_outil = Number(outil.id_outil)
      await outilRepository.removeFromStock(client, id_outil, quantite)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { id_outil, reference_fabricant, quantite }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
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
    try {
      await client.query("BEGIN")

      const outil = await outilRepository.findByReferenceFabricant(reference_fabricant, client)
      if (!outil) throw new HttpError(404, "OUTIL_NOT_FOUND", `Aucun outil pour la reference fabricant: ${reference_fabricant}`)

      const id_outil = Number(outil.id_outil)
      await outilRepository.addToStock(client, id_outil, quantite)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { id_outil, reference_fabricant, quantite }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  },

  async inventaireSet(payload: InventaireSetPayload) {
    const { id_outil, new_qty, utilisateur } = payload

    assertPositiveInt(id_outil, "id_outil")
    assertNonNegativeNumber(new_qty, "new_qty")
    assertUser(utilisateur)

    const client = await db.connect()
    try {
      await client.query("BEGIN")

      await outilRepository.setStockAbsolute(client, id_outil, new_qty)
      await outilRepository.logMouvementStock(client, {
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

      await client.query("COMMIT")
      return { success: true }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
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
