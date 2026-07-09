import { z } from "zod";

// Validateurs T2. Convention repo : parse contrôleur (schema.parse(req.body/query/params)),
// DTOs via z.infer. ANTI-IDOR : les schémas salarié ne contiennent JAMAIS d'employee_id
// (l'employé est dérivé de req.user côté serveur).

export const HR_EVENT_TYPES = ["IN", "OUT", "BREAK_START", "BREAK_END", "MISSION_START", "MISSION_END"] as const;

const eventTime = z.string().datetime({ offset: true }).optional(); // ISO 8601 ; défaut = now serveur
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format YYYY-MM-DD");

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
