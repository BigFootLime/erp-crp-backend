import { z } from "zod"

export const uuidSchema = z.string().regex(/^[0-9a-fA-F-]{36}$/)

export const asbuiltLotParamsSchema = z.object({
  lotId: uuidSchema,
})

export const asbuiltDownloadParamsSchema = z.object({
  lotId: uuidSchema,
  documentId: uuidSchema,
})

export const asbuiltGenerateBodySchema = z
  .object({
    signataire_user_id: z.number().int().positive().optional(),
    commentaire: z.string().max(2000).optional(),
  })
  .strict()

export type AsbuiltGenerateBodyDTO = z.infer<typeof asbuiltGenerateBodySchema>
