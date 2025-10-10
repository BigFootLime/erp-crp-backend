import { Router } from "express"
import multer from "multer"
import path from "path"
import fs from "fs"
import { createCommande, deleteCommande, generateAffairesFromOrder, getCommande, listCommandes } from "../controllers/commande-client.controller"
import { createCommandeBodySchema, idParamSchema, validate } from "../validators/commande-client.validators"
import { z } from "zod"

// Storage vers /uploads/docs (ou ton NAS si prod)
const ensureDir = (dir: string) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }
const uploadDir = path.resolve("uploads/docs")
ensureDir(uploadDir)
const upload = multer({ dest: uploadDir })

// middleware pour parser `data` JSON depuis multipart
function parseCommandeBody(req: any, _res: any, next: any) {
  try {
    const raw = req.body?.data
    if (!raw) throw new Error("payload manquant")
    const json = JSON.parse(raw)
    // validation zod ici pour renvoyer 400 tôt
    const parsed = createCommandeBodySchema.safeParse(json)
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      return _res.status(400).json({ error: msg })
    }
    req.parsedCommandeBody = parsed.data
    next()
  } catch (e:any) {
    return _res.status(400).json({ error: e?.message || "Invalid payload" })
  }
}

const router = Router()

// POST /api/v1/commandes  (multipart: data + documents[])
router.post("/", upload.array("documents[]"), parseCommandeBody, createCommande)

// GET /api/v1/commandes
router.get("/", listCommandes)

// GET /api/v1/commandes/:id
router.get("/:id", validate(idParamSchema), getCommande)

// DELETE /api/v1/commandes/:id
router.delete("/:id", validate(idParamSchema), deleteCommande)

// POST /api/v1/commandes/:id/generate-affaires
router.post("/:id/generate-affaires", validate(idParamSchema), generateAffairesFromOrder)

export default router
