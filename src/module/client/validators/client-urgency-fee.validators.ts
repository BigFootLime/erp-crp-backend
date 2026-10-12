import { z } from 'zod';
import { formatDecimal, parseDecimal } from '../../facturation/domain/decimal-money';

export const clientUrgencyFeeBody = z.object({
  expected_version: z.number().int().min(0).max(2147483646),
  amount_ht: z.string().trim().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/, 'Montant HT : deux décimales maximum')
    .transform(value => formatDecimal(parseDecimal(value, 2, 'Forfait HT'), 2)),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
}).strict();
export type ClientUrgencyFeeBody = z.infer<typeof clientUrgencyFeeBody>;
