import type { RequestHandler } from "express";
import { z } from "zod";
import pool from '../../config/database';

import { asyncHandler } from "../../utils/asyncHandler";
import { HttpError } from "../../utils/httpError";
import * as directory from './account-requests.directory-facade';
import {
  accountRequestStatusSchema, approveAccountRequestSchema, deleteAccountRequestSchema,
  listAccountRequestsSchema, rejectAccountRequestSchema, submitAccountRequestSchema,
} from "./validators/account-requests.validators";

function assertProductionRequest(header: string | undefined) {
  if (header !== 'cerp_prod') throw new HttpError(400, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette demande doit viser la production.');
}

export const submit: RequestHandler = asyncHandler(async (req, res) => {
  assertProductionRequest(req.get('X-CERP-Database') ?? undefined);
  const dto = submitAccountRequestSchema.parse({ body: req.body });
  const result = await directory.submitDirectoryRequest(dto.body);
  res.setHeader("Cache-Control", "no-store");
  res.status(202).json(result);
});

export const status: RequestHandler = asyncHandler(async (req, res) => {
  assertProductionRequest(req.get('X-CERP-Database') ?? undefined);
  const authorization = req.get('Authorization');
  const receipt = authorization?.match(/^Account-Request-Receipt ([A-Za-z0-9_-]{43})$/)?.[1];
  const dto = accountRequestStatusSchema.parse({ headers: { receipt } });
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.readDirectoryRequestStatus(dto.headers.receipt));
});

export const list: RequestHandler = asyncHandler(async (req, res) => {
  const dto = listAccountRequestsSchema.parse({ query: req.query });
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.listDirectoryRequests(req, dto.query));
});

export const companyAccessOptions: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const id = z.string().uuid().parse(req.params.id);
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.listDirectoryRequestCompanyAccessOptions(req, id));
});

const companyAccessBody = z.object({ company_access: z.array(z.object({
  company_id: z.string().uuid(), expected_membership_version: z.number().int().min(0),
}).strict()).max(100) }).strict();
async function directoryProfileForLocalUser(userId: number) {
  const row = (await pool.query<{ profile_id: string }>(
    "SELECT directory_profile_id::text AS profile_id FROM public.users WHERE id=$1 AND directory_profile_id IS NOT NULL", [userId],
  )).rows[0];
  if (!row) throw new HttpError(404, "DIRECTORY_PROFILE_NOT_FOUND", "Le compte n’est pas rattaché à l’annuaire.");
  return row.profile_id;
}
export const approvedCompanyAccess: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const profileId = z.string().uuid().parse(req.params.profileId);
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.readDirectoryApprovedCompanyAccess(req, profileId));
});
export const setApprovedCompanyAccess: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const profileId = z.string().uuid().parse(req.params.profileId);
  const body = companyAccessBody.parse(req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.setDirectoryApprovedCompanyAccess(req, profileId, body.company_access));
});
export const approvedCompanyAccessForUser: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const profileId = await directoryProfileForLocalUser(z.coerce.number().int().positive().parse(req.params.userId));
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.readDirectoryApprovedCompanyAccess(req, profileId));
});
export const setApprovedCompanyAccessForUser: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const profileId = await directoryProfileForLocalUser(z.coerce.number().int().positive().parse(req.params.userId));
  const body = companyAccessBody.parse(req.body);
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.setDirectoryApprovedCompanyAccess(req, profileId, body.company_access));
});

export const approve: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const dto = approveAccountRequestSchema.parse({ params: req.params, headers: { idempotencyKey: req.get("Idempotency-Key") }, body: req.body });
  const result = await directory.approveDirectoryRequest(pool, req, { id: dto.params.id, approval: dto.body, key: dto.headers.idempotencyKey });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json(result);
});

export const reject: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const dto = rejectAccountRequestSchema.parse({ params: req.params, headers: { idempotencyKey: req.get("Idempotency-Key") }, body: req.body });
  res.setHeader("Cache-Control", "no-store");
  res.json(await directory.rejectDirectoryRequest(req, { id: dto.params.id, expected_version: dto.body.expected_version, reason: dto.body.reason, key: dto.headers.idempotencyKey }));
});

export const purge: RequestHandler = asyncHandler(async (req, res) => {
  if (!req.user) throw new HttpError(401, "AUTH_REQUIRED", "Authentification requise.");
  const dto = deleteAccountRequestSchema.parse({ params: req.params, headers: { idempotencyKey: req.get("Idempotency-Key") }, body: req.body });
  await directory.deleteDirectoryRequest(req, { id: dto.params.id, expected_version: dto.body.expected_version, key: dto.headers.idempotencyKey });
  res.status(204).end();
});
