import { z } from 'zod';
export const recoveryConsolidationParams=z.object({recoveryId:z.string().guid(),consolidationId:z.string().guid()}).strict();
export const recoveryConsolidationCandidateParams=z.object({recoveryId:z.string().guid()}).strict();
export const recoveryConsolidationCandidatesQuery=z.object({
  q:z.string().trim().max(80).default(''),
  cursor:z.coerce.number().int().positive().optional(),
  limit:z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type RecoveryConsolidationCandidatesQuery=z.infer<typeof recoveryConsolidationCandidatesQuery>;
export const recoveryConsolidationApplyBody=z.object({
  expected_request_version:z.number().int().positive(),
  preview_hash:z.string().regex(/^[a-f0-9]{64}$/),
  proposal_hash:z.string().regex(/^[a-f0-9]{64}$/),
  planning_reference_at:z.string().datetime({offset:true}),
  idempotency_key:z.string().guid(),
}).strict();
export type RecoveryConsolidationApplyInput=z.infer<typeof recoveryConsolidationApplyBody>;
