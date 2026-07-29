// src/module/gammes/routes/gammes.routes.ts — monté sur /gammes
//
// Les routes de LECTURE et d'ÉCRITURE des opérations déclarent désormais leur
// capacité Méthodes (refus par défaut). Elles restent montées aux mêmes URL :
// aucun écran existant ne change d'adresse.
import { Router } from "express"
import { authenticateToken } from "../../auth/middlewares/auth.middleware"
import { requireMethodesCapability } from "../../methodes/middlewares/methodes-authorization.middleware"
import {
  addGammeOperation,
  deleteGammeOperation,
  listGammeOperations,
  nextGammeOperationPhase,
  publishGamme,
  readGammePublicationReadiness,
  reorderGammeOperations,
  updateGamme,
  updateGammeOperation,
} from "../controllers/gammes.controller"
import {
  addGammeOperationSchema,
  deleteGammeOperationSchema,
  gammeIdParamSchema,
  nextPhaseQuerySchema,
  operationIdParamSchema,
  publishGammeSchema,
  reorderOperationsSchema,
  updateGammeOperationSchema,
  updateGammeSchema,
  validate,
} from "../validators/gammes.validators"

const router = Router()
router.use(authenticateToken)

router.patch("/:gammeId", validate(gammeIdParamSchema), validate(updateGammeSchema), updateGamme)

/* Opérations. */
router.get(
  "/:gammeId/operations",
  requireMethodesCapability("gamme_operation_read"),
  validate(gammeIdParamSchema),
  listGammeOperations
)
// Déclaré AVANT `/:gammeId/operations/:operationId` : sans cela, « next-phase »
// et « reorder » seraient capturés comme des identifiants d'opération.
router.get(
  "/:gammeId/operations/next-phase",
  requireMethodesCapability("gamme_operation_read"),
  validate(gammeIdParamSchema),
  validate(nextPhaseQuerySchema),
  nextGammeOperationPhase
)
router.patch(
  "/:gammeId/operations/reorder",
  requireMethodesCapability("gamme_operation_write"),
  validate(gammeIdParamSchema),
  validate(reorderOperationsSchema),
  reorderGammeOperations
)
router.post(
  "/:gammeId/operations",
  requireMethodesCapability("gamme_operation_write"),
  validate(gammeIdParamSchema),
  validate(addGammeOperationSchema),
  addGammeOperation
)
router.patch(
  "/:gammeId/operations/:operationId",
  requireMethodesCapability("gamme_operation_write"),
  validate(operationIdParamSchema),
  validate(updateGammeOperationSchema),
  updateGammeOperation
)
router.delete(
  "/:gammeId/operations/:operationId",
  requireMethodesCapability("gamme_operation_write"),
  validate(operationIdParamSchema),
  validate(deleteGammeOperationSchema),
  deleteGammeOperation
)

/* Publication : figer une gamme pour la production est un acte distinct. */
router.get(
  "/:gammeId/publication",
  requireMethodesCapability("gamme_operation_read"),
  validate(gammeIdParamSchema),
  readGammePublicationReadiness
)
router.post(
  "/:gammeId/publish",
  requireMethodesCapability("gamme_publish"),
  validate(gammeIdParamSchema),
  validate(publishGammeSchema),
  publishGamme
)

export default router
