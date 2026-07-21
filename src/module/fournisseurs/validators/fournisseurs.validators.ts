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

const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v)

export const sortDirSchema = z.enum(["asc", "desc"])
export const fournisseurStatusSchema = z.enum(["actif", "a_completer", "inactif", "archive"])

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional().nullable()
const emailOptional = z.preprocess(emptyToNull, z.string().trim().toLowerCase().email().max(200).nullable().optional())
const urlOptional = z.preprocess(emptyToNull, z.string().trim().url().max(300).nullable().optional())
const dateOptional = z.preprocess(
  emptyToNull,
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD").nullable().optional()
)

const domaineLienInputSchema = z.object({
  domaine_code: z.string().trim().min(1).max(80),
  is_primary: z.boolean().optional().default(false),
  notes: z.string().trim().min(1).max(1000).optional().nullable(),
})

export const fournisseurAdresseTypeSchema = z.enum(["commande", "livraison", "facturation"])
export type FournisseurAdresseTypeDTO = z.infer<typeof fournisseurAdresseTypeSchema>

const adresseInputSchema = z.object({
  type: fournisseurAdresseTypeSchema,
  label: optionalText(120),
  ligne1: optionalText(200),
  ligne2: optionalText(200),
  house_no: optionalText(30),
  postcode: optionalText(30),
  city: optionalText(120),
  country: optionalText(120),
  is_primary: z.boolean().optional().default(false),
  actif: z.boolean().optional().default(true),
  notes: optionalText(2000),
})

export const fournisseurIdParamSchema = z.object({
  params: z.object({ id: uuid }),
})

export const listFournisseursQuerySchema = z
  .object({
    search: z.string().trim().optional(),
    actif: z.preprocess(parseBoolean, z.boolean().optional()),
    status: fournisseurStatusSchema.optional(),
    domaines: z.string().trim().optional(),
    homologation: z.string().trim().optional(),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce.number().int().min(1).max(200).optional().default(20),
    sortBy: z.enum(["updated_at", "code", "nom"]).optional().default("updated_at"),
    sortDir: sortDirSchema.optional().default("desc"),
  })
  .passthrough()

export type ListFournisseursQueryDTO = z.infer<typeof listFournisseursQuerySchema>

// NOTE: `code` is intentionally NOT accepted — it is generated server-side (FOU-NNN),
// immutable, via public.fn_next_issued_code_value('FOU'). Addresses are typed
// (commande/livraison/facturation); the flat address columns on public.fournisseurs are a
// service-maintained cache of the primary "commande" address (single write path).
export const createFournisseurSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(250),
      actif: z.boolean().optional().default(true),
      status: fournisseurStatusSchema.optional(),
      type_principal: optionalText(80),
      tva: optionalText(80),
      siret: optionalText(80),
      email: emailOptional,
      telephone: optionalText(50),
      site_web: urlOptional,
      nom_commercial: optionalText(250),
      logo: optionalText(1000),
      notes: optionalText(10000),
      domaines: z.array(domaineLienInputSchema).max(20).optional(),
      adresses: z.array(adresseInputSchema).max(20).optional(),
    })
    .strict(),
})

export type CreateFournisseurBodyDTO = z.infer<typeof createFournisseurSchema>["body"]

// PATCH is tri-state: only provided keys are updated. `code` is immutable (absent here);
// domaines are managed via PUT /:id/domaines; addresses via the /:id/adresses sub-resource.
// Optimistic concurrency: optional `expected_updated_at` guards against lost updates.
export const updateFournisseurSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(250).optional(),
      actif: z.boolean().optional(),
      status: fournisseurStatusSchema.optional(),
      type_principal: optionalText(80),
      tva: optionalText(80),
      siret: optionalText(80),
      email: emailOptional,
      telephone: optionalText(50),
      site_web: urlOptional,
      nom_commercial: optionalText(250),
      logo: optionalText(1000),
      notes: optionalText(10000),
      expected_updated_at: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
})

export type UpdateFournisseurBodyDTO = z.infer<typeof updateFournisseurSchema>["body"]

// Duplicate detection (protected endpoint; no sensitive data in query logs).
export const doublonQuerySchema = z
  .object({
    siret: z.string().trim().max(80).optional(),
    tva: z.string().trim().max(80).optional(),
    email: z.string().trim().max(200).optional(),
    exclude_id: uuid.optional(),
  })
  .passthrough()

export type DoublonQueryDTO = z.infer<typeof doublonQuerySchema>

export const contactIdParamSchema = z.object({
  params: z.object({ id: uuid, contactId: uuid }),
})

export const createContactSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(200),
      first_name: optionalText(100),
      last_name: optionalText(100),
      full_name: optionalText(220),
      email: emailOptional,
      telephone: optionalText(50),
      mobile: optionalText(50),
      role: optionalText(120),
      notes: optionalText(5000),
      is_primary: z.boolean().optional().default(false),
      actif: z.boolean().optional().default(true),
    })
    .strict(),
})

