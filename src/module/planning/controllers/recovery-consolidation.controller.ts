import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { buildAuditContext } from './planning.controller';
import { recoveryConsolidationParams,recoveryConsolidationApplyBody,recoveryConsolidationCandidateParams,recoveryConsolidationCandidatesQuery } from '../validators/recovery-consolidation.validators';
import { svcPreviewRecoveryGrouping,svcApplyRecoveryGrouping,svcListRecoveryGroupingCandidates } from '../services/recovery-consolidation.service';

export const listRecoveryGroupingCandidates:RequestHandler=asyncHandler(async(req,res)=>{
  buildAuditContext(req);
  const {recoveryId}=recoveryConsolidationCandidateParams.parse(req.params);
  const query=recoveryConsolidationCandidatesQuery.parse(req.query);
  res.setHeader('Cache-Control','private, no-store');
  res.json(await svcListRecoveryGroupingCandidates(recoveryId,query));
});

export const previewRecoveryGrouping:RequestHandler=asyncHandler(async(req,res)=>{
  buildAuditContext(req);
  const {recoveryId,consolidationId}=recoveryConsolidationParams.parse(req.params);
  res.setHeader('Cache-Control','private, no-store');
  res.json(await svcPreviewRecoveryGrouping(recoveryId,consolidationId));
});
export const applyRecoveryGrouping:RequestHandler=asyncHandler(async(req,res)=>{
  const audit=buildAuditContext(req);
  const {recoveryId,consolidationId}=recoveryConsolidationParams.parse(req.params);
  const body=recoveryConsolidationApplyBody.parse(req.body);
  res.setHeader('Cache-Control','private, no-store');
  res.json(await svcApplyRecoveryGrouping(recoveryId,consolidationId,body,audit));
});
