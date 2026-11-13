import { Router } from "express";
import { z } from "zod";
import pool from "../../../config/database";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { companyContextForRequest } from "../runtime/company-runtime.middleware";
import { verifyIntercompanyDelivery, intercompanyTransportConfiguration } from "./intercompany-transport";
import { receiveIntercompanyMessage, type IntercompanyHandlers } from "./intercompany-inbox.repository";
import { applyCommercialIntercompanyMessageTx } from "./commercial-intercompany-message.repository";
import { applyIntercompanyFulfilmentMessageTx } from "./intercompany-fulfilment.repository";
import { applyPurchaseSubmittedTx, applyCancellationRequestedTx, decideIntercompanyRequest, getIntercompanyRequest, listIntercompanyRequests } from "./intercompany-requests.repository";

const id = z.string().uuid();
const handlers: IntercompanyHandlers = {
  RELATION_PROPOSED: applyCommercialIntercompanyMessageTx,
  RELATION_ACCEPTED: applyCommercialIntercompanyMessageTx,
  PURCHASE_SUBMITTED: applyPurchaseSubmittedTx,
  CANCEL_REQUESTED: applyCancellationRequestedTx,
  ORDER_DECIDED: applyCommercialIntercompanyMessageTx,
  CATALOGUE_PUBLISHED: applyCommercialIntercompanyMessageTx,
  SHIPMENT_DISPATCHED: applyIntercompanyFulfilmentMessageTx,
};

/** Mounted before JWT middleware; only fixed peer HMAC authentication is accepted. */
export const intercompanyDeliveryRoutes = Router();
intercompanyDeliveryRoutes.post("/messages", asyncHandler(async (req, res) => {
  const message = verifyIntercompanyDelivery(intercompanyTransportConfiguration(), name => req.get(name), req.body);
  const receipt = await receiveIntercompanyMessage(pool, message, handlers);
  res.setHeader("Cache-Control", "no-store"); res.status(200).json(receipt);
}));

/** Mounted after JWT + module gate, before /commandes/:id. */
export const intercompanyRequestRoutes = Router();
intercompanyRequestRoutes.use((req, _res, next) => {
  if (!companyContextForRequest(req)) return next(new HttpError(404, "NOT_FOUND", "Ressource introuvable."));
  next();
});
intercompanyRequestRoutes.get("/", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.json(await listIntercompanyRequests(pool, companyContextForRequest(req)!, req.query));
}));
intercompanyRequestRoutes.get("/:id", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store"); res.json(await getIntercompanyRequest(pool, companyContextForRequest(req)!, id.parse(req.params.id)));
}));
intercompanyRequestRoutes.post("/:id/decision", asyncHandler(async (req, res) => {
  if (!req.user?.id) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  res.setHeader("Cache-Control", "no-store"); res.json(await decideIntercompanyRequest(pool, companyContextForRequest(req)!, req.user.id, id.parse(req.params.id), req.body));
}));

/** Buyer-local delivery/decision state, mounted under Commandes fournisseurs. */
export const intercompanyPurchaseTrackingRoutes = Router();
intercompanyPurchaseTrackingRoutes.get("/:id/intercompany", asyncHandler(async (req, res) => {
  const context = companyContextForRequest(req);
  if (!context || !context.module_keys.includes("commandes-fournisseurs")) throw new HttpError(404, "NOT_FOUND", "Suivi introuvable.");
  const purchaseId = id.parse(req.params.id);
  const link = (await pool.query<{ buyer_sales_order_id: string; supplier_company_id: string; supplier_request_id: string | null; supplier_request_revision: number | null;
    supplier_decision_version: number | null; supplier_order_state: string | null; supplier_sales_order_id: string | null }>(
    `SELECT link.buyer_sales_order_id::text,relation.supplier_company_id::text,link.supplier_request_id::text,link.supplier_request_revision,link.supplier_decision_version,
      link.supplier_order_state,link.supplier_sales_order_id
     FROM public.intercompany_purchase_order_links link JOIN public.intercompany_supplier_relations relation ON relation.id=link.relation_id
     WHERE link.buyer_purchase_order_id=$1::uuid AND relation.buyer_company_id=$2::uuid AND relation.environment=$3 AND relation.local_role='BUYER'`,
    [purchaseId, context.company_id, context.environment])).rows[0];
  if (!link) throw new HttpError(404, "INTERCOMPANY_PURCHASE_LINK_NOT_FOUND", "Cet achat n'est pas une commande entre entreprises.");
  const messages = await pool.query<{ id: string; kind: string; revision: number; attempts: number; next_attempt_at: string; delivered_at: string | null; last_error_code: string | null }>(
    `SELECT id::text,kind,revision,attempts,next_attempt_at::text,delivered_at::text,last_error_code FROM public.cerp_intercompany_outbox
     WHERE source_company_id=$1::uuid AND environment=$2 AND aggregate_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20`,
    [context.company_id, context.environment, purchaseId]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ purchase_order_id: purchaseId, buyer_sales_order_id: link.buyer_sales_order_id, supplier_company_id: link.supplier_company_id,
    supplier_request_id: link.supplier_request_id, supplier_request_revision: link.supplier_request_revision,
    supplier_decision_version: link.supplier_decision_version, supplier_order_state: link.supplier_order_state,
    supplier_sales_order_id: link.supplier_sales_order_id, messages: messages.rows });
}));
