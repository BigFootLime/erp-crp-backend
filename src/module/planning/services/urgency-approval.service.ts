import { approveUrgencyRecovery, previewUrgencyApproval } from '../repository/urgency-approval.repository';
export const svcPreviewUrgencyApproval = (requestId: string) => previewUrgencyApproval(requestId);
export const svcApproveUrgencyRecovery = (args: Parameters<typeof approveUrgencyRecovery>[0]) => approveUrgencyRecovery(args);
