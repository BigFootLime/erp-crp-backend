import type { NextFunction, Request, Response } from "express";

import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import { sendSecureStoredFile } from "../../../shared/uploads/secure-download";
import { getClientIp, parseDevice } from "../../../utils/requestMeta";
import { HttpError } from "../../../utils/httpError";
import * as repository from "../repository/client-portal.repository";
import * as service from "../services/client-portal.service";
import {
  adminCreatePortalAccountSchema,
  adminCreatePortalPublicationSchema,
  adminPortalAccountStatusSchema,
  adminRevokePortalPublicationSchema,
  idempotencyKeySchema,
  portalActivateSchema,
  portalForgotPasswordSchema,
  portalLoginSchema,
  portalPaginationSchema,
  portalResetPasswordSchema,
  portalUuidParamSchema,
} from "../validators/client-portal.validators";

export { requireSuperadmin };

function metaFrom(req: Request) {
  const userAgent = req.headers["user-agent"]?.toString() ?? null;
  const device = parseDevice(userAgent);
  return service.buildPortalRequestMeta({
    requestId: req.requestId ?? null,
    ip: getClientIp(req),
    browser: device.browser,
  });
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(400, "CLIENT_PORTAL_VALIDATION", "Données portail invalides.", parsed.error);
  }
  return parsed.data;
}

function portalIdentity(req: Request) {
  if (!req.portalIdentity) throw new HttpError(401, "CLIENT_PORTAL_SESSION_REQUIRED", "Session portail requise.");
  return req.portalIdentity;
}

function erpActorId(req: Request): number {
  if (!req.user || typeof req.user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
  return req.user.id;
}

function idempotencyKey(req: Request): string {
  const parsed = idempotencyKeySchema.safeParse(req.header("Idempotency-Key"));
  if (!parsed.success) {
    throw new HttpError(400, "CLIENT_PORTAL_IDEMPOTENCY_REQUIRED", "Un en-tête Idempotency-Key UUID est requis.");
  }
  return parsed.data;
}

function uuidParam(value: unknown): string {
  const parsed = portalUuidParamSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "CLIENT_PORTAL_VALIDATION", "Identifiant invalide.");
  return parsed.data;
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(portalLoginSchema, req.body);
    res.json(await service.loginPortal(body, metaFrom(req)));
  } catch (error) { next(error); }
}

export async function activate(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(portalActivateSchema, req.body);
    res.json(await service.activatePortalAccount(body, metaFrom(req)));
  } catch (error) { next(error); }
}

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(portalForgotPasswordSchema, req.body);
    await service.requestPortalPasswordReset(body.email, metaFrom(req));
    res.status(202).json({ accepted: true });
  } catch (error) { next(error); }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(portalResetPasswordSchema, req.body);
    res.json(await service.resetPortalPassword(body, metaFrom(req)));
  } catch (error) { next(error); }
}

export async function me(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.getPortalProfile(portalIdentity(req))); }
  catch (error) { next(error); }
}

function pagination(req: Request) {
  return parseBody(portalPaginationSchema, req.query);
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listPortalOrders(portalIdentity(req), pagination(req))); }
  catch (error) { next(error); }
}

export async function listDeliveries(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listPortalDeliveries(portalIdentity(req), pagination(req))); }
  catch (error) { next(error); }
}

export async function listInvoices(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listPortalInvoices(portalIdentity(req), pagination(req))); }
  catch (error) { next(error); }
}

export async function listDocuments(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listPortalDocuments(portalIdentity(req))); }
  catch (error) { next(error); }
}

export async function acknowledgeDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const publicationId = uuidParam(req.params.publicationId);
    res.json(await service.acknowledgePortalDocument(portalIdentity(req), publicationId, metaFrom(req)));
  } catch (error) { next(error); }
}

export async function downloadDocument(req: Request, res: Response, next: NextFunction) {
  const identity = req.portalIdentity;
  const publicationId = portalUuidParamSchema.safeParse(req.params.publicationId);
  if (!identity || !publicationId.success) {
    next(new HttpError(identity ? 400 : 401, "CLIENT_PORTAL_DOCUMENT_REQUEST", "Demande de document invalide."));
    return;
  }
  try {
    const document = await service.getPortalDocumentDownload(identity, publicationId.data);
    res.setHeader("X-CERP-Document-SHA256", document.sha256);
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
    const result = await sendSecureStoredFile(res, {
      filePath: document.file_path,
      allowedRoots: [document.allowed_root],
      filename: document.filename,
      mimeType: document.mime_type,
      download: true,
      expectedSha256: document.sha256,
      integrityError: {
        status: 409,
        code: "CLIENT_PORTAL_DOCUMENT_INTEGRITY",
        message: "L'intégrité du document ne peut pas être vérifiée.",
      },
    });
    if (result === "completed") {
      await repository.repoRecordPortalDocumentDownload({
        identity,
        publicationId: publicationId.data,
        outcome: "SUCCEEDED",
        meta: metaFrom(req),
      });
    }
  } catch (error) {
    if (error instanceof HttpError && error.code === "CLIENT_PORTAL_DOCUMENT_INTEGRITY") {
      await repository.repoRecordPortalDocumentDownload({
        identity,
        publicationId: publicationId.data,
        outcome: "INTEGRITY_FAILURE",
        meta: metaFrom(req),
      }).catch(() => undefined);
    }
    next(error);
  }
}

export async function listAdminAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id.trim() : undefined;
    if (clientId && clientId.length > 3) throw new HttpError(400, "CLIENT_PORTAL_VALIDATION", "Client invalide.");
    res.json({ data: await repository.repoListPortalAccounts(clientId) });
  } catch (error) { next(error); }
}

export async function createAdminAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.createPortalAccountByAdmin({
      actorId: erpActorId(req),
      idempotencyKey: idempotencyKey(req),
      body: parseBody(adminCreatePortalAccountSchema, req.body),
      meta: metaFrom(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
}

export async function createAdminInvitation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.createPortalInvitationByAdmin({
      actorId: erpActorId(req),
      accountId: uuidParam(req.params.accountId),
      idempotencyKey: idempotencyKey(req),
      meta: metaFrom(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
}

export async function patchAdminAccountStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(adminPortalAccountStatusSchema, req.body);
    res.json({ data: await service.setPortalAccountStatusByAdmin({
      actorId: erpActorId(req),
      accountId: uuidParam(req.params.accountId),
      status: body.status,
      reason: body.reason,
      meta: metaFrom(req),
    }) });
  } catch (error) { next(error); }
}

export async function listAdminPublications(req: Request, res: Response, next: NextFunction) {
  try {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id.trim() : undefined;
    if (clientId && clientId.length > 3) throw new HttpError(400, "CLIENT_PORTAL_VALIDATION", "Client invalide.");
    res.json({ data: await repository.repoListPortalPublications(clientId) });
  } catch (error) { next(error); }
}

export async function createAdminPublication(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.createPortalPublicationByAdmin({
      actorId: erpActorId(req),
      idempotencyKey: idempotencyKey(req),
      body: parseBody(adminCreatePortalPublicationSchema, req.body),
      meta: metaFrom(req),
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
}

export async function revokeAdminPublication(req: Request, res: Response, next: NextFunction) {
  try {
    const body = parseBody(adminRevokePortalPublicationSchema, req.body);
    res.json({ data: await repository.repoRevokePortalPublication({
      actorId: erpActorId(req),
      publicationId: uuidParam(req.params.publicationId),
      reason: body.reason,
      meta: metaFrom(req),
    }) });
  } catch (error) { next(error); }
}

