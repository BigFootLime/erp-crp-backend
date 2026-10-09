import type { Request,RequestHandler } from "express";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { getClientIp,parseDevice } from "../../../utils/requestMeta";
import { stripQueryFromUrl } from "../../../utils/logPath";
import { effectiveRoleHasAny } from "../../auth/domain/roles";
import { hasGrantedAccountModuleAccess } from "../../access-control/context/account-module-access.context";
import { CLIENT_WRITE_ROLES } from "../client.permissions";
import type { AuditContext } from "../repository/client.repository";
import { contractClientIdSchema,contractIdempotencySchema,clientContractCommandSchema,
  clientContractQuerySchema,clientContractArticleQuerySchema } from "../validators/client-contract.validators";
import { getClientContracts,getClientContractArticles,getClientContract,getClientContractCalls,executeClientContractCommand } from "../services/client-contract.service";

function canWrite(req:Request) {
  return hasGrantedAccountModuleAccess()||effectiveRoleHasAny(req.user?.role,CLIENT_WRITE_ROLES);
}
export function clientContractAuditContext(req:Request):AuditContext {
  const userId=req.user?.id;
  if(typeof userId!=="number"||!Number.isInteger(userId)||userId<1)throw new HttpError(401,"UNAUTHORIZED","Connexion requise");
  const userAgent=typeof req.headers["user-agent"]==="string"?req.headers["user-agent"]:null;
  const session=z.string().uuid().safeParse(req.headers["x-client-session-id"]??req.headers["x-session-id"]);
  return {user_id:userId,ip:getClientIp(req),user_agent:userAgent,...parseDevice(userAgent),
    path:stripQueryFromUrl(req.originalUrl),page_key:"clients.contracts",client_session_id:session.success?session.data:null};
}
export const listContracts:RequestHandler=async(req,res,next)=>{
  try {
    const clientId=contractClientIdSchema.parse(req.params.id),query=clientContractQuerySchema.parse(req.query);
    res.setHeader("Cache-Control","no-store");
    const data=await getClientContracts(clientId,query.page);
    res.json({...data,can_write:data.client_active&&canWrite(req)});
  } catch(error){next(error);}
};
export const listContractArticles:RequestHandler=async(req,res,next)=>{
  try {
    const clientId=contractClientIdSchema.parse(req.params.id),query=clientContractArticleQuerySchema.parse(req.query);
    res.setHeader("Cache-Control","no-store");res.json(await getClientContractArticles(clientId,query.q));
  } catch(error){next(error);}
};
export const readContract:RequestHandler=async(req,res,next)=>{
  try {
    const clientId=contractClientIdSchema.parse(req.params.id),id=z.string().uuid().parse(req.params.contractId);
    const query=clientContractQuerySchema.parse(req.query);
    const data=await getClientContract(clientId,id,query.page);
    res.setHeader("Cache-Control","no-store");res.json({...data,can_write:data.client_active&&canWrite(req)});
  } catch(error){next(error);}
};
export const postContractCommand:RequestHandler=async(req,res,next)=>{
  try {
    const saved=await executeClientContractCommand(contractClientIdSchema.parse(req.params.id),
      clientContractCommandSchema.parse(req.body),contractIdempotencySchema.parse(req.headers["idempotency-key"]),clientContractAuditContext(req));
    res.setHeader("Cache-Control","no-store");res.setHeader("Idempotency-Replayed",saved.replayed?"true":"false");
    res.status(saved.replayed?200:201).json(saved.result);
  } catch(error){next(error);}
};
export const listContractCalls:RequestHandler=async(req,res,next)=>{
  try {
    const clientId=contractClientIdSchema.parse(req.params.id),id=z.string().uuid().parse(req.params.contractId);
    const query=clientContractQuerySchema.parse(req.query);
    res.setHeader('Cache-Control','no-store');res.json(await getClientContractCalls(clientId,id,query.page));
  } catch(error){next(error);}
};
