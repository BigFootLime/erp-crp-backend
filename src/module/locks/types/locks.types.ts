export type UserRef = {
  id: number;
  name: string;
};

export type EntityLock = {
  id: string;
  entityType: string;
  entityId: string;
  lockedBy: UserRef;
  lockedAt: string;
  expiresAt: string;
};

export type LockUpdatedPayload = {
  entityType: string;
  entityId: string;
  locked: boolean;
  lock: EntityLock | null;
};
