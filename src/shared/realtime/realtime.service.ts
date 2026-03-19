import type { Server as SocketIOServer } from "socket.io";

import { getIO } from "../../sockets/sockeServer";

export const REALTIME_EVENTS = {
  ENTITY_CHANGED: "entity:changed",
  AUDIT_NEW: "audit:new",
  LOCK_UPDATED: "lock:updated",
  APP_NOTIFICATION_CREATED: "app-notification:created",
  CHAT_MESSAGE_CREATED: "chat:message:created",
  CHAT_CONVERSATION_READ: "chat:conversation:read",
} as const;

export const REALTIME_ROOMS = {
  GLOBAL: "erp:global",
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
  by: RealtimeUserRef;
  invalidateKeys: string[];
};

export type AuditNewPayload = {
  auditId: string;
};

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

export type ChatConversationReadPayload = {
  conversation_id: string;
  read_at: string;
};

function tryGetIO(): SocketIOServer | null {
  try {
    return getIO();
  } catch {
    // Tests often mount Express without Socket.IO.
    return null;
  }
}

function entityRoom(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function moduleRoom(moduleKey: string): string {
  return `module:${moduleKey}`;
}

function userRoom(userId: number): string {
  return `USER:${userId}`;
}

export function emitEntityChanged(payload: EntityChangedPayload): void {
  const io = tryGetIO();
  if (!io) return;

  io.to(REALTIME_ROOMS.GLOBAL).emit(REALTIME_EVENTS.ENTITY_CHANGED, payload);
  io.to(entityRoom(payload.entityType, payload.entityId)).emit(REALTIME_EVENTS.ENTITY_CHANGED, payload);
  io.to(moduleRoom(payload.module)).emit(REALTIME_EVENTS.ENTITY_CHANGED, payload);
}

export function emitAuditNew(payload: AuditNewPayload): void {
  const io = tryGetIO();
  if (!io) return;
  io.to(REALTIME_ROOMS.GLOBAL).emit(REALTIME_EVENTS.AUDIT_NEW, payload);
}

export function emitLockUpdated(payload: LockUpdatedPayload): void {
  const io = tryGetIO();
  if (!io) return;
  io.to(REALTIME_ROOMS.GLOBAL).emit(REALTIME_EVENTS.LOCK_UPDATED, payload);
  io.to(entityRoom(payload.entityType, payload.entityId)).emit(REALTIME_EVENTS.LOCK_UPDATED, payload);
}

export function emitAppNotificationCreated(userId: number, payload: AppNotificationCreatedPayload): void {
  const io = tryGetIO();
  if (!io) return;
  io.to(userRoom(userId)).emit(REALTIME_EVENTS.APP_NOTIFICATION_CREATED, payload);
}

export function emitChatMessageCreated(userId: number, payload: ChatMessageCreatedPayload): void {
  const io = tryGetIO();
  if (!io) return;
  io.to(userRoom(userId)).emit(REALTIME_EVENTS.CHAT_MESSAGE_CREATED, payload);
}

export function emitChatConversationRead(userId: number, payload: ChatConversationReadPayload): void {
  const io = tryGetIO();
  if (!io) return;
  io.to(userRoom(userId)).emit(REALTIME_EVENTS.CHAT_CONVERSATION_READ, payload);
}
