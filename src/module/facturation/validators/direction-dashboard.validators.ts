import { z } from "zod";

import { PERIOD_PRESETS } from "../domain/reporting-policy";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ")
  .refine((value) => {
    const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
    const probe = new Date(Date.UTC(year, month - 1, day));
    return (
      probe.getUTCFullYear() === year &&
      probe.getUTCMonth() === month - 1 &&
      probe.getUTCDate() === day
    );
  }, "Date inexistante");

const optionalUuid = z.string().trim().uuid().optional();

export const directionDashboardQuerySchema = z.object({
  period: z.enum(PERIOD_PRESETS).optional().default("current_month"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  as_of: isoDate.optional(),
  site_id: optionalUuid,
  client_id: z.string().trim().min(1).max(64).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

export type DirectionDashboardQueryDTO = z.infer<typeof directionDashboardQuerySchema>;
