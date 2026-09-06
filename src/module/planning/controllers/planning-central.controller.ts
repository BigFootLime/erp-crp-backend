import type { RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { buildAuditContext } from "./planning.controller";
import { readCentralSettings, readCentralSnapshot } from "../repository/planning-central.repository";
import { createCentralSimulation, getCentralSimulation, applyCentralSimulation, assertCentralActivation } from "../services/planning-central.service";
import { centralApplySchema, centralSimulationSchema, centralWindowSchema } from "../validators/planning-central.validators";
import { requestHasElevatedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasPlanningCapability } from "../domain/planning-rbac";
const key = (value: unknown) => typeof value === "string" ? value : "";
export const centralStatus: RequestHandler = asyncHandler(async (req,res)=>{
  res.setHeader("Cache-Control","no-store");res.json({apiVersion:2,...await readCentralSettings(),
    canManageSchedule:requestHasElevatedAccountModuleAccess(req) || roleHasPlanningCapability(req.user?.role,"manage_schedule")});
});
export const centralSnapshot: RequestHandler = asyncHandler(async(req,res)=>{
  const query=centralWindowSchema.parse(req.query);
  const snapshot=await readCentralSnapshot(query);
  assertCentralActivation(snapshot.activation,"READ");
  res.setHeader("Cache-Control","no-store");res.json(snapshot);
});
export const centralSimulate: RequestHandler = asyncHandler(async(req,res)=>{
  const input=centralSimulationSchema.parse(req.body);
  res.status(201).json(await createCentralSimulation(input,buildAuditContext(req),key(req.headers["idempotency-key"])));
});
export const centralGetSimulation: RequestHandler = asyncHandler(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id);
  res.setHeader("Cache-Control","no-store");res.json(await getCentralSimulation(id,buildAuditContext(req)));
});
export const centralApply: RequestHandler = asyncHandler(async(req,res)=>{
  const id=z.string().uuid().parse(req.params.id),input=centralApplySchema.parse(req.body);
  res.json(await applyCentralSimulation(id,input.revision,buildAuditContext(req),key(req.headers["idempotency-key"])));
});
