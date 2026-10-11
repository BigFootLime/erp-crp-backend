import type { Request, RequestHandler } from 'express';
import { HttpError } from '../../../utils/httpError';
import { deliveryStockRecoveryParams } from '../validators/delivery-stock-recovery.validators';
import { deliveryUrgencyQuery, deliveryUrgencyBody, deliveryUrgencyRequestParams, deliveryUrgencyCancelBody, deliveryUrgencyKey } from '../validators/delivery-urgency.validators';
import { svcPreviewDeliveryUrgency, svcCreateDeliveryUrgencyRequest, svcListDeliveryUrgencyRequests, svcCancelDeliveryUrgencyRequest } from '../services/delivery-urgency.service';
import type { AuditContext } from '../../production/repository/production.repository';

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
    res.json(result);
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
