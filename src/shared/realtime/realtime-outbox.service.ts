import {
  enqueueRealtimeEvent,
  type RealtimeDbQueryer,
} from "./realtime-control-plane";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleForRealtimeEntity,
  moduleRealtimeSubscription,
  normalizeRealtimeModuleKey,
  realtimeRoomName,
  type RealtimeSubscription,
} from "./realtime-room-policy";

// This module is deliberately outbox-only. It must never import sockeServer,
// access-control, or an application repository: repositories can safely use it
// from inside their business transaction without creating a runtime cycle.
export const REALTIME_EVENTS = {
  ENTITY_CHANGED: "entity:changed",
  AUDIT_NEW: "audit:new",
  LOCK_UPDATED: "lock:updated",
  APP_NOTIFICATION_CREATED: "app-notification:created",
  CHAT_MESSAGE_CREATED: "chat:message:created",
  CHAT_CONVERSATION_READ: "chat:conversation:read",
  CHAT_CONVERSATION_UPSERT: "chat:conversation:upsert",
} as const;

export type RealtimeUserRef = { id: number; name: string };

export type EntityChangedPayload = {
  entityType: string;
  entityId: string;
  action: "created" | "updated" | "deleted" | "status_changed";
  module: string;
  at: string;
  invalidateKeys: string[];
};

export type RealtimeDeliveryMetadata = {
  event_id: string;
  sequence: string;
  stream_id: string;
  occurred_at: string;
};

export type AuditNewPayload = { auditId: string };

export type LockRef = {
  id: string;
  entityType: string;
  entityId: string;
  lockedBy: RealtimeUserRef;
  lockedAt: string;
  expiresAt: string;
};

export type LockUpdatedPayload = {
  entityType: string;
  entityId: string;
  locked: boolean;
  lock: LockRef | null;
};

export type AppNotificationCreatedPayload = {
  id: string;
  user_id: number;
  kind: string;
  title: string;
  message: string;
  severity: "info" | "success" | "warning" | "error";
  action_url: string | null;
  action_label: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
};

export type ChatMessageCreatedPayload = {
  conversation_id: string;
  message: {
    id: string;
    conversation_id: string;
    sender_user_id: number;
    message_type: "text";
    content: string;
    created_at: string;
  };
  sender: {
    id: number;
    username: string;
    name: string | null;
    surname: string | null;
  };
};

export type ChatConversationReadPayload = { conversation_id: string; read_at: string };
export type ChatConversationUpsertPayload = {
  conversation_id: string;
  type: "direct" | "group";
  group_name: string | null;
};

export type TransactionalRealtimeOptions = {
  deduplicationKey: string;
  streamId?: string;
};

function streamFor(event: string, targets: readonly RealtimeSubscription[], requested?: string): string {
  if (requested) return requested;
  const entity = targets.find((target) => target.scope === "entity");
  if (entity?.scope === "entity") return `entity:${entity.entityType}:${entity.entityId}`;
  const first = targets[0];
  if (!first) throw new Error(`INVALID_REALTIME_TARGET:${event}`);
  return realtimeRoomName(first);
}

function enqueueDispatch(
  tx: RealtimeDbQueryer,
  event: string,
  payload: unknown,
  targets: readonly RealtimeSubscription[],
  options: TransactionalRealtimeOptions
): Promise<string> {
  if (targets.length === 0) throw new Error(`INVALID_REALTIME_TARGET:${event}`);
  return enqueueRealtimeEvent(tx, {
    event,
    payload,
    targets,
    streamId: streamFor(event, targets, options.streamId),
    deduplicationKey: options.deduplicationKey,
  });
}

export function enqueueEntityChanged(
  tx: RealtimeDbQueryer,
  payload: EntityChangedPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  const moduleSubscription = moduleRealtimeSubscription(payload.module);
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  const entityModule = moduleForRealtimeEntity(payload.entityType);
  if (!moduleSubscription || !entitySubscription || entityModule !== moduleSubscription.moduleKey) {
    throw new Error("INVALID_REALTIME_ENTITY_TARGET");
  }
  return enqueueDispatch(tx, REALTIME_EVENTS.ENTITY_CHANGED, {
    ...payload,
    module: moduleSubscription.moduleKey,
    entityType: entitySubscription.entityType,
  }, [moduleSubscription, entitySubscription], options);
}

export function enqueueAuditNew(tx: RealtimeDbQueryer, payload: AuditNewPayload): Promise<string> {
  return enqueueDispatch(tx, REALTIME_EVENTS.AUDIT_NEW, payload, [
    { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
  ], { deduplicationKey: `audit:new:${payload.auditId}` });
}

export function enqueueLockUpdated(
  tx: RealtimeDbQueryer,
  payload: LockUpdatedPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  if (!entitySubscription) throw new Error("INVALID_REALTIME_LOCK_TARGET");
  return enqueueDispatch(tx, REALTIME_EVENTS.LOCK_UPDATED, payload, [entitySubscription], options);
}

export function enqueueAppNotificationCreated(
  tx: RealtimeDbQueryer,
  userId: number,
  payload: AppNotificationCreatedPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  return enqueueDispatch(tx, REALTIME_EVENTS.APP_NOTIFICATION_CREATED, payload, [{ scope: "user", userId }], options);
}

export function enqueueChatMessageCreated(
  tx: RealtimeDbQueryer,
  userId: number,
  payload: ChatMessageCreatedPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  return enqueueDispatch(tx, REALTIME_EVENTS.CHAT_MESSAGE_CREATED, payload, [{ scope: "user", userId }], options);
}

export function enqueueChatConversationRead(
  tx: RealtimeDbQueryer,
  userId: number,
  payload: ChatConversationReadPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  return enqueueDispatch(tx, REALTIME_EVENTS.CHAT_CONVERSATION_READ, payload, [{ scope: "user", userId }], options);
}

export function enqueueChatConversationUpsert(
  tx: RealtimeDbQueryer,
  userId: number,
  payload: ChatConversationUpsertPayload,
  options: TransactionalRealtimeOptions
): Promise<string> {
  return enqueueDispatch(tx, REALTIME_EVENTS.CHAT_CONVERSATION_UPSERT, payload, [{ scope: "user", userId }], options);
}

export function enqueueModuleRealtimeEvent(
  tx: RealtimeDbQueryer,
  moduleKey: string,
  event: string,
  payload: unknown,
  options: TransactionalRealtimeOptions
): Promise<string> {
  const canonical = normalizeRealtimeModuleKey(moduleKey);
  const subscription = canonical ? moduleRealtimeSubscription(canonical) : null;
  if (!subscription) throw new Error("INVALID_REALTIME_MODULE_TARGET");
  return enqueueDispatch(tx, event, payload, [subscription], options);
}
