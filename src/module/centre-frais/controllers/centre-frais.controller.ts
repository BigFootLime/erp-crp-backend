// src/module/pieces-families/controllers/pieces-families.controller.ts
import { RequestHandler } from "express"
import {
  createPieceCFSVC,
  deletePieceCFSVC,
  getPieceCFSVC,
  listPieceCFSVC,
  updatePieceCFSVC,
} from "../services/centre-frais.service"

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null
}

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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const row = await getPieceCFSVC(id)
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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const row = await updatePieceCFSVC(id, req.body)
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
    const id = routeParam(req.params.id)
    if (!id) {
      res.status(400).json({ error: "id must be a string" })
      return
    }
    const ok = await deletePieceCFSVC(id)
    if (!ok) {
      res.status(404).json({ error: "Not found" })
      return
    }
    res.status(204).send()
  } catch (err) {
    next(err)
  }
}
