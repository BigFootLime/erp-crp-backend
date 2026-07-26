// Validateurs du suivi et pointage de production (#274).
//
// Principe : le serveur ne fait jamais confiance au client sur l'identité, le
// temps ni les identifiants. En particulier :
//   * l'opérateur d'un pointage personnel vient du JWT, pas du corps de requête ;
//   * l'identifiant du pointage est généré par le serveur, jamais transmis ;
//   * les horodatages officiels sont posés par la base, le client ne peut en
//     proposer que pour une saisie rétroactive explicitement motivée.

import { z } from "zod";

import { PRODUCTION_EXECUTION_CAPABILITIES } from "../domain/production-execution";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide (attendu AAAA-MM-JJ)");

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => Number.isFinite(Date.parse(v)), "Horodatage invalide");

const activityCode = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, "Code d'activité invalide");

const reason = z.string().trim().min(3, "Motif trop court (3 caractères minimum)").max(2000);

/**
 * Clé d'idempotence : fournie par l'appelant, obligatoire sur toute commande à
 * effet. Elle permet au double-clic, au second onglet et au retry réseau de
 * produire exactement un effet.
 */
const idempotencyKey = z
  .string()
  .trim()
  .min(8, "Clé d'idempotence trop courte")
  .max(200);

export const executionIdParamSchema = z.object({ params: z.object({ id: uuid }) });

export const executionIdempotencyHeaderSchema = z.object({
  headers: z.object({
    "idempotency-key": idempotencyKey,
  }),
});

/* -------------------------------------------------------------------------- */
/* Lecture                                                                    */
/* -------------------------------------------------------------------------- */

export const listExecutionsQuerySchema = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
  of_id: z.coerce.number().int().positive().optional(),
  operation_id: uuid.optional(),
  machine_id: uuid.optional(),
  poste_id: uuid.optional(),
  operator_user_id: z.coerce.number().int().positive().optional(),
  activity_code: activityCode.optional(),
  status: z.enum(["RUNNING", "DONE", "CANCELLED", "CORRECTED"]).optional(),
  // Files opérationnelles du command center — filtres SERVEUR, jamais un tri de
  // la page courante.
  segment: z
    .enum([
      "all",
      "running",
      "long_running",
      "to_validate",
      "rejected",
      "incidents",
      "scrap",
      "overrun",
    ])
    .optional()
    .default("all"),
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  sortBy: z
    .enum(["start_ts", "end_ts", "duration_minutes", "updated_at"])
    .optional()
    .default("start_ts"),
  sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
});
export type ListExecutionsQueryDTO = z.infer<typeof listExecutionsQuerySchema>;

export const executionCenterQuerySchema = z.object({
  date_from: isoDate.optional(),
  date_to: isoDate.optional(),
});
export type ExecutionCenterQueryDTO = z.infer<typeof executionCenterQuerySchema>;

export const operatorBoardQuerySchema = z.object({
  // Le tableau de bord du poste opérateur est TOUJOURS celui de l'appelant.
  // Consulter celui d'un tiers exige `create_for_other`, contrôlé côté service.
  operator_user_id: z.coerce.number().int().positive().optional(),
  of_id: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});
export type OperatorBoardQueryDTO = z.infer<typeof operatorBoardQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Commandes à effet                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Démarrage. Aucun `id` : le serveur génère l'identifiant. `operator_user_id`
 * n'est accepté que si l'appelant détient `create_for_other`, et il exige alors
 * un motif — sinon le champ est ignoré au profit de l'identité du JWT.
 */
export const startExecutionSchema = z.object({
  body: z.object({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid.nullable().optional(),
    machine_id: uuid.nullable().optional(),
    poste_id: uuid.nullable().optional(),
    activity_code: activityCode,
    time_type: z.enum(["OPERATEUR", "MACHINE", "PROGRAMMATION"]).optional(),
    comment: z.string().trim().max(2000).nullable().optional(),

    operator_user_id: z.coerce.number().int().positive().optional(),
    for_other_reason: reason.optional(),

    // Saisie rétroactive bornée : motif obligatoire, contrôle de chevauchement
    // et validation hiérarchique côté service.
    start_ts: isoDateTime.optional(),
    retroactive_reason: reason.optional(),
  }),
});
export type StartExecutionBodyDTO = z.infer<typeof startExecutionSchema>["body"];

export const pauseExecutionSchema = z.object({
  body: z.object({
    activity_code: activityCode.optional(),
    reason: reason.optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
  }),
});
export type PauseExecutionBodyDTO = z.infer<typeof pauseExecutionSchema>["body"];

export const resumeExecutionSchema = z.object({
  body: z.object({
    activity_code: activityCode.optional(),
    machine_id: uuid.nullable().optional(),
    comment: z.string().trim().max(2000).nullable().optional(),
  }),
});
export type ResumeExecutionBodyDTO = z.infer<typeof resumeExecutionSchema>["body"];

/**
 * Changement d'activité, de machine ou d'opérateur : clôture le segment courant
 * et en ouvre un nouveau. L'historique n'est jamais réécrit.
 */
