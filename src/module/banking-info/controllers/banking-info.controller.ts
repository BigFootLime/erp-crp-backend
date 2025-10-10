// src/module/banking-info/controllers/banking-info.controller.ts
import { RequestHandler } from "express"
import {
  createBankingInfoSVC,
  deleteBankingInfoSVC,
  getBankingInfoSVC,
  listBankingInfosSVC,
  updateBankingInfoSVC,
} from "../services/banking-info.service"

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
    const row = await getBankingInfoSVC(req.params.id)
    if (!row) { res.status(404).json({ error: "Not found" }); return }
    res.json(row)
  } catch (err) { next(err) }
}

export const updateBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const row = await updateBankingInfoSVC(req.params.id, req.body)
    if (!row) { res.status(404).json({ error: "Not found" }); return }
    res.json(row)
  } catch (err) { next(err) }
}

export const deleteBankingInfo: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deleteBankingInfoSVC(req.params.id)
    if (!ok) { res.status(404).json({ error: "Not found" }); return }
    res.status(204).send()
  } catch (err) { next(err) }
}
