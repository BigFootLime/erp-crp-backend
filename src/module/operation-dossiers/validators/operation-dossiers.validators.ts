import { z } from "zod"

export const operationDossierOperationTypeSchema = z.enum(["PIECE_TECHNIQUE_OPERATION", "OF_OPERATION"])

export const operationDossierTypeSchema = z.enum(["TECHNIQUE", "PROGRAMMATION"])

export const getOperationDossierQuerySchema = z
  .object({
    operation_type: operationDossierOperationTypeSchema,
    operation_id: z.string().trim().min(1),
    dossier_type: operationDossierTypeSchema,
  })
  .passthrough()

export type GetOperationDossierQueryDTO = z.infer<typeof getOperationDossierQuerySchema>

export const dossierIdParamsSchema = z.object({ dossierId: z.string().uuid() })

export const documentIdParamsSchema = z.object({ documentId: z.string().uuid() })

export const createOperationDossierVersionBodySchema = z
  .object({
    commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
  })
  .passthrough()

export type CreateOperationDossierVersionBodyDTO = z.infer<typeof createOperationDossierVersionBodySchema>
