import { z } from 'zod';
import { HttpError } from '../../../utils/httpError';
import { formatDecimal, parseDecimal } from '../../facturation/domain/decimal-money';

const feeSchema = z.object({
  amount_ht: z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  tax_rate_percent: z.string().regex(/^\d{1,3}(?:\.\d{1,4})?$/).refine(v => Number(v) <= 100),
  settings_version: z.number().int().positive(),
});
export type UrgencyOrderFee = z.infer<typeof feeSchema>;
export function acceptedUrgencyFee(value: unknown): UrgencyOrderFee {
  const parsed = feeSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(409, 'URGENCY_FEE_REQUIRED', 'Renseignez le forfait urgence dans la fiche client, puis actualisez la demande.');
  return { ...parsed.data, amount_ht: formatDecimal(parseDecimal(parsed.data.amount_ht, 2, 'Forfait'), 2),
    tax_rate_percent: formatDecimal(parseDecimal(parsed.data.tax_rate_percent, 4, 'TVA'), 4) };
}
