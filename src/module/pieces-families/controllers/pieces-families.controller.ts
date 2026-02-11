// src/module/pieces-families/controllers/pieces-families.controller.ts
import { RequestHandler } from "express"
import {
  createPieceFamilySVC,
  deletePieceFamilySVC,
  getPieceFamilySVC,
  listPieceFamiliesSVC,
  updatePieceFamilySVC,
} from "../services/pieces-families.service"

export const createPieceFamily: RequestHandler = async (req, res, next) => {
  try {
    const row = await createPieceFamilySVC(req.body)
    res.status(201).json(row)
  } catch (err) {
    next(err)
  }
}

export const listPieceFamilies: RequestHandler = async (_req, res, next) => {
  try {
    const rows = await listPieceFamiliesSVC()
    res.json(rows)
  } catch (err) {
    next(err)
  }
}

export const getPieceFamily: RequestHandler = async (req, res, next) => {
  try {
    const row = await getPieceFamilySVC(req.params.id)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const updatePieceFamily: RequestHandler = async (req, res, next) => {
  try {
    const row = await updatePieceFamilySVC(req.params.id, req.body)
    if (!row) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.json(row)
  } catch (err) {
    next(err)
  }
}

export const deletePieceFamily: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deletePieceFamilySVC(req.params.id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}
