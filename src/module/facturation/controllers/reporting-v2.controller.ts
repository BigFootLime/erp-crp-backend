// Reporting commercial 360 (#275) — surface HTTP.
//
// Le contrôleur ne calcule rien : il valide, résout les permissions réelles de
// l'appelant et délègue. Chaque handler renvoie `{ envelope, data, … }`.

import type { RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import {
  buildExport,
  getClientsSection,
  getDefinitions,
  getDeliveriesSection,
  getDrilldown,
  getInvoicingSection,
  getOrdersSection,
  getOverview,
  getQuotesSection,
  getReceivablesSection,
  resolvePermissions,
  resolveRequest,
} from "../services/reporting-v2.service";
import {
  drilldownQuerySchema,
  exportQuerySchema,
  reportingFiltersSchema,
} from "../validators/reporting-v2.validators";

function requireUser(req: Parameters<RequestHandler>[0]) {
  if (!req.user) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return req.user;
}

/** Les résultats de reporting ne sont jamais mis en cache par un intermédiaire. */
function sealResponse(res: Parameters<RequestHandler>[1]) {
  res.setHeader("Cache-Control", "no-store, private");
}

function handler(
  run: (
    request: ReturnType<typeof resolveRequest>,
    permissions: ReturnType<typeof resolvePermissions>
  ) => unknown | Promise<unknown>
): RequestHandler {
  return async (req, res, next) => {
    try {
      const user = requireUser(req);
      const query = reportingFiltersSchema.parse(req.query);
      const request = resolveRequest(query);
      const permissions = resolvePermissions(user.role);
      sealResponse(res);
      res.json(await run(request, permissions));
    } catch (err) {
      next(err);
    }
  };
}

export const reportingOverview = handler(getOverview);
export const reportingQuotes = handler(getQuotesSection);
export const reportingOrders = handler(getOrdersSection);
export const reportingDeliveries = handler(getDeliveriesSection);
export const reportingInvoicing = handler(getInvoicingSection);
export const reportingReceivables = handler(getReceivablesSection);
export const reportingClients = handler(getClientsSection);
export const reportingDefinitions = handler(getDefinitions);

export const reportingDrilldown: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = drilldownQuerySchema.parse(req.query);
    const request = resolveRequest(query);
    const permissions = resolvePermissions(user.role);
    sealResponse(res);
    res.json(await getDrilldown(request, query, permissions));
  } catch (err) {
    next(err);
  }
};

export const reportingExport: RequestHandler = async (req, res, next) => {
  try {
    const user = requireUser(req);
    const query = exportQuerySchema.parse(req.query);
    const request = resolveRequest(query);
    const permissions = resolvePermissions(user.role);
    const payload = await buildExport(request, query, permissions, {
      id: user.id,
      username: user.username,
    });

    sealResponse(res);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${payload.filename}"`);
    res.setHeader("X-CERP-Export-Checksum", payload.checksum_sha256);
    res.setHeader("X-CERP-Export-Rows", String(payload.rows));
    // BOM : Excel FR ouvre le CSV en UTF-8 sans casser les accents.
    res.send(`﻿${payload.content}`);
  } catch (err) {
    next(err);
  }
};
