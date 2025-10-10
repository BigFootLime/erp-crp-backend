import { z } from "zod";

export const createPaymentModeSchema = z.object({
  name: z.string().min(2),
  code: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

export type CreatePaymentModeDTO = z.infer<typeof createPaymentModeSchema>;
