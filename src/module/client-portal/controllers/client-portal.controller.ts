import {changeDemandSite} from '../repository/client-portal-demand-sites.repository';
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
  portalDeliveryReceiptSchema,
  portalDeliveryDashboardQuerySchema,adminPortalDeliverySiteBindingSchema,adminPortalDemandSiteBindingSchema,adminPortalContractBindingSchema,adminPortalOperationalNoticeSchema,
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

export async function commercialOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await repository.repoGetPortalCommercialOverview(portalIdentity(req));
    res.json({ data, meta: { source: "CERP PostgreSQL — portal scoped commercial cockpit", reliability: "SYSTEM_OF_RECORD" } });
  } catch (error) { next(error); }
}

export async function listDeliveries(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listPortalDeliveries(portalIdentity(req), pagination(req))); }
  catch (error) { next(error); }
}

export async function confirmDeliveryReceipt(req: Request, res: Response, next: NextFunction) {
  try {
    const deliveryId = uuidParam(req.params.deliveryId);
    const body = parseBody(portalDeliveryReceiptSchema, req.body);
    const { repoCreatePortalDeliveryReceipt } = await import("../repository/client-portal-delivery-receipts.repository");
    res.status(201).json(await repoCreatePortalDeliveryReceipt({ identity: portalIdentity(req), deliveryId, idempotencyKey: idempotencyKey(req),
      deliveredAt: body.delivered_at, receivedByName: body.received_by_name ?? null, note: body.note ?? null,
      lines: body.line_receipts, meta: metaFrom(req) }));
  } catch (error) { next(error); }
}
export async function deliveryDashboard(req: Request,res:Response,next:NextFunction){try{const q=parseBody(portalDeliveryDashboardQuerySchema,req.query);const {repoPortalDeliveryDashboard}=await import("../repository/client-portal-delivery-dashboard.repository");res.json(await repoPortalDeliveryDashboard(portalIdentity(req),q.from,q.to));}catch(error){next(error)}}
export async function createAdminDeliverySiteBinding(req:Request,res:Response,next:NextFunction){try{const accountId=uuidParam(req.params.accountId),body=parseBody(adminPortalDeliverySiteBindingSchema,req.body);const {default:pool}=await import("../../../config/database");const permitted=await pool.query(`SELECT 1 FROM public.client_portal_accounts account JOIN public.commande_client order_header ON order_header.client_id=account.client_id WHERE account.id=$1::uuid AND order_header.destinataire_id=$2::uuid LIMIT 1`,[accountId,body.delivery_address_id]);if(!permitted.rowCount)throw new HttpError(422,"CLIENT_PORTAL_SITE_SCOPE_UNVERIFIED","Ce site ne peut pas être lié : aucune commande client ne prouve son rattachement.");const row=await pool.query(`INSERT INTO public.client_portal_delivery_site_bindings(account_id,delivery_address_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING RETURNING account_id::text,delivery_address_id::text`,[accountId,body.delivery_address_id]);res.status(row.rows[0]?201:200).json({data:row.rows[0]??{account_id:accountId,delivery_address_id:body.delivery_address_id}});}catch(error){next(error)}}
export async function createAdminContractBinding(req:Request,res:Response,next:NextFunction){try{const accountId=uuidParam(req.params.accountId),body=parseBody(adminPortalContractBindingSchema,req.body);const {default:pool}=await import("../../../config/database");const row=await pool.query(`INSERT INTO public.client_portal_contract_bindings(account_id,contract_id,created_by_user_id) VALUES($1::uuid,$2::uuid,$3) ON CONFLICT DO NOTHING RETURNING account_id::text,contract_id::text,created_at::text`,[accountId,body.contract_id,erpActorId(req)]);res.status(row.rows[0]?201:200).json({data:row.rows[0]??{account_id:accountId,contract_id:body.contract_id}});}catch(error){next(error)}}
export async function listAdminOperationalNotices(req:Request,res:Response,next:NextFunction){try{const {default:pool}=await import("../../../config/database");const data=(await pool.query(`SELECT id::text,client_id,account_id::text,delivery_address_id::text,notice_type,title,message,published_from::text,published_until::text,starts_on::text,ends_on::text,created_at::text FROM public.client_portal_operational_notices ORDER BY published_from DESC,id DESC LIMIT 250`)).rows;res.json({data});}catch(error){next(error)}}
export async function createAdminOperationalNotice(req:Request,res:Response,next:NextFunction){try{const body=parseBody(adminPortalOperationalNoticeSchema,req.body);const {default:pool}=await import("../../../config/database");const row=(await pool.query(`INSERT INTO public.client_portal_operational_notices(client_id,account_id,delivery_address_id,notice_type,title,message,published_from,published_until,starts_on,ends_on,created_by_user_id) VALUES($1,$2::uuid,$3::uuid,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9::date,$10::date,$11) RETURNING id::text,client_id,account_id::text,delivery_address_id::text,notice_type,title,message,published_from::text,published_until::text,starts_on::text,ends_on::text`,[body.client_id,body.account_id??null,body.delivery_address_id??null,body.notice_type,body.title,body.message,body.published_from,body.published_until,body.starts_on??null,body.ends_on??null,erpActorId(req)])).rows[0];res.status(201).json({data:row});}catch(error){next(error)}}
async function setDemandSite(req:Request,res:Response,next:NextFunction,revoke:boolean){
 try{const {external_site}=parseBody(adminPortalDemandSiteBindingSchema,req.body);
  const result=await changeDemandSite({accountId:uuidParam(req.params.accountId),site:external_site,revoke,actorId:erpActorId(req),meta:metaFrom(req)});
  res.status(result.changed&&!revoke?201:200).json({data:result});
 }catch(error){next(error);}
}
export const createAdminDemandSiteBinding=(req:Request,res:Response,next:NextFunction)=>setDemandSite(req,res,next,false);
export const revokeAdminDemandSiteBinding=(req:Request,res:Response,next:NextFunction)=>setDemandSite(req,res,next,true);
export async function listAdminDemandSiteBindings(req:Request,res:Response,next:NextFunction){try{const accountId=uuidParam(req.params.accountId);const {default:pool}=await import("../../../config/database");const data=(await pool.query(`SELECT portal_account_id::text,external_site,created_at::text,created_by_user_id FROM public.client_portal_demand_sites WHERE portal_account_id=$1::uuid ORDER BY external_site`,[accountId])).rows;res.json({data});}catch(error){next(error)}}

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

