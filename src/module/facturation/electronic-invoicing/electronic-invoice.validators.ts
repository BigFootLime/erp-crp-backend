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
