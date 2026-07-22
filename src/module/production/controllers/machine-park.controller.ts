import fs from "node:fs/promises";

import { asyncHandler } from "../../../utils/asyncHandler";
import { getDocumentStoragePath, isPathInsideDirectory, resolveCerpStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";
import { buildAuditContext } from "./production.controller";
import {
  createMachineMaintenanceEventSchema,
  createMachineMaintenancePlanSchema,
  createMachineDocumentSchema,
  createMachineUnavailabilitySchema,
  listMachineUnavailabilitySchema,
  machineMaintenancePlanIdParamSchema,
  machineDocumentIdParamSchema,
  machineParkIdParamSchema,
  machineUnavailabilityIdParamSchema,
  reactivateMachineSchema,
  updateMachineMaintenancePlanSchema,
  uploadMachineDocumentSchema,
} from "../validators/machine-park.validators";
import {
  svcArchiveMachineUnavailability,
  svcCreateMachineMaintenanceEvent,
  svcCreateMachineMaintenancePlan,
  svcCreateMachineDocument,
  svcCreateMachineUnavailability,
  svcGetMachineParkContext,
  svcGetMachineDocumentForDownload,
  svcListMachineMaintenanceEvents,
  svcListMachineMaintenancePlans,
  svcListMachineUnavailability,
  svcReactivateMachine,
  svcRemoveMachineDocument,
  svcUpdateMachineMaintenancePlan,
  svcUploadMachineDocument,
} from "../services/machine-park.service";

export const getMachineParkContext = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const result = await svcGetMachineParkContext(id);
  if (!result) {
    res.status(404).json({ error: "MACHINE_NOT_FOUND" });
    return;
  }
  res.json(result);
});

export const listMachineUnavailability = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const query = listMachineUnavailabilitySchema.parse({ query: req.query }).query;
  res.json(await svcListMachineUnavailability(id, query));
});

export const createMachineUnavailability = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const body = createMachineUnavailabilitySchema.parse({ body: req.body }).body;
  res.status(201).json(await svcCreateMachineUnavailability({ machineId: id, body, audit: buildAuditContext(req) }));
});

export const archiveMachineUnavailability = asyncHandler(async (req, res) => {
  const { id, unavailabilityId } = machineUnavailabilityIdParamSchema.parse({ params: req.params }).params;
  await svcArchiveMachineUnavailability({ machineId: id, unavailabilityId, audit: buildAuditContext(req) });
  res.status(204).send();
});

export const listMachineMaintenancePlans = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  res.json(await svcListMachineMaintenancePlans(id));
});

export const createMachineMaintenancePlan = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const body = createMachineMaintenancePlanSchema.parse({ body: req.body }).body;
  res.status(201).json(await svcCreateMachineMaintenancePlan({ machineId: id, body, audit: buildAuditContext(req) }));
});

export const updateMachineMaintenancePlan = asyncHandler(async (req, res) => {
  const { id, planId } = machineMaintenancePlanIdParamSchema.parse({ params: req.params }).params;
  const body = updateMachineMaintenancePlanSchema.parse({ body: req.body }).body;
  res.json(await svcUpdateMachineMaintenancePlan({ machineId: id, planId, body, audit: buildAuditContext(req) }));
});

export const listMachineMaintenanceEvents = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  res.json(await svcListMachineMaintenanceEvents(id));
});

export const createMachineMaintenanceEvent = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const body = createMachineMaintenanceEventSchema.parse({ body: req.body }).body;
  res.status(201).json(await svcCreateMachineMaintenanceEvent({ machineId: id, body, audit: buildAuditContext(req) }));
});

export const reactivateMachine = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const { expected_updated_at } = reactivateMachineSchema.parse({ body: req.body }).body;
  await svcReactivateMachine({ machineId: id, expectedUpdatedAt: expected_updated_at, audit: buildAuditContext(req) });
  res.status(204).send();
});

export const createMachineDocument = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  const body = createMachineDocumentSchema.parse({ body: req.body }).body;
  res.status(201).json(await svcCreateMachineDocument({ machineId: id, body, audit: buildAuditContext(req) }));
});

export const uploadMachineDocument = asyncHandler(async (req, res) => {
  const { id } = machineParkIdParamSchema.parse({ params: req.params }).params;
  if (!req.file) throw new HttpError(400, "MACHINE_DOCUMENT_FILE_REQUIRED", "A document file is required.");
  const rawData = typeof req.body?.data === "string" ? req.body.data : null;
  if (!rawData) {
    await fs.unlink(req.file.path).catch(() => undefined);
    throw new HttpError(400, "MACHINE_DOCUMENT_METADATA_REQUIRED", "Document metadata is required.");
  }
  let parsedData: unknown;
  try {
    parsedData = JSON.parse(rawData);
  } catch {
    await fs.unlink(req.file.path).catch(() => undefined);
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON payload in 'data'.");
  }
  const validation = uploadMachineDocumentSchema.safeParse({ body: parsedData });
  if (!validation.success) {
    await fs.unlink(req.file.path).catch(() => undefined);
    throw validation.error;
  }
  const body = validation.data.body;
  res.status(201).json(await svcUploadMachineDocument({ machineId: id, body, file: req.file, audit: buildAuditContext(req) }));
});

export const downloadMachineDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = machineDocumentIdParamSchema.parse({ params: req.params }).params;
  const document = await svcGetMachineDocumentForDownload({ machineId: id, documentId, audit: buildAuditContext(req) });
  if (!document) throw new HttpError(404, "MACHINE_DOCUMENT_NOT_FOUND", "Machine document not found.");
  const baseDirectory = getDocumentStoragePath("machines");
  const absolutePath = resolveCerpStoragePath(document.storage_path, baseDirectory);
  if (!isPathInsideDirectory(baseDirectory, absolutePath)) {
    throw new HttpError(400, "INVALID_STORAGE_PATH", "Invalid document storage path.");
  }
  try {
    await fs.access(absolutePath);
  } catch {
    throw new HttpError(404, "MACHINE_DOCUMENT_FILE_NOT_FOUND", "Machine document file not found.");
  }
  res.setHeader("Content-Type", document.mime_type);
  const download = req.query.download === "true" || req.query.download === "1";
  res.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(document.original_name)}"`
  );
  res.sendFile(absolutePath);
});

export const removeMachineDocument = asyncHandler(async (req, res) => {
  const { id, documentId } = machineDocumentIdParamSchema.parse({ params: req.params }).params;
  await svcRemoveMachineDocument({ machineId: id, documentId, audit: buildAuditContext(req) });
  res.status(204).send();
});
