// src/module/banking-info/controllers/banking-info.controller.ts
import { RequestHandler } from "express"
import {
  createBankingInfoSVC,
  deleteBankingInfoSVC,
  getBankingInfoSVC,
  listBankingInfosSVC,
  updateBankingInfoSVC,
} from "../services/banking-info.service"

function routeParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null
}

export const createBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const row = await createBankingInfoSVC(req.body)
    res.status(201).json(row)   // ✅ no return of Response
    return                     // (optional) makes intent explicit
  } catch (err) { next(err) }
}

export const listBankingInfos: RequestHandler = async (_req, res, next) => {
  try {
    const rows = await listBankingInfosSVC()
    res.json(rows)
  } catch (err) { next(err) }
}

export const getBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const id = routeParam(req.params.id)
    if (!id) { res.status(400).json({ error: "id must be a string" }); return }
    const row = await getBankingInfoSVC(id)
    if (!row) { res.status(404).json({ error: "Not found" }); return }
    res.json(row)
  } catch (err) { next(err) }
}

export const updateBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const id = routeParam(req.params.id)
    if (!id) { res.status(400).json({ error: "id must be a string" }); return }
    const row = await updateBankingInfoSVC(id, req.body)
    if (!row) { res.status(404).json({ error: "Not found" }); return }
    res.json(row)
  } catch (err) { next(err) }
}

export const deleteBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const id = routeParam(req.params.id)
    if (!id) { res.status(400).json({ error: "id must be a string" }); return }
    const ok = await deleteBankingInfoSVC(id)
    if (!ok) { res.status(404).json({ error: "Not found" }); return }
    res.status(204).send()
  } catch (err) { next(err) }
}
