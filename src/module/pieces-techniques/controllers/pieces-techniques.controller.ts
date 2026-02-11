// src/module/pieces-techniques/controllers/pieces-techniques.controller.ts
import { RequestHandler } from "express"
import {
  createPieceTechniqueSVC,
  deletePieceTechniqueSVC,
  getPieceTechniqueSVC,
  listPieceTechniquesSVC,
  updatePieceTechniqueSVC,
} from "../services/pieces-techniques.service"

export const createPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const row = await createPieceTechniqueSVC(req.body)
    res.status(201).json(row)
  } catch (err) {
    next(err)
  }
}

export const listPieceTechniques: RequestHandler = async (_req, res, next) => {
  try {
    const rows = await listPieceTechniquesSVC()
    res.json(rows)
  } catch (err) {
    next(err)
  }
}

export const getPieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const row = await getPieceTechniqueSVC(req.params.id)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const updatePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const row = await updatePieceTechniqueSVC(req.params.id, req.body)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const deletePieceTechnique: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deletePieceTechniqueSVC(req.params.id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}
