// src/module/pieces-families/validators/pieces-families.validators.ts
import { z } from "zod"

export const createPieceCFSchema = z.object({
  body: z.object({
    code: z.string().min(1, "Code requis"),
    designation: z.string().min(2, "Désignation requise"),
    type_cf: z.string().optional().nullable(),
    section: z.string().optional().nullable(),
  }),
})

export const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid("id must be a uuid") }),
})

export function validate(schema: z.ZodTypeAny) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query })
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      return res.status(400).json({ error: msg })
    }
    next()
  }
}
