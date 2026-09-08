import {materialIdentitySchema as identity,materialConfigurationSchema as configuration,materialConfirmationSchema as confirmation,materialSourceRefSchema,materialLotVerificationSchema} from "../validators/of-material.validators";
import type {Request} from "express";
import {asyncHandler} from "../../../utils/asyncHandler";
import {HttpError} from "../../../utils/httpError";
import {buildAuditContext} from "./production.controller";
import {getOfMaterial,configureOfMaterial,confirmOfMaterial,verifyOfMaterialLot,getOperationReadiness} from "../services/of-material.service";
import {roleHasOfCapability} from "../domain/of-rbac";
import {roleHasStockCapability} from "../../stock/domain/stock-rbac";
import {roleHasCommandeFournisseurCapability} from "../../commande-fournisseur/domain/commande-fournisseur-rbac";
import {requestHasGrantedAccountModuleAccess} from "../../access-control/context/account-module-access.context";
import {materialDebitSchema} from '../validators/of-material.validators';
import {debitOfMaterial} from '../services/of-material.service';

function rights(req:Request){
  const granted=requestHasGrantedAccountModuleAccess(req);
  return {canConfigure:granted||roleHasOfCapability(req.user?.role,"edit_prelaunch"),canVerifyLot:granted||roleHasStockCapability(req.user?.role,"lot_quality"),canConfirm:granted||roleHasStockCapability(req.user?.role,"reservation_manage"),canPurchase:granted||roleHasCommandeFournisseurCapability(req.user?.role,"create"),canReadPrices:granted||roleHasCommandeFournisseurCapability(req.user?.role,"prices")};
}
function present(data:Awaited<ReturnType<typeof getOfMaterial>>,req:Request){
  const access=rights(req);
  if(!data.enabled)return data;
  return {...data,permissions:access,needs:data.needs.map(n=>({...n,price:access.canReadPrices?n.price:null,catalog:n.catalog?{...n.catalog,prix_unitaire:access.canReadPrices?n.catalog.prix_unitaire:null}:null}))};
}
export const readMaterial=asyncHandler(async(req,res)=>{res.json(present(await getOfMaterial(identity.parse(req.params).id),req));});
export const debitMaterial=asyncHandler(async(req,res)=>{
  const result=await debitOfMaterial(identity.parse(req.params).id,materialDebitSchema.parse(req.body),buildAuditContext(req));
  res.json({...result,coverage:present(result.coverage,req)});
});
export const readOperationReadiness=asyncHandler(async(req,res)=>{res.json(await getOperationReadiness(identity.parse(req.params).id));});
export const verifyMaterialLot=asyncHandler(async(req,res)=>{
  if(!rights(req).canVerifyLot)throw new HttpError(403,"MATERIAL_LOT_VERIFICATION_FORBIDDEN","Les droits de vérification qualité des lots sont nécessaires.");
  res.json(present(await verifyOfMaterialLot(identity.parse(req.params).id,materialSourceRefSchema.parse(req.params.sourceRef),materialLotVerificationSchema.parse(req.body),buildAuditContext(req)),req));
});
export const configureMaterial=asyncHandler(async(req,res)=>{
  if(!rights(req).canConfigure)throw new HttpError(403,"MATERIAL_CONFIGURE_FORBIDDEN","Les droits de préparation de l’OF sont nécessaires.");
  res.json(present(await configureOfMaterial(identity.parse(req.params).id,materialSourceRefSchema.parse(req.params.sourceRef),configuration.parse(req.body),buildAuditContext(req)),req));
});
export const confirmMaterial=asyncHandler(async(req,res)=>{
  const access=rights(req);
  if(!access.canConfirm)throw new HttpError(403,"MATERIAL_RESERVE_FORBIDDEN","Les droits de réservation du stock sont nécessaires.");
  const result=await confirmOfMaterial(identity.parse(req.params).id,confirmation.parse(req.body),buildAuditContext(req),access.canPurchase);
  res.json({...result,coverage:present(result.coverage,req)});
});
