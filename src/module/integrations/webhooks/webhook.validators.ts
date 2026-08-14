import { z } from "zod";

import { WEBHOOK_EVENT_REGISTRY } from "./webhook.domain";

const registeredEvents = WEBHOOK_EVENT_REGISTRY.map((entry) => entry.type) as [string, ...string[]];
const idSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });

export const webhookIdParamsSchema = z.object({ id: idSchema }).strict();

export const webhookCreateSubscriptionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  endpoint_url: z.string().trim().url().max(2048),
  event_types: z.array(z.enum(registeredEvents)).min(1).max(20).transform((items) => [...new Set(items)].sort()),
}).strict();

export const webhookPatchSubscriptionSchema = z.object({
  expected_updated_at: timestampSchema,
  name: z.string().trim().min(2).max(120).optional(),
  endpoint_url: z.string().trim().url().max(2048).optional(),
  event_types: z.array(z.enum(registeredEvents)).min(1).max(20).transform((items) => [...new Set(items)].sort()).optional(),
  status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]).optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "expected_updated_at"), {
  message: "Au moins une modification est requise.",
});

export const webhookRotateSecretSchema = z.object({
  expected_updated_at: timestampSchema,
}).strict();

export const webhookListDeliveriesQuerySchema = z.object({
  subscription_id: idSchema.optional(),
  status: z.enum(["PENDING", "PROCESSING", "RETRY", "DELIVERED", "DEAD_LETTER", "CANCELLED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const webhookSubscriptionResponseSchema = z.object({
  id: idSchema,
  name: z.string(),
  endpoint_url: z.string().url(),
  event_types: z.array(z.enum(registeredEvents)).min(1),
  status: z.enum(["ACTIVE", "PAUSED", "DISABLED"]),
  secret_hint: z.string(),
  secret_version: z.number().int().positive(),
  consecutive_failure_count: z.number().int().nonnegative(),
  disabled_reason: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const webhookSecretResponseSchema = z.object({
  subscription: webhookSubscriptionResponseSchema,
  secret: z.string().startsWith("whsec_"),
  idempotent_replay: z.boolean(),
});

export const webhookDeliveryResponseSchema = z.object({
  id: idSchema,
  subscription_id: idSchema,
  event_id: idSchema,
  replay_of_delivery_id: idSchema.nullable(),
  status: z.enum(["PENDING", "PROCESSING", "RETRY", "DELIVERED", "DEAD_LETTER", "CANCELLED"]),
  attempt_count: z.number().int().nonnegative(),
  next_attempt_at: timestampSchema,
  last_http_status: z.number().int().min(100).max(599).nullable(),
  last_error_code: z.string().nullable(),
  delivered_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  event_type: z.enum(registeredEvents).optional(),
}).strict();

export const webhookSubscriptionMutationResponseSchema = z.object({
  subscription: webhookSubscriptionResponseSchema,
  idempotent_replay: z.boolean(),
}).strict();

export const webhookDeliveryMutationResponseSchema = z.object({
  delivery: webhookDeliveryResponseSchema,
  idempotent_replay: z.boolean(),
}).strict();
