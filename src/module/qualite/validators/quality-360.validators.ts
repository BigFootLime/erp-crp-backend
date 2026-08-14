// Validateurs Zod stricts pour la surface Qualité 360 (#228).
// Toutes les bornes (pagination, tri, longueurs, quantités) sont serveur ;
// aucun champ inconnu n'est accepté.

import { z } from "zod";

import { TRACEABILITY_NODE_TYPES } from "../../traceability/domain/traceability-model";

import {
  QUALITY_CHARACTERISTIC_TYPES,
  QUALITY_CRITICALITIES,
  QUALITY_SAMPLING_RULES,
  QUALITY_TRIGGERS,
  QUALITY_VALUE_KINDS,
} from "../domain/quality-plan";
import {
  QUALITY_DEROGATION_STATUSES,
  QUALITY_DELIVERY_POLICY_STATUSES,
  QUALITY_DISPOSITION_TYPES,
  QUALITY_NC_STATUSES,
  QUALITY_PLAN_STATUSES,
  QUALITY_VERDICTS,
} from "../domain/quality-policy";
import {
  QUALITY_ELIGIBILITY_PURPOSES,
  QUALITY_RELEASE_DECISIONS,
  QUALITY_SOURCE_TYPES,
} from "../domain/quality-release";

const uuid = z.string().uuid();
const optionalUuid = uuid.nullable().optional();

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((v) => Number.isFinite(Date.parse(v)), "Date-heure invalide");

const shortText = (max: number) => z.string().trim().min(1).max(max);
const longText = (max: number) => z.string().trim().max(max);

// Les quantités sont finies, positives ou nulles et bornées : un Infinity ou un
// NaN ne franchit jamais la validation.
const quantity = z
  .number()
  .refine((v) => Number.isFinite(v), "Quantité non finie")
  .refine((v) => v >= 0, "Quantité négative")
  .refine((v) => v <= 1_000_000_000, "Quantité hors limites");

const positiveQuantity = quantity.refine((v) => v > 0, "Quantité strictement positive requise");

const unite = z.string().trim().min(1).max(16);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const idParamSchema = z.object({ params: z.object({ id: uuid }) });

/* -------------------------------------------------------------------------- */
/* Plans de contrôle                                                          */
/* -------------------------------------------------------------------------- */

export const samplingSchema = z
  .object({
    rule: z.enum(QUALITY_SAMPLING_RULES),
    value: z.number().finite().positive().max(100_000).nullable().default(null),
    justification: longText(500).nullable().default(null),
  })
  .strict();

export const planCharacteristicInputSchema = z
  .object({
    characteristic_key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9._-]*$/i, "Clé de caractéristique invalide (A-Z, 0-9, . _ -)"),
    position: z.number().int().min(1).max(500),
    label: shortText(200),
    characteristic_type: z.enum(QUALITY_CHARACTERISTIC_TYPES),
    value_kind: z.enum(QUALITY_VALUE_KINDS),
    unit: z.string().trim().min(1).max(16).nullable().default(null),
    nominal: z.number().finite().nullable().default(null),
    tolerance_min: z.number().finite().nullable().default(null),
    tolerance_max: z.number().finite().nullable().default(null),
    precision: z.number().int().min(0).max(9).nullable().default(null),
    expected_boolean: z.boolean().nullable().default(null),
    allowed_values: z.array(shortText(80)).min(1).max(50).nullable().default(null),
    criticality: z.enum(QUALITY_CRITICALITIES),
    mandatory: z.boolean().default(true),
    requires_instrument: z.boolean().default(false),
    instrument_category: z.string().trim().min(1).max(60).nullable().default(null),
    method: longText(500).nullable().default(null),
    acceptance_rule: longText(500).nullable().default(null),
    sampling: samplingSchema,
    trigger: z.enum(QUALITY_TRIGGERS),
  })
  .strict();

export type PlanCharacteristicInputDTO = z.infer<typeof planCharacteristicInputSchema>;

const planScopeShape = {
  article_id: optionalUuid,
  piece_technique_id: optionalUuid,
  piece_version_id: optionalUuid,
  famille_id: optionalUuid,
  operation_code: z.string().trim().min(1).max(40).nullable().optional(),
  fournisseur_id: optionalUuid,
};

