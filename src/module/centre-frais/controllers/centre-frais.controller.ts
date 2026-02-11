// src/module/pieces-families/controllers/pieces-families.controller.ts
import { RequestHandler } from "express"
import {
  createPieceCFSVC,
  deletePieceCFSVC,
  getPieceCFSVC,
  listPieceCFSVC,
  updatePieceCFSVC,
} from "../services/centre-frais.service"

export const createPieceCF: RequestHandler = async (req, res, next) => {
  try {
    const row = await createPieceCFSVC(req.body)
    res.status(201).json(row)
  } catch (err) {
    next(err)
  }
}

export const listPieceCF: RequestHandler = async (_req, res, next) => {
  try {
    const rows = await listPieceCFSVC()
    res.json(rows)
  } catch (err) {
    next(err)
  }
}

export const getPieceCF: RequestHandler = async (req, res, next) => {
  try {
    const row = await getPieceCFSVC(req.params.id)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const updatePieceCF: RequestHandler = async (req, res, next) => {
  try {
    const row = await updatePieceCFSVC(req.params.id, req.body)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const deletePieceCF: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deletePieceCFSVC(req.params.id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}
