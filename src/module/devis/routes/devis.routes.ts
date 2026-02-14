import type { RequestHandler } from "express";
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import {
  createDevis,
  convertDevisToCommande,
  deleteDevis,
  getDevis,
  getDevisDocumentFile,
  listDevis,
  updateDevis,
} from "../controllers/devis.controller";
import { createDevisBodySchema, updateDevisBodySchema } from "../validators/devis.validators";

declare global {
  namespace Express {
    interface Request {
      parsedDevisBody?: unknown;
    }
  }
}

const ensureDir = (dir: string) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
const uploadDir = path.resolve("uploads/docs");
ensureDir(uploadDir);
const upload = multer({ dest: uploadDir });

const parseMultipartData = (schema: z.ZodTypeAny): RequestHandler => {
  return (req, _res, next) => {
    const raw = (req.body as { data?: unknown } | undefined)?.data;
    if (typeof raw !== "string" || raw.trim() === "") {
      next(new HttpError(400, "MISSING_DATA", "Missing data field"));
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      next(new HttpError(400, "BAD_JSON", "Invalid JSON in data field"));
      return;
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request";
      next(new HttpError(422, "VALIDATION_ERROR", msg, parsed.error.flatten()));
      return;
    }

    req.parsedDevisBody = parsed.data;
    next();
  };
};

const router = Router();

router.get("/", listDevis);
router.get("/:id", getDevis);
router.get("/:id/documents/:docId/file", getDevisDocumentFile);
router.post("/", upload.array("documents[]"), parseMultipartData(createDevisBodySchema), createDevis);
router.post("/:id/convert-to-commande", convertDevisToCommande);
router.patch("/:id", upload.array("documents[]"), parseMultipartData(updateDevisBodySchema), updateDevis);
router.delete("/:id", deleteDevis);

export default router;
