import { z } from 'zod';
import { canonicalizeStockUnitCode } from '../../../shared/stock-unit';
import { parseCumpDecimal } from '../domain/cump-decimal';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const unit=z.string().min(1).max(32).refine(value=>canonicalizeStockUnitCode(value)===value,
  'Sélectionnez l’unité proposée pour le stock d’ouverture.');
const digest=z.string().regex(/^[0-9a-f]{64}$/);
export const openingBasisParams=z.object({articleId:uuid,unit});
export const openingBasisBody=z.object({request_id:uuid,expected_source_sha256:digest,
  document_id:uuid,expected_document_sha256:digest,
  // Only the documented amount is entered by a financial approver. Quantities,
  // unit, owner and currency come from the immutable capture candidate.
  total_value_ht:z.string().max(40).regex(/^(0|[1-9][0-9]{0,25})(\.[0-9]{1,12})?$/)
    .refine(value=>{try{return parseCumpDecimal(value)>=0n;}catch{return false;}},'Montant EUR invalide.'),
}).strict();
export type DeclareOpeningBasis=z.infer<typeof openingBasisBody>;
