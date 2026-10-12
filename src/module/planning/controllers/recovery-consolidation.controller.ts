import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { buildAuditContext } from './planning.controller';
import { recoveryConsolidationParams } from '../validators/recovery-consolidation.validators';
import { svcPreviewRecoveryGrouping } from '../services/recovery-consolidation.service';

export const previewRecoveryGrouping:RequestHandler=asyncHandler(async(req,res)=>{
  buildAuditContext(req);
  const {recoveryId,consolidationId}=recoveryConsolidationParams.parse(req.params);
  res.setHeader('Cache-Control','private, no-store');
  res.json(await svcPreviewRecoveryGrouping(recoveryId,consolidationId));
});
