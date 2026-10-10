import type { RequestHandler } from 'express';
import { z } from 'zod';
import { clientContractAuditContext } from './client-contract.controller';
import { contractClientIdSchema, contractIdempotencySchema } from '../validators/client-contract.validators';
import { clientReplenishmentPreparationSchema } from '../validators/client-contract-replenishment.validators';
import { getClientReplenishmentPreparation, prepareClientReplenishment } from '../services/client-contract-replenishment.service';

const uuid = z.string().uuid().transform(value => value.toLowerCase());
const readQuery = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1) }).strict();
export const readClientContractReplenishment: RequestHandler = async (req, res, next) => {
  try {
    const query = readQuery.parse(req.query);
    const result = await getClientReplenishmentPreparation(contractClientIdSchema.parse(req.params.id), uuid.parse(req.params.contractId),
      req.params.planId ? uuid.parse(req.params.planId) : undefined, query.page);
    res.setHeader('Cache-Control', 'private, no-store'); res.json(result);
  } catch (error) { next(error); }
};
export const postClientContractReplenishment: RequestHandler = async (req, res, next) => {
  try {
    const saved = await prepareClientReplenishment(contractClientIdSchema.parse(req.params.id), uuid.parse(req.params.contractId),
      clientReplenishmentPreparationSchema.parse(req.body), contractIdempotencySchema.parse(req.headers['idempotency-key']), clientContractAuditContext(req));
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Idempotency-Replayed', saved.replayed ? 'true' : 'false');
    res.status(saved.replayed ? 200 : 201).json({ ...saved.result, replayed: saved.replayed });
  } catch (error) { next(error); }
};
