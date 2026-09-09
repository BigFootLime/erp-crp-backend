import { consumableAccountRights } from '../../stock/domain/consumable-access';
import type { Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../utils/asyncHandler';
import { HttpError } from '../../../utils/httpError';
import { buildAuditContext } from './production.controller';
import { getOfConsumables } from '../repository/consumable-procurement-read.repository';
import { configureOfConsumable,prepareOfConsumables,withdrawOfConsumable,reconcileOfConsumables } from '../repository/consumable-procurement.repository';
import { consumableConfigurationSchema,consumablePreparationSchema,consumableWithdrawalSchema,consumableReconciliationSchema } from '../validators/consumable-procurement.validators';

const ofId=(req:Request)=>z.coerce.number().int().positive().parse(req.params.id);
export const consumableRights=consumableAccountRights;
async function present(data:Awaited<ReturnType<typeof getOfConsumables>>,req:Request){
  const permissions=await consumableRights(req);
  return {...data,permissions,needs:data.needs.map(n=>({...n,catalogue:n.catalogue?{...n.catalogue,price:permissions.prices?n.catalogue.price:null}:null,
    catalogues:n.catalogues.map(c=>({...c,price:permissions.prices?c.price:null}))})),
    otherPurchases:data.otherPurchases.map(p=>({...p,pu_achat:permissions.prices?p.pu_achat:null}))};
}
export const readConsumables=asyncHandler(async(req,res)=>{res.json(await present(await getOfConsumables(ofId(req)),req));});
export const configureConsumable=asyncHandler(async(req,res)=>{
  const access=await consumableRights(req);
  if(!access.configure&&!access.purchase)throw new HttpError(403,'CONSUMABLE_CONFIGURE_FORBIDDEN','Les droits de préparation ou d’achat sont nécessaires.');
  res.json(await present(await configureOfConsumable(ofId(req),consumableConfigurationSchema.parse(req.body),buildAuditContext(req)),req));
});
export const prepareConsumables=asyncHandler(async(req,res)=>{
  const result=await prepareOfConsumables(ofId(req),consumablePreparationSchema.parse(req.body),buildAuditContext(req),await consumableRights(req));
  res.json({...result,coverage:await present(result.coverage,req)});
});
export const withdrawConsumable=asyncHandler(async(req,res)=>{
  if(!(await consumableRights(req)).withdraw)throw new HttpError(403,'CONSUMABLE_WITHDRAWAL_FORBIDDEN','Les droits de réservation et de sortie de stock sont nécessaires.');
  const result=await withdrawOfConsumable(ofId(req),consumableWithdrawalSchema.parse(req.body),buildAuditContext(req));
  res.json({...result,coverage:await present(result.coverage,req)});
});
export const reconcileConsumables=asyncHandler(async(req,res)=>{
  const rights=await consumableRights(req);
  if(!rights.configure||!rights.reserve)throw new HttpError(403,'CONSUMABLE_RECONCILIATION_FORBIDDEN','Les droits de préparation et de réservation sont nécessaires.');
  res.json(await present(await reconcileOfConsumables(ofId(req),consumableReconciliationSchema.parse(req.body),buildAuditContext(req)),req));
});