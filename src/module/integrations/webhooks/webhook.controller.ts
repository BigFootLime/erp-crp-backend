import type { Request, RequestHandler } from "express";
import { z } from "zod";

import { HttpError } from "../../../utils/httpError";
import {
  createWebhookSubscription,
  enqueueWebhookTest,
  getWebhookSubscription,
  listWebhookDeliveries,
  listWebhookEventRegistry,
  listWebhookSubscriptions,
  patchWebhookSubscription,
  replayWebhookDelivery,
  rotateWebhookSecret,
  webhookReadiness,
} from "./webhook.service";
import {
  webhookCreateSubscriptionSchema,
  webhookIdParamsSchema,
  webhookListDeliveriesQuerySchema,
  webhookPatchSubscriptionSchema,
  webhookRotateSecretSchema,
  webhookDeliveryMutationResponseSchema,
  webhookDeliveryResponseSchema,
  webhookSecretResponseSchema,
  webhookSubscriptionMutationResponseSchema,
  webhookSubscriptionResponseSchema,
} from "./webhook.validators";

const idempotencySchema = z.string().uuid();

function actor(req: Request) {
  const userId = req.user?.id;
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return { userId: Number(userId), requestId: req.requestId ?? "missing-request-id" };
}

function idempotencyKey(req: Request): string {
  const value = req.header("Idempotency-Key");
  const parsed = idempotencySchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Un en-tête Idempotency-Key UUID est requis.");
  return parsed.data;
}

export const getWebhookReadiness: RequestHandler = (_req, res) => {
  const readiness = webhookReadiness();
  res.status(readiness.ready ? 200 : 503).json(readiness);
};

export const getWebhookEvents: RequestHandler = (_req, res) => {
  res.json(listWebhookEventRegistry());
};

export const getWebhookSubscriptions: RequestHandler = async (_req, res, next) => {
  try { res.json(webhookSubscriptionResponseSchema.array().parse(await listWebhookSubscriptions())); } catch (error) { next(error); }
};

export const getWebhookSubscriptionById: RequestHandler = async (req, res, next) => {
  try { res.json(webhookSubscriptionResponseSchema.parse(await getWebhookSubscription(webhookIdParamsSchema.parse(req.params).id))); } catch (error) { next(error); }
};

export const postWebhookSubscription: RequestHandler = async (req, res, next) => {
  try {
    const input = webhookCreateSubscriptionSchema.parse(req.body);
    const result = await createWebhookSubscription({
      name: input.name,
      endpointUrl: input.endpoint_url,
      eventTypes: input.event_types,
      actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    });
    res.status(result.idempotent_replay ? 200 : 201).json(webhookSecretResponseSchema.parse(result));
  } catch (error) { next(error); }
};

export const patchWebhookSubscriptionController: RequestHandler = async (req, res, next) => {
  try {
    const { id } = webhookIdParamsSchema.parse(req.params);
    const input = webhookPatchSubscriptionSchema.parse(req.body);
    res.json(webhookSubscriptionMutationResponseSchema.parse(await patchWebhookSubscription({
      id,
      expectedUpdatedAt: input.expected_updated_at,
      name: input.name,
      endpointUrl: input.endpoint_url,
      eventTypes: input.event_types,
      status: input.status,
      actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    })));
  } catch (error) { next(error); }
};

export const postWebhookSecretRotation: RequestHandler = async (req, res, next) => {
  try {
    const { id } = webhookIdParamsSchema.parse(req.params);
    const input = webhookRotateSecretSchema.parse(req.body);
    res.json(webhookSecretResponseSchema.parse(await rotateWebhookSecret({
      id,
      expectedUpdatedAt: input.expected_updated_at,
      actor: actor(req),
      idempotencyKey: idempotencyKey(req),
    })));
  } catch (error) { next(error); }
};

export const postWebhookTest: RequestHandler = async (req, res, next) => {
  try {
    const { id } = webhookIdParamsSchema.parse(req.params);
    const result = await enqueueWebhookTest({ subscriptionId: id, actor: actor(req), idempotencyKey: idempotencyKey(req) });
    res.status(result.idempotent_replay ? 200 : 202).json(webhookDeliveryMutationResponseSchema.parse(result));
  } catch (error) { next(error); }
};

export const getWebhookDeliveries: RequestHandler = async (req, res, next) => {
  try {
    const query = webhookListDeliveriesQuerySchema.parse(req.query);
    res.json(webhookDeliveryResponseSchema.array().parse(
      await listWebhookDeliveries({ subscriptionId: query.subscription_id, status: query.status, limit: query.limit }),
    ));
  } catch (error) { next(error); }
};

export const postWebhookReplay: RequestHandler = async (req, res, next) => {
  try {
    const { id } = webhookIdParamsSchema.parse(req.params);
    const result = await replayWebhookDelivery({ deliveryId: id, actor: actor(req), idempotencyKey: idempotencyKey(req) });
    res.status(result.idempotent_replay ? 200 : 202).json(webhookDeliveryMutationResponseSchema.parse(result));
  } catch (error) { next(error); }
};
