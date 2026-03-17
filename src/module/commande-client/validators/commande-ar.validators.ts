import { z } from "zod";

export const generateCommandeArSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
  }),
});

export const sendCommandeArSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "id must be an integer"),
  }),
  body: z.object({
    ar_id: z.string().uuid(),
    recipient_emails: z.array(z.string().email()).min(1),
    recipient_contact_ids: z.array(z.string().uuid()).optional().default([]),
    message: z.string().trim().max(20000).optional().nullable(),
  }),
});

export type SendCommandeArBodyDTO = z.infer<typeof sendCommandeArSchema>["body"];
