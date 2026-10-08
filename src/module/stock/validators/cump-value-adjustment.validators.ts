import { z } from 'zod';
import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export const valueAdjustmentParams=z.object({articleId:uuid,unit:z.string().min(1).max(32)
  .refine(value=>value===canonicalizeStockUnitCode(value),'Unité canonique attendue.')});
export const valueAdjustmentBody=z.object({
  request_id:uuid,expected_source_sha256:z.string().regex(/^[0-9a-f]{64}$/),
  document_id:uuid,expected_document_sha256:z.string().regex(/^[0-9a-f]{64}$/),
  total_value_ht:z.string().regex(/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$/),
}).strict();
export type DeclareValueAdjustment=z.infer<typeof valueAdjustmentBody>;
