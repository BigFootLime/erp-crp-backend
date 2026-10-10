import type { Request, RequestHandler } from 'express';
import { HttpError } from '../../../utils/httpError';
import type { AuditContext } from '../../stock/repository/stock.repository';
import { deliveryStockRecoveryParams, deliveryStockRecoveryBody, deliveryStockRecoveryKey } from '../validators/delivery-stock-recovery.validators';
import { svcPreviewDeliveryStockRecovery, svcReserveDeliveryStockRecovery } from '../services/delivery-stock-recovery.service';
function audit(req: Request): AuditContext {
  if (!req.user) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  return { user_id: req.user.id, ip: req.ip ?? null, user_agent: req.get('user-agent') ?? null,
    device_type: null, os: null, browser: null, path: req.originalUrl,
    page_key: req.get('x-page-key') ?? null, client_session_id: req.get('x-client-session-id') ?? req.get('x-session-id') ?? null };
}
export const previewDeliveryStockRecovery: RequestHandler = async (req,res,next) => {
  try { audit(req); const { allocationId } = deliveryStockRecoveryParams.parse(req.params);
    const result = await svcPreviewDeliveryStockRecovery(allocationId);
    res.setHeader('Cache-Control','private, no-store, max-age=0'); res.json(result);
  } catch(error) { next(error); }
};
export const reserveDeliveryStockRecovery: RequestHandler = async (req,res,next) => {
  try { const context = audit(req), { allocationId } = deliveryStockRecoveryParams.parse(req.params);
    const body = deliveryStockRecoveryBody.parse(req.body);
    const idempotencyKey = deliveryStockRecoveryKey.parse(req.get('Idempotency-Key'));
    res.json(await svcReserveDeliveryStockRecovery({ allocationId, previewHash: body.preview_hash, reason: body.reason, idempotencyKey, audit: context }));
  } catch(error) { next(error); }
};
