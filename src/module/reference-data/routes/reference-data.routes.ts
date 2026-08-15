import { Router } from "express";

import {
  applyChangeSet,
  createChangeSet,
  decideChangeSet,
  exportReferenceData,
  getChangeSet,
  listChangeSets,
  listRecords,
  previewChanges,
  readCapabilities,
  readCatalog,
} from "../controllers/reference-data.controller";
import { requireReferenceDataCapability } from "../middlewares/reference-data-authorization.middleware";
import {
  changeSetIdParamSchema,
  createReferenceChangeSetSchema,
  datasetCodeParamSchema,
  listReferenceChangesQuerySchema,
  listReferenceRecordsQuerySchema,
  referenceApplySchema,
  referenceDecisionSchema,
  referenceExportQuerySchema,
  referencePreviewSchema,
  validate,
} from "../validators/reference-data.validators";

const router = Router();

router.get("/capabilities", readCapabilities);
router.get("/catalog", requireReferenceDataCapability("view"), readCatalog);
router.get("/export", requireReferenceDataCapability("export"), validate(referenceExportQuerySchema, "query"), exportReferenceData);
router.get("/datasets/:datasetCode", requireReferenceDataCapability("view"), validate(datasetCodeParamSchema, "params"), validate(listReferenceRecordsQuerySchema, "query"), listRecords);
router.post("/changes/preview", requireReferenceDataCapability("propose"), validate(referencePreviewSchema, "body"), previewChanges);
router.post("/imports/preview", requireReferenceDataCapability("import"), validate(referencePreviewSchema, "body"), previewChanges);
router.post("/changes", requireReferenceDataCapability("propose"), validate(createReferenceChangeSetSchema, "body"), createChangeSet);
router.post("/imports", requireReferenceDataCapability("import"), validate(createReferenceChangeSetSchema, "body"), createChangeSet);
router.get("/changes", requireReferenceDataCapability("view"), validate(listReferenceChangesQuerySchema, "query"), listChangeSets);
router.get("/changes/:changeSetId", requireReferenceDataCapability("view"), validate(changeSetIdParamSchema, "params"), getChangeSet);
router.post("/changes/:changeSetId/decision", requireReferenceDataCapability("approve"), validate(changeSetIdParamSchema, "params"), validate(referenceDecisionSchema, "body"), decideChangeSet);
router.post("/changes/:changeSetId/apply", requireReferenceDataCapability("apply"), validate(changeSetIdParamSchema, "params"), validate(referenceApplySchema, "body"), applyChangeSet);

export default router;
