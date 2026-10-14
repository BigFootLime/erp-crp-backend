import type { RequestHandler } from "express";
import { z } from "zod";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { uploadUserAvatar } from "../repository/avatar.repository";
import { HttpError } from "../../../utils/httpError";

const inputSchema=z.object({key:z.string().uuid(),userId:z.number().int().positive().max(2147483647),body:z.object({}).strict()});
function upload(admin:boolean):RequestHandler {
  return async(req,res,next)=>{try {
    const actorId=req.user?.id;
    if(!actorId) throw new HttpError(401,"AUTH_REQUIRED","Connexion requise.");
    const parsed=inputSchema.parse({key:req.headers["idempotency-key"],userId:admin ? Number(req.params.id):actorId,body:req.body ?? {}});
    if(!req.file) throw new HttpError(400,"AVATAR_REQUIRED","Choisissez une image.");
    const ua=typeof req.headers["user-agent"]==="string" ? req.headers["user-agent"]:null;
    const out=await uploadUserAvatar({userId:parsed.userId,actorId,key:parsed.key,file:req.file,meta:{ip:getClientIp(req),user_agent:ua,...parseDevice(ua),path:admin ? "/admin/users/:id/avatar":"/auth/me/avatar"}});
    res.status(200).json(out);
  }catch(error){next(error);}};
}
export const uploadOwnAvatar=upload(false);
export const uploadAdminUserAvatar=upload(true);
