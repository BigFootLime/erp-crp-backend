import crypto from "node:crypto"
import fs from "node:fs/promises"

import type { PoolClient } from "pg"

import db from "../../../config/database"
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction"
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service"
import { buildPublicImageUrl, deleteStoredImageFile, normalizeStoredImagePath } from "../../../utils/imageStorage"
import { HttpError } from "../../../utils/httpError"
import {
  type UploadCommitReconciliation,
  withUploadTransaction,
} from "../../../shared/uploads/upload-transaction"
import { outilRepository } from "../repository/outil.repository"
import type { OutillageImportBatchSummary, OutillageRecentMovement, OutilPricingResponse } from "../types/outil.types"
import {
  type OutillageToolUploadFiles,
  type PromotedOutillageFile,
  promoteOutillageFabricantFile,
  promoteOutillageFamilleFile,
  promoteOutillageGeometrieFile,
  promoteOutillageToolFiles,
} from "../utils/outillage-upload"
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

type ExpectedOutillageUpload = Readonly<{
  column: string
  storedPath: string
  absolutePath: string
}>

async function classifyOutillageUploadCommit(
  row: Record<string, unknown> | undefined,
  expected: readonly ExpectedOutillageUpload[],
  operation: "create" | "update"
): Promise<UploadCommitReconciliation> {
  if (!row) return "not-committed"
  if (expected.length === 0) return operation === "create" ? "committed" : "uncertain"

  const matches = expected.filter(({ column, storedPath }) =>
    normalizeStoredImagePath(typeof row[column] === "string" ? row[column] as string : null) === storedPath
  )
  if (matches.length === 0) return operation === "create" ? "uncertain" : "not-committed"
  if (matches.length !== expected.length) return "uncertain"

  const present = await Promise.all(
    expected.map(({ absolutePath }) => fs.stat(absolutePath).then((stat) => stat.isFile()).catch(() => false))
  )
  return present.every(Boolean) ? "committed" : "uncertain"
}

function toolUploadFiles(files: OutillageToolUploadFiles): Express.Multer.File[] {
  return [files.esquisse, files.plan, files.image].filter((file): file is Express.Multer.File => Boolean(file))
}

function expectedToolUploads(
  promoted: Awaited<ReturnType<typeof promoteOutillageToolFiles>>
): ExpectedOutillageUpload[] {
  return (["esquisse", "plan", "image"] as const).flatMap((column) => {
    const entry = promoted[column]
    return entry ? [{ column, storedPath: entry.storedPath, absolutePath: entry.absolutePath }] : []
  })
}

type SingleUploadTransactionOptions<T> = Readonly<{
  context: string
  operation: "create" | "update"
  file?: Express.Multer.File
  column: string
  promote: (file: Express.Multer.File) => Promise<PromotedOutillageFile>
  mutate: (client: PoolClient) => Promise<T>
  persist: (client: PoolClient, result: T, storedPath: string) => Promise<void>
  readFresh: (result: T) => Promise<Record<string, unknown> | undefined>
  decorate?: (result: T, storedPath: string) => T
}>

