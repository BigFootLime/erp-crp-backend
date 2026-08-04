import { emitToAuthorizedSubscribers } from "../../sockets/sockeServer";
import {
  REALTIME_CAPABILITIES,
  entityRealtimeSubscription,
  moduleForRealtimeEntity,
  moduleRealtimeSubscription,
  normalizeRealtimeModuleKey,
  type RealtimeSubscription,
} from "./realtime-room-policy";

export const REALTIME_EVENTS = {
  ENTITY_CHANGED: "entity:changed",
  AUDIT_NEW: "audit:new",
  LOCK_UPDATED: "lock:updated",
  APP_NOTIFICATION_CREATED: "app-notification:created",
  CHAT_MESSAGE_CREATED: "chat:message:created",
  CHAT_CONVERSATION_READ: "chat:conversation:read",
  CHAT_CONVERSATION_UPSERT: "chat:conversation:upsert",
} as const;

export type RealtimeUserRef = {
  id: number;
  name: string;
};

export type EntityChangedPayload = {
  entityType: string;
  entityId: string;
  action: "created" | "updated" | "deleted" | "status_changed";
  module: string;
  at: string;
  invalidateKeys: string[];
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
    email: string | null;
    role: string | null;
    status: string | null;
  };
};

export type ChatConversationReadPayload = { conversation_id: string; read_at: string };
export type ChatConversationUpsertPayload = {
  conversation_id: string;
  type: "direct" | "group";
  group_name: string | null;
};

function dispatch(event: string, payload: unknown, targets: readonly RealtimeSubscription[]): void {
  void emitToAuthorizedSubscribers(event, payload, targets).catch((error: unknown) => {
    console.error(JSON.stringify({
      type: "realtime_emission_failed",
      event,
      error: error instanceof Error ? error.name : "unknown",
    }));
  });
}

export function emitEntityChanged(payload: EntityChangedPayload): void {
  const moduleSubscription = moduleRealtimeSubscription(payload.module);
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  const entityModule = moduleForRealtimeEntity(payload.entityType);
  if (!moduleSubscription || !entitySubscription || entityModule !== moduleSubscription.moduleKey) {
    dispatch(REALTIME_EVENTS.ENTITY_CHANGED, payload, []);
    return;
  }
  dispatch(REALTIME_EVENTS.ENTITY_CHANGED, {
    ...payload,
    module: moduleSubscription.moduleKey,
    entityType: entitySubscription.entityType,
  }, [moduleSubscription, entitySubscription]);
}

export function emitAuditNew(payload: AuditNewPayload): void {
  dispatch(REALTIME_EVENTS.AUDIT_NEW, payload, [
    { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ },
  ]);
}

export function emitLockUpdated(payload: LockUpdatedPayload): void {
  const entitySubscription = entityRealtimeSubscription(payload.entityType, payload.entityId);
  dispatch(REALTIME_EVENTS.LOCK_UPDATED, payload, entitySubscription ? [entitySubscription] : []);
}

export function emitAppNotificationCreated(userId: number, payload: AppNotificationCreatedPayload): void {
  dispatch(REALTIME_EVENTS.APP_NOTIFICATION_CREATED, payload, [{ scope: "user", userId }]);
}

export function emitChatMessageCreated(userId: number, payload: ChatMessageCreatedPayload): void {
  dispatch(REALTIME_EVENTS.CHAT_MESSAGE_CREATED, payload, [{ scope: "user", userId }]);
}

export function emitChatConversationRead(userId: number, payload: ChatConversationReadPayload): void {
  dispatch(REALTIME_EVENTS.CHAT_CONVERSATION_READ, payload, [{ scope: "user", userId }]);
}

export function emitChatConversationUpsert(userId: number, payload: ChatConversationUpsertPayload): void {
  dispatch(REALTIME_EVENTS.CHAT_CONVERSATION_UPSERT, payload, [{ scope: "user", userId }]);
}

/** Compatibility bridge for legacy event names, now constrained to one module. */
export function emitModuleRealtimeEvent(moduleKey: string, event: string, payload?: unknown): void {
  const canonical = normalizeRealtimeModuleKey(moduleKey);
  const subscription = canonical ? moduleRealtimeSubscription(canonical) : null;
  dispatch(event, payload, subscription ? [subscription] : []);
}
