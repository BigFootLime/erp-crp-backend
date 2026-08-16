import type { Request, Response } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import {
  enrollMfaSchema,
  manageMfaSchema,
  stepUpMfaSchema,
  updateMfaPolicySchema,
  verifyMfaChallengeSchema,
} from "../validators/auth.validator";
import {
  beginOwnMfaEnrollment,
  beginMfaReplacement,
  getMfaPolicyConfiguration,
  getMfaStatus,
  regenerateRecoveryCodes,
  revokeOwnMfa,
  stepUpMfa,
  updateMfaPolicyConfiguration,
  verifyMfaChallenge,
  type MfaAuditMeta,
} from "../services/mfa.service";

function meta(req: Request): MfaAuditMeta {
  const userAgent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(userAgent);
  return {
    ip: getClientIp(req),
    user_agent: userAgent,
    device_type: device.device_type,
    os: device.os,
    browser: device.browser,
    path: req.originalUrl.split("?", 1)[0] ?? req.path,
    request_id: req.requestId ?? null,
  };
}

function authenticatedUserId(req: Request): number {
  if (!req.user || typeof req.user.id !== "number") throw new Error("Authenticated user missing");
  return req.user.id;
}

export const verifyChallenge = asyncHandler(async (req: Request, res: Response) => {
  const body = verifyMfaChallengeSchema.parse(req.body);
  const result = await verifyMfaChallenge(body.challenge_token, body.code, meta(req));
  return res.status(200).json({ message: "Authentification renforcée validée", ...result });
});

export const status = asyncHandler(async (req: Request, res: Response) => {
  return res.status(200).json(await getMfaStatus(authenticatedUserId(req)));
});

export const stepUp = asyncHandler(async (req: Request, res: Response) => {
  const body = stepUpMfaSchema.parse(req.body);
  return res.status(200).json(await stepUpMfa(authenticatedUserId(req), body.code, meta(req)));
});

export const startEnrollment = asyncHandler(async (req: Request, res: Response) => {
  const body = enrollMfaSchema.parse(req.body);
  return res.status(200).json(await beginOwnMfaEnrollment(
    authenticatedUserId(req), body.current_password, body.device_label, meta(req),
  ));
});

export const startReplacement = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  return res.status(200).json(await beginMfaReplacement(
    authenticatedUserId(req), body.current_password, body.code, body.device_label, meta(req),
  ));
});

export const recoveryCodes = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  return res.status(200).json(await regenerateRecoveryCodes(
    authenticatedUserId(req), body.current_password, body.code, meta(req),
  ));
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  return res.status(200).json(await revokeOwnMfa(
    authenticatedUserId(req), body.current_password, body.code, meta(req),
  ));
});

export const policy = asyncHandler(async (_req: Request, res: Response) => {
  return res.status(200).json(await getMfaPolicyConfiguration());
});

export const updatePolicy = asyncHandler(async (req: Request, res: Response) => {
  const body = updateMfaPolicySchema.parse(req.body);
  return res.status(200).json(await updateMfaPolicyConfiguration({
    userId: authenticatedUserId(req),
    password: body.current_password,
    code: body.code,
    policy: body.policy,
    meta: meta(req),
  }));
});
