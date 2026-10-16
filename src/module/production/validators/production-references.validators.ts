import { z } from "zod";
import { crmClientIdSchema } from "../../client/validators/client-crm.validators";

const uuid = z.string().uuid();

export const productionReferenceListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  client_id: crmClientIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const productionReferencePieceParamSchema = z.object({
  params: z.object({ pieceId: uuid }),
});

export const productionReferenceReceiptParamSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    movementId: uuid,
  }),
});

export type ProductionReferenceListQuery = z.infer<typeof productionReferenceListQuerySchema>;
