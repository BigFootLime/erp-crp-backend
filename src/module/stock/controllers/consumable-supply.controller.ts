import { z } from 'zod';
import type { Request } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { buildAuditContext } from '../../production/controllers/production.controller';
import { consumableRights } from '../../production/controllers/consumable-procurement.controller';
import { getConsumableSupply,resolveConsumableScan,replenishConsumable,depleteConsumablePack } from '../repository/consumable-supply.repository';
import { consumableDepletionSchema,consumableReplenishmentSchema } from '../validators/consumable-supply.validators';
const identity=(req:Request)=>z.string().uuid().parse(req.params.id);
async function present(data:Awaited<ReturnType<typeof getConsumableSupply>>,req:Request){
  const permissions=await consumableRights(req);
  return {...data,permissions,catalogues:data.catalogues.map(c=>({...c,price:permissions.prices?c.price:null}))};
}
export const readConsumableSupply=asyncHandler(async(req,res)=>{res.json(await present(await getConsumableSupply(identity(req)),req));});
export const prepareConsumableSupply=asyncHandler(async(req,res)=>{
  if(!(await consumableRights(req)).purchase)throw new HttpError(403,'CONSUMABLE_PURCHASE_FORBIDDEN','Les droits de préparation des achats sont nécessaires.');
  const result=await replenishConsumable(identity(req),consumableReplenishmentSchema.parse(req.body),buildAuditContext(req));
  res.json({...result,supply:await present(result.supply,req)});
});
export const finishConsumablePack=asyncHandler(async(req,res)=>{
  if(!(await consumableRights(req)).deplete)throw new HttpError(403,'CONSUMABLE_DEPLETION_FORBIDDEN','Les droits de création et de comptabilisation des sorties de stock sont nécessaires.');
  const result=await depleteConsumablePack(identity(req),consumableDepletionSchema.parse(req.body),buildAuditContext(req));
  res.json({...result,supply:await present(result.supply,req)});
});

export const findScannedConsumable=asyncHandler(async(req,res)=>{res.json(await resolveConsumableScan(z.string().trim().min(1).max(255).parse(req.query.scan)));});