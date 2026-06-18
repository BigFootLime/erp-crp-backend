// src/module/pieces-families/controllers/pieces-families.controller.ts
import { RequestHandler } from "express"
import {
  createPieceFamilySVC,
  deletePieceFamilySVC,
  getPieceFamilySVC,
  listPieceFamiliesSVC,
  updatePieceFamilySVC,
} from "../services/pieces-families.service"

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null
}

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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const row = await getPieceFamilySVC(id)
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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const row = await updatePieceFamilySVC(id, req.body)
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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const ok = await deletePieceFamilySVC(id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}
