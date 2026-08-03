// src/module/gammes/validators/gammes.validators.ts
// GPAO B2.2 — validators des gammes + opérations de gamme.
import type { RequestHandler } from "express"
import { z } from "zod"
import { uuidRouteParam } from "../../../utils/routeParams"

const uuid = z.string().uuid()

export const gammeStatutSchema = z.enum(["BROUILLON", "EN_VALIDATION", "APPLICABLE", "OBSOLETE"])
export type GammeStatutDTO = z.infer<typeof gammeStatutSchema>

// `DECOUPE` rejoint les types d'opération (débit / découpe matière). Aucun type
// existant n'est retiré : les gammes déjà saisies restent lisibles.
export const operationTypeSchema = z.enum([
  "TOURNAGE",
  "FRAISAGE",
  "DECOUPE",
  "REPRISE",
  "CONTROLE",
  "LAVAGE",
  "SOUS_TRAITANCE",
  "EMBALLAGE",
  "AUTRE",
])
export type OperationTypeDTO = z.infer<typeof operationTypeSchema>

export const versionIdParamSchema = z.object({ params: z.object({ versionId: uuidRouteParam("versionId") }) })
export const gammeIdParamSchema = z.object({ params: z.object({ gammeId: uuidRouteParam("gammeId") }) })

const gammeCore = z.object({
  // #227 — le nom devient OPTIONNEL : le serveur le calcule depuis la pièce et l'indice
  // (domain/gamme-naming.ts). Un intitulé explicitement fourni reste respecté — reprise
  // de données, import, renommage volontaire — mais l'UI de création n'en envoie plus.
  nom: z.string().trim().min(1, "Nom de gamme vide").max(200).optional().nullable(),
  code: z.string().trim().max(80).optional().nullable(),
  designation: z.string().trim().max(200).optional().nullable(),
  commentaire: z.string().max(2000).optional().nullable(),
  statut: gammeStatutSchema.optional().default("BROUILLON"),
  is_current: z.boolean().optional().default(false),
})

export const createGammeSchema = z.object({ body: gammeCore })
export type CreateGammeBodyDTO = z.infer<typeof createGammeSchema>["body"]

export const updateGammeSchema = z.object({
  body: gammeCore.partial().extend({ expected_updated_at: z.string().min(1).optional() }),
})
export type UpdateGammeBodyDTO = z.infer<typeof updateGammeSchema>["body"]

/**
 * #433 — Préparer une révision d'une gamme figée.
 *
 * Le corps ne décrit PAS le contenu de la nouvelle gamme : celui-ci est
 * intégralement dupliqué depuis la source. Il ne porte que le verrou optimiste
 * et, éventuellement, un intitulé choisi — sinon le serveur nomme la révision.
 */
export const createGammeRevisionSchema = z.object({
  body: z
    .object({
      expected_updated_at: z.string().min(1).optional(),
      nom: z.string().trim().min(1, "Nom de gamme vide").max(200).optional().nullable(),
    })
    .strict(),
})
export type CreateGammeRevisionBodyDTO = z.infer<typeof createGammeRevisionSchema>["body"]

// Opération de gamme. Noms métier mappés aux colonnes DB : numero_operation→phase,
// temps_preparation→tp, temps_cycle→tf_unit.
//
// TROIS CHAMPS NE SONT PLUS ACCEPTÉS EN ENTRÉE :
//   - `taux_horaire`  : il est FIGÉ depuis le tarif du centre de frais ;
//   - `temps_total`   : il est CALCULÉ (`tp + tf × qte × coef`) ;
//   - `cout_mo`       : il est CALCULÉ, et vaut `null` sans tarif connu.
// Un client qui les envoie reçoit une erreur explicite plutôt qu'un silence.
const machineFamilyCode = z
  .string()
  .trim()
  .max(24)
  .transform((value) => value.toUpperCase())

const rejectedInputs = z
  .object({
    taux_horaire: z.undefined({
      invalid_type_error:
        "Le taux horaire ne se saisit plus sur l'opération : il est versionné sur le centre de frais.",
    }),
    temps_total: z.undefined({ invalid_type_error: "Le temps total est calculé, il ne se saisit pas." }),
    cout_mo: z.undefined({ invalid_type_error: "Le coût main-d'œuvre est calculé, il ne se saisit pas." }),
    temps_fabrication: z.undefined({ invalid_type_error: "Le temps de fabrication est calculé, il ne se saisit pas." }),
  })
  .partial()

const operationCore = z
  .object({
    numero_operation: z.coerce.number().int().min(1).max(999_999).optional(),
    insert_after_operation_id: uuid.optional().nullable(),
    // Optionnelle à la SAISIE si le centre de frais sait la générer. Une gamme
    // publiée, elle, n'accepte jamais une opération sans désignation figée.
    designation: z.string().trim().max(200).optional().nullable(),
    designation_2: z.string().max(200).optional().nullable(),
    type_operation: operationTypeSchema.optional().nullable(),
    machine_family_code: machineFamilyCode.optional().nullable(),
    machine_id: uuid.optional().nullable(),
    poste_id: uuid.optional().nullable(),
    cf_id: uuid.optional().nullable(),
    numero_programme: z.string().trim().max(60).optional().nullable(),
    // Unité de SAISIE de l'interface.
    temps_preparation_minutes: z.coerce.number().min(0).max(100_000).optional().nullable(),
    temps_unitaire_minutes: z.coerce.number().min(0).max(100_000).optional().nullable(),
    // Contrat historique, en HEURES décimales. Conservé pour ne pas casser les
    // appelants existants ; incompatible avec la variante en minutes.
    temps_preparation: z.coerce.number().min(0).optional().nullable(),
    temps_cycle: z.coerce.number().min(0).optional().nullable(),
    qte: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
    coef: z.coerce.number().min(0).max(1_000).optional().nullable(),
    prix: z.coerce.number().min(0).optional().nullable(),
    consignes: z.string().max(4000).optional().nullable(),
  })
  .merge(rejectedInputs)

export const addGammeOperationSchema = z.object({ body: operationCore })
export type AddGammeOperationBodyDTO = z.infer<typeof addGammeOperationSchema>["body"]

export const updateGammeOperationSchema = z.object({
  body: operationCore.extend({
    expected_updated_at: z.string().trim().min(1, "expected_updated_at est obligatoire"),
  }),
})
export type UpdateGammeOperationBodyDTO = z.infer<typeof updateGammeOperationSchema>["body"]

export const deleteGammeOperationSchema = z.object({
  body: z.object({ expected_updated_at: z.string().trim().min(1, "expected_updated_at est obligatoire") }),
})

export const operationIdParamSchema = z.object({
  params: z.object({ gammeId: uuidRouteParam("gammeId"), operationId: uuidRouteParam("operationId") }),
})

export const nextPhaseQuerySchema = z.object({
  query: z.object({ after_operation_id: uuid.optional() }),
})

export const publishGammeSchema = z.object({
  body: z.object({ expected_updated_at: z.string().trim().min(1, "expected_updated_at est obligatoire") }),
})

export const reorderOperationsSchema = z.object({ body: z.object({ order: z.array(uuid).min(1) }) })
export type ReorderOperationsBodyDTO = z.infer<typeof reorderOperationsSchema>["body"]

export function validate(schema: z.ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    try {
      schema.parse({ body: req.body, params: req.params, query: req.query })
      next()
    } catch (e) {
      next(e)
    }
  }
}
