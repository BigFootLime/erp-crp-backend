import type { Request, RequestHandler } from 'express';
import { HttpError } from '../../../utils/httpError';
import { deliveryStockRecoveryParams } from '../validators/delivery-stock-recovery.validators';
import { deliveryUrgencyQuery, deliveryUrgencyBody, deliveryUrgencyRequestParams, deliveryUrgencyCancelBody, deliveryUrgencyKey, deliveryUrgencyWithdrawalBody } from '../validators/delivery-urgency.validators';
import { svcPreviewDeliveryUrgency, svcCreateDeliveryUrgencyRequest, svcListDeliveryUrgencyRequests, svcCancelDeliveryUrgencyRequest, svcPreviewUrgencyWithdrawal, svcWithdrawDeliveryUrgency } from '../services/delivery-urgency.service';
import type { AuditContext } from '../../production/repository/production.repository';
import { requestHasGrantedAccountModuleAccess } from '../../access-control/context/account-module-access.context';
import { roleHasLivraisonCapability } from '../domain/livraisons-rbac';
import { deliveryUrgencyRetainBody } from '../validators/delivery-urgency.validators';
import { svcPreviewUrgencyCancellation } from '../services/delivery-urgency.service';

const canAllocate = (req: Request) => requestHasGrantedAccountModuleAccess(req) || roleHasLivraisonCapability(req.user?.role, 'allocate');

function audit(req: Request): AuditContext {
  if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return { user_id: req.user.id, user_role: req.user.role, ip: req.ip ?? null, user_agent: req.get('user-agent') ?? null,
    device_type: null, os: null, browser: null, path: req.originalUrl,
    page_key: req.get('x-page-key') ?? null, client_session_id: req.get('x-client-session-id') ?? req.get('x-session-id') ?? null };
}

export const previewDeliveryUrgency: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
    const { allocationId } = deliveryStockRecoveryParams.parse(req.params);
    const { quantity } = deliveryUrgencyQuery.parse(req.query);
    const result = await svcPreviewDeliveryUrgency(allocationId, quantity);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.json({ ...result, can_request: canAllocate(req) });
  } catch (error) { next(error); }
};

export const listDeliveryUrgencyRequests: RequestHandler = async (req, res, next) => {
  try {
    audit(req);
    const { allocationId } = deliveryStockRecoveryParams.parse(req.params);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.json(await svcListDeliveryUrgencyRequests(allocationId));
  } catch (error) { next(error); }
};

export const createDeliveryUrgencyRequest: RequestHandler = async (req, res, next) => {
  try {
    const context = audit(req), { allocationId } = deliveryStockRecoveryParams.parse(req.params);
    const body = deliveryUrgencyBody.parse(req.body);
    const idempotencyKey = deliveryUrgencyKey.parse(req.get('Idempotency-Key'));
    const result = await svcCreateDeliveryUrgencyRequest({ allocationId, body, idempotencyKey, audit: context });
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
};

export const cancelDeliveryUrgencyRequest: RequestHandler = async (req, res, next) => {
  try {
    const context = audit(req), { requestId } = deliveryUrgencyRequestParams.parse(req.params);
    const body = deliveryUrgencyCancelBody.parse(req.body);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.json(await svcCancelDeliveryUrgencyRequest({ requestId, body, audit: context }));
  } catch (error) { next(error); }
};

export const previewDeliveryUrgencyCancellation: RequestHandler = async (req,res,next) => {
  try {
    audit(req);
    const { requestId }=deliveryUrgencyRequestParams.parse(req.params);
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.json({...await svcPreviewUrgencyCancellation(requestId),can_allocate:canAllocate(req)});
  } catch(error) { next(error); }
};

/** Mounted only under planning's module scope and manage_schedule capability. */
export const cancelDeliveryUrgencyRetainingProduction: RequestHandler = async (req,res,next) => {
  try {
    const context=audit(req),{requestId}=deliveryUrgencyRequestParams.parse(req.params);
    const body=deliveryUrgencyRetainBody.parse(req.body);
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.json(await svcCancelDeliveryUrgencyRequest({requestId,body,audit:context,retainProduction:true}));
  } catch(error) { next(error); }
};

export const previewUrgencyWithdrawal: RequestHandler = async (req,res,next) => {
  try {
    audit(req);
    const { requestId } = deliveryUrgencyRequestParams.parse(req.params);
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.json({ ...await svcPreviewUrgencyWithdrawal(requestId), can_allocate: canAllocate(req) });
  } catch (error) { next(error); }
};

export const withdrawDeliveryUrgency: RequestHandler = async (req,res,next) => {
  try {
    const context = audit(req), { requestId } = deliveryUrgencyRequestParams.parse(req.params);
    const body = deliveryUrgencyWithdrawalBody.parse(req.body);
    const idempotencyKey = deliveryUrgencyKey.parse(req.get('Idempotency-Key'));
    const result = await svcWithdrawDeliveryUrgency({ requestId,expectedVersion:body.expected_version,
      previewHash:body.preview_hash,idempotencyKey,audit:context });
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { next(error); }
};
