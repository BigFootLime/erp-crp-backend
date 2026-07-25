// Validateurs Zod stricts pour la surface Métrologie 360 (#229).
//
// Toutes les bornes (pagination, tri, longueurs, plages) sont serveur ; aucun
// champ inconnu n'est accepté (`.strict()`), et aucun code métier n'est reçu du
// client : il est alloué par le serveur.

import { z } from "zod";

import {
  METROLOGY_EQUIPMENT_STATES,
  METROLOGY_IMPACT_DECISIONS,
  METROLOGY_IMPACT_STATUSES,
  METROLOGY_OPERATION_TYPES,
  METROLOGY_VERDICTS,
} from "../domain/metrology-policy";

const uuid = z.string().uuid();
const optionalUuid = uuid.nullable().optional();

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide (format attendu AAAA-MM-JJ)");

const isoDateTime = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), "Date-heure invalide");

const shortText = (max: number) => z.string().trim().min(1).max(max);
const longText = (max: number) => z.string().trim().max(max);

// Les grandeurs physiques sont finies et bornées : ni NaN, ni Infinity, ni
// valeur absurde qui ferait sauter une comparaison de plage.
const measure = z
  .number()
  .refine((value) => Number.isFinite(value), "Valeur non finie")
  .refine((value) => Math.abs(value) <= 1_000_000_000, "Valeur hors limites");

const positiveMeasure = measure.refine((value) => value > 0, "Valeur strictement positive requise");
const nonNegativeMeasure = measure.refine((value) => value >= 0, "Valeur négative interdite");

const unite = z.string().trim().min(1).max(16);
const categoryCode = z
  .string()
  .trim()
  .regex(/^[A-Z0-9_]{2,40}$/, "Code de catégorie invalide (A-Z, 0-9, _)");

const reason = (min: number, max = 2000) =>
  z.string().trim().min(min, `Motif d'au moins ${min} caractères requis`).max(max);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

export const idParamSchema = z.object({ params: z.object({ id: uuid }) });

export const nestedIdParamSchema = z.object({
  params: z.object({ id: uuid, childId: uuid }),
});

/** Verrou optimiste : obligatoire sur toute écriture d'un agrégat existant. */
const expectedVersion = { expected_updated_at: isoDateTime };

/* -------------------------------------------------------------------------- */
/* Référentiel des catégories                                                 */
/* -------------------------------------------------------------------------- */

export const listCategoriesQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    active: z.enum(["true", "false", "all"]).default("true"),
  })
  .strict();
export type ListCategoriesQueryDTO = z.infer<typeof listCategoriesQuerySchema>;

export const upsertCategorySchema = z.object({
  body: z
    .object({
      code: categoryCode,
      parent_code: categoryCode.nullable().default(null),
      label: shortText(120),
      description: longText(1000).nullable().default(null),
      active: z.boolean().default(true),
      display_order: z.number().int().min(0).max(10_000).default(100),
      requires_range: z.boolean().default(false),
      requires_resolution: z.boolean().default(false),
      requires_uncertainty: z.boolean().default(false),
      requires_unit: z.boolean().default(false),
      default_unit: unite.nullable().default(null),
      default_periodicity_months: z.number().int().min(1).max(600).nullable().default(null),
      default_operation_type: z.enum(["ETALONNAGE", "VERIFICATION"]).default("ETALONNAGE"),
    })
    .strict(),
});
export type UpsertCategoryBodyDTO = z.infer<typeof upsertCategorySchema>["body"];

/* -------------------------------------------------------------------------- */
/* Registre équipement                                                        */
/* -------------------------------------------------------------------------- */

const equipmentSpecShape = {
  unite: unite.nullable().default(null),
  plage_min: measure.nullable().default(null),
  plage_max: measure.nullable().default(null),
  resolution: positiveMeasure.nullable().default(null),
  mpe: nonNegativeMeasure.nullable().default(null),
  incertitude: nonNegativeMeasure.nullable().default(null),
  methodes: z.array(shortText(80)).max(20).default([]),
  conditions_utilisation: longText(2000).nullable().default(null),
  restrictions: longText(2000).nullable().default(null),
  etalon_reference: shortText(200).nullable().default(null),
  exige_certificat: z.boolean().default(false),
  // Complément libre : jamais source de vérité pour l'éligibilité.
  specifications: z.record(z.string().max(60), z.unknown()).default({}),
};