export type CreateContactBodyDTO = z.infer<typeof createContactSchema>["body"]

export const updateContactSchema = z.object({
  body: z
    .object({
      nom: z.string().trim().min(1).max(200).optional(),
      first_name: optionalText(100),
      last_name: optionalText(100),
      full_name: optionalText(220),
      email: emailOptional,
      telephone: optionalText(50),
      mobile: optionalText(50),
      role: optionalText(120),
      notes: optionalText(5000),
      is_primary: z.boolean().optional(),
      actif: z.boolean().optional(),
    })
    .strict(),
})

export type UpdateContactBodyDTO = z.infer<typeof updateContactSchema>["body"]

// Typed addresses (commande / livraison / facturation).
export const adresseIdParamSchema = z.object({
  params: z.object({ id: uuid, adresseId: uuid }),
})

export const createAdresseSchema = z.object({ body: adresseInputSchema.strict() })
export type CreateAdresseBodyDTO = z.infer<typeof createAdresseSchema>["body"]

export const updateAdresseSchema = z.object({
  body: z
    .object({
      type: fournisseurAdresseTypeSchema.optional(),
      label: optionalText(120),
      ligne1: optionalText(200),
      ligne2: optionalText(200),
      house_no: optionalText(30),
      postcode: optionalText(30),
      city: optionalText(120),
      country: optionalText(120),
      is_primary: z.boolean().optional(),
      actif: z.boolean().optional(),
      notes: optionalText(2000),
    })
    .strict(),
})

export type UpdateAdresseBodyDTO = z.infer<typeof updateAdresseSchema>["body"]

// Structured homologation / qualification.
export const fournisseurHomologationStatutSchema = z.enum([
  "a_qualifier",
  "en_cours",
  "homologue",
  "sous_reserve",
  "suspendu",
  "refuse",
  "expire",
])
export type FournisseurHomologationStatutDTO = z.infer<typeof fournisseurHomologationStatutSchema>

export const homologationIdParamSchema = z.object({
  params: z.object({ id: uuid, homologationId: uuid }),
})

export const createHomologationSchema = z.object({
  body: z
    .object({
      domaine_code: optionalText(80),
      statut: fournisseurHomologationStatutSchema.optional().default("a_qualifier"),
      reference: optionalText(200),
      organisme: optionalText(200),
      perimetre: optionalText(2000),
      valid_from: dateOptional,
      valid_to: dateOptional,
      document_id: uuid.optional().nullable(),
      notes: optionalText(2000),
    })
    .strict(),
})

export type CreateHomologationBodyDTO = z.infer<typeof createHomologationSchema>["body"]

export const updateHomologationSchema = z.object({
  body: z
    .object({
      domaine_code: optionalText(80),
      statut: fournisseurHomologationStatutSchema.optional(),
      reference: optionalText(200),
      organisme: optionalText(200),
      perimetre: optionalText(2000),
      valid_from: dateOptional,
      valid_to: dateOptional,
      document_id: uuid.optional().nullable(),
      notes: optionalText(2000),
    })
    .strict(),
})

export type UpdateHomologationBodyDTO = z.infer<typeof updateHomologationSchema>["body"]

export const fournisseurCatalogueTypeSchema = z.enum([
  "MATIERE",
  "CONSOMMABLE",
  "SOUS_TRAITANCE",
  "SERVICE",
  "OUTILLAGE",
  "AUTRE",
])

export type FournisseurCatalogueTypeDTO = z.infer<typeof fournisseurCatalogueTypeSchema>

export const incotermSchema = z.enum([
  "EXW",
  "FCA",
  "FAS",
  "FOB",
  "CFR",
  "CIF",
  "CPT",
  "CIP",
  "DAP",
  "DPU",
  "DDP",
])

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
      prix_multiple: z.number().finite().min(0).optional().nullable(),
      incoterm: incotermSchema.optional().nullable(),
      valid_from: dateOptional,
      valid_to: dateOptional,
      exigence_qualite: optionalText(2000),
      requiert_controle_reception: z.boolean().optional().default(false),
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
      prix_multiple: z.number().finite().min(0).optional().nullable(),
      incoterm: incotermSchema.optional().nullable(),
      valid_from: dateOptional,
      valid_to: dateOptional,
      exigence_qualite: optionalText(2000),
      requiert_controle_reception: z.boolean().optional(),
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

export const putFournisseurDomainesSchema = z.object({
  body: z.object({
    domaines: z.array(domaineLienInputSchema).max(20).default([]),
  }),
})

export type PutFournisseurDomainesDTO = z.infer<typeof putFournisseurDomainesSchema>["body"]

// Archive / status transition (distinct from simple deactivation).
export const archiveFournisseurSchema = z.object({
  body: z
    .object({
      motif: z.string().trim().min(1).max(2000).optional().nullable(),
    })
    .strict()
    .optional()
    .default({}),
})
