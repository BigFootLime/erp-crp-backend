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
    email_body: z.string().trim().min(1).max(20000).optional().nullable(),
    message: z.string().trim().max(20000).optional().nullable(),
  }),
});

export const acknowledgementDocumentParamsSchema = z.object({
  id: z.string().regex(/^\d+$/, "id must be an integer"),
  documentId: z.string().uuid(),
});

export const createAcknowledgementSchema = z.object({
  params: z.object({ id: z.string().regex(/^\d+$/, "id must be an integer") }),
  body: z.object({
    // The acknowledgement is a fresh business document; this token is carried
    // into audit provenance and lets the UI correlate a per-attempt request.
    source_revision: z.string().trim().min(1).max(160),
    reissue_reason: z.string().trim().min(3).max(500).optional().nullable(),
  }).strict(),
});

export const sendAcknowledgementSchema = z.object({
  params: acknowledgementDocumentParamsSchema,
  body: z.object({
    recipient_emails: z.array(z.string().email()).min(1),
    recipient_contact_ids: z.array(z.string().uuid()).optional().default([]),
    email_body: z.string().trim().min(1).max(20000).optional().nullable(),
    message: z.string().trim().max(20000).optional().nullable(),
  }),
});

export type SendCommandeArBodyDTO = z.infer<typeof sendCommandeArSchema>["body"];
