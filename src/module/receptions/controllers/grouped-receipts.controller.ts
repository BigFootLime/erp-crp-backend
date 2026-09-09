import { consumableAccountRights } from '../../stock/domain/consumable-access';
import { z } from 'zod';
import type { Request } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { buildAuditContext } from '../../production/controllers/production.controller';
import { roleHasStockCapability } from '../../stock/domain/stock-rbac';
import { expectedReceiptsQuerySchema,prepareGroupedReceiptSchema,confirmGroupedReceiptSchema } from '../validators/grouped-receipts.validators';
import { getExpectedReceiptLines } from '../repository/expected-receipts.repository';
import { prepareGroupedReceipt,confirmGroupedReceipt } from '../repository/grouped-receipts.repository';
const permissions=consumableAccountRights;
async function assertReceive(req:Request){if(!(await permissions(req)).receive)throw new HttpError(403,'RECEIPT_CONFIRMATION_FORBIDDEN','Les droits de réception et de stock sont nécessaires.');}
export const expectedReceiptLines=asyncHandler(async(req,res)=>{
  if(!roleHasStockCapability(req.user?.role,'read'))throw new HttpError(403,'RECEIPT_READ_FORBIDDEN','Les droits de consultation des rÃ©ceptions sont nÃ©cessaires.');
  const access=await permissions(req),result=await getExpectedReceiptLines(expectedReceiptsQuerySchema.parse(req.query));
  res.json({...result,permissions:access,items:result.items.map(l=>({...l,price:access.prices?l.price:null}))});
});
export const stageGroupedReceipt=asyncHandler(async(req,res)=>{await assertReceive(req);res.status(201).json(await prepareGroupedReceipt(prepareGroupedReceiptSchema.parse(req.body),buildAuditContext(req)));});
export const validateGroupedReceipt=asyncHandler(async(req,res)=>{await assertReceive(req);res.json(await confirmGroupedReceipt(z.string().uuid().parse(req.params.id),confirmGroupedReceiptSchema.parse(req.body),buildAuditContext(req)));});