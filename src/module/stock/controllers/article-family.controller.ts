import type { RequestHandler } from "express";
import { z } from "zod";
import { buildAuditContext } from "./stock.controller";
import { repoUpdateArticleFamily } from "../repository/stock.repository";

const schema=z.object({category:z.enum(['fabrique','matiere','traitement','achat']),code:z.string().trim().min(1).max(40),designation:z.string().trim().min(1).max(160),expected_updated_at:z.string().min(1)}).strict();
export const updateArticleFamily:RequestHandler=async(req,res,next)=>{
  try { const input=schema.parse(req.body);res.json(await repoUpdateArticleFamily(input,buildAuditContext(req))); }
  catch(error){next(error);}
};
