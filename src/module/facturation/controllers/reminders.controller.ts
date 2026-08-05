import type { Request, RequestHandler } from "express";

import { HttpError } from "../../../utils/httpError";
import type { FinanceActorContext } from "../repository/workflow.repository.shared";
import { runReminderCycle, svcSendReminder } from "../services/reminder-job.service";
import {
  svcApproveReminder,
  svcCancelReminder,
  svcCreateReminderPolicy,
  svcGetReminderReadiness,
  svcGetReminderClientPreference,
  svcListClientReminderHistory,
  svcListInvoiceReminderHistory,
  svcListReminderPolicies,
  svcListReminderSuggestions,
  svcRetireReminderPolicy,
  svcRetryReminder,
  svcUpsertReminderClientPreference,
  svcValidateReminderPolicy,
} from "../services/reminders.service";
import {
  approveReminderSchema,
  cancelReminderSchema,
  createReminderPolicySchema,
  listReminderSuggestionsSchema,
  reminderClientParamsSchema,
  reminderClientPreferenceSchema,
  reminderFactureParamsSchema,
  reminderHistoryQuerySchema,
  reminderIdParamsSchema,
  retireReminderPolicySchema,
  retryReminderSchema,
  runReminderCycleSchema,
  sendReminderSchema,
  validateReminderPolicySchema,
} from "../validators/reminders.validators";

function actor(req: Request): FinanceActorContext {
  const userId = req.user?.id;
  if (typeof userId !== "number" || userId <= 0) {
    throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  }
  return {
    userId,
    requestId: req.requestId ?? "missing-request-id",
    path: req.originalUrl.split("?")[0] ?? req.path,
  };
}

function withIdempotencyKey(req: Request): Record<string, unknown> {
  const header = req.headers["idempotency-key"];
  return {
    ...(req.body && typeof req.body === "object" ? req.body : {}),
    ...(typeof header === "string" ? { idempotency_key: header } : {}),
  };
}

export const getReminderReadiness: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await svcGetReminderReadiness());
  } catch (error) {
    next(error);
  }
};

export const listReminderPolicies: RequestHandler = async (_req, res, next) => {
  try {
    res.json(await svcListReminderPolicies());
  } catch (error) {
    next(error);
  }
};

export const createReminderPolicy: RequestHandler = async (req, res, next) => {
  try {
    res.status(201).json(await svcCreateReminderPolicy(createReminderPolicySchema.parse(req.body), actor(req)));
  } catch (error) {
    next(error);
  }
};

export const validateReminderPolicy: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    res.json(await svcValidateReminderPolicy({
      policyId: id,
      input: validateReminderPolicySchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const retireReminderPolicy: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    res.json(await svcRetireReminderPolicy({
      policyId: id,
      input: retireReminderPolicySchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const listReminderSuggestions: RequestHandler = async (req, res, next) => {
  try {
    res.json(await svcListReminderSuggestions(listReminderSuggestionsSchema.parse(req.query)));
  } catch (error) {
    next(error);
  }
};

export const runReminderCycleNow: RequestHandler = async (req, res, next) => {
  try {
    const input = runReminderCycleSchema.parse(withIdempotencyKey(req));
    res.json(await runReminderCycle({
      now: input.now ? new Date(input.now) : new Date(),
      limit: input.limit,
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const approveReminder: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    res.json(await svcApproveReminder({
      suggestionId: id,
      input: approveReminderSchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const sendReminder: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    const input = sendReminderSchema.parse(withIdempotencyKey(req));
    res.json(await svcSendReminder({
      suggestionId: id,
      expectedVersion: input.expected_version,
      idempotencyKey: input.idempotency_key,
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const retryReminder: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    res.json(await svcRetryReminder({
      suggestionId: id,
      input: retryReminderSchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const cancelReminder: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderIdParamsSchema.parse(req.params);
    res.json(await svcCancelReminder({
      suggestionId: id,
      input: cancelReminderSchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const listInvoiceReminderHistory: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderFactureParamsSchema.parse(req.params);
    const { limit } = reminderHistoryQuerySchema.parse(req.query);
    res.json(await svcListInvoiceReminderHistory(id, limit));
  } catch (error) {
    next(error);
  }
};

export const listClientReminderHistory: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderClientParamsSchema.parse(req.params);
    const { limit } = reminderHistoryQuerySchema.parse(req.query);
    res.json(await svcListClientReminderHistory(id, limit));
  } catch (error) {
    next(error);
  }
};

export const upsertReminderClientPreference: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderClientParamsSchema.parse(req.params);
    res.json(await svcUpsertReminderClientPreference({
      clientId: id,
      input: reminderClientPreferenceSchema.parse(withIdempotencyKey(req)),
      actor: actor(req),
    }));
  } catch (error) {
    next(error);
  }
};

export const getReminderClientPreference: RequestHandler = async (req, res, next) => {
  try {
    const { id } = reminderClientParamsSchema.parse(req.params);
    res.json(await svcGetReminderClientPreference(id));
  } catch (error) {
    next(error);
  }
};