export const changeExecutionSchema = z.object({
  body: z
    .object({
      activity_code: activityCode.optional(),
      machine_id: uuid.nullable().optional(),
      poste_id: uuid.nullable().optional(),
      operator_user_id: z.coerce.number().int().positive().optional(),
      reason: reason.optional(),
      comment: z.string().trim().max(2000).nullable().optional(),
    })
    .refine(
      (b) =>
        b.activity_code !== undefined ||
        b.machine_id !== undefined ||
        b.poste_id !== undefined ||
        b.operator_user_id !== undefined,
      { message: "Indiquez au moins un changement (activité, machine, poste ou opérateur)." }
    ),
});
export type ChangeExecutionBodyDTO = z.infer<typeof changeExecutionSchema>["body"];

export const incidentExecutionSchema = z.object({
  body: z.object({
    activity_code: activityCode,
    reason,
    comment: z.string().trim().max(2000).nullable().optional(),
    // Un aléa peut suspendre la machine sans arrêter l'opération.
    stops_machine: z.boolean().optional().default(false),
  }),
});
export type IncidentExecutionBodyDTO = z.infer<typeof incidentExecutionSchema>["body"];

export const stopExecutionSchema = z.object({
  body: z.object({
    comment: z.string().trim().max(2000).nullable().optional(),
    // Un arrêt de timer ne termine JAMAIS l'opération tout seul : la clôture
    // passe par la commande atomique de fin d'opération.
    end_ts: isoDateTime.optional(),
    retroactive_reason: reason.optional(),
  }),
});
export type StopExecutionBodyDTO = z.infer<typeof stopExecutionSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Quantités                                                                  */
/* -------------------------------------------------------------------------- */

const quantityDelta = z.object({
  qty_good: z.coerce.number().finite().min(0).optional().default(0),
  qty_scrap: z.coerce.number().finite().min(0).optional().default(0),
  qty_rework: z.coerce.number().finite().min(0).optional().default(0),
  qty_pending_control: z.coerce.number().finite().min(0).optional().default(0),
  unite: z.string().trim().max(32).nullable().optional(),
  scrap_reason_code: z.string().trim().max(64).nullable().optional(),
  rework_reason_code: z.string().trim().max(64).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  // Motif exigé uniquement en cas de dépassement toléré du restant.
  overproduction_reason: reason.optional(),
});

export const declareQuantitySchema = z.object({
  body: quantityDelta.extend({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid.nullable().optional(),
    pointage_id: uuid.nullable().optional(),
  }),
});
export type DeclareQuantityBodyDTO = z.infer<typeof declareQuantitySchema>["body"];

/**
 * Commande métier atomique de fin d'opération. `preview` d'abord (lecture
 * seule, aucune écriture), puis confirmation avec l'empreinte de l'aperçu :
 * si l'état a bougé entre les deux, la confirmation est refusée plutôt que
 * d'appliquer un effet calculé sur des données périmées.
 */
export const finishOperationPreviewSchema = z.object({
  body: quantityDelta.extend({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid,
    stop_active_segment: z.boolean().optional().default(true),
    complete_operation: z.boolean().optional().default(false),
  }),
});
export type FinishOperationPreviewBodyDTO = z.infer<typeof finishOperationPreviewSchema>["body"];

export const finishOperationSchema = z.object({
  body: quantityDelta.extend({
    of_id: z.coerce.number().int().positive(),
    operation_id: uuid,
    stop_active_segment: z.boolean().optional().default(true),
    complete_operation: z.boolean().optional().default(false),
    // Empreinte de l'aperçu affiché à l'opérateur : garantit qu'il confirme
    // bien ce qu'il a vu.
    preview_hash: z.string().trim().length(64),
  }),
});
export type FinishOperationBodyDTO = z.infer<typeof finishOperationSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Cycle de validation                                                        */
/* -------------------------------------------------------------------------- */

export const submitExecutionSchema = z.object({
  body: z.object({ note: z.string().trim().max(2000).nullable().optional() }),
});
export type SubmitExecutionBodyDTO = z.infer<typeof submitExecutionSchema>["body"];

export const validateExecutionSchema = z.object({
  body: z.object({ note: z.string().trim().max(2000).nullable().optional() }),
});
export type ValidateExecutionBodyDTO = z.infer<typeof validateExecutionSchema>["body"];

export const rejectExecutionSchema = z.object({
  body: z.object({ reason }),
});
export type RejectExecutionBodyDTO = z.infer<typeof rejectExecutionSchema>["body"];

export const correctExecutionSchema = z.object({
  body: z.object({
    correction_reason: reason,
    patch: z
      .object({
        start_ts: isoDateTime.optional(),
        end_ts: isoDateTime.nullable().optional(),
        activity_code: activityCode.optional(),
        machine_id: uuid.nullable().optional(),
        poste_id: uuid.nullable().optional(),
        operation_id: uuid.nullable().optional(),
        comment: z.string().trim().max(2000).nullable().optional(),
      })
      .refine((p) => Object.keys(p).length > 0, { message: "Aucune correction fournie." }),
  }),
});
export type CorrectExecutionBodyDTO = z.infer<typeof correctExecutionSchema>["body"];

export const cancelExecutionSchema = z.object({
  body: z.object({ reason }),
});
export type CancelExecutionBodyDTO = z.infer<typeof cancelExecutionSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Référentiel d'activités                                                    */
/* -------------------------------------------------------------------------- */

export const listActivityCategoriesQuerySchema = z.object({
  include_disabled: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type ListActivityCategoriesQueryDTO = z.infer<typeof listActivityCategoriesQuerySchema>;

export const capabilitiesResponseSchema = z.object({
  capabilities: z.array(z.enum(PRODUCTION_EXECUTION_CAPABILITIES)),
});
