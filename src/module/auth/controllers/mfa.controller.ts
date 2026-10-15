import type { Request, Response } from "express";

import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import pool from '../../../config/database';
import {sharedDirectoryClient,directoryAuthenticationResult} from '../../../shared-directory/site-runtime';
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

async function sharedOperation(req:Request,operation:string,input:unknown){
  const directory=sharedDirectoryClient();if(!directory)return null;
  if(!req.user?.directory_session)throw new Error('DIRECTORY_SESSION_REQUIRED');
  const {path:_path,request_id:_request,...clientMeta}=meta(req);
  return {value:await directory.call(operation,{directory_session:req.user.directory_session,input,meta:clientMeta}),meta:clientMeta};
}

const directoryMfaFailures = new Map<string, { status: number; message: string }>([
  ["MFA_CODE_INVALID", { status: 401, message: "Code MFA invalide." }],
  ["MFA_LOCKED", { status: 423, message: "Le facteur MFA est temporairement verrouillé." }],
  ["MFA_CHALLENGE_INVALID", { status: 400, message: "Défi MFA invalide." }],
  ["MFA_CHALLENGE_USED", { status: 400, message: "Ce défi MFA a déjà été utilisé." }],
  ["MFA_CHALLENGE_EXPIRED", { status: 400, message: "Le défi MFA a expiré." }],
  ["MFA_CHALLENGE_STALE", { status: 400, message: "La session a changé. Reconnectez-vous." }],
  ["MFA_FACTOR_INVALID", { status: 400, message: "Le facteur MFA n'est plus actif." }],
  ["MFA_ENROLLMENT_EXPIRED", { status: 400, message: "L'enrôlement MFA a expiré." }],
]);

function mapDirectoryMfaFailure(error: unknown): never {
  const candidate = error as { code?: unknown } | null;
  const code = typeof candidate?.code === "string" ? candidate.code : null;
  const failure = code ? directoryMfaFailures.get(code) : undefined;
  if (failure && code !== null) throw new HttpError(failure.status, code, failure.message);
  throw error;
}

export const verifyChallenge = asyncHandler(async (req: Request, res: Response) => {
  const body = verifyMfaChallengeSchema.parse(req.body);
  const directory=sharedDirectoryClient(),audit=meta(req);
  const {path: _path,request_id: _request,...clientMeta}=audit;
  let result;
  try {
    result = directory ? await directoryAuthenticationResult(pool,await directory.call('verify-mfa',{input:body,meta:clientMeta}),clientMeta):await verifyMfaChallenge(body.challenge_token, body.code, audit);
  } catch (error) {
    if (directory) mapDirectoryMfaFailure(error);
    throw error;
  }
  return res.status(200).json({ message: "Authentification renforcée validée", ...result });
});

export const status = asyncHandler(async (req: Request, res: Response) => {
  const shared=await sharedOperation(req,'mfa-status',{});if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await getMfaStatus(authenticatedUserId(req)));
});

export const stepUp = asyncHandler(async (req: Request, res: Response) => {
  const body = stepUpMfaSchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-step-up',body);if(shared)return res.status(200).json(await directoryAuthenticationResult(pool,shared.value));
  return res.status(200).json(await stepUpMfa(authenticatedUserId(req), body.code, meta(req)));
});

export const startEnrollment = asyncHandler(async (req: Request, res: Response) => {
  const body = enrollMfaSchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-enroll',body);if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await beginOwnMfaEnrollment(
    authenticatedUserId(req), body.current_password, body.device_label, meta(req),
  ));
});

export const startReplacement = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-replace',body);if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await beginMfaReplacement(
    authenticatedUserId(req), body.current_password, body.code, body.device_label, meta(req),
  ));
});

export const recoveryCodes = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-recovery-codes',body);if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await regenerateRecoveryCodes(
    authenticatedUserId(req), body.current_password, body.code, meta(req),
  ));
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const body = manageMfaSchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-revoke',body);if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await revokeOwnMfa(
    authenticatedUserId(req), body.current_password, body.code, meta(req),
  ));
});

export const policy = asyncHandler(async (req: Request, res: Response) => {
  const shared=await sharedOperation(req,'mfa-policy',{});if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await getMfaPolicyConfiguration());
});

export const updatePolicy = asyncHandler(async (req: Request, res: Response) => {
  const body = updateMfaPolicySchema.parse(req.body);
  const shared=await sharedOperation(req,'mfa-policy-update',body);if(shared)return res.status(200).json(shared.value);
  return res.status(200).json(await updateMfaPolicyConfiguration({
    userId: authenticatedUserId(req),
    password: body.current_password,
    code: body.code,
    policy: body.policy,
    meta: meta(req),
  }));
});
