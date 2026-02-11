// src/module/pieces-techniques/controllers/pieces-techniques.controller.ts
import type { Request, RequestHandler } from "express"
import { HttpError } from "../../../utils/httpError"
import {
  achatIdParamSchema,
  addAchatSchema,
  addBomLineSchema,
  addOperationSchema,
  bomLineIdParamSchema,
  createPieceTechniqueSchema,
  getPieceTechniqueQuerySchema,
  idParamSchema,
  listPiecesTechniquesQuerySchema,
  operationIdParamSchema,
  pieceTechniqueStatusSchema,
  reorderSchema,
  updateAchatSchema,
  updateBomLineSchema,
  updateOperationSchema,
  updatePieceTechniqueSchema,
  type CreatePieceTechniqueBodyDTO,
  type AddAchatBodyDTO,
  type AddBomLineBodyDTO,
  type AddOperationBodyDTO,
  type PieceTechniqueStatusBodyDTO,
  type ReorderBodyDTO,
  type UpdateAchatBodyDTO,
  type UpdateBomLineBodyDTO,
  type UpdateOperationBodyDTO,
  type UpdatePieceTechniqueBodyDTO,
} from "../validators/pieces-techniques.validators"
import {
  addAchatSVC,
  addBomLineSVC,
  addOperationSVC,
  deleteAchatSVC,
  deleteBomLineSVC,
  deleteOperationSVC,
  deletePieceTechniqueSVC,
  duplicatePieceTechniqueSVC,
  getPieceTechniqueSVC,
  listPieceTechniquesSVC,
  reorderAchatsSVC,
  reorderBomSVC,
  reorderOperationsSVC,
  updateAchatSVC,
  updateBomLineSVC,
  updateOperationSVC,
  updatePieceTechniqueSVC,
  updatePieceTechniqueStatusSVC,
  createPieceTechniqueSVC,
} from "../services/pieces-techniques.service"

function parseIncludeSet(req: Request) {
  const parsed = getPieceTechniqueQuerySchema.safeParse(req.query)
  const includeStr = parsed.success ? parsed.data.include : ""
  return new Set(
    includeStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  )
}

function resolveUserId(req: Request, fallbackBodyValue?: unknown): number | null {
  const fromAuth = (req as unknown as { user?: unknown }).user
  if (typeof (fromAuth as { id?: unknown } | undefined)?.id === "number") return (fromAuth as { id: number }).id
  return typeof fallbackBodyValue === "number" ? fallbackBodyValue : null
}

export const createPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const parsed = createPieceTechniqueSchema.safeParse({ body: req.body })
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid body" })
      return
    }

    const body: CreatePieceTechniqueBodyDTO = parsed.data.body
    const userId = resolveUserId(req, null)
    const out = await createPieceTechniqueSVC(body, userId)
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const listPieceTechniques: RequestHandler = async (req, res, next) => {
  try {
    const parsed = listPiecesTechniquesQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues?.[0]?.message ?? "Invalid query" })
      return
    }

    const out = await listPieceTechniquesSVC(parsed.data)
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const getPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const includes = parseIncludeSet(req)
    const out = await getPieceTechniqueSVC(id, includes)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(out)
  } catch (err) {
    next(err)
  }
}

export const updatePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdatePieceTechniqueBodyDTO
    const userId = resolveUserId(req, (req.body as { updated_by?: unknown } | undefined)?.updated_by)
    const out = await updatePieceTechniqueSVC(id, body, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deletePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const ok = await deletePieceTechniqueSVC(id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const duplicatePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const userId = resolveUserId(req, null)
    const out = await duplicatePieceTechniqueSVC(id, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updatePieceTechniqueStatus: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as PieceTechniqueStatusBodyDTO
    const userId = resolveUserId(req, null)
    if (userId === null) throw new HttpError(401, "UNAUTHORIZED", "Authentication required")

    const out = await updatePieceTechniqueStatusSVC(id, body, userId)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddBomLineBodyDTO
    const out = await addBomLineSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id, lineId } = bomLineIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateBomLineBodyDTO
    const out = await updateBomLineSVC(id, lineId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteBomLine: RequestHandler = async (req, res, next) => {
  try {
    const { id, lineId } = bomLineIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteBomLineSVC(id, lineId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderBom: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderBomSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddOperationBodyDTO
    const out = await addOperationSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id, opId } = operationIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateOperationBodyDTO
    const out = await updateOperationSVC(id, opId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteOperation: RequestHandler = async (req, res, next) => {
  try {
    const { id, opId } = operationIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteOperationSVC(id, opId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderOperations: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderOperationsSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const addAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as AddAchatBodyDTO
    const out = await addAchatSVC(id, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(201).json(out)
  } catch (err) {
    next(err)
  }
}

export const updateAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id, achatId } = achatIdParamSchema.parse({ params: req.params }).params
    const body = req.body as UpdateAchatBodyDTO
    const out = await updateAchatSVC(id, achatId, body)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}

export const deleteAchat: RequestHandler = async (req, res, next) => {
  try {
    const { id, achatId } = achatIdParamSchema.parse({ params: req.params }).params
    const ok = await deleteAchatSVC(id, achatId)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}

export const reorderAchats: RequestHandler = async (req, res, next) => {
  try {
    const { id } = idParamSchema.parse({ params: req.params }).params
    const body = req.body as ReorderBodyDTO
    const out = await reorderAchatsSVC(id, body.order)
    if (!out) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(200).json(out)
  } catch (err) {
    next(err)
  }
}
