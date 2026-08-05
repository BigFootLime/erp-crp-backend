import { z } from "zod"

const uuid = z.string().uuid()

export const listReplenishmentProposalsSchema = z.object({
  query: z.object({
    status: z.enum(["PROPOSEE", "A_COMPLETER", "CONVERTIE", "RESOLUE"]).optional(),
    magasin_id: uuid.optional(),
    article_id: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }).strict(),
})

export const refreshReplenishmentProposalsSchema = z.object({
  body: z.object({
    magasin_id: uuid.optional(),
    article_id: uuid.optional(),
    limit: z.number().int().min(1).max(500).default(200),
  }).strict().default({ limit: 200 }),
})

export const validateReplenishmentProposalSchema = z.object({
  params: z.object({ id: uuid }).strict(),
  body: z.object({
    catalogue_id: uuid,
    expected_version: z.number().int().positive(),
    idempotency_key: z.string().trim().min(8).max(200),
  }).strict(),
})

export type ListReplenishmentProposalsDTO = z.infer<typeof listReplenishmentProposalsSchema>["query"]
export type RefreshReplenishmentProposalsDTO = z.infer<typeof refreshReplenishmentProposalsSchema>["body"]
export type ValidateReplenishmentProposalDTO = z.infer<typeof validateReplenishmentProposalSchema>["body"]
