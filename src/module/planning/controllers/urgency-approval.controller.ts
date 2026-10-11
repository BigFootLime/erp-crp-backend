import type { RequestHandler } from 'express';
import { asyncHandler } from '../../../utils/asyncHandler';
import { buildAuditContext } from './planning.controller';
import { urgencyApprovalParams, urgencyApprovalBody, urgencyApprovalKey } from '../validators/urgency-approval.validators';
import { svcApproveUrgencyRecovery, svcPreviewUrgencyApproval } from '../services/urgency-approval.service';
export const previewRecoveryApproval: RequestHandler = asyncHandler(async (req, res) => {
    buildAuditContext(req);
    const { requestId } = urgencyApprovalParams.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await svcPreviewUrgencyApproval(requestId));
});
export const approveRecovery: RequestHandler = asyncHandler(async (req, res) => {
    const context = buildAuditContext(req);
    const { requestId } = urgencyApprovalParams.parse(req.params);
    const body = urgencyApprovalBody.parse(req.body);
    const idempotencyKey = urgencyApprovalKey.parse(req.get('Idempotency-Key'));
    const result = await svcApproveUrgencyRecovery({
        requestId, expectedVersion: body.expected_version,
        previewHash: body.preview_hash, idempotencyKey, audit: { ...context, user_role: context.role }
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(result.replayed ? 200 : 201).json(result);
});
