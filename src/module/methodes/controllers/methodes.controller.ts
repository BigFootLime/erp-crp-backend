// HTTP handlers du module Méthodes.

import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import { methodesCapabilitiesFor } from "../domain/methodes-policy";
import {
  addCostCenterRateSVC,
  createCostCenterSVC,
  createMachineFamilySVC,
  getCostCenterSVC,
  getMachineQualificationSVC,
  listCostCenterRatesSVC,
  listCostCentersSVC,
  listMachineFamiliesSVC,
  listMachineOptionsSVC,
  listMachinesForQualificationSVC,
  previewMachineQualificationSVC,
  qualifyMachineSVC,
  updateCostCenterSVC,
  updateMachineFamilySVC,
} from "../services/methodes.service";
import type { AuditContext } from "../types/methodes.types";
import {
  addCostCenterRateSchema,
  createCostCenterSchema,
  createFamilySchema,
  listCostCentersQuerySchema,
  listFamiliesQuerySchema,
  listMachineOptionsQuerySchema,
  listMachinesQualificationQuerySchema,
  previewMachineQualificationQuerySchema,
  qualifyMachineSchema,
  updateCostCenterSchema,
  updateFamilySchema,
  validatedQuery,
} from "../validators/methodes.validators";

export function buildMethodesAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  return {
    user_id: user.id,
    role: user.role ?? null,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    client_session_id:
      typeof req.headers["x-client-session-id"] === "string"
        ? req.headers["x-client-session-id"]
        : typeof req.headers["x-session-id"] === "string"
          ? req.headers["x-session-id"]
          : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Capacités                                                                  */
/* -------------------------------------------------------------------------- */

export const readMethodesCapabilities: RequestHandler = (req, res, next) => {
  try {
    if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
    res.json({ capabilities: methodesCapabilitiesFor(req.user.role) });
  } catch (error) {
    next(error);
  }
};

/* -------------------------------------------------------------------------- */
/* Familles machine                                                           */
/* -------------------------------------------------------------------------- */

export const listMachineFamilies: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<ReturnType<(typeof listFamiliesQuerySchema)["parse"]>>(req);
    res.json(await listMachineFamiliesSVC(query.include_inactive));
  } catch (error) {
    next(error);
  }
};

export const createMachineFamily: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = createFamilySchema.parse(req.body);
    res.status(201).json(await createMachineFamilySVC(body, audit));
  } catch (error) {
    next(error);
  }
};

export const updateMachineFamily: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = updateFamilySchema.parse(req.body);
    const out = await updateMachineFamilySVC(String(req.params.code).toUpperCase(), body, audit);
    if (!out) throw new HttpError(404, "NOT_FOUND", "Famille machine introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};

/* -------------------------------------------------------------------------- */
/* Centres de frais                                                           */
/* -------------------------------------------------------------------------- */

export const listCostCenters: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<ReturnType<(typeof listCostCentersQuerySchema)["parse"]>>(req);
    res.json(
      await listCostCentersSVC({
        search: query.search ?? null,
        statut: query.statut ?? null,
        machine_family_code: query.machine_family_code ?? null,
        include_archived: query.include_archived,
      })
    );
  } catch (error) {
    next(error);
  }
};

export const getCostCenter: RequestHandler = async (req, res, next) => {
  try {
    const out = await getCostCenterSVC(req.params.cfId);
    if (!out) throw new HttpError(404, "NOT_FOUND", "Centre de frais introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};

export const createCostCenter: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = createCostCenterSchema.parse(req.body);
    res.status(201).json(await createCostCenterSVC(body, audit));
  } catch (error) {
    next(error);
  }
};

export const updateCostCenter: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = updateCostCenterSchema.parse(req.body);
    const out = await updateCostCenterSVC(req.params.cfId, body, audit);
    if (!out) throw new HttpError(404, "NOT_FOUND", "Centre de frais introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};

export const listCostCenterRates: RequestHandler = async (req, res, next) => {
  try {
    res.json(await listCostCenterRatesSVC(req.params.cfId));
  } catch (error) {
    next(error);
  }
};

export const addCostCenterRate: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = addCostCenterRateSchema.parse(req.body);
    res.status(201).json(await addCostCenterRateSVC(req.params.cfId, body, audit));
  } catch (error) {
    next(error);
  }
};

/* -------------------------------------------------------------------------- */
/* Machines                                                                   */
/* -------------------------------------------------------------------------- */

export const listMachineOptions: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<ReturnType<(typeof listMachineOptionsQuerySchema)["parse"]>>(req);
    res.json(
      await listMachineOptionsSVC({
        machine_family_code: query.machine_family_code ?? null,
        search: query.search ?? null,
        include_unselectable: query.include_unselectable,
      })
    );
  } catch (error) {
    next(error);
  }
};

/* -------------------------------------------------------------------------- */
/* Qualification du parc machine (#233)                                       */
/* -------------------------------------------------------------------------- */

export const listMachinesForQualification: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<ReturnType<(typeof listMachinesQualificationQuerySchema)["parse"]>>(req);
    res.json(
      await listMachinesForQualificationSVC({
        search: query.search ?? null,
        only_unqualified: query.only_unqualified,
        include_archived: query.include_archived,
      })
    );
  } catch (error) {
    next(error);
  }
};

export const getMachineQualification: RequestHandler = async (req, res, next) => {
  try {
    const out = await getMachineQualificationSVC(req.params.machineId);
    if (!out) throw new HttpError(404, "NOT_FOUND", "Machine introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};

/** Aperçu d'impact : lecture seule, appelée avant de confirmer une décision. */
export const previewMachineQualification: RequestHandler = async (req, res, next) => {
  try {
    const query = validatedQuery<ReturnType<(typeof previewMachineQualificationQuerySchema)["parse"]>>(req);
    const out = await previewMachineQualificationSVC(req.params.machineId, query.machine_family_code ?? null);
    if (!out) throw new HttpError(404, "NOT_FOUND", "Machine introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};

export const qualifyMachine: RequestHandler = async (req, res, next) => {
  try {
    const audit = buildMethodesAuditContext(req);
    const body = qualifyMachineSchema.parse(req.body);
    const out = await qualifyMachineSVC(
      req.params.machineId,
      {
        machine_family_code: body.machine_family_code,
        cf_id: body.cf_id,
        valid_from: body.valid_from ?? null,
        valid_to: body.valid_to ?? null,
        motif: body.motif,
        expected_updated_at: body.expected_updated_at,
      },
      audit
    );
    if (!out) throw new HttpError(404, "NOT_FOUND", "Machine introuvable");
    res.json(out);
  } catch (error) {
    next(error);
  }
};
