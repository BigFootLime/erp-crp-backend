import type { RequestHandler } from "express"
import { createCommandeSVC, deleteCommandeSVC, getCommandeSVC, listCommandesSVC, generateAffairesFromOrderSVC } from "../services/commande-client.service"

// POST /api/v1/commandes  (multipart)
// Champ "data" = JSON ; fichiers => documents
export const createCommande: RequestHandler = async (req, res, next) => {
  try {
    // "data" est parsé par un middleware (voir routes) sinon:
    const payload = (req as any).parsedCommandeBody
    const documents = ((req as any).files as Express.Multer.File[] || []).map(f => ({
      filename: f.originalname,
      path: f.path,
      mimetype: f.mimetype,
      size: f.size,
    }))
    const row = await createCommandeSVC(payload, documents)
    res.status(201).json(row); return
  } catch (err) { next(err) }
}

export const listCommandes: RequestHandler = async (_req, res, next) => {
  try { res.json(await listCommandesSVC()) } catch (e) { next(e) }
}

export const getCommande: RequestHandler = async (req, res, next) => {
  try {
    const row = await getCommandeSVC(req.params.id)
    if (!row) { res.status(404).json({error:"Not found"}); return }
    res.json(row)
  } catch (e) { next(e) }
}

export const deleteCommande: RequestHandler = async (req, res, next) => {
  try {
    const ok = await deleteCommandeSVC(req.params.id)
    if (!ok) { res.status(404).json({error:"Not found"}); return }
    res.status(204).send()
  } catch (e) { next(e) }
}

export const generateAffairesFromOrder: RequestHandler = async (req, res, next) => {
  try {
    const out = await generateAffairesFromOrderSVC(req.params.id)
    res.json(out)
  } catch (e) { next(e) }
}