const equipmentIdentityShape = {
  designation: shortText(400),
  categorie_code: categoryCode,
  sous_categorie_code: categoryCode.nullable().default(null),
  marque: shortText(120).nullable().default(null),
  modele: shortText(120).nullable().default(null),
  numero_serie: shortText(200).nullable().default(null),
  criticite: z.enum(["NORMAL", "CRITIQUE"]).default("NORMAL"),
  proprietaire_service: shortText(120).nullable().default(null),
  responsable_user_id: z.number().int().positive().nullable().default(null),
  site: shortText(120).nullable().default(null),
  magasin: shortText(120).nullable().default(null),
  zone: shortText(120).nullable().default(null),
  localisation_precise: shortText(200).nullable().default(null),
  date_mise_en_service: isoDate.nullable().default(null),
  notes: longText(5000).nullable().default(null),
};

// Le `code` est ABSENT de l'entrée : il est alloué par le serveur. Envoyer un
// code déclenche donc une 422 par `.strict()`, ce qui est le comportement voulu.
export const createEquipmentSchema = z.object({
  body: z
    .object({ ...equipmentIdentityShape, ...equipmentSpecShape })
    .strict()
    .superRefine(assertRangeCoherent),
});
export type CreateEquipmentBodyDTO = z.infer<typeof createEquipmentSchema>["body"];

export const updateEquipmentSchema = z.object({
  body: z
    .object({
      ...expectedVersion,
      ...equipmentIdentityShape,
      ...equipmentSpecShape,
      date_retrait: isoDate.nullable().default(null),
    })
    .strict()
    .superRefine(assertRangeCoherent),
});
export type UpdateEquipmentBodyDTO = z.infer<typeof updateEquipmentSchema>["body"];

function assertRangeCoherent(
  value: { plage_min: number | null; plage_max: number | null; unite: string | null },
  ctx: z.RefinementCtx
): void {
  if (value.plage_min !== null && value.plage_max !== null && value.plage_min > value.plage_max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plage_max"],
      message: "La borne haute doit être supérieure ou égale à la borne basse.",
    });
  }
  if ((value.plage_min !== null || value.plage_max !== null) && !value.unite) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["unite"],
      message: "Une plage exige son unité : une valeur nue n'est pas comparable.",
    });
  }
}

export const equipmentTransitionSchema = z.object({
  body: z
    .object({
      ...expectedVersion,
      target_state: z.enum(METROLOGY_EQUIPMENT_STATES),
      reason: reason(10),
      // Requis uniquement pour une remise en service après quarantaine.
      proof_execution_id: optionalUuid,
    })
    .strict(),
});
export type EquipmentTransitionBodyDTO = z.infer<typeof equipmentTransitionSchema>["body"];

export const quarantineSchema = z.object({
  body: z
    .object({
      ...expectedVersion,
      reason: reason(10),
      open_impact_analysis: z.boolean().default(true),
    })
    .strict(),
});
export type QuarantineBodyDTO = z.infer<typeof quarantineSchema>["body"];

export const listEquipmentQuerySchema = paginationSchema
  .extend({
    q: z.string().trim().max(200).optional(),
    categorie_code: categoryCode.optional(),
    etat: z.enum(METROLOGY_EQUIPMENT_STATES).optional(),
    criticite: z.enum(["NORMAL", "CRITIQUE"]).optional(),
    site: z.string().trim().max(120).optional(),
    // Segments du command center : filtres SERVEUR, jamais un tri client.
    segment: z
      .enum(["all", "due_soon", "overdue", "quarantine", "out_of_tolerance", "repair", "retired"])
      .default("all"),
    sortBy: z
      .enum(["updated_at", "created_at", "designation", "code", "next_due_date", "etat"])
      .default("updated_at"),
  })
  .strict();
