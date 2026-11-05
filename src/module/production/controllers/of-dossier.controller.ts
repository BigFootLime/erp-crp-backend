import {materialCommandSchema as completeSchema} from "../validators/of-material.validators";
import {asyncHandler} from "../../../utils/asyncHandler";
import {ofIdParamSchema} from "../validators/production.validators";
import {buildAuditContext} from "./production.controller";
import {getOfDossier,completeOfDossier} from "../services/of-dossier.service";
import {canValidateTechnicalDossier} from "../domain/technical-dossier-approval";
export const readDossier=asyncHandler(async(req,res)=>{res.json({...await getOfDossier(ofIdParamSchema.parse({params:req.params}).params.id),canValidate:canValidateTechnicalDossier(req.user)});});
export const completeDossier=asyncHandler(async(req,res)=>{res.json({...await completeOfDossier(ofIdParamSchema.parse({params:req.params}).params.id,completeSchema.parse(req.body),buildAuditContext(req)),canValidate:true});});
