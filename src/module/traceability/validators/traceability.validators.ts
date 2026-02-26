import { z } from "zod"

export const traceabilityNodeTypeSchema = z.enum([
  "devis",
  "commande",
  "affaire",
  "of",
  "lot",
  "bon_livraison",
  "non_conformity",
])

function coerceInt(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === "string" && /^-?[0-9]+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
  return undefined
}

export const traceabilityChainQuerySchema = z
  .object({
    type: traceabilityNodeTypeSchema,
    id: z.string().min(1),
    maxDepth: z.preprocess(coerceInt, z.number().int().min(0).max(10)).optional(),
    maxNodes: z.preprocess(coerceInt, z.number().int().min(1).max(500)).optional(),
    maxEdges: z.preprocess(coerceInt, z.number().int().min(1).max(2000)).optional(),
  })
  .strict()

export type TraceabilityChainQueryDTO = z.infer<typeof traceabilityChainQuerySchema>