async function withSingleOutillageUpload<T>(options: SingleUploadTransactionOptions<T>): Promise<T> {
  const client = await db.connect()
  let expected: ExpectedOutillageUpload[] = []
  return withUploadTransaction({
    client,
    files: options.file ? [options.file] : [],
    context: options.context,
    work: async () => {
      let result = await options.mutate(client) as T
      if (!options.file) return result

      const promoted = await options.promote(options.file)
      await options.persist(client, result, promoted.storedPath)
      expected = [{
        column: options.column,
        storedPath: promoted.storedPath,
        absolutePath: promoted.absolutePath,
      }]
      if (options.decorate) result = options.decorate(result, promoted.storedPath)
      return result
    },
    reconcile: async (result) => classifyOutillageUploadCommit(
      await options.readFresh(result),
      expected,
      options.operation
    ),
  })
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
      utilisateur: string
      user_id?: number | null
    },
    files: OutillageToolUploadFiles = {}
  ) {
    assertUser(data.utilisateur)

    const client = await db.connect()
    let expected: ExpectedOutillageUpload[] = []
    return withUploadTransaction({
      client,
      files: toolUploadFiles(files),
      context: "outillage.outils.create",
      work: async () => {
        // All referential and uniqueness validation is executed before a file
        // leaves staging. The paths are attached only after that succeeds.
        const id_outil = await outilRepository.create({
          ...data,
          esquisse: null,
          plan: null,
          image: null,
        }, client)
        const promoted = await promoteOutillageToolFiles(files)
        expected = expectedToolUploads(promoted)
        await outilRepository.setOutilUploadPaths(client, id_outil, {
          esquisse: promoted.esquisse?.storedPath,
          plan: promoted.plan?.storedPath,
          image: promoted.image?.storedPath,
        })
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
      },
      reconcile: async ({ id_outil }) => {
        const result = await db.query(
          `SELECT esquisse, plan, image FROM gestion_outils_outil WHERE id_outil = $1`,
          [id_outil]
        )
        return classifyOutillageUploadCommit(result.rows[0], expected, "create")
      },
    })
  },

  async updateOutil(
    id_outil: number,
    data: UpdateOutilInput,
    files: OutillageToolUploadFiles = {}
  ) {
    assertPositiveInt(id_outil, "ID outil")
    // One id per requested mutation: retries inside the commit verifier retain
    // this key, while a later A -> B -> A update receives a distinct event.
    const realtimeMutationId = crypto.randomUUID()

    const client = await db.connect()
    let expected: ExpectedOutillageUpload[] = []
    return withUploadTransaction({
      client,
      files: toolUploadFiles(files),
      context: "outillage.outils.update",
      work: async () => {
        await outilRepository.update(id_outil, {
          ...data,
          esquisse: undefined,
          plan: undefined,
          image: undefined,
        }, client)
        const promoted = await promoteOutillageToolFiles(files)
        expected = expectedToolUploads(promoted)
        await outilRepository.setOutilUploadPaths(client, id_outil, {
          esquisse: promoted.esquisse?.storedPath,
          plan: promoted.plan?.storedPath,
          image: promoted.image?.storedPath,
        })
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
      },
      reconcile: async () => {
        const result = await db.query(
          `SELECT esquisse, plan, image FROM gestion_outils_outil WHERE id_outil = $1`,
          [id_outil]
        )
        return classifyOutillageUploadCommit(result.rows[0], expected, "update")
      },
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
  async createFamille(nom_famille: string, file?: Express.Multer.File) {
    const normalizedName = normalizeTaxonomyLabel(nom_famille)
    return withSingleOutillageUpload({
      context: "outillage.familles.create",
      operation: "create",
      file,
      column: "image_path",
      promote: promoteOutillageFamilleFile,
      mutate: (client) => outilRepository.createFamille(normalizedName, null, client),
      persist: (client, result, storedPath) => outilRepository.setFamilleImagePath(client, result.value, storedPath),
      readFresh: async (result) => (await db.query(
        `SELECT image_path FROM gestion_outils_famille WHERE id_famille = $1`,
        [result.value]
      )).rows[0],
      decorate: (result, storedPath) => ({ ...result, imagePath: buildPublicImageUrl(storedPath) }),
    })
  },
  async updateFamille(id_famille: number, nom_famille: string, file?: Express.Multer.File) {
    const normalizedName = normalizeTaxonomyLabel(nom_famille)
    return withSingleOutillageUpload({
      context: "outillage.familles.update",
      operation: "update",
      file,
      column: "image_path",
      promote: promoteOutillageFamilleFile,
      mutate: (client) => outilRepository.updateFamille(id_famille, normalizedName, null, client),
      persist: (client, _result, storedPath) => outilRepository.setFamilleImagePath(client, id_famille, storedPath),
      readFresh: async () => (await db.query(
        `SELECT image_path FROM gestion_outils_famille WHERE id_famille = $1`,
        [id_famille]
      )).rows[0],
      decorate: (result, storedPath) => ({ ...result, imagePath: buildPublicImageUrl(storedPath) }),
    })
  },
  getFabricants: () => outilRepository.getFabricants(),
  getFournisseurs: (fabricantId?: number) => outilRepository.getFournisseurs(fabricantId),
  async createFabricant(nom: string, file: Express.Multer.File | undefined, fournisseurs: number[]) {
    return withSingleOutillageUpload({
      context: "outillage.fabricants.create",
      operation: "create",
      file,
      column: "logo",
      promote: promoteOutillageFabricantFile,
      mutate: (client) => outilRepository.createFabricant(nom, null, fournisseurs, client),
      persist: (client, id, storedPath) => outilRepository.setFabricantLogo(client, id, storedPath),
      readFresh: async (id) => (await db.query(
        `SELECT logo FROM gestion_outils_fabricant WHERE id_fabricant = $1`,
        [id]
      )).rows[0],
    })
  },
  async updateFabricant(
    id_fabricant: number,
    nom: string,
    file: Express.Multer.File | undefined,
    fournisseurs: number[]
  ) {
    const realtimeMutationId = crypto.randomUUID()
    return withSingleOutillageUpload({
      context: "outillage.fabricants.update",
      operation: "update",
      file,
      column: "logo",
      promote: promoteOutillageFabricantFile,
      mutate: async (client) => {
        const result = await outilRepository.updateFabricant(id_fabricant, nom, null, fournisseurs, client)
        await enqueueEntityChanged(client, {
          entityType: "OUTIL_FABRICANT",
          entityId: String(id_fabricant),
          action: "updated",
          module: "outillage",
          at: new Date().toISOString(),
          invalidateKeys: ["outils-fabricants", "outils"],
        }, {
          deduplicationKey: `outillage:fabricant:${id_fabricant}:updated:${realtimeMutationId}`,
        })
        return result
      },
      persist: (client, _result, storedPath) => outilRepository.setFabricantLogo(client, id_fabricant, storedPath),
      readFresh: async () => (await db.query(
        `SELECT logo FROM gestion_outils_fabricant WHERE id_fabricant = $1`,
        [id_fabricant]
      )).rows[0],
      decorate: (result, storedPath) => ({ ...result, logo: buildPublicImageUrl(storedPath) }),
    })
  },
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
  async createGeometrie(nom_geometrie: string, id_famille: number, file?: Express.Multer.File) {
    const normalizedName = normalizeTaxonomyLabel(nom_geometrie)
    return withSingleOutillageUpload({
      context: "outillage.geometries.create",
      operation: "create",
      file,
      column: "image_path",
      promote: promoteOutillageGeometrieFile,
      mutate: (client) => outilRepository.createGeometrie(normalizedName, id_famille, null, client),
      persist: (client, result, storedPath) => outilRepository.setGeometrieImagePath(client, result.value, storedPath),
      readFresh: async (result) => (await db.query(
        `SELECT image_path FROM gestion_outils_geometrie WHERE id_geometrie = $1`,
        [result.value]
      )).rows[0],
      decorate: (result, storedPath) => ({ ...result, imagePath: buildPublicImageUrl(storedPath) }),
    })
  },
  async updateGeometrie(
    id_geometrie: number,
    nom_geometrie: string,
    id_famille: number,
    file?: Express.Multer.File
  ) {
    const normalizedName = normalizeTaxonomyLabel(nom_geometrie)
    return withSingleOutillageUpload({
      context: "outillage.geometries.update",
      operation: "update",
      file,
      column: "image_path",
      promote: promoteOutillageGeometrieFile,
      mutate: (client) => outilRepository.updateGeometrie(id_geometrie, normalizedName, id_famille, null, client),
      persist: (client, _result, storedPath) => outilRepository.setGeometrieImagePath(client, id_geometrie, storedPath),
      readFresh: async () => (await db.query(
        `SELECT image_path FROM gestion_outils_geometrie WHERE id_geometrie = $1`,
        [id_geometrie]
      )).rows[0],
      decorate: (result, storedPath) => ({ ...result, imagePath: buildPublicImageUrl(storedPath) }),
    })
  },
  getRevetements: (id_fabricant?: number) => outilRepository.getRevetements(id_fabricant),
  getAretes: (id_geometrie?: number) => outilRepository.getAretes(id_geometrie),
  createRevetement: (nom: string, id_fabricant: number) => outilRepository.createRevetement(nom, id_fabricant),
}
