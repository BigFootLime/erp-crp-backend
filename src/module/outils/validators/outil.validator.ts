import { z } from "zod"

const profondeurUtileValues = [
  "3xd",
  "4xd",
  "5xd",
  "6xd",
  "8xd",
  "10xd",
  "12xd",
  "court",
  "long",
] as const

const typeArrosageValues = ["Arr-bc", "Arr-externe"] as const

function toFiniteNumber(value: unknown) {
  if (value === "" || value === null || value === undefined) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toTrimmedString(value: unknown) {
  if (value === null || value === undefined) return ""
  return String(value).trim()
}

const requiredString = z.preprocess((value) => toTrimmedString(value), z.string().min(1, "Champ requis"))

const optionalString = z
  .preprocess((value) => toTrimmedString(value), z.string())
  .transform((value) => (value.length ? value : undefined))

const nullableString = z
  .preprocess((value) => toTrimmedString(value), z.string())
  .transform((value) => (value.length ? value : null))

const positiveInt = z.preprocess((value) => toFiniteNumber(value), z.number().int().positive())

const optionalPositiveInt = z.preprocess((value) => {
  const parsed = toFiniteNumber(value)
  return parsed === null ? undefined : parsed
}, z.number().int().positive().optional())

const nullableInt = z.preprocess((value) => {
  const parsed = toFiniteNumber(value)
  return parsed === null ? null : Math.trunc(parsed)
}, z.number().int().nullable())

const nullableFiniteNumber = z.preprocess((value) => toFiniteNumber(value), z.number().finite().nullable())

const nonNegativeInt = z.preprocess((value) => {
  const parsed = toFiniteNumber(value)
  return parsed === null ? 0 : Math.trunc(parsed)
}, z.number().int().nonnegative())

const nonNegativeNumber = z.preprocess((value) => {
  const parsed = toFiniteNumber(value)
  return parsed === null ? 0 : parsed
}, z.number().finite().nonnegative())

const positiveQuantity = z.preprocess((value) => toFiniteNumber(value), z.number().int().positive())

const positiveIntegerArray = z
  .array(z.union([z.string(), z.number()]))
  .optional()
  .default([])
  .transform((items) =>
    items
      .map((item) => toFiniteNumber(item))
      .filter((item): item is number => item !== null && Number.isInteger(item) && item > 0)
      .map((item) => Math.trunc(item))
  )

export const outilUpsertSchema = z.object({
  id_fabricant: positiveInt,
  id_famille: positiveInt,
  id_geometrie: nullableInt.optional(),

  codification: requiredString,
  designation_outil_cnc: requiredString,
  reference_fabricant: optionalString,

  profondeur_utile: z
    .preprocess(
      (value) => {
        const normalized = toTrimmedString(value).toLowerCase()
        return normalized.length ? normalized : null
      },
      z.enum(profondeurUtileValues).nullable()
    )
    .optional(),
  matiere_usiner: nullableString.optional(),
  utilisation: nullableString.optional(),

  longueur_coupe: nullableFiniteNumber.optional(),
  longueur_detalonnee: nullableFiniteNumber.optional(),
  longueur_totale: nullableFiniteNumber.optional(),
  diametre_nominal: nullableFiniteNumber.optional(),
  diametre_queue: nullableFiniteNumber.optional(),
  diametre_trou: nullableFiniteNumber.optional(),
  diametre_detalonnee: nullableFiniteNumber.optional(),
  angle_helice: nullableFiniteNumber.optional(),
  angle_pointe: nullableFiniteNumber.optional(),
  angle_filetage: nullableFiniteNumber.optional(),
  norme_filetage: nullableString.optional(),
  pas_filetage: nullableFiniteNumber.optional(),
  type_arrosage: z
    .preprocess((value) => {
      const normalized = toTrimmedString(value)
      return normalized.length ? normalized : null
    }, z.enum(typeArrosageValues).nullable())
    .optional(),
  type_entree: nullableString.optional(),
  nombre_dents: nullableInt.optional(),

  fournisseurs: positiveIntegerArray,
  revetements: positiveIntegerArray,
  valeurs_aretes: z
    .array(
      z.object({
        id_arete_coupe: positiveInt,
        valeur: nonNegativeNumber,
      })
    )
    .optional()
    .default([]),

  quantite_stock: nonNegativeInt.default(0),
  quantite_minimale: nonNegativeInt.default(0),

  esquisse_file: z.unknown().optional().nullable(),
  plan_file: z.unknown().optional().nullable(),
  image_file: z.unknown().optional().nullable(),

  _created_at: optionalString,
})

export type CreateOutilInput = z.infer<typeof outilUpsertSchema>
export type UpdateOutilInput = z.infer<typeof outilUpsertSchema>

export const sortieStockSchema = z.object({
  id: positiveInt,
  quantity: positiveQuantity,
  reason: optionalString,
  note: optionalString,
  affaire_id: optionalPositiveInt,
})

export type SortieStockInput = z.infer<typeof sortieStockSchema>

export const reapprovisionnementSchema = z.object({
  id_outil: positiveInt,
  quantite: positiveQuantity,
  prix: z.preprocess((value) => toFiniteNumber(value), z.number().finite().nonnegative()),
  id_fournisseur: positiveInt,
  reason: optionalString,
  note: optionalString,
  affaire_id: optionalPositiveInt,
})

export type ReapprovisionnementInput = z.infer<typeof reapprovisionnementSchema>

export const scanMovementSchema = z.object({
  barcode: requiredString,
  quantity: positiveQuantity.optional().default(1),
  prix: z.preprocess((value) => {
    const parsed = toFiniteNumber(value)
    return parsed === null ? undefined : parsed
  }, z.number().finite().nonnegative().optional()),
  id_fournisseur: optionalPositiveInt,
  reason: optionalString,
  note: optionalString,
  affaire_id: optionalPositiveInt,
}).superRefine((value, ctx) => {
  const hasPrix = typeof value.prix === "number"
  const hasFournisseur = typeof value.id_fournisseur === "number"
  if (hasPrix !== hasFournisseur) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasPrix ? ["id_fournisseur"] : ["prix"],
      message: "Le fournisseur et le prix doivent etre renseignes ensemble",
    })
  }
})

export type ScanMovementInput = z.infer<typeof scanMovementSchema>

export const adjustStockSchema = z.object({
  id_outil: positiveInt,
  new_qty: z.preprocess((value) => toFiniteNumber(value), z.number().int().nonnegative()),
  reason: optionalString.default("inventaire"),
  note: optionalString,
  affaire_id: optionalPositiveInt,
})

export type AdjustStockInput = z.infer<typeof adjustStockSchema>

export const createFabricantSchema = z.object({
  nom_fabricant: requiredString,
  id_fournisseurs: positiveIntegerArray,
})

export const createFournisseurSchema = z.object({
  nom: requiredString,
  adresse_ligne: optionalString,
  house_no: optionalString,
  postcode: optionalString,
  city: optionalString,
  country: optionalString,
  phone_num: optionalString,
  email: optionalString.refine((value) => !value || z.string().email().safeParse(value).success, {
    message: "Email invalide",
  }),
  nom_commercial: optionalString,
})

export const createRevetementSchema = z.object({
  nom: requiredString,
  id_fabricant: positiveInt,
})

export const createFamilleSchema = z.object({
  nom_famille: requiredString,
})

export const updateFamilleSchema = createFamilleSchema

export const createGeometrieSchema = z.object({
  nom_geometrie: requiredString,
  id_famille: positiveInt,
})

export const updateGeometrieSchema = createGeometrieSchema
