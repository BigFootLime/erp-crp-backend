import { z } from "zod";

export const createPaymentModeSchema = z.object({
  name: z.string().trim().min(2).max(255),
  code: z.string().trim().max(64).optional().or(z.literal("")),
  notes: z.string().trim().max(2_000).optional().or(z.literal("")),
});

export type CreatePaymentModeDTO = z.infer<typeof createPaymentModeSchema>;