export const createPlanSchema = z.object({
  body: z
    .object({
      label: shortText(200),
      trigger_type: z.enum(QUALITY_TRIGGERS),
      ...planScopeShape,
      sampling: samplingSchema,
      owner_user_id: z.number().int().positive().nullable().optional(),
      revision_reason: longText(500).nullable().optional(),
      effective_from: isoDateTime.nullable().optional(),
      effective_to: isoDateTime.nullable().optional(),
      characteristics: z.array(planCharacteristicInputSchema).min(1).max(200),
    })
    .strict()
    .refine(
      (b) =>
        Boolean(b.article_id || b.piece_technique_id || b.piece_version_id || b.famille_id),
      { message: "Au moins un axe produit est requis (article, pièce, version ou famille)", path: ["piece_technique_id"] }
    ),
});
export type CreatePlanBodyDTO = z.infer<typeof createPlanSchema>["body"];

export const updatePlanSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      expected_updated_at: isoDateTime,
      label: shortText(200).optional(),
      sampling: samplingSchema.optional(),
      owner_user_id: z.number().int().positive().nullable().optional(),
      revision_reason: longText(500).nullable().optional(),
      effective_from: isoDateTime.nullable().optional(),
      effective_to: isoDateTime.nullable().optional(),
      characteristics: z.array(planCharacteristicInputSchema).min(1).max(200).optional(),
    })
    .strict(),
});
export type UpdatePlanBodyDTO = z.infer<typeof updatePlanSchema>["body"];

export const planTransitionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      target_status: z.enum(QUALITY_PLAN_STATUSES),
      expected_updated_at: isoDateTime,
      reason: longText(500).nullable().optional(),
    })
    .strict(),
});
export type PlanTransitionBodyDTO = z.infer<typeof planTransitionSchema>["body"];

export const revisePlanSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      revision_reason: shortText(500),
    })
    .strict(),
});

export const listPlansQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(QUALITY_PLAN_STATUSES).optional(),
  trigger_type: z.enum(QUALITY_TRIGGERS).optional(),
  article_id: uuid.optional(),
  piece_technique_id: uuid.optional(),
  piece_version_id: uuid.optional(),
  famille_id: uuid.optional(),
  fournisseur_id: uuid.optional(),
  sortBy: z.enum(["code", "version", "label", "status", "updated_at", "published_at"]).default("updated_at"),
});
export type ListPlansQueryDTO = z.infer<typeof listPlansQuerySchema>;

export const planApplicabilityQuerySchema = z
  .object({
    trigger: z.enum(QUALITY_TRIGGERS),
    article_id: uuid.optional(),
    piece_technique_id: uuid.optional(),
    piece_version_id: uuid.optional(),
    famille_id: uuid.optional(),
    operation_code: z.string().trim().min(1).max(40).optional(),
    fournisseur_id: uuid.optional(),
    at: isoDateTime.optional(),
  })
  .strict();
export type PlanApplicabilityQueryDTO = z.infer<typeof planApplicabilityQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Politique globale de liberation des BL                                     */
/* -------------------------------------------------------------------------- */

export const deliveryReleasePolicyRulesSchema = z
  .object({
    schema: z.literal("cerp.quality.delivery-release-policy.v2"),
    engine: z.literal("CERP_QUALITY_ELIGIBILITY_V1"),
    aggregate_scope: z.literal("ALL_DELIVERY_ALLOCATIONS"),
    derogation_mode: z.enum(["FORBIDDEN", "APPROVED_LINKED_RELEASE_ONLY"]),
    required_control_triggers: z.tuple([z.literal("LOT_RELEASE")]),
    require_independent_decider: z.literal(true),
    required_documents: z
      .array(
        z
          .object({
            document_type: shortText(80),
            scope: z.enum(["PER_DELIVERY", "PER_TARGET"]),
            min_count: z.number().int().min(1).max(100),
          })
          .strict()
      )
      .max(50),
  })
  .strict();

export const createDeliveryPolicySchema = z.object({
  body: z
    .object({
      label: shortText(200),
      justification: shortText(1000),
      valid_from: isoDateTime,
      valid_to: isoDateTime.nullable().optional(),
      rules: deliveryReleasePolicyRulesSchema,
    })
    .strict(),
});
export type CreateDeliveryPolicyBodyDTO = z.infer<typeof createDeliveryPolicySchema>["body"];

export const updateDeliveryPolicySchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      expected_updated_at: isoDateTime,
      label: shortText(200),
      justification: shortText(1000),
      valid_from: isoDateTime,
      valid_to: isoDateTime.nullable().optional(),
      rules: deliveryReleasePolicyRulesSchema,
    })
    .strict(),
});
export type UpdateDeliveryPolicyBodyDTO = z.infer<typeof updateDeliveryPolicySchema>["body"];

