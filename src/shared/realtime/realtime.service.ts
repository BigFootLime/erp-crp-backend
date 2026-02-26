import type { Server as SocketIOServer } from "socket.io";

import { getIO } from "../../sockets/sockeServer";

export const REALTIME_EVENTS = {
  ENTITY_CHANGED: "entity:changed",
  AUDIT_NEW: "audit:new",
  LOCK_UPDATED: "lock:updated",
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
