import { z } from "zod"

import { livraisonIdParamsSchema } from "./livraisons.validators"

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value !== "string") return undefined
  const v = value.trim().toLowerCase()
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true
  if (v === "false" || v === "0" || v === "no" || v === "n") return false
  return undefined
}

export const packPreviewParamsSchema = livraisonIdParamsSchema

const includeDocumentsSchema = z
  .preprocess((v) => {
    const parsed = parseBoolean(v)
    return parsed === undefined ? v : parsed
  }, z.boolean())
  .default(true)

export const packGenerateBodySchema = z
  .object({
    signataire_user_id: z.coerce.number().int().positive().optional(),
    include_documents: includeDocumentsSchema,
    commentaire_pack: z.string().trim().min(1).max(5000).optional().nullable(),
  })
  .strict()

export type PackGenerateBodyDTO = z.infer<typeof packGenerateBodySchema>

export const packRevokeParamsSchema = z.object({
  id: z.string().uuid(),
  versionId: z.string().uuid(),
})
