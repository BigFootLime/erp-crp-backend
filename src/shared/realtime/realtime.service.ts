import { publishRealtimeEvent, type PublishRealtimeOptions } from "../../sockets/sockeServer";
import {
  REALTIME_EVENTS,
  type AppNotificationCreatedPayload,
  type AuditNewPayload,
  type ChatConversationReadPayload,
  type ChatConversationUpsertPayload,
  type ChatMessageCreatedPayload,
  type EntityChangedPayload,
  type LockUpdatedPayload,
} from "./realtime-outbox.service";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleForRealtimeEntity,
  moduleRealtimeSubscription,
  normalizeRealtimeModuleKey,
  type RealtimeSubscription,
} from "./realtime-room-policy";

export * from "./realtime-outbox.service";

function dispatch(
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[],
  options: PublishRealtimeOptions = {}
): Promise<void> {
  const publication = publishRealtimeEvent(event, payload, targets, options).then(() => undefined);
  void publication.catch((error: unknown) => {
    console.error(JSON.stringify({
      type: "realtime_producer_publish_failed",
      event,
      error: error instanceof Error ? error.name : "unknown",
    }));
  });
  return publication;
}

export function emitEntityChanged(payload: EntityChangedPayload): Promise<void> {
  const moduleSubscription = moduleRealtimeSubscription(payload.module);
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  const entityModule = moduleForRealtimeEntity(payload.entityType);
  if (!moduleSubscription || !entitySubscription || entityModule !== moduleSubscription.moduleKey) {
    return dispatch(REALTIME_EVENTS.ENTITY_CHANGED, payload, []);
  }
  return dispatch(REALTIME_EVENTS.ENTITY_CHANGED, {
    ...payload,
    module: moduleSubscription.moduleKey,
    entityType: entitySubscription.entityType,
  }, [moduleSubscription, entitySubscription]);
}

export function emitAuditNew(payload: AuditNewPayload): Promise<void> {
  return dispatch(REALTIME_EVENTS.AUDIT_NEW, payload, [
    { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
  ], { deduplicationKey: `audit:new:${payload.auditId}` });
}

export function emitLockUpdated(payload: LockUpdatedPayload): Promise<void> {
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  return dispatch(REALTIME_EVENTS.LOCK_UPDATED, payload, entitySubscription ? [entitySubscription] : []);
}

export function emitAppNotificationCreated(userId: number, payload: AppNotificationCreatedPayload): Promise<void> {
  return dispatch(REALTIME_EVENTS.APP_NOTIFICATION_CREATED, payload, [{ scope: "user", userId }]);
}

export function emitChatMessageCreated(userId: number, payload: ChatMessageCreatedPayload): Promise<void> {
  return dispatch(REALTIME_EVENTS.CHAT_MESSAGE_CREATED, payload, [{ scope: "user", userId }]);
}

export function emitChatConversationRead(userId: number, payload: ChatConversationReadPayload): Promise<void> {
  return dispatch(REALTIME_EVENTS.CHAT_CONVERSATION_READ, payload, [{ scope: "user", userId }]);
}

export function emitChatConversationUpsert(userId: number, payload: ChatConversationUpsertPayload): Promise<void> {
  return dispatch(REALTIME_EVENTS.CHAT_CONVERSATION_UPSERT, payload, [{ scope: "user", userId }]);
}

/** Compatibility bridge. Production repositories use the outbox-only module. */
export function emitModuleRealtimeEvent(moduleKey: string, event: string, payload?: unknown): Promise<void> {
  const canonical = normalizeRealtimeModuleKey(moduleKey);
  const subscription = canonical ? moduleRealtimeSubscription(canonical) : null;
  return dispatch(event, payload, subscription ? [subscription] : []);
}
