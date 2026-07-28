// #210 — Configuration de la finition d'une opération de gamme.
//
// Monté sur /api/v1/gammes AVANT le routeur historique des gammes : ces routes
// déclarent des capacités fines et ne doivent hériter d'aucun garde hérité.
// Le routeur historique reste inchangé pour les écrans en production.

import { Router } from "express";

import {
  confirmOperationFinish,
  detachOperationFinish,
  getOperationFinish,
  previewOperationFinish,
} from "../controllers/surface-finish.controller";
import { requireSurfaceFinishCapability } from "../middlewares/surface-finish-authorization.middleware";
import {
  confirmFinishBodySchema,
  detachFinishBodySchema,
  operationFinishParamsSchema,
  previewFinishBodySchema,
  validate,
} from "../validators/surface-finish.validators";

const router = Router();

const params = validate(operationFinishParamsSchema, "params");

router.get(
  "/:gammeId/operations/:operationId/finition",
  requireSurfaceFinishCapability("library_read"),
  params,
  getOperationFinish
);

// Aperçu : lecture pure. Une capacité de prévisualisation suffit — les Achats
// doivent pouvoir regarder sans pouvoir écrire.
router.post(
  "/:gammeId/operations/:operationId/finition/preview",
  requireSurfaceFinishCapability("article_preview"),
  params,
  validate(previewFinishBodySchema),
  previewOperationFinish
);

// Confirmation : commande transactionnelle, clé d'idempotence obligatoire.
router.post(
  "/:gammeId/operations/:operationId/finition/confirm",
  requireSurfaceFinishCapability("article_resolve"),
  params,
  validate(confirmFinishBodySchema),
  confirmOperationFinish
);

router.delete(
  "/:gammeId/operations/:operationId/finition",
  requireSurfaceFinishCapability("operation_configure"),
  params,
  validate(detachFinishBodySchema),
  detachOperationFinish
);

export default router;
