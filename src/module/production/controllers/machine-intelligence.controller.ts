import { asyncHandler } from "../../../utils/asyncHandler";
import { machineIdParamSchema } from "../validators/production.validators";
import {
  listMachineModelsQuerySchema,
  machineModelIdParamSchema,
} from "../validators/machine-intelligence.validators";
import {
  svcGetMachineModel,
  svcListMachineCapabilities,
  svcListMachineDocuments,
  svcListMachineModelCapabilities,
  svcListMachineModelDocuments,
  svcListMachineModels,
} from "../services/machine-intelligence.service";

export const listMachineModels = asyncHandler(async (req, res) => {
  const query = listMachineModelsQuerySchema.parse(req.query);
  const out = await svcListMachineModels(query);
  res.json(out);
});

export const getMachineModel = asyncHandler(async (req, res) => {
  const { id } = machineModelIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetMachineModel(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const listMachineModelCapabilities = asyncHandler(async (req, res) => {
  const { id } = machineModelIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListMachineModelCapabilities(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const listMachineModelDocuments = asyncHandler(async (req, res) => {
  const { id } = machineModelIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListMachineModelDocuments(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const listMachineCapabilities = asyncHandler(async (req, res) => {
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListMachineCapabilities(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const listMachineDocuments = asyncHandler(async (req, res) => {
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcListMachineDocuments(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});
