import { z } from 'zod';
export const urgencyApprovalParams = z.object({ requestId: z.string().guid() });
export const urgencyApprovalBody = z.object({
    expected_version: z.number().int().positive(),
    preview_hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export const urgencyApprovalKey = z.string().guid();
