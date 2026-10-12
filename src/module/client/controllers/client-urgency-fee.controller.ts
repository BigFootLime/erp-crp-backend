import type { RequestHandler } from 'express';
import { contractClientIdSchema } from '../validators/client-contract.validators';
import { clientUrgencyFeeBody } from '../validators/client-urgency-fee.validators';
import { clientContractAuditContext } from './client-contract.controller';
import { readClientUrgencyFee, saveClientUrgencyFee } from '../services/client-urgency-fee.service';
import { canWriteClient } from '../client.permissions';
export const getClientUrgencyFee: RequestHandler = async (req,res,next) => {
  try {
    clientContractAuditContext(req);
    res.setHeader('Cache-Control','private, no-store');
    const result = await readClientUrgencyFee(contractClientIdSchema.parse(req.params.id));
    res.json({ ...result, can_write: result.client_active && canWriteClient(req.user?.role) });
  } catch (error) { next(error); }
};
export const putClientUrgencyFee: RequestHandler = async (req,res,next) => {
  try {
    const audit = { ...clientContractAuditContext(req), page_key: 'clients.urgency-fee' };
    const result = await saveClientUrgencyFee(contractClientIdSchema.parse(req.params.id),clientUrgencyFeeBody.parse(req.body),audit);
    res.setHeader('Cache-Control','private, no-store');
    res.json({ ...result, can_write: result.client_active && canWriteClient(req.user?.role) });
  } catch (error) { next(error); }
};
