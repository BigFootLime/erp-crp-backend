import type { NextFunction, Request, Response } from "express";

import { HttpError } from "../../../utils/httpError";
import { parseId } from "../../../utils/parseId";
import { linkToolSupplierOfferSchema, priceVariationReportQuerySchema } from "../validators/outil.validator";
import { linkToolSupplierOffer, listMasterToolSuppliers, listToolIndicativePriceHistory, listToolSupplierOffers, priceVariationReport } from "../repository/outil-supplier-catalogue.repository";

function audit(req: Request) {
  if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  const forwarded = req.headers["x-forwarded-for"];
  return { userId: req.user.id, ip: typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() ?? null : req.ip ?? null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
    path: req.originalUrl ?? null, pageKey: typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null,
    sessionId: typeof req.headers["x-client-session-id"] === "string" ? req.headers["x-client-session-id"] : null };
}

export async function getMasterToolSuppliers(_req: Request, res: Response, next: NextFunction) { try { res.json(await listMasterToolSuppliers()); } catch (error) { next(error); } }
export async function getToolSupplierOffers(req: Request, res: Response, next: NextFunction) { try { res.json(await listToolSupplierOffers(parseId(req.params.id, "ID Outil"))); } catch (error) { next(error); } }
export async function postToolSupplierOffer(req: Request, res: Response, next: NextFunction) { try {
  const body = linkToolSupplierOfferSchema.parse(req.body); res.status(201).json(await linkToolSupplierOffer(parseId(req.params.id, "ID Outil"), body.catalogue_id, body.source, audit(req)));
} catch (error) { next(error); } }
export async function getToolIndicativePriceHistory(req: Request, res: Response, next: NextFunction) { try { res.json(await listToolIndicativePriceHistory(parseId(req.params.id, "ID Outil"))); } catch (error) { next(error); } }
export async function getPriceVariationReport(req: Request, res: Response, next: NextFunction) { try {
  const query = priceVariationReportQuerySchema.parse(req.query); res.json({ comparison: { currency: query.devise, unit: query.unite, price_kind: "ACTUAL_PURCHASE" }, items: await priceVariationReport(query) });
} catch (error) { next(error); } }

/** Legacy endpoints remain deliberately non-mutating: suppliers are mastered by /fournisseurs. */
export function rejectLegacyToolSupplierWrite(_req: Request, _res: Response, next: NextFunction) {
  next(new HttpError(410, "OUTILLAGE_SUPPLIER_MASTER_MOVED", "Créez ou modifiez le fournisseur dans le module Fournisseurs maître."));
}
