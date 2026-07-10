import type { Request, Response } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import * as svc from "../services/temps-deplacements-admin.service";
import {
  contractBodySchema,
  listContractsQuerySchema,
  listSchedulesQuerySchema,
  ruleSetBodySchema,
  scheduleBodySchema,
  setActiveSchema,
  uuidParamsSchema,
} from "../validators/temps-deplacements.validators";
import { buildAuditContext, requireUser } from "./temps-deplacements.controller";

// -------------------------------------------------------------- Employés (pickers)
export const getEmployees = asyncHandler(async (req: Request, res: Response) => {
  res.json(await svc.listEmployees(requireUser(req)));
});

// -------------------------------------------------------------- Rule sets
export const getRuleSets = asyncHandler(async (req: Request, res: Response) => {
  res.json(await svc.listRuleSets(requireUser(req)));
});
export const postRuleSet = asyncHandler(async (req: Request, res: Response) => {
  const body = ruleSetBodySchema.parse(req.body);
  res.status(201).json(await svc.createRuleSet(requireUser(req), body, buildAuditContext(req)));
});
export const putRuleSet = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = ruleSetBodySchema.parse(req.body);
  res.json(await svc.updateRuleSet(requireUser(req), id, body, buildAuditContext(req)));
});
export const patchRuleSetActive = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { active } = setActiveSchema.parse(req.body);
  res.json(await svc.setRuleSetActive(requireUser(req), id, active, buildAuditContext(req)));
});

// -------------------------------------------------------------- Contrats
export const getContracts = asyncHandler(async (req: Request, res: Response) => {
  const { employee_id } = listContractsQuerySchema.parse(req.query);
  res.json(await svc.listContracts(requireUser(req), employee_id));
});
export const postContract = asyncHandler(async (req: Request, res: Response) => {
  const body = contractBodySchema.parse(req.body);
  res.status(201).json(await svc.createContract(requireUser(req), body, buildAuditContext(req)));
});
export const putContract = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = contractBodySchema.parse(req.body);
  res.json(await svc.updateContract(requireUser(req), id, body, buildAuditContext(req)));
});
export const patchContractActive = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const { active } = setActiveSchema.parse(req.body);
  res.json(await svc.setContractActive(requireUser(req), id, active, buildAuditContext(req)));
});

// -------------------------------------------------------------- Horaires types
export const getSchedules = asyncHandler(async (req: Request, res: Response) => {
  const { employee_id } = listSchedulesQuerySchema.parse(req.query);
  res.json(await svc.listSchedules(requireUser(req), employee_id));
});
export const postSchedule = asyncHandler(async (req: Request, res: Response) => {
  const body = scheduleBodySchema.parse(req.body);
  res.status(201).json(await svc.createSchedule(requireUser(req), body, buildAuditContext(req)));
});
export const putSchedule = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  const body = scheduleBodySchema.parse(req.body);
  res.json(await svc.updateSchedule(requireUser(req), id, body, buildAuditContext(req)));
});
export const deleteScheduleHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = uuidParamsSchema.parse(req.params);
  res.json(await svc.deleteSchedule(requireUser(req), id, buildAuditContext(req)));
});
