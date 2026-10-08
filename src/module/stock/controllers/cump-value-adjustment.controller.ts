import type { RequestHandler } from 'express';
import { buildAuditContext } from '../../margin-engine/controllers/margin-audit-context';
import { valueAdjustmentParams,valueAdjustmentBody } from '../validators/cump-value-adjustment.validators';
import { svcValueAdjustmentCandidate,svcListValueAdjustments,svcDeclareValueAdjustment } from '../services/cump-value-adjustment.service';
export const readValueAdjustmentCandidate:RequestHandler=async(req,res,next)=>{
  try {const {articleId,unit}=valueAdjustmentParams.parse(req.params);res.setHeader('Cache-Control','no-store');
    res.json(await svcValueAdjustmentCandidate(articleId,unit));}catch(error){next(error);}
};
export const listValueAdjustments:RequestHandler=async(req,res,next)=>{
  try {const {articleId,unit}=valueAdjustmentParams.parse(req.params);res.setHeader('Cache-Control','no-store');
    res.json(await svcListValueAdjustments(articleId,unit));}catch(error){next(error);}
};
export const declareValueAdjustment:RequestHandler=async(req,res,next)=>{
  try {const {articleId,unit}=valueAdjustmentParams.parse(req.params),input=valueAdjustmentBody.parse(req.body);
    const result=await svcDeclareValueAdjustment(articleId,unit,input,buildAuditContext(req));
    res.setHeader('Cache-Control','no-store');res.status(result.replayed?200:201).json(result);}catch(error){next(error);}
};
