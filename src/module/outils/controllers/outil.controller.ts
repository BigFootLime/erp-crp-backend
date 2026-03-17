import type { NextFunction, Request, Response } from "express"
import { getIO } from "../../../sockets/sockeServer"
import { HttpError } from "../../../utils/httpError"
import { parseId } from "../../../utils/parseId"
import { parseString } from "../../../utils/parseString"
import { deleteStoredImageFile } from "../../../utils/imageStorage"
import { outilService, outilSupportService } from "../services/outil.service"
import {
  adjustStockSchema,
  createFabricantSchema,
  createFamilleSchema,
  createFournisseurSchema,
  createGeometrieSchema,
  createRevetementSchema,
  outilUpsertSchema,
  reapprovisionnementSchema,
  scanMovementSchema,
  sortieStockSchema,
  updateFamilleSchema,
  updateGeometrieSchema,
} from "../validators/outil.validator"
import {
  getOutillageFabricantStoredPath,
  getOutillageFamilleStoredPath,
  getOutillageGeometrieStoredPath,
  getOutillageToolStoredPath,
} from "../utils/outillage-upload"

function isPgUniqueViolation(err: unknown): err is { code?: string; constraint?: string; detail?: string; table?: string } {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505"
}

function uniqueViolationDetails(err: { constraint?: string; detail?: string; table?: string }) {
  return {
    constraint: err.constraint,
    detail: err.detail,
    table: err.table,
  }
}

function requireUser(req: Request) {
  const user = req.user
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")
  return user
}

function parseMultipartJsonBody<T>(raw: unknown, schema: { parse: (value: unknown) => T }) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new HttpError(400, "MISSING_DATA", "Donnees manquantes (champ 'data')")
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Le champ 'data' doit etre un JSON valide")
  }

  return schema.parse(parsedJson)
}

function extractUploadedToolPaths(files: Request["files"]) {
  const uploaded = files as Record<string, Express.Multer.File[]> | undefined

  const paths = {
    esquisse: uploaded?.esquisse?.[0]?.filename ? getOutillageToolStoredPath(uploaded.esquisse[0].filename) : undefined,
    plan: uploaded?.plan?.[0]?.filename ? getOutillageToolStoredPath(uploaded.plan[0].filename) : undefined,
    image: uploaded?.image?.[0]?.filename ? getOutillageToolStoredPath(uploaded.image[0].filename) : undefined,
  }

  const uploadedPaths = [paths.esquisse, paths.plan, paths.image].filter((value): value is string => Boolean(value))
  return { paths, uploadedPaths }
}