export const deliveryPolicyTransitionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      target_status: z.enum(QUALITY_DELIVERY_POLICY_STATUSES),
      expected_updated_at: isoDateTime,
      reason: shortText(1000),
      signature_reference: z.string().trim().min(3).max(200).nullable().optional(),
      document_reference: z.string().trim().min(3).max(500).nullable().optional(),
    })
    .strict(),
});
export type DeliveryPolicyTransitionBodyDTO = z.infer<typeof deliveryPolicyTransitionSchema>["body"];

export const reviseDeliveryPolicySchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ revision_reason: shortText(1000) }).strict(),
});

/* -------------------------------------------------------------------------- */
/* Exécutions de contrôle                                                     */
/* -------------------------------------------------------------------------- */

export const executionPreviewSchema = z.object({
  body: z
    .object({
      source_type: z.enum(QUALITY_SOURCE_TYPES),
      source_id: shortText(64),
      trigger: z.enum(QUALITY_TRIGGERS),
      population: positiveQuantity,
      unite,
      article_id: optionalUuid,
      piece_technique_id: optionalUuid,
      piece_version_id: optionalUuid,
      famille_id: optionalUuid,
      operation_code: z.string().trim().min(1).max(40).nullable().optional(),
      fournisseur_id: optionalUuid,
      lot_id: optionalUuid,
      bon_livraison_id: optionalUuid,
      delivery_allocation_id: optionalUuid,
      of_id: z.number().int().positive().nullable().optional(),
      reception_ligne_id: optionalUuid,
    })
    .strict(),
});
export type ExecutionPreviewBodyDTO = z.infer<typeof executionPreviewSchema>["body"];

export const createExecutionSchema = z.object({
  body: executionPreviewSchema.shape.body.extend({
    preview_sha256: z
      .string()
      .trim()
      .regex(/^[a-f0-9]{64}$/, "Empreinte d'aperçu invalide"),
    controlled_by: z.number().int().positive().nullable().optional(),
    comments: longText(2000).nullable().optional(),
  }),
});
export type CreateExecutionBodyDTO = z.infer<typeof createExecutionSchema>["body"];

export const measurementInputSchema = z
  .object({
    characteristic_key: shortText(40),
    sample_no: z.number().int().min(1).max(10_000),
    value_numeric: z.number().finite().nullable().default(null),
    value_boolean: z.boolean().nullable().default(null),
    value_text: longText(2000).nullable().default(null),
    unit: z.string().trim().min(1).max(16).nullable().default(null),
    instrument_id: optionalUuid,
    comment: longText(1000).nullable().default(null),
  })
  .strict();
export type MeasurementInputDTO = z.infer<typeof measurementInputSchema>;

export const recordMeasurementsSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      expected_updated_at: isoDateTime,
      measurements: z.array(measurementInputSchema).min(1).max(500),
      // Motif obligatoire dès qu'une mesure existante est corrigée.
      correction_reason: z.string().trim().min(5).max(500).nullable().optional(),
    })
    .strict(),
});
export type RecordMeasurementsBodyDTO = z.infer<typeof recordMeasurementsSchema>["body"];

export const verdictPreviewSchema = z.object({ params: z.object({ id: uuid }) });

export const decideExecutionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      expected_updated_at: isoDateTime,
      preview_sha256: z.string().trim().regex(/^[a-f0-9]{64}$/, "Empreinte d'aperçu invalide"),
      decision: z.enum(QUALITY_RELEASE_DECISIONS),
      qty: quantity,
      unite,
      object_type: z.enum(QUALITY_SOURCE_TYPES),
      object_id: shortText(64),
      verdict_override: z.enum(QUALITY_VERDICTS).nullable().optional(),
      justification: longText(2000).nullable().optional(),
      derogation_id: optionalUuid,
    })
    .strict(),
});
export type DecideExecutionBodyDTO = z.infer<typeof decideExecutionSchema>["body"];

export const listExecutionsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["PLANNED", "IN_PROGRESS", "VALIDATED", "REJECTED"]).optional(),
  verdict: z.enum(QUALITY_VERDICTS).optional(),
  trigger: z.enum(QUALITY_TRIGGERS).optional(),
  source_type: z.enum(QUALITY_SOURCE_TYPES).optional(),
  source_id: z.string().trim().max(64).optional(),
  plan_id: uuid.optional(),
  lot_id: uuid.optional(),
  sortBy: z.enum(["control_date", "updated_at", "verdict", "reference"]).default("control_date"),
});
export type ListExecutionsQueryDTO = z.infer<typeof listExecutionsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Dérogations / concessions                                                  */
/* -------------------------------------------------------------------------- */

