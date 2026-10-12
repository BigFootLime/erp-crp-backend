import type { RequestHandler } from 'express';
import { contractClientIdSchema } from '../validators/client-contract.validators';
import { clientUrgencyFeeBody } from '../validators/client-urgency-fee.validators';
import { clientContractAuditContext } from './client-contract.controller';
import { readClientUrgencyFee, saveClientUrgencyFee } from '../services/client-urgency-fee.service';
export const getClientUrgencyFee: RequestHandler = async (req,res,next) => {
  try {
    clientContractAuditContext(req);
    res.setHeader('Cache-Control','private, no-store');
    res.json(await readClientUrgencyFee(contractClientIdSchema.parse(req.params.id)));
  } catch (error) { next(error); }
};
export const putClientUrgencyFee: RequestHandler = async (req,res,next) => {
  try {
    const audit = { ...clientContractAuditContext(req), page_key: 'clients.urgency-fee' };
    const result = await saveClientUrgencyFee(contractClientIdSchema.parse(req.params.id),clientUrgencyFeeBody.parse(req.body),audit);
    res.setHeader('Cache-Control','private, no-store'); res.json(result);
  } catch (error) { next(error); }
};
