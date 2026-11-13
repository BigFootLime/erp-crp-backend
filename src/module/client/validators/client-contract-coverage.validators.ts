import { z } from 'zod';
import { forecastMonthSchema } from './client-contract-forecast.validators';

export const clientContractCoverageQuerySchema = z.object({
  start_month: forecastMonthSchema.optional(), months: z.coerce.number().int().min(1).max(36).default(12),
}).strict();
export type ClientContractCoverageQuery = z.infer<typeof clientContractCoverageQuerySchema>;