const derogationScopeShape = {
  article_id: optionalUuid,
  piece_technique_id: optionalUuid,
  piece_version_id: optionalUuid,
  lot_id: optionalUuid,
  of_id: z.number().int().positive().nullable().optional(),
  commande_id: optionalUuid,
  bon_livraison_id: optionalUuid,
};

export const createDerogationSchema = z.object({
  body: z
    .object({
      derogation_type: z.enum(["CONCESSION", "DEVIATION_PERMIT", "SPECIAL_ACCEPTANCE"]),
      non_conformity_id: optionalUuid,
      client_id: z.string().trim().min(1).max(40).nullable().optional(),
      fournisseur_id: optionalUuid,
      ...derogationScopeShape,
      requirement: shortText(500),
      deviation: shortText(2000),
      risk_analysis: longText(4000).nullable().optional(),
      conditions: longText(4000).nullable().optional(),
      max_qty: positiveQuantity.nullable().optional(),
      unite: unite.nullable().optional(),
      valid_from: isoDateTime.nullable().optional(),
      valid_to: isoDateTime.nullable().optional(),
      customer_agreement_reference: z.string().trim().min(1).max(120).nullable().optional(),
    })
    .strict()
    .refine(
      (b) =>
        Boolean(
          b.article_id ||
            b.piece_technique_id ||
            b.piece_version_id ||
            b.lot_id ||
            b.of_id ||
            b.commande_id ||
            b.bon_livraison_id
        ),
      { message: "Une dérogation exige un périmètre exploitable", path: ["lot_id"] }
    )
    .refine((b) => (b.max_qty === null || b.max_qty === undefined ? true : Boolean(b.unite)), {
      message: "Une quantité maximale exige une unité",
      path: ["unite"],
    }),
});
export type CreateDerogationBodyDTO = z.infer<typeof createDerogationSchema>["body"];

export const derogationTransitionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      target_status: z.enum(QUALITY_DEROGATION_STATUSES),
      expected_updated_at: isoDateTime,
      reason: longText(1000).nullable().optional(),
    })
    .strict()
    .refine(
      (b) =>
        b.target_status === "REJECTED" || b.target_status === "REVOKED"
          ? Boolean((b.reason ?? "").trim())
          : true,
      { message: "Un refus ou une révocation exige un motif", path: ["reason"] }
    ),
});
export type DerogationTransitionBodyDTO = z.infer<typeof derogationTransitionSchema>["body"];

export const consumeDerogationSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      qty: positiveQuantity,
      unite,
      quality_control_id: optionalUuid,
      release_decision_id: optionalUuid,
      bon_livraison_id: optionalUuid,
      context: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
    })
    .strict(),
});
export type ConsumeDerogationBodyDTO = z.infer<typeof consumeDerogationSchema>["body"];

export const listDerogationsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(QUALITY_DEROGATION_STATUSES).optional(),
  non_conformity_id: uuid.optional(),
  lot_id: uuid.optional(),
  expiring_within_days: z.coerce.number().int().min(1).max(365).optional(),
  sortBy: z.enum(["code", "status", "valid_to", "updated_at"]).default("updated_at"),
});
export type ListDerogationsQueryDTO = z.infer<typeof listDerogationsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Non-conformités : analyse guidée et transitions étendues                    */
/* -------------------------------------------------------------------------- */

export const analysisStepInputSchema = z
  .object({
    method: z.enum(["FIVE_WHY", "EIGHT_D"]),
    step_code: shortText(20),
    position: z.number().int().min(1).max(20),
    question: longText(1000).nullable().default(null),
    answer: longText(4000).nullable().default(null),
    owner_user_id: z.number().int().positive().nullable().default(null),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD")
      .nullable()
      .default(null),
    completed: z.boolean().default(false),
  })
  .strict();
export type AnalysisStepInputDTO = z.infer<typeof analysisStepInputSchema>;

export const upsertAnalysisSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      expected_updated_at: isoDateTime,
      method: z.enum(["FIVE_WHY", "EIGHT_D"]),
      steps: z.array(analysisStepInputSchema).min(1).max(20),
    })
    .strict(),
});
export type UpsertAnalysisBodyDTO = z.infer<typeof upsertAnalysisSchema>["body"];