export const outilController = {
  async getAll(_req: Request, res: Response, next: NextFunction) {
    try {
      const outils = await outilService.getAllOutils()
      return res.status(200).json(outils)
    } catch (error) {
      next(error)
    }
  },

  async getFiltered(req: Request, res: Response, next: NextFunction) {
    try {
      const id_famille = req.query.id_famille ? Number(req.query.id_famille) : undefined
      const id_geometrie = req.query.id_geometrie ? Number(req.query.id_geometrie) : undefined
      const q = typeof req.query.q === "string" ? req.query.q : undefined
      const only_in_stock =
        typeof req.query.only_in_stock === "string"
          ? req.query.only_in_stock === "true" || req.query.only_in_stock === "1"
          : undefined

      const limit = req.query.limit ? Number(req.query.limit) : undefined
      const offset = req.query.offset ? Number(req.query.offset) : undefined

      if (id_famille !== undefined && (!Number.isFinite(id_famille) || id_famille <= 0)) {
        throw new HttpError(400, "INVALID_FAMILLE", "id_famille invalide")
      }
      if (id_geometrie !== undefined && (!Number.isFinite(id_geometrie) || id_geometrie <= 0)) {
        throw new HttpError(400, "INVALID_GEOMETRIE", "id_geometrie invalide")
      }
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
        throw new HttpError(400, "INVALID_LIMIT", "limit invalide")
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        throw new HttpError(400, "INVALID_OFFSET", "offset invalide")
      }

      const outils = await outilService.getAllFiltered({
        id_famille,
        id_geometrie,
        q,
        only_in_stock,
        limit,
        offset,
      })

      return res.status(200).json(outils)
    } catch (error) {
      next(error)
    }
  },

  async getLowStock(_req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await outilService.getLowStock()
      return res.status(200).json(rows)
    } catch (error) {
      next(error)
    }
  },

  async getById(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseId(req.params.id, "ID Outil")
      const outil = await outilService.getOutil(id)
      return res.status(200).json(outil)
    } catch (error) {
      next(error)
    }
  },

  async getPricing(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseId(req.params.id, "ID Outil")
      const pricing = await outilService.getOutilPricing(id)
      return res.status(200).json(pricing)
    } catch (error) {
      next(error)
    }
  },

  async getByReferenceFabricant(req: Request, res: Response, next: NextFunction) {
    try {
      const ref = parseString(req.params.ref_fabricant, "Reference fabricant")
      const outil = await outilService.getOutilByRefFabricant(ref)

      if (!outil) return res.status(404).json({ message: "Aucun outil trouve." })
      return res.status(200).json(outil)
    } catch (error) {
      next(error)
    }
  },

  async create(req: Request, res: Response, next: NextFunction) {
    const { uploadedPaths, paths } = extractUploadedToolPaths(req.files)

    try {
      const parsed = parseMultipartJsonBody(req.body.data, outilUpsertSchema)
      const result = await outilService.createOutil({
        ...parsed,
        esquisse: paths.esquisse ?? null,
        plan: paths.plan ?? null,
        image: paths.image ?? null,
      })

      try {
        const io = getIO()
        io.emit("outilCreated", { id_outil: result.id_outil })
      } catch {
        // noop
      }

      return res.status(201).json(result)
    } catch (error) {
      await Promise.all(uploadedPaths.map((value) => deleteStoredImageFile(value)))

      if (isPgUniqueViolation(error)) {
        return res.status(409).json({
          message: "Doublon: cette reference fabricant existe deja pour ce fabricant.",
          ...uniqueViolationDetails(error),
        })
      }

      next(error)
    }
  },

  async update(req: Request, res: Response, next: NextFunction) {
    const id = parseId(req.params.id, "ID Outil")
    const { uploadedPaths, paths } = extractUploadedToolPaths(req.files)

    try {
      const parsed = parseMultipartJsonBody(req.body.data, outilUpsertSchema)
      await outilService.updateOutil(id, {
        ...parsed,
        esquisse: paths.esquisse,
        plan: paths.plan,
        image: paths.image,
      })

      try {
        const io = getIO()
        io.emit("outilUpdated", { id_outil: id })
      } catch {
        // noop
      }

      return res.status(200).json({ id_outil: id })
    } catch (error) {
      await Promise.all(uploadedPaths.map((value) => deleteStoredImageFile(value)))

      if (isPgUniqueViolation(error)) {
        return res.status(409).json({
          message: "Doublon: cette reference fabricant existe deja pour ce fabricant.",
          ...uniqueViolationDetails(error),
        })
      }

      next(error)
    }
  },

  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const id = parseId(req.params.id, "ID Outil")
      await outilService.deleteOutil(id)

      try {
        const io = getIO()
        io.emit("outilDeleted", { id_outil: id })
      } catch {
        // noop
      }

      return res.status(200).json({ success: true })
    } catch (error) {
      next(error)
    }
  },

  async sortieStock(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req)
      const payload = sortieStockSchema.parse(req.body)

      await outilService.sortieStock({
        id_outil: payload.id,
        quantite: payload.quantity,
        utilisateur: user.username,
        user_id: user.id ?? null,
        reason: payload.reason ?? null,
        source: "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })

      try {
        const io = getIO()
        io.emit("stockUpdated", {
          id_outil: payload.id,
          quantity: payload.quantity,
          user: user.username,
          type: "sortie",
          date: new Date().toISOString(),
        })
      } catch {
        // noop
      }

      return res.status(200).json({
        success: true,
        message: `Outil ${payload.id} retire du stock, quantite : ${payload.quantity}`,
      })
    } catch (error) {
      next(error)
    }
  },

  async reapprovisionner(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req)
      const payload = reapprovisionnementSchema.parse(req.body)

      await outilService.reapprovisionner({
        ...payload,
        utilisateur: user.username,
        user_id: user.id ?? null,
        reason: payload.reason ?? null,
        source: "manual",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })

      try {
        const io = getIO()
        io.emit("stockUpdated", {
          id_outil: payload.id_outil,
          quantity: payload.quantite,
          user: user.username,
          type: "entree",
          date: new Date().toISOString(),
        })
      } catch {
        // noop
      }

      return res.status(200).json({
        success: true,
        message: `Outil ${payload.id_outil} reapprovisionne de ${payload.quantite} unite(s).`,
      })
    } catch (error) {
      next(error)
    }
  },

  async scanSortie(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req)
      const payload = scanMovementSchema.parse(req.body)

      const result = await outilService.scanSortie({
        reference_fabricant: payload.barcode,
        quantite: payload.quantity,
        utilisateur: user.username,
        user_id: user.id ?? null,
        reason: payload.reason ?? null,
        source: "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })

      try {
        const io = getIO()
        io.emit("stockUpdated", {
          id_outil: result.id_outil,
          quantity: payload.quantity,
          user: user.username,
          type: "sortie",
          date: new Date().toISOString(),
          source: "scan",
        })
      } catch {
        // noop
      }

      return res.status(200).json({
        success: true,
        ...result,
        message: `Sortie stock OK (${payload.barcode}) x${payload.quantity}`,
      })
    } catch (error) {
      next(error)
    }
  },

  async scanEntree(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req)
      const payload = scanMovementSchema.parse(req.body)

      const result = await outilService.scanEntree({
        reference_fabricant: payload.barcode,
        quantite: payload.quantity,
        prix: payload.prix,
        id_fournisseur: payload.id_fournisseur,
        utilisateur: user.username,
        user_id: user.id ?? null,
        reason: payload.reason ?? null,
        source: "scan",
        note: payload.note ?? null,
        affaire_id: payload.affaire_id ?? null,
      })

      try {
        const io = getIO()
        io.emit("stockUpdated", {
          id_outil: result.id_outil,
          quantity: payload.quantity,
          user: user.username,
          type: "entree",
          date: new Date().toISOString(),
          source: "scan",
        })
      } catch {
        // noop
      }

      return res.status(200).json({
        success: true,
        ...result,
        message: `Entree stock OK (${payload.barcode}) x${payload.quantity}`,
      })
    } catch (error) {
      next(error)
    }
  },

  async inventaireSet(req: Request, res: Response, next: NextFunction) {
    try {
      const user = requireUser(req)
      const payload = adjustStockSchema.parse(req.body)

      await outilService.inventaireSet({
        id_outil: payload.id_outil,
        new_qty: payload.new_qty,
        utilisateur: user.username,
        user_id: user.id ?? null,
        reason: payload.reason ?? "inventaire",
        source: "manual",
        note: payload.note ?? null,
      })

      try {
        const io = getIO()
        io.emit("stockUpdated", {
          id_outil: payload.id_outil,
          quantity: payload.new_qty,
          user: user.username,
          type: "inventaire",
          date: new Date().toISOString(),
        })
      } catch {
        // noop
      }

      return res.status(200).json({ success: true, message: `Inventaire OK (outil ${payload.id_outil} => ${payload.new_qty})` })
    } catch (error) {
      next(error)
    }
  },
}

