import { z } from 'zod';

export const manufacturingBasisParams=z.object({ofId:z.string().regex(/^[1-9]\d{0,18}$/)
  .refine(value=>/^[1-9]\d{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n,'Identifiant OF invalide.')});
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const manufacturingBasisCandidateParams=manufacturingBasisParams.extend({snapshotId:uuid});
export const manufacturingBasisBody=z.object({
  request_id:uuid,margin_snapshot_id:uuid,
  expected_source_sha256:z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type DeclareManufacturingBasis=z.infer<typeof manufacturingBasisBody>;
