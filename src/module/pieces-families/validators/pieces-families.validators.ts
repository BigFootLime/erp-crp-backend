// src/module/pieces-families/validators/pieces-families.validators.ts
import { z } from "zod"

const codeSchema = z.string().trim().min(1, "Code requis").max(64, "Code trop long")
const designationSchema = z.string().trim().min(2, "Désignation requise").max(255, "Désignation trop longue")
const optionalLabelSchema = z.string().trim().max(120, "Valeur trop longue").nullable().optional()

export const createPieceFamilySchema = z.object({
  body: z.object({
    code: codeSchema,
    designation: designationSchema,
    type_famille: optionalLabelSchema,
    section: optionalLabelSchema,
  }),
})

export const updatePieceFamilySchema = z.object({
  body: z.object({
    code: codeSchema.optional(),
    designation: designationSchema.optional(),
    type_famille: optionalLabelSchema,
    section: optionalLabelSchema,
  }).refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: "Au moins un champ modifiable est requis",
  }),
})

export const idParamSchema = z.object({
  params: z.object({ id: z.string().guid("id must be a uuid") }),
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
