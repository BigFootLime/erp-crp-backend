import { Router, type RequestHandler } from "express";

import { HttpError } from "../../utils/httpError";
import { collectDocumentServiceCapabilities } from "./document-service-capabilities";

const router = Router();

const getDocumentServiceCapabilities: RequestHandler = async (req, res, next) => {
  try {
    if (typeof req.user?.id !== "number") {
      throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    }
    res.json(await collectDocumentServiceCapabilities());
  } catch (error) {
    next(error);
  }
};

router.get("/documents", getDocumentServiceCapabilities);

export default router;
