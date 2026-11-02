import { z } from "zod";
export const supplierSandboxLoginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(12).max(256),
  })
  .strict();
export const supplierSandboxPromiseSchema = z
  .object({
    order_id: z.string().uuid(),
    line_id: z.string().uuid(),
    promised_date: z.string().date(),
    promised_quantity: z.coerce.number().positive().max(999999999),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
