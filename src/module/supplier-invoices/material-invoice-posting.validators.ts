import { z } from 'zod';
import { MATERIAL_RECONCILIATION_METHOD } from './material-invoice-reconciliation';

/** Intent only: all quantities, costs and attribution are read on the server. */
export const materialInvoicePostingBody=z.object({
  method:z.literal(MATERIAL_RECONCILIATION_METHOD),
  expected_source_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  request_id:z.string().uuid().transform(v=>v.toLowerCase()),
}).strict();
export type MaterialInvoicePostingInput=z.infer<typeof materialInvoicePostingBody>;
