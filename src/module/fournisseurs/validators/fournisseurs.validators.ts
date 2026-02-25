import { z } from "zod"

const uuid = z.string().uuid()

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

export const sortDirSchema = z.enum(["asc", "desc"])

export const fournisseurIdParamSchema = z.object({
  params: z.object({ id: uuid }),
})

export const listFournisseursQuerySchema = z
  .object({
    search: z.string().trim().optional(),
    actif: z.preprocess(parseBoolean, z.boolean().optional()),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
    sortBy: z.enum(["updated_at", "code", "nom"]).optional().default("updated_at"),
    sortDir: sortDirSchema.optional().default("desc"),
  })
  .passthrough()

export type ListFournisseursQueryDTO = z.infer<typeof listFournisseursQuerySchema>

export const createFournisseurSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80),
      nom: z.string().trim().min(1).max(250),
      actif: z.boolean().optional().default(true),
      tva: z.string().trim().min(1).max(80).optional().nullable(),
      siret: z.string().trim().min(1).max(80).optional().nullable(),
      email: z.string().trim().min(1).max(200).optional().nullable(),
      telephone: z.string().trim().min(1).max(50).optional().nullable(),
      site_web: z.string().trim().min(1).max(300).optional().nullable(),
      notes: z.string().trim().min(1).max(10000).optional().nullable(),
    })
    .strict(),
})

export type CreateFournisseurBodyDTO = z.infer<typeof createFournisseurSchema>["body"]

export const updateFournisseurSchema = z.object({
  body: z
    .object({
      code: z.string().trim().min(1).max(80).optional(),
      nom: z.string().trim().min(1).max(250).optional(),
      actif: z.boolean().optional(),
      tva: z.string().trim().min(1).max(80).optional().nullable(),
      siret: z.string().trim().min(1).max(80).optional().nullable(),
      email: z.string().trim().min(1).max(200).optional().nullable(),
      telephone: z.string().trim().min(1).max(50).optional().nullable(),
      site_web: z.string().trim().min(1).max(300).optional().nullable(),
      notes: z.string().trim().min(1).max(10000).optional().nullable(),
    })
    .strict(),
})

export type UpdateFournisseurBodyDTO = z.infer<typeof updateFournisseurSchema>["body"]

export const contactIdParamSchema = z.object({
  params: z.object({ id: uuid, contactId: uuid }),
})

export const createContactSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(200),
      email: z.string().trim().min(1).max(200).optional().nullable(),
      telephone: z.string().trim().min(1).max(50).optional().nullable(),
      role: z.string().trim().min(1).max(120).optional().nullable(),
      notes: z.string().trim().min(1).max(5000).optional().nullable(),
      actif: z.boolean().optional().default(true),
    })
    .strict(),
})

export type CreateContactBodyDTO = z.infer<typeof createContactSchema>["body"]

export const updateContactSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(200).optional(),
      email: z.string().trim().min(1).max(200).optional().nullable(),
      telephone: z.string().trim().min(1).max(50).optional().nullable(),
      role: z.string().trim().min(1).max(120).optional().nullable(),
      notes: z.string().trim().min(1).max(5000).optional().nullable(),
      actif: z.boolean().optional(),
    })
    .strict(),
})

export type UpdateContactBodyDTO = z.infer<typeof updateContactSchema>["body"]

export const fournisseurCatalogueTypeSchema = z.enum([
  "MATIERE",
  "CONSOMMABLE",
  "SOUS_TRAITANCE",
  "SERVICE",
  "OUTILLAGE",
  "AUTRE",
])

export type FournisseurCatalogueTypeDTO = z.infer<typeof fournisseurCatalogueTypeSchema>

export const catalogueIdParamSchema = z.object({
  params: z.object({ id: uuid, catalogueId: uuid }),
})

export const listCatalogueQuerySchema = z
  .object({
    type: fournisseurCatalogueTypeSchema.optional(),
    actif: z.preprocess(parseBoolean, z.boolean().optional()),
  })
  .passthrough()

export type ListCatalogueQueryDTO = z.infer<typeof listCatalogueQuerySchema>

export const createCatalogueSchema = z.object({
  body: z
    .object({
      type: fournisseurCatalogueTypeSchema,
      article_id: uuid.optional().nullable(),
      designation: z.string().trim().min(1).max(400),
      reference_fournisseur: z.string().trim().min(1).max(200).optional().nullable(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      prix_unitaire: z.number().finite().min(0).optional().nullable(),
      devise: z.string().trim().min(1).max(10).optional().default("EUR"),
      delai_jours: z.number().int().min(0).optional().nullable(),
      moq: z.number().finite().min(0).optional().nullable(),
      conditions: z.string().trim().min(1).max(10000).optional().nullable(),
      actif: z.boolean().optional().default(true),
    })
    .strict(),
})

export type CreateCatalogueBodyDTO = z.infer<typeof createCatalogueSchema>["body"]

export const updateCatalogueSchema = z.object({
  body: z
    .object({
      type: fournisseurCatalogueTypeSchema.optional(),
      article_id: uuid.optional().nullable(),
      designation: z.string().trim().min(1).max(400).optional(),
      reference_fournisseur: z.string().trim().min(1).max(200).optional().nullable(),
      unite: z.string().trim().min(1).max(30).optional().nullable(),
      prix_unitaire: z.number().finite().min(0).optional().nullable(),
      devise: z.string().trim().min(1).max(10).optional(),
      delai_jours: z.number().int().min(0).optional().nullable(),
      moq: z.number().finite().min(0).optional().nullable(),
      conditions: z.string().trim().min(1).max(10000).optional().nullable(),
      actif: z.boolean().optional(),
    })
    .strict(),
})

export type UpdateCatalogueBodyDTO = z.infer<typeof updateCatalogueSchema>["body"]

export const docIdParamSchema = z.object({
  params: z.object({ id: uuid, docId: uuid }),
})

export const attachDocumentsBodySchema = z
  .object({
    document_type: z.string().trim().min(1).max(80),
    commentaire: z.string().trim().min(1).max(5000).optional().nullable(),
    label: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .passthrough()

export type AttachDocumentsBodyDTO = z.infer<typeof attachDocumentsBodySchema>
