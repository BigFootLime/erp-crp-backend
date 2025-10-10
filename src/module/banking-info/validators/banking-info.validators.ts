// src/module/banking-info/validators/banking-info.validators.ts
import { z } from "zod"

export const createBankingInfoSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Nom requis"),
    iban: z.string().min(15, "IBAN invalide"),
    bic: z.string().min(8, "BIC invalide"),
    creation_date: z.string().optional(),
  }),
})

export const idParamSchema = z.object({
  params: z.object({ id: z.string().uuid("id must be a uuid") }),
})

// tiny helper
export function validate(schema: z.ZodTypeAny) {
  return (req: any, res: any, next: any) => {
    const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query })
    if (!parsed.success) {
      const msg = parsed.error.issues?.[0]?.message ?? "Invalid request"
      return res.status(400).json({ error: msg })
    }
    // attach parsed value if you want (optional)
    next()
  }
}
