import type { RequestHandler } from 'express';
import { z } from 'zod';
import { contractClientIdSchema } from '../validators/client-contract.validators';
import { clientContractCoverageQuerySchema } from '../validators/client-contract-coverage.validators';
import { getClientContractCoverage } from '../services/client-contract-coverage.service';

export const readClientContractCoverage: RequestHandler = async (req, res, next) => {
  try {
    const result = await getClientContractCoverage(contractClientIdSchema.parse(req.params.id),
      z.string().uuid().transform(value => value.toLowerCase()).parse(req.params.contractId), clientContractCoverageQuerySchema.parse(req.query));
    res.setHeader('Cache-Control', 'private, no-store'); res.json(result);
  } catch (error) { next(error); }
};
