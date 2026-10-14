import type { Request, RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { svcPreviewCustomerRefund, svcRegisterCustomerRefund } from "../services/customer-refund.service";
import { customerRefundPreviewSchema, registerCustomerRefundSchema } from "../validators/customer-refund.validators";
function actor(req: Request) {
  if (!req.user?.id) throw new HttpError(401,"UNAUTHORIZED","Authentification requise.");
  return {userId:req.user.id,requestId:req.requestId??"missing-request-id",path:req.originalUrl.split("?")[0]??req.path};
}
export const previewCustomerRefund: RequestHandler = async (req,res,next) => {
  try { res.json(await svcPreviewCustomerRefund(customerRefundPreviewSchema.parse(req.body))); } catch(error) { next(error); }
};
export const registerCustomerRefund: RequestHandler = async (req,res,next) => {
  try {
    const key=req.headers["idempotency-key"];
    const result=await svcRegisterCustomerRefund({input:registerCustomerRefundSchema.parse(req.body),actor:actor(req),idempotencyKey:typeof key==="string"?key:undefined});
    res.status(result.idempotent_replay?200:201).json(result);
  }catch(error){next(error);}
};
