import { sanitizeLogValue } from "../../../shared/observability/logger";
import type { CreateAuditLogBodyDTO } from "../validators/audit-logs.validators";

/** Browser telemetry never impersonates server-confirmed business actions. */
export function clientAuditEvent(body: CreateAuditLogBodyDTO): CreateAuditLogBodyDTO {
  const path = body.path?.split(/[?#]/, 1)[0] ?? null;
  const safePath = path && /^\/[a-zA-Z0-9_./:-]{0,399}$/.test(path) ? path : null;
  return {
    event_type: body.event_type,
    action: body.event_type === "NAVIGATION" ? "CLIENT_NAVIGATION" : "CLIENT_ACTION",
    page_key: body.page_key,
    entity_type: "client_event", entity_id: null, path: safePath,
    client_session_id: body.client_session_id,
    details: { source: "client", action: sanitizeLogValue(body.action), metadata: sanitizeLogValue(body.details ?? null) },
  };
}
