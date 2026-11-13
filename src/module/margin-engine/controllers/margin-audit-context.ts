import type { Request } from 'express';
import { HttpError } from '../../../utils/httpError';
import { getClientIp, parseDevice } from '../../../utils/requestMeta';
import type { MarginAuditContext } from '../repository/margin-engine.repository';

/** Shared actor and request metadata for financial declarations. */
export function buildAuditContext(req: Request): MarginAuditContext {
  if (typeof req.user?.id !== 'number') throw new HttpError(401, 'UNAUTHORIZED', 'Authentification requise.');
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const device = parseDevice(userAgent);
  const rawSessionId = typeof req.headers['x-client-session-id'] === 'string' ? req.headers['x-client-session-id'] : null;
  const clientSessionId = rawSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawSessionId)
    ? rawSessionId : null;
  return {
    user_id: req.user.id, ip: getClientIp(req), user_agent: userAgent,
    device_type: device.device_type, os: device.os, browser: device.browser,
    path: req.originalUrl ?? null, page_key: 'margin-engine', client_session_id: clientSessionId,
  };
}
