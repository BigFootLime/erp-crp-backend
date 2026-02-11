import { z } from "zod";

export const auditEventTypeSchema = z.enum(["NAVIGATION", "ACTION"]);

export const createAuditLogBodySchema = z
  .object({
    event_type: auditEventTypeSchema,
    action: z.string().trim().min(1).max(80),
    page_key: z.string().trim().max(80).optional().nullable(),
    entity_type: z.string().trim().max(80).optional().nullable(),
    entity_id: z.string().trim().max(80).optional().nullable(),
    path: z.string().trim().max(400).optional().nullable(),
    client_session_id: z.string().uuid().optional().nullable(),
    details: z.record(z.unknown()).optional().nullable(),
  })
  .strict();

export type CreateAuditLogBodyDTO = z.infer<typeof createAuditLogBodySchema>;

export const listAuditLogsQuerySchema = z.object({
  q: z.string().trim().optional(),
  from: z.string().trim().optional(),
  to: z.string().trim().optional(),
  user_id: z.coerce.number().int().positive().optional(),
  event_type: auditEventTypeSchema.optional(),
  action: z.string().trim().optional(),
  page_key: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});

export type ListAuditLogsQueryDTO = z.infer<typeof listAuditLogsQuerySchema>;