export type ListEquipmentQueryDTO = z.infer<typeof listEquipmentQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Plans versionnés                                                           */
/* -------------------------------------------------------------------------- */

const planShape = {
  operation_type: z.enum(["ETALONNAGE", "VERIFICATION"]),
  methode: shortText(200).nullable().default(null),
  procedure_ref: shortText(200).nullable().default(null),
  periodicite_valeur: z.number().int().min(1).max(3650),
  periodicite_unite: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]).default("MONTH"),
  base_calcul: z.enum(["LAST_PROOF", "FIXED_DATE"]).default("LAST_PROOF"),
  alert_window_days: z.number().int().min(0).max(365).default(30),
  tolerance_min: measure.nullable().default(null),
  tolerance_max: measure.nullable().default(null),
  unite: unite.nullable().default(null),
  min_points: z.number().int().min(1).max(200).nullable().default(null),
  prestataire_type: z.enum(["INTERNE", "EXTERNE"]).default("INTERNE"),
  prestataire_label: shortText(200).nullable().default(null),
  fournisseur_id: optionalUuid,
  role_habilite: shortText(120).nullable().default(null),
  criticite: z.enum(["NORMAL", "CRITIQUE"]).default("NORMAL"),
  blocking_strategy: z.enum(["BLOCK", "WARN", "NONE"]).default("BLOCK"),
  exige_certificat: z.boolean().default(false),
  effective_from: isoDate.nullable().default(null),
  notes: longText(2000).nullable().default(null),
};

function assertPlanCoherent(
  value: {
    prestataire_type: "INTERNE" | "EXTERNE";
    prestataire_label: string | null;
    fournisseur_id?: string | null;
    tolerance_min: number | null;
    tolerance_max: number | null;
    base_calcul: "LAST_PROOF" | "FIXED_DATE";
    effective_from: string | null;
  },
  ctx: z.RefinementCtx
): void {
  if (value.prestataire_type === "EXTERNE" && !value.prestataire_label && !value.fournisseur_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["prestataire_label"],
      message: "Un étalonnage externe déclare son prestataire qualifié.",
    });
  }
  if (
    value.tolerance_min !== null &&
    value.tolerance_max !== null &&
    value.tolerance_min > value.tolerance_max
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tolerance_max"],
      message: "La tolérance haute doit être supérieure ou égale à la tolérance basse.",
    });
  }
  if (value.base_calcul === "FIXED_DATE" && !value.effective_from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effective_from"],
      message: "Une échéance à date fixe exige sa date d'effet.",
    });
  }
}

export const createPlanSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object(planShape).strict().superRefine(assertPlanCoherent),
});
export type CreatePlanBodyDTO = z.infer<typeof createPlanSchema>["body"];

export const revisePlanSchema = z.object({
  params: z.object({ id: uuid, childId: uuid }),
  body: z
    .object({ ...expectedVersion, ...planShape, revision_reason: reason(10) })
    .strict()
    .superRefine(assertPlanCoherent),
});
export type RevisePlanBodyDTO = z.infer<typeof revisePlanSchema>["body"];

export const planTransitionSchema = z.object({
  params: z.object({ id: uuid, childId: uuid }),
  body: z
    .object({
      ...expectedVersion,
      target_status: z.enum(["ACTIVE", "ARCHIVED"]),
      reason: reason(5).nullable().default(null),
    })
    .strict(),
});
export type PlanTransitionBodyDTO = z.infer<typeof planTransitionSchema>["body"];

export const schedulePreviewQuerySchema = z
  .object({
    plan_version_id: uuid.optional(),
    periodicite_valeur: z.coerce.number().int().min(1).max(3650).optional(),
    periodicite_unite: z.enum(["DAY", "WEEK", "MONTH", "YEAR"]).optional(),
    base_calcul: z.enum(["LAST_PROOF", "FIXED_DATE"]).optional(),
    alert_window_days: z.coerce.number().int().min(0).max(365).optional(),
    effective_from: isoDate.optional(),
    last_proof_date: isoDate.optional(),
    certificate_due_date: isoDate.optional(),
  })
  .strict();
