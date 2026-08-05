import { z } from "zod";

const uuid = z.string().uuid();
const nullableUuid = uuid.nullable();
const idempotencyKey = z.string().trim().min(8).max(200);
const occurredAt = z.string().trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
    "Horodatage ISO 8601 avec fuseau requis"
  )
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "Horodatage invalide" });
const activityCode = z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const optionalComment = z.string().trim().max(2000).nullable().optional();

const commonEvent = z.object({
  event_id: uuid,
  idempotency_key: idempotencyKey,
  occurred_at: occurredAt,
  device_id: uuid,
  user_id: z.coerce.number().int().positive(),
  station_session_id: uuid,
  machine_id: nullableUuid,
});

const pointageStart = commonEvent.extend({
  type: z.literal("POINTAGE_START"),
  payload: z.object({
    of_id: z.coerce.number().int().positive(),
    operation_id: nullableUuid.optional(),
    poste_id: nullableUuid.optional(),
    activity_code: activityCode,
    time_type: z.enum(["OPERATEUR", "MACHINE", "PROGRAMMATION"]).optional(),
    comment: optionalComment,
  }).strict(),
}).strict();

const pointageStop = commonEvent.extend({
  type: z.literal("POINTAGE_STOP"),
  payload: z.object({
    pointage_id: uuid.nullable().optional(),
    start_event_id: uuid.nullable().optional(),
    comment: optionalComment,
  }).strict().refine((value) => Number(Boolean(value.pointage_id)) + Number(Boolean(value.start_event_id)) === 1, {
    message: "Indiquez exactement pointage_id ou start_event_id",
  }),
}).strict();

const quantityDeclare = commonEvent.extend({
  type: z.literal("QUANTITY_DECLARE"),
  payload: z.object({
    of_id: z.coerce.number().int().positive(),
    operation_id: nullableUuid.optional(),
    pointage_id: uuid.optional(),
    pointage_start_event_id: uuid.optional(),
    qty_good: z.coerce.number().finite().min(0).max(1_000_000).optional().default(0),
    qty_scrap: z.coerce.number().finite().min(0).max(1_000_000).optional().default(0),
    qty_rework: z.coerce.number().finite().min(0).max(1_000_000).optional().default(0),
    qty_pending_control: z.coerce.number().finite().min(0).max(1_000_000).optional().default(0),
    unite: z.string().trim().max(32).nullable().optional(),
    scrap_reason_code: z.string().trim().max(64).nullable().optional(),
    rework_reason_code: z.string().trim().max(64).nullable().optional(),
    note: optionalComment,
    overproduction_reason: z.string().trim().min(3).max(2000).optional(),
  }).strict()
    .refine(
      (value) =>
        value.qty_good + value.qty_scrap + value.qty_rework + value.qty_pending_control > 0,
      { message: "La quantité totale doit être strictement positive" }
    )
    .refine(
      (value) => !(value.pointage_id && value.pointage_start_event_id),
      { message: "pointage_id et pointage_start_event_id sont mutuellement exclusifs" }
    ),
}).strict();

export const offlineStationEventSchema = z.discriminatedUnion("type", [
  pointageStart,
  pointageStop,
  quantityDeclare,
]);

export const offlineStationSyncSchema = z.object({
  client_batch_id: uuid,
  events: z.array(offlineStationEventSchema).min(1).max(25),
}).strict().superRefine((value, ctx) => {
  const eventIds = new Set<string>();
  const keys = new Set<string>();
  value.events.forEach((event, index) => {
    if (eventIds.has(event.event_id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events", index, "event_id"], message: "event_id dupliqué" });
    }
    if (keys.has(event.idempotency_key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["events", index, "idempotency_key"], message: "idempotency_key dupliquée" });
    }
    eventIds.add(event.event_id);
    keys.add(event.idempotency_key);
  });
});

export type OfflineStationEventDTO = z.infer<typeof offlineStationEventSchema>;
export type OfflineStationSyncDTO = z.infer<typeof offlineStationSyncSchema>;