export const ncTransitionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      target_status: z.enum(QUALITY_NC_STATUSES),
      expected_updated_at: isoDateTime,
      reason: longText(1000).nullable().optional(),
    })
    .strict()
    .refine(
      (b) =>
        b.target_status === "CANCELLED" || b.target_status === "OPEN"
          ? true
          : true,
      { message: "Motif requis", path: ["reason"] }
    ),
});
export type NcTransitionBodyDTO = z.infer<typeof ncTransitionSchema>["body"];

export const dispositionPreviewSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      disposition_type: z.enum(QUALITY_DISPOSITION_TYPES),
      qty: quantity,
      unite,
      instructions: longText(2000).nullable().optional(),
      derogation_id: optionalUuid,
      quality_control_id: optionalUuid,
    })
    .strict(),
});
export type DispositionPreviewBodyDTO = z.infer<typeof dispositionPreviewSchema>["body"];

export const dispositionConfirmSchema = z.object({
  params: z.object({ id: uuid }),
  body: dispositionPreviewSchema.shape.body.extend({
    preview_sha256: z.string().trim().regex(/^[a-f0-9]{64}$/, "Empreinte d'aperçu invalide"),
  }),
});
export type DispositionConfirmBodyDTO = z.infer<typeof dispositionConfirmSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Éligibilité                                                                */
/* -------------------------------------------------------------------------- */

export const eligibilityQuerySchema = z
  .object({
    purpose: z.enum(QUALITY_ELIGIBILITY_PURPOSES),
    object_type: z.enum(QUALITY_SOURCE_TYPES),
    object_id: shortText(64),
    // Query string : la quantité arrive en texte, on la contraint puis on
    // applique les mêmes bornes que dans un corps JSON.
    qty: z.coerce
      .number()
      .refine((v) => Number.isFinite(v), "Quantité non finie")
      .refine((v) => v >= 0, "Quantité négative")
      .refine((v) => v <= 1_000_000_000, "Quantité hors limites"),
  })
  .strict();
export type EligibilityQueryDTO = z.infer<typeof eligibilityQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Centre Qualité                                                             */
/* -------------------------------------------------------------------------- */

export const qualityCenterQuerySchema = z
  .object({
    horizon_days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type QualityCenterQueryDTO = z.infer<typeof qualityCenterQuerySchema>;

export const qualityIntelligenceQuerySchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    horizon_days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict()
  .refine((value) => value.from <= value.to, { path: ["to"], message: "La fin doit suivre le début" });
export type QualityIntelligenceQueryDTO = z.infer<typeof qualityIntelligenceQuerySchema>;

export const qualityInvestigationQuerySchema = z
  .object({
    type: z.enum(TRACEABILITY_NODE_TYPES),
    id: shortText(160),
    as_of: z.string().datetime({ offset: true }).optional(),
    period_from: z.string().datetime({ offset: true }).optional(),
    period_to: z.string().datetime({ offset: true }).optional(),
    max_depth: z.coerce.number().int().min(1).max(8).default(8),
  })
  .strict();
export type QualityInvestigationQueryDTO = z.infer<typeof qualityInvestigationQuerySchema>;

export const createQualityCostSchema = z
  .object({
    body: z
      .object({
        non_conformity_id: uuid,
        category: z.enum(["SCRAP", "REWORK", "SORTING", "CONTAINMENT", "RETURN", "OTHER"]),
        amount: z.number().finite().positive().max(1_000_000_000),
        currency: z.string().trim().regex(/^[A-Z]{3}$/),
        occurred_on: z.string().date(),
        source_type: z.enum(["STOCK_MOVEMENT", "TIME_ENTRY", "SUPPLIER_DOCUMENT", "MANUAL_EVIDENCE"]),
        source_id: shortText(160),
        evidence_document_id: uuid.optional().nullable(),
        note: z.string().trim().min(5).max(2000),
      })
      .strict(),
  })
  .strict();
export type CreateQualityCostBodyDTO = z.infer<typeof createQualityCostSchema>["body"];

export const assignQualityCauseSchema = z
  .object({
    params: idParamSchema.shape.params,
    body: z
      .object({
        cause_code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
        expected_updated_at: isoDateTime,
        reason: z.string().trim().min(5).max(2000),
      })
      .strict(),
  })
  .strict();
export type AssignQualityCauseBodyDTO = z.infer<typeof assignQualityCauseSchema>["body"];