export type SchedulePreviewQueryDTO = z.infer<typeof schedulePreviewQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Exécutions et mesures                                                      */
/* -------------------------------------------------------------------------- */

export const createExecutionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      operation_type: z.enum(METROLOGY_OPERATION_TYPES),
      plan_version_id: optionalUuid,
      started_at: isoDateTime.optional(),
      operator_user_id: z.number().int().positive().nullable().default(null),
      provider_label: shortText(200).nullable().default(null),
      fournisseur_id: optionalUuid,
      methode: shortText(200).nullable().default(null),
      procedure_ref: shortText(200).nullable().default(null),
      etalon_reference: shortText(200).nullable().default(null),
      environnement: z
        .object({
          temperature_c: measure.nullable().default(null),
          humidite_pct: measure.nullable().default(null),
          pression_hpa: measure.nullable().default(null),
          commentaire: longText(500).nullable().default(null),
        })
        .strict()
        .default({
          temperature_c: null,
          humidite_pct: null,
          pression_hpa: null,
          commentaire: null,
        }),
      observations: longText(5000).nullable().default(null),
    })
    .strict()
    .superRefine((value, ctx) => {
      const needsPlan = value.operation_type === "ETALONNAGE" || value.operation_type === "VERIFICATION";
      if (needsPlan && !value.plan_version_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["plan_version_id"],
          message: "Un étalonnage ou une vérification s'adosse à une version de plan active.",
        });
      }
    }),
});
export type CreateExecutionBodyDTO = z.infer<typeof createExecutionSchema>["body"];

export const measurementInputSchema = z
  .object({
    point_key: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Z0-9][A-Z0-9._-]*$/i, "Clé de point invalide (A-Z, 0-9, . _ -)"),
    sample_no: z.number().int().min(1).max(500).default(1),
    label: shortText(200).nullable().default(null),
    nominal: measure.nullable().default(null),
    tolerance_min: measure.nullable().default(null),
    tolerance_max: measure.nullable().default(null),
    measured: measure.nullable().default(null),
    unite: unite.nullable().default(null),
    incertitude: nonNegativeMeasure.nullable().default(null),
    comment: longText(1000).nullable().default(null),
    /** Motif obligatoire quand on corrige un point déjà saisi. */
    revision_reason: reason(5, 1000).nullable().default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.tolerance_min !== null &&
      value.tolerance_max !== null &&
      value.tolerance_min > value.tolerance_max
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tolerance_max"],
        message: "La borne haute doit être supérieure ou égale à la borne basse.",
      });
    }
  });
export type MeasurementInputDTO = z.infer<typeof measurementInputSchema>;

export const recordMeasurementsSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      ...expectedVersion,
      measurements: z.array(measurementInputSchema).min(1).max(500),
    })
    .strict(),
});
export type RecordMeasurementsBodyDTO = z.infer<typeof recordMeasurementsSchema>["body"];

export const validateExecutionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      ...expectedVersion,
      /** Empreinte de l'aperçu serveur : refuse une confirmation sur données périmées. */
      preview_hash: z.string().trim().regex(/^[A-Fa-f0-9]{64}$/, "Empreinte d'aperçu invalide"),
      verdict: z.enum(METROLOGY_VERDICTS),
      verdict_justification: longText(2000).nullable().default(null),
      restriction: longText(1000).nullable().default(null),
      decision: z.enum([
        "REMISE_EN_SERVICE",
        "QUARANTAINE",
        "AJUSTAGE_REQUIS",
        "REPARATION_REQUISE",
        "RETRAIT",
      ]),
      decision_reason: reason(10),
      ended_at: isoDateTime.optional(),
      /** Échéance dérogatoire : exige motif + approbateur distinct. */
      override_next_due_date: isoDate.nullable().default(null),
      override_reason: longText(2000).nullable().default(null),
      override_approved_by: z.number().int().positive().nullable().default(null),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.verdict === "CONFORME_AVEC_RESTRICTION" && !value.restriction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["restriction"],
          message: "Une conformité avec restriction décrit la restriction appliquée.",
        });
      }
      if (value.override_next_due_date && !value.override_approved_by) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["override_approved_by"],
          message: "Une échéance dérogatoire exige une approbation explicite.",
        });
      }
    }),
});
export type ValidateExecutionBodyDTO = z.infer<typeof validateExecutionSchema>["body"];

