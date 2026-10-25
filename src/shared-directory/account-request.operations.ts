import { z } from 'zod';
import type { Express, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { requireDirectoryOwner } from './authority';
import { validateDirectorySession } from './session.repository';
import { directoryProfileForSite } from './admin.repository';
import { HttpError } from '../utils/httpError';
import {
  activateDirectoryAccountRequest, approveDirectoryAccountRequest, deleteDirectoryAccountRequest, listDirectoryAccountRequests,
  rejectDirectoryAccountRequest, statusDirectoryAccountRequest, submitDirectoryAccountRequest,
} from './account-request.repository';
import { usernameBaseFromGivenName } from '../module/account-requests/validators/account-requests.validators';
import { approveAccountRequestSchema, submitAccountRequestSchema } from '../module/account-requests/validators/account-requests.validators';

type Wrap = (work: (req: Request, res: Response) => Promise<void>) => RequestHandler;
const sourceSession = z.string().regex(/^dir_[a-f0-9]{64}$/);
const requestId = z.string().guid();
const version = z.number().int().min(0);

export function mountDirectoryAccountRequests(app: Express, db: Pool, wrap: Wrap) {
  const endpoint = (operation: string, work: (actor: Awaited<ReturnType<typeof validateDirectorySession>> | null, input: unknown) => Promise<unknown>) => app.post(`/internal/directory/${operation}`, wrap(async (req, res) => {
    const body = z.object({ directory_session: sourceSession.optional(), input: z.unknown() }).strict().parse(req.body);
    if (req.directoryCaller !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    const actor = body.directory_session ? await validateDirectorySession(db, req.directoryCaller!, body.directory_session) : null;
    res.json(await work(actor, body.input));
  }));
  endpoint('account-request-submit', async (_actor, raw) => {
    const input = submitAccountRequestSchema.shape.body.parse(raw);
    // Public DTO follows the existing ERP convention: `surname` carries the
    // applicant's given name, from which the immutable login base is derived.
    return submitDirectoryAccountRequest(db, { ...input, email: input.email.toLowerCase(), username_base: usernameBaseFromGivenName(input.surname) });
  });
  endpoint('account-request-status', async (_actor, raw) => statusDirectoryAccountRequest(db, z.object({ receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(raw).receipt));
  endpoint('account-request-list', async (actor, raw) => {
    if (!actor) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
    if (actor.database !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    await requireDirectoryOwner(db, actor);
    const input = z.object({ status: z.enum(['PENDING', 'PROJECTION_PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).default('PENDING'), limit: z.number().int().min(1).max(100).default(50), cursor: requestId.optional() }).strict().parse(raw);
    return { ...await listDirectoryAccountRequests(db, input.status, input.limit, input.cursor), historical_link_supported: false };
  });
  endpoint('account-request-approve', async (actor, raw) => {
    if (!actor) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
    if (actor.database !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    await requireDirectoryOwner(db, actor);
    const envelope = z.object({ id: requestId, key: z.string().guid(), approval: z.unknown() }).strict().parse(raw);
    const parsed = approveAccountRequestSchema.parse({ params: { id: envelope.id }, headers: { idempotencyKey: envelope.key }, body: envelope.approval });
    if (parsed.body.module_keys.length === 0) throw new HttpError(422, 'ACCOUNT_REQUEST_MODULE_REQUIRED', 'Sélectionnez au moins un module.');
    if (parsed.body.link_historical_user_id !== null && parsed.body.link_historical_user_id !== undefined) throw new HttpError(422, 'HISTORICAL_LINK_REQUIRES_OWNER_OPERATION', 'Le rattachement historique exige une opération administrateur distincte.');
    const prepared = await approveDirectoryAccountRequest(db, actor, envelope.id, parsed.body, envelope.key);
    return { ...prepared, profile: await directoryProfileForSite(db, actor.database, prepared.profile_id) };
  });
  endpoint('account-request-activate', async (actor, raw) => {
    if (!actor) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
    if (actor.database !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    await requireDirectoryOwner(db, actor);
    return activateDirectoryAccountRequest(db, actor, z.object({ id: requestId, expected_version: version, profile_id: z.string().guid() }).strict().parse(raw));
  });
  endpoint('account-request-reject', async (actor, raw) => {
    if (!actor) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
    if (actor.database !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    await requireDirectoryOwner(db, actor);
    return rejectDirectoryAccountRequest(db, actor, z.object({ id: requestId, expected_version: version, reason: z.string().trim().max(500).optional(), key: z.string().guid() }).strict().parse(raw));
  });
  endpoint('account-request-delete', async (actor, raw) => {
    if (!actor) throw new HttpError(401, 'DIRECTORY_SESSION_REQUIRED', 'Une nouvelle connexion est requise.');
    if (actor.database !== 'cerp_prod') throw new HttpError(403, 'ACCOUNT_REQUEST_PRODUCTION_ONLY', 'Cette opération est réservée à la Production.');
    await requireDirectoryOwner(db, actor);
    return deleteDirectoryAccountRequest(db, actor, z.object({ id: requestId, expected_version: version, key: z.string().guid() }).strict().parse(raw));
  });
}
