import { Router, type RequestHandler } from "express";

import { HttpError } from "../../utils/httpError";
import { isDemoMode } from "../../config/demo-mode";
import { collectDocumentServiceCapabilities } from "./document-service-capabilities";

const router = Router();

const getDocumentServiceCapabilities: RequestHandler = async (req, res, next) => {
  try {
    if (typeof req.user?.id !== "number") {
      throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    }
    // The demo never has a document vault.  Do not probe a mounted volume or
    // invoke storage/scanner health checks from its public presentation UI.
    if (isDemoMode()) {
      res.json({
        contract_version: 1,
        status: "degraded",
        document_writes_supported: false,
        reason_code: "GED_VAULT_NOT_CONFIGURED",
        checked_at: new Date().toISOString(),
      });
      return;
    }
    res.json(await collectDocumentServiceCapabilities());
  } catch (error) {
    next(error);
  }
};

router.get("/documents", getDocumentServiceCapabilities);

export default router;
