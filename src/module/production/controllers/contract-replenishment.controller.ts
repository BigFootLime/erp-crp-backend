import type { RequestHandler } from 'express';
import { z } from 'zod';
import { clientContractAuditContext } from '../../client/controllers/client-contract.controller';
import { contractClientIdSchema, contractIdempotencySchema } from '../../client/validators/client-contract.validators';
import { clientReplenishmentLaunchSchema } from '../../client/validators/client-contract-replenishment.validators';
import { generateClientContractReplenishment } from '../../client/services/client-contract-replenishment-launch.service';

const uuid = z.string().uuid().transform(value => value.toLowerCase());

/** The route lives under production, so a client-write grant cannot create OFs. */
export const generateContractReplenishment: RequestHandler = async (req, res, next) => {
  try {
    const saved = await generateClientContractReplenishment(
      contractClientIdSchema.parse(req.params.clientId), uuid.parse(req.params.contractId),
      clientReplenishmentLaunchSchema.parse(req.body), contractIdempotencySchema.parse(req.headers['idempotency-key']),
      { ...clientContractAuditContext(req), page_key: 'production.replenishment' }, req.user?.role);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Idempotency-Replayed', saved.replayed ? 'true' : 'false');
    res.status(saved.replayed ? 200 : 201).json({ ...saved.result, replayed: saved.replayed });
  } catch (error) { next(error); }
};