export const cancelExecutionSchema = z.object({
  params: z.object({ id: uuid }),
  body: z.object({ ...expectedVersion, reason: reason(10) }).strict(),
});
export type CancelExecutionBodyDTO = z.infer<typeof cancelExecutionSchema>["body"];

export const listExecutionsQuerySchema = paginationSchema
  .extend({
    equipement_id: uuid.optional(),
    operation_type: z.enum(METROLOGY_OPERATION_TYPES).optional(),
    status: z.enum(["DRAFT", "IN_PROGRESS", "VALIDATED", "CANCELLED"]).optional(),
    verdict: z.enum(METROLOGY_VERDICTS).optional(),
    sortBy: z.enum(["started_at", "ended_at", "created_at", "code"]).default("started_at"),
  })
  .strict();
export type ListExecutionsQueryDTO = z.infer<typeof listExecutionsQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Certificats et PV                                                          */
/* -------------------------------------------------------------------------- */

// Le fichier arrive en multipart ; ce schéma valide les champs textuels.
export const uploadCertificateSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      execution_id: optionalUuid,
      document_kind: z.enum(["CERTIFICAT", "PV_INTERNE", "RAPPORT", "AUTRE"]).default("CERTIFICAT"),
      date_etalonnage: isoDate,
      date_echeance: isoDate.nullable().optional().default(null),
      resultat: z.enum(["CONFORME", "NON_CONFORME", "AJUSTAGE"]),
      emetteur: shortText(200).nullable().optional().default(null),
      numero_externe: shortText(120).nullable().optional().default(null),
      organisme: shortText(200).nullable().optional().default(null),
      commentaire: longText(5000).nullable().optional().default(null),
      confidentiality: z
        .enum(["INTERNAL", "RESTRICTED", "CUSTOMER_VISIBLE"])
        .default("RESTRICTED"),
    })
    .strict()
    .superRefine((value, ctx) => {
      // Un certificat externe est émis par un tiers : sans émetteur, c'est un PV
      // interne, et le confondre fausserait la traçabilité.
      if (value.document_kind === "CERTIFICAT" && !value.emetteur) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["emetteur"],
          message: "Un certificat externe déclare son émetteur ; sinon enregistrez un PV interne.",
        });
      }
    }),
});
export type UploadCertificateBodyDTO = z.infer<typeof uploadCertificateSchema>["body"];

export const cancelCertificateSchema = z.object({
  params: z.object({ id: uuid, childId: uuid }),
  body: z
    .object({
      reason: reason(10),
      replaced_by_id: optionalUuid,
      open_impact_analysis: z.boolean().default(true),
    })
    .strict(),
});
export type CancelCertificateBodyDTO = z.infer<typeof cancelCertificateSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Analyse d'impact                                                           */
/* -------------------------------------------------------------------------- */

export const createImpactSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      execution_id: optionalUuid,
      certificat_id: optionalUuid,
      trigger_type: z
        .enum(["VERDICT_NON_CONFORME", "CERTIFICAT_INVALIDE", "MANUEL"])
        .default("MANUEL"),
      window_from: isoDateTime.nullable().default(null),
      window_to: isoDateTime.nullable().default(null),
      window_reason: longText(2000).nullable().default(null),
      exclusions: longText(2000).nullable().default(null),
      owner_user_id: z.number().int().positive().nullable().default(null),
    })
    .strict()
    .superRefine((value, ctx) => {
      const hasFrom = Boolean(value.window_from);
      const hasTo = Boolean(value.window_to);
      if (hasFrom !== hasTo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [hasFrom ? "window_to" : "window_from"],
          message: "Une fenêtre imposée déclare ses deux bornes.",
        });
      }
      if (hasFrom && hasTo && (value.window_reason ?? "").trim().length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["window_reason"],
          message: "Une fenêtre imposée exige une justification d'au moins 20 caractères.",
        });
      }
    }),
});
export type CreateImpactBodyDTO = z.infer<typeof createImpactSchema>["body"];

