import type { RequestHandler } from "express";
import { HttpError } from "../../../utils/httpError";
import { emitLockUpdated } from "../../../shared/realtime/realtime.service";
import { svcAcquireLock, svcHeartbeatLock, svcReleaseLock } from "../services/locks.service";
import { acquireLockBodySchema, lockEntityBodySchema } from "../validators/locks.validators";

function requireUserId(req: Express.Request): number {
  const userId = typeof req.user?.id === "number" ? req.user.id : null;
  if (!userId) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  return userId;
}

function lockedResponse(lock: { lockedBy: { id: number; name: string }; lockedAt: string; expiresAt: string }) {
  return {
    code: "ENTITY_LOCKED",
    message: `En cours d'édition par ${lock.lockedBy.name}`,
    lock: {
      lockedBy: lock.lockedBy,
      lockedAt: lock.lockedAt,
      expiresAt: lock.expiresAt,
    },
  };
}

export const acquireLock: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const body = acquireLockBodySchema.parse(req.body);

    const r = await svcAcquireLock({
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      user_id: userId,
      reason: body.reason ?? null,
    });

    if (!r.ok) {
      res.status(409).json(lockedResponse(r.lock));
      return;
    }

    emitLockUpdated({ entityType: r.lock.entityType, entityId: r.lock.entityId, locked: true, lock: r.lock });
    res.status(200).json({ lock: r.lock });
  } catch (e) {
    next(e);
  }
};

export const heartbeatLock: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const body = lockEntityBodySchema.parse(req.body);

    const r = await svcHeartbeatLock({
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      user_id: userId,
    });

    if (!r.ok) {
      res.status(409).json(lockedResponse(r.lock));
      return;
    }

    emitLockUpdated({ entityType: r.lock.entityType, entityId: r.lock.entityId, locked: true, lock: r.lock });
    res.status(200).json({ lock: r.lock });
  } catch (e) {
    next(e);
  }
};

export const releaseLock: RequestHandler = async (req, res, next) => {
  try {
    const userId = requireUserId(req);
    const body = lockEntityBodySchema.parse(req.body);

    const r = await svcReleaseLock({
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      user_id: userId,
    });

    if (!r.ok) {
      res.status(409).json(lockedResponse(r.lock));
      return;
    }

    emitLockUpdated({ entityType: body.entity_type, entityId: body.entity_id, locked: false, lock: null });
    res.status(200).json({ lock: null });
  } catch (e) {
    next(e);
  }
};
