import type { Request,RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { svcPreviewCustomerRefundReversal,svcReverseCustomerRefund } from "../services/customer-refund-reversal.service";
import { customerRefundReversalPreviewSchema,reverseCustomerRefundSchema } from "../validators/customer-refund.validators";
function actor(req:Request){
  if(!req.user?.id)throw new HttpError(401,"UNAUTHORIZED","Authentification requise.");
  return{userId:req.user.id,requestId:req.requestId??"missing-request-id",path:req.originalUrl.split("?")[0]??req.path};
}
export const previewCustomerRefundReversal:RequestHandler=async(req,res,next)=>{
  try{res.json(await svcPreviewCustomerRefundReversal(customerRefundReversalPreviewSchema.parse(req.body)));}catch(error){next(error);}
};
export const reverseCustomerRefund:RequestHandler=async(req,res,next)=>{
  try{
    const key=req.headers["idempotency-key"];
    const result=await svcReverseCustomerRefund({input:reverseCustomerRefundSchema.parse(req.body),actor:actor(req),idempotencyKey:typeof key==="string"?key:undefined});
    res.status(result.idempotent_replay?200:201).json(result);
  }catch(error){next(error);}
};
