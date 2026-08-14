import { z } from "zod";

// Validateurs T2. Convention repo : parse contrôleur (schema.parse(req.body/query/params)),
// DTOs via z.infer. ANTI-IDOR : les schémas salarié ne contiennent JAMAIS d'employee_id
// (l'employé est dérivé de req.user côté serveur).

export const HR_EVENT_TYPES = ["IN", "OUT", "BREAK_START", "BREAK_END", "MISSION_START", "MISSION_END"] as const;

const eventTime = z.string().datetime({ offset: true }).optional(); // ISO 8601 ; défaut = now serveur
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");
const timezone = z.string().trim().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Fuseau horaire IANA invalide");
const decimalMoney = z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/, "Montant décimal positif attendu");

// POST /time-clock/events (salarié) — aucun employee_id.
export const createTimeEventSchema = z
  .object({
    event_type: z.enum(HR_EVENT_TYPES, { errorMap: () => ({ message: "event_type invalide" }) }),
    event_time: eventTime,
  })
  .strict();
export type CreateTimeEventBody = z.infer<typeof createTimeEventSchema>;

// POST /time-clock/device-events (borne) — idempotency_key OBLIGATOIRE ; badge_uid brut (haché serveur, jamais loggé).
export const deviceEventSchema = z
  .object({
    badge_uid: z.string().min(1, "badge_uid requis").max(256),
    event_type: z.enum(HR_EVENT_TYPES, { errorMap: () => ({ message: "event_type invalide" }) }),
    event_time: eventTime,
    idempotency_key: z.string().min(8, "idempotency_key requis (min 8 caractères)").max(200),
    device_token: z.string().min(1).max(512).optional(),
  })
  .strict();
export type DeviceEventBody = z.infer<typeof deviceEventSchema>;

// POST /time-clock/device-heartbeat (borne).
export const deviceHeartbeatSchema = z
  .object({
    device_token: z.string().min(1, "device_token requis").max(512),
  })
  .strict();
export type DeviceHeartbeatBody = z.infer<typeof deviceHeartbeatSchema>;

export const meTodayQuerySchema = z.object({ date: dateOnly.optional() });
export const meWeekQuerySchema = z.object({ week_start: dateOnly.optional() });
export const meAnomaliesQuerySchema = z.object({
  date: dateOnly.optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export const employeeIdParamsSchema = z.object({ id: z.string().uuid("employee id (uuid) attendu") });

// --- T4 : corrections tracées + validation ---
export const HR_ADJUSTMENT_TARGETS = ["EVENT", "DAY", "WEEK"] as const;

// Le salarié demande une correction SUR SES PROPRES données (motif OBLIGATOIRE).
export const createAdjustmentSchema = z
  .object({
    target_type: z.enum(HR_ADJUSTMENT_TARGETS),
    target_id: z.string().uuid("target_id (uuid) attendu"),
    reason: z.string().trim().min(3, "Motif obligatoire (min 3 caractères)").max(2000),
    old_value: z.record(z.unknown()).optional(),
    new_value: z.record(z.unknown()).optional(),
  })
  .strict();
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>;

export const uuidParamsSchema = z.object({ id: z.string().uuid("id (uuid) attendu") });
export const teamAnomaliesQuerySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

// --- T5 : admin RH (règles / contrats / horaires) ---
const nonNegInt = z.number().int().min(0);
const timeOfDay = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Heure attendue HH:MM").nullable();

export const HR_CONTRACT_TYPES = ["H35", "H39", "PARTIAL", "OTHER"] as const;

// Règle de calcul — JAMAIS de 35/39 en dur : les cibles sont saisies ici (minutes).
export const ruleSetBodySchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    weekly_target_minutes: nonNegInt.max(10080), // ≤ 7j
    daily_target_minutes: nonNegInt.max(1440),
    overtime_threshold_1_minutes: nonNegInt.max(10080).nullable().default(null),
    overtime_rate_1: z.number().min(1).max(5).nullable().default(null),
    overtime_threshold_2_minutes: nonNegInt.max(10080).nullable().default(null),
    overtime_rate_2: z.number().min(1).max(5).nullable().default(null),
    rounding_rule: z.record(z.unknown()).default({}),
    break_rule: z.record(z.unknown()).default({}),
  })
  .strict();
export type RuleSetBody = z.infer<typeof ruleSetBodySchema>;