export const listImpactsQuerySchema = paginationSchema
  .extend({
    equipement_id: uuid.optional(),
    status: z.enum(METROLOGY_IMPACT_STATUSES).optional(),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).optional(),
    sortBy: z.enum(["created_at", "updated_at", "priority", "code"]).default("created_at"),
  })
  .strict();
export type ListImpactsQueryDTO = z.infer<typeof listImpactsQuerySchema>;

export const listImpactItemsQuerySchema = paginationSchema
  .extend({
    decision: z.enum(METROLOGY_IMPACT_DECISIONS).optional(),
    sortBy: z.enum(["control_date", "decision"]).default("control_date"),
  })
  .strict();
export type ListImpactItemsQueryDTO = z.infer<typeof listImpactItemsQuerySchema>;

export const decideImpactItemSchema = z.object({
  params: z.object({ id: uuid, childId: uuid }),
  body: z
    .object({
      decision: z.enum([
        "NO_IMPACT",
        "RECHECK",
        "HOLD_LOT",
        "OPEN_NC",
        "REISSUE_DOCUMENT",
        "INFORM_CUSTOMER",
      ]),
      reason: reason(5),
      non_conformity_id: optionalUuid,
    })
    .strict(),
});
export type DecideImpactItemBodyDTO = z.infer<typeof decideImpactItemSchema>["body"];

export const transitionImpactSchema = z.object({
  params: z.object({ id: uuid }),
  body: z
    .object({
      ...expectedVersion,
      target_status: z.enum(["IN_REVIEW", "OPEN", "CLOSED", "CANCELLED"]),
      conclusion: longText(5000).nullable().default(null),
    })
    .strict(),
});
export type TransitionImpactBodyDTO = z.infer<typeof transitionImpactSchema>["body"];

/* -------------------------------------------------------------------------- */
/* Éligibilité et centre de commande                                          */
/* -------------------------------------------------------------------------- */

export const eligibilityQuerySchema = z
  .object({
    characteristic_key: z.string().trim().min(1).max(40).default("MESURE"),
    instrument_id: uuid.optional(),
    instrument_category: z.string().trim().min(1).max(60).optional(),
    method: z.string().trim().min(1).max(200).optional(),
    unit: unite.optional(),
    nominal: z.coerce.number().finite().optional(),
    tolerance_min: z.coerce.number().finite().optional(),
    tolerance_max: z.coerce.number().finite().optional(),
    requires_certificate: z.enum(["true", "false"]).default("false"),
    /** Liste des instruments candidats plutôt qu'un seul verdict. */
    mode: z.enum(["single", "candidates"]).default("single"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "single" && !value.instrument_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instrument_id"],
        message: "Le mode « single » exige l'instrument à évaluer.",
      });
    }
  });
export type EligibilityQueryDTO = z.infer<typeof eligibilityQuerySchema>;

export const centerQuerySchema = z
  .object({
    site: z.string().trim().max(120).optional(),
    categorie_code: categoryCode.optional(),
    horizon_days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .strict();
export type CenterQueryDTO = z.infer<typeof centerQuerySchema>;

export const timelineQuerySchema = paginationSchema
  .extend({
    entity_type: z.string().trim().max(60).optional(),
  })
  .strict();
export type TimelineQueryDTO = z.infer<typeof timelineQuerySchema>;

export const usageQuerySchema = paginationSchema
  .extend({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .strict();
export type UsageQueryDTO = z.infer<typeof usageQuerySchema>;