export const outilSupportController = {
  getFamilles: async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const familles = await outilSupportService.getFamilles()
      return res.json(familles)
    } catch (error) {
      next(error)
    }
  },

  postFamille: async (req: Request, res: Response, next: NextFunction) => {
    const uploadedImage = req.file?.filename ? getOutillageFamilleStoredPath(req.file.filename) : null

    try {
      requireUser(req)
      const parsed = createFamilleSchema.parse(req.body)
      const famille = await outilSupportService.createFamille(parsed.nom_famille, uploadedImage)
      return res.status(201).json(famille)
    } catch (error) {
      await deleteStoredImageFile(uploadedImage)
      next(error)
    }
  },

  patchFamille: async (req: Request, res: Response, next: NextFunction) => {
    const uploadedImage = req.file?.filename ? getOutillageFamilleStoredPath(req.file.filename) : null

    try {
      requireUser(req)
      const id = parseId(req.params.id, "ID Famille")
      const parsed = updateFamilleSchema.parse(req.body)
      const famille = await outilSupportService.updateFamille(id, parsed.nom_famille, uploadedImage)
      return res.status(200).json(famille)
    } catch (error) {
      await deleteStoredImageFile(uploadedImage)
      next(error)
    }
  },

  getFabricants: async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const fabricants = await outilSupportService.getFabricants()
      return res.json(fabricants)
    } catch (error) {
      next(error)
    }
  },

  postFabricant: async (req: Request, res: Response, next: NextFunction) => {
    const uploadedLogo = req.file?.filename ? getOutillageFabricantStoredPath(req.file.filename) : null

    try {
      requireUser(req)
      let fournisseursPayload: unknown = []
      if (req.body.id_fournisseurs) {
        try {
          fournisseursPayload = JSON.parse(req.body.id_fournisseurs)
        } catch {
          throw new HttpError(400, "INVALID_JSON", "id_fournisseurs doit etre un JSON valide")
        }
      }

      const parsed = createFabricantSchema.parse({
        nom_fabricant: req.body.nom_fabricant,
        id_fournisseurs: fournisseursPayload,
      })

      const id = await outilSupportService.createFabricant(parsed.nom_fabricant, uploadedLogo, parsed.id_fournisseurs)
      return res.status(201).json({ message: "Fabricant cree", id })
    } catch (error) {
      await deleteStoredImageFile(uploadedLogo)
      next(error)
    }
  },

  getFournisseurs: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fabricantId = req.query.fabricantId ? parseId(req.query.fabricantId as string, "ID Fabricant") : undefined
      const fournisseurs = await outilSupportService.getFournisseurs(fabricantId)
      return res.json(fournisseurs)
    } catch (error) {
      next(error)
    }
  },

  postFournisseur: async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireUser(req)
      const parsed = createFournisseurSchema.parse(req.body)
      await outilSupportService.createFournisseur(parsed)
      res.status(201).json({ message: "Fournisseur cree" })

      try {
        const io = getIO()
        io.emit("fournisseurAdded")
      } catch {
        // noop
      }
    } catch (error) {
      next(error)
    }
  },

  getGeometries: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_famille ? parseId(req.query.id_famille as string, "ID Famille") : undefined
      const result = await outilSupportService.getGeometries(id)
      return res.json(result)
    } catch (error) {
      next(error)
    }
  },

  postGeometrie: async (req: Request, res: Response, next: NextFunction) => {
    const uploadedImage = req.file?.filename ? getOutillageGeometrieStoredPath(req.file.filename) : null

    try {
      requireUser(req)
      const parsed = createGeometrieSchema.parse(req.body)
      const geometrie = await outilSupportService.createGeometrie(parsed.nom_geometrie, parsed.id_famille, uploadedImage)
      return res.status(201).json(geometrie)
    } catch (error) {
      await deleteStoredImageFile(uploadedImage)
      next(error)
    }
  },

  patchGeometrie: async (req: Request, res: Response, next: NextFunction) => {
    const uploadedImage = req.file?.filename ? getOutillageGeometrieStoredPath(req.file.filename) : null

    try {
      requireUser(req)
      const id = parseId(req.params.id, "ID Geometrie")
      const parsed = updateGeometrieSchema.parse(req.body)
      const geometrie = await outilSupportService.updateGeometrie(
        id,
        parsed.nom_geometrie,
        parsed.id_famille,
        uploadedImage
      )
      return res.status(200).json(geometrie)
    } catch (error) {
      await deleteStoredImageFile(uploadedImage)
      next(error)
    }
  },

  getRevetements: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_fabricant ? parseId(req.query.id_fabricant as string, "ID Fabricant") : undefined
      const result = await outilSupportService.getRevetements(id)
      return res.json(result)
    } catch (error) {
      next(error)
    }
  },

  getAretes: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.query.id_geometrie ? parseId(req.query.id_geometrie as string, "ID Geometrie") : undefined
      const result = await outilSupportService.getAretes(id)
      return res.json(result)
    } catch (error) {
      next(error)
    }
  },

  postRevetement: async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireUser(req)
      const parsed = createRevetementSchema.parse(req.body)
      const id = await outilSupportService.createRevetement(parsed.nom, parsed.id_fabricant)

      try {
        const io = getIO()
        io.emit("revetementAdded")
      } catch {
        // noop
      }

      return res.status(201).json({ message: "Revetement cree", id })
    } catch (error) {
      next(error)
    }
  },
}
