import { z } from "zod";

import { ELECTRONIC_INVOICE_FORMATS } from "./electronic-invoice.domain";

export const electronicInvoiceIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const queueElectronicInvoiceBodySchema = z.object({
  format: z.enum(ELECTRONIC_INVOICE_FORMATS),
}).strict();

export const electronicInvoiceProviderParamsSchema = z.object({
  providerCode: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/),
});

export const activateSuperPdpBodySchema = z.object({
  formats: z.array(z.enum(ELECTRONIC_INVOICE_FORMATS)).min(1).max(3)
    .refine((formats) => new Set(formats).size === formats.length, "Les formats doivent être uniques."),
  qualification_reference: z.string().trim().min(8).max(200),
}).strict();

export const deactivateSuperPdpBodySchema = z.object({
  reason: z.string().trim().min(8).max(500),
}).strict();
