import type { RequestHandler } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { buildAuditContext } from "./planning.controller";
import { readCentralSettings, readCentralSnapshot } from "../repository/planning-central.repository";
import { createCentralSimulation, getCentralSimulation, applyCentralSimulation, assertCentralActivation, unplanCentral } from "../services/planning-central.service";
import { centralApplySchema, centralSimulationSchema, centralWindowSchema, centralUnplanSchema } from "../validators/planning-central.validators";
import { requestHasElevatedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { roleHasPlanningCapability } from "../domain/planning-rbac";
import pool from '../../../config/database';
import { readTaskObservations } from '../repository/duration-learning.repository';
import { HttpError } from '../../../utils/httpError';
import { previewCentralWindow } from '../services/planning-central.service';
import { centralPreviewSchema } from '../validators/planning-central.validators';
import {readCentralPage} from '../services/central-snapshot-pages';
const key = (value: unknown) => typeof value === "string" ? value : "";
export const centralPreview: RequestHandler = asyncHandler(async(req,res)=>{
  const input=centralPreviewSchema.parse(req.body), abort=new AbortController();
  const onClose=()=>{if(!res.writableEnded)abort.abort();};
  res.on('close',onClose);
  const start=performance.now();
  try {
    const result=await previewCentralWindow(input,abort.signal);
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Server-Timing',`planning;dur=${(performance.now()-start).toFixed(1)}`);
    res.json(result);
  } finally {res.off('close',onClose);}
});
export const centralObservations: RequestHandler = asyncHandler(async(req,res)=>{
  const operationId=z.string().uuid().parse(req.params.operationId);
  const query=z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100).default(20)}).parse(req.query);
  const result=await readTaskObservations(pool,operationId,query.offset,query.limit);
  if(!result)throw new HttpError(404,'PLANNING_TASK_NOT_FOUND','Opération introuvable.');
  res.setHeader('Cache-Control','no-store');res.json(result);
});
export const centralUnplan: RequestHandler = asyncHandler(async(req,res)=>{
  res.json(await unplanCentral(centralUnplanSchema.parse(req.body),buildAuditContext(req),key(req.headers["idempotency-key"])));
});
export const centralStatus: RequestHandler = asyncHandler(async (req,res)=>{
  res.setHeader("Cache-Control","no-store");res.json({apiVersion:2,...await readCentralSettings(),
    canManageSchedule:requestHasElevatedAccountModuleAccess(req) || roleHasPlanningCapability(req.user?.role,"manage_schedule")});
});
export const centralSnapshot: RequestHandler = asyncHandler(async(req,res)=>{
  const query=centralWindowSchema.parse(req.query);
  const snapshot=await readCentralPage(query);
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
