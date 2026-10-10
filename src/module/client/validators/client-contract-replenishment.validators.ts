import { z } from 'zod';
import { forecastMonthSchema } from './client-contract-forecast.validators';

export const clientReplenishmentPreparationSchema = z.object({
  action: z.literal('PREPARE'), expected_contract_version: z.number().int().positive().max(2147483646),
  expected_plan_id: z.string().uuid().transform(value => value.toLowerCase()).nullable(),
  expected_snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
  start_month: forecastMonthSchema, months: z.number().int().min(1).max(36),
}).strict();
export type ClientReplenishmentPreparationCommand = z.infer<typeof clientReplenishmentPreparationSchema>;