export const contractBodySchema = z
  .object({
    employee_id: z.string().uuid(),
    contract_type: z.enum(HR_CONTRACT_TYPES),
    weekly_hours_target: z.number().min(0).max(168),
    daily_hours_target: z.number().min(0).max(24).nullable().default(null),
    start_date: dateOnly,
    end_date: dateOnly.nullable().default(null),
    rule_set_id: z.string().uuid().nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict();
export type ContractBody = z.infer<typeof contractBodySchema>;

export const scheduleBodySchema = z
  .object({
    employee_id: z.string().uuid(),
    day_of_week: z.number().int().min(0).max(6),
    expected_start: timeOfDay.default(null),
    expected_end: timeOfDay.default(null),
    expected_break_minutes: nonNegInt.max(1440).default(0),
    flexible_start_window: nonNegInt.max(240).default(0),
    flexible_end_window: nonNegInt.max(240).default(0),
    active: z.boolean().default(true),
  })
  .strict();
export type ScheduleBody = z.infer<typeof scheduleBodySchema>;

export const setActiveSchema = z.object({ active: z.boolean() }).strict();

// --- T6 : kilomètres ---
export const HR_KM_TYPES = ["MISSION", "CLIENT", "FOURNISSEUR", "LIVRAISON", "AUTRE"] as const;
export const HR_KM_STATUSES = ["DRAFT", "SUBMITTED", "VALIDATED", "REJECTED"] as const;

// ANTI-IDOR : aucun employee_id (l'employé vient de req.user).
export const createKmSchema = z
  .object({
    date: dateOnly,
    type: z.enum(HR_KM_TYPES).default("MISSION"),
    vehicle_id: z.string().uuid().nullable().default(null),
    start_location: z.string().trim().max(300).nullable().default(null),
    end_location: z.string().trim().max(300).nullable().default(null),
    start_odometer: z.number().min(0).max(9_999_999).nullable().default(null),
    end_odometer: z.number().min(0).max(9_999_999).nullable().default(null),
    distance_km: z.number().min(0).max(100_000).default(0),
    affaire_id: z.number().int().positive().nullable().default(null),
    client_id: z.number().int().positive().nullable().default(null),
    fournisseur_id: z.number().int().positive().nullable().default(null),
    submit: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.start_odometer == null || v.end_odometer == null || v.end_odometer >= v.start_odometer, {
    message: "Odomètre d'arrivée < départ.",
    path: ["end_odometer"],
  });
export type CreateKmBody = z.infer<typeof createKmSchema>;

export const myKmQuerySchema = z.object({
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  status: z.enum(HR_KM_STATUSES).optional(),
});
export const teamKmQuerySchema = z.object({ status: z.enum(HR_KM_STATUSES).optional() });

export const vehicleBodySchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    plate: z.string().trim().max(20).nullable().default(null),
    owner_type: z.enum(["COMPANY", "PERSONAL"]).default("COMPANY"),
  })
  .strict();
export type VehicleBody = z.infer<typeof vehicleBodySchema>;

// --- T8 : bornes & badges ---
export const deviceBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    location: z.string().trim().max(300).nullable().default(null),
    device_type: z.string().trim().max(100).nullable().default(null),
  })
  .strict();
export type DeviceBody = z.infer<typeof deviceBodySchema>;

export const deviceStatusSchema = z.object({ status: z.enum(["ACTIVE", "DISABLED"]) }).strict();

export const badgeBodySchema = z
  .object({
    employee_id: z.string().uuid(),
    badge_uid: z.string().trim().min(1, "badge_uid requis").max(256),
    badge_label: z.string().trim().max(200).nullable().default(null),
  })
  .strict();
export type BadgeBody = z.infer<typeof badgeBodySchema>;

export const listBadgesQuerySchema = z.object({ employee_id: z.string().uuid().optional() });

// --- T7 : exports paie ---
export const HR_EXPORT_FORMATS = ["CSV", "PDF"] as const;
export const exportBodySchema = z
  .object({ period_start: dateOnly, period_end: dateOnly, format: z.enum(HR_EXPORT_FORMATS) })
  .strict();
export type ExportBody = z.infer<typeof exportBodySchema>;
export const listContractsQuerySchema = z.object({ employee_id: z.string().uuid().optional() });
export const listSchedulesQuerySchema = z.object({ employee_id: z.string().uuid("employee_id (uuid) requis") });

export const HR_ABSENCE_TYPES = ["PAID_LEAVE", "SICK_LEAVE", "RTT", "TRAINING", "OTHER"] as const;
export const HR_ABSENCE_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"] as const;

export const createAbsenceSchema = z.object({
  absence_date: dateOnly,
  minutes: z.number().int().positive().max(1440),
  absence_type: z.enum(HR_ABSENCE_TYPES),
  timezone: timezone.default("Europe/Paris"),
  reason: z.string().trim().min(3).max(2000),
  source_ref: z.string().trim().max(500).nullish(),
}).strict();
export type CreateAbsenceBody = z.infer<typeof createAbsenceSchema>;

export const absenceStatusQuerySchema = z.object({ status: z.enum(HR_ABSENCE_STATUSES).optional() }).strict();

export const createPeriodClosureSchema = z.object({
  period_start: dateOnly,
  period_end: dateOnly,
  employee_id: z.string().uuid().nullish(),
  timezone: timezone.default("Europe/Paris"),
  reason: z.string().trim().min(5).max(2000),
}).strict().refine((value) => value.period_end >= value.period_start, {
  message: "La fin de période doit suivre son début.", path: ["period_end"],
});
export type CreatePeriodClosureBody = z.infer<typeof createPeriodClosureSchema>;

export const createKilometerRateSchema = z.object({
  owner_type: z.enum(["COMPANY", "PERSONAL"]),
  rate_per_km: decimalMoney,
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("EUR"),
  effective_from: dateOnly,
  definition: z.string().trim().min(5).max(500),
  source_type: z.enum(["DECLARATION", "LEGAL_SCALE", "CONTRACT", "OTHER"]),
  source_ref: z.string().trim().max(500).nullish(),
  observed_at: z.string().datetime({ offset: true }),
  reliability: z.enum(["DECLARED", "VERIFIED", "ESTIMATED"]),
}).strict();
export type CreateKilometerRateBody = z.infer<typeof createKilometerRateSchema>;
