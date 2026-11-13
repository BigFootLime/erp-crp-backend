import type { RequestHandler } from "express";
import { z } from "zod";
import { contractClientIdSchema, contractIdempotencySchema } from "../validators/client-contract.validators";
import { legacyContractBindSchema, legacyContractOrderIdSchema, legacyContractQuerySchema } from "../validators/client-contract-legacy.validators";
import { bindLegacyContractOrder, getLegacyContractOrders, getLegacyContractPreview } from "../services/client-contract-legacy.service";
import { clientContractAuditContext } from "./client-contract.controller";

const contractId = z.string().uuid().transform(value => value.toLowerCase());
export const listLegacyContractOrders: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    const query = legacyContractQuerySchema.parse(req.query);
    res.json(await getLegacyContractOrders(contractClientIdSchema.parse(req.params.id), contractId.parse(req.params.contractId), query.page));
  } catch (error) { next(error); }
};
export const readLegacyContractPreview: RequestHandler = async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.json(await getLegacyContractPreview(contractClientIdSchema.parse(req.params.id), contractId.parse(req.params.contractId),
      legacyContractOrderIdSchema.parse(req.params.commandeId)));
  } catch (error) { next(error); }
};
export const postLegacyContractAssociation: RequestHandler = async (req, res, next) => {
  try {
    const result = await bindLegacyContractOrder(contractClientIdSchema.parse(req.params.id), contractId.parse(req.params.contractId),
      legacyContractBindSchema.parse(req.body), contractIdempotencySchema.parse(req.headers["idempotency-key"]), clientContractAuditContext(req));
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Idempotency-Replayed", result.replayed ? "true" : "false");
    res.status(result.replayed ? 200 : 201).json(result.association);
  } catch (error) { next(error); }
};
