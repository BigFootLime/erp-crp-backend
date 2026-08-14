import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

export type AccountModuleAccessContext = {
  userId: number | null;
  moduleKey: string | null;
  granted: boolean;
  /** Explicit override/superadmin/kill-switch, as opposed to ordinary default access. */
  elevated: boolean;
};

const accountModuleAccessStorage = new AsyncLocalStorage<AccountModuleAccessContext>();

declare global {
  namespace Express {
    interface Request {
      accountModuleAccess?: AccountModuleAccessContext;
    }
  }
}

/**
 * Installe le contexte dès l'entrée dans le routeur v1. La décision est
 * complétée ensuite par le gate. Ce cycle de vie englobe toute la chaîne
 * Express, y compris les routeurs imbriqués et leurs middlewares asynchrones.
 */
export function runWithAccountModuleAccessScope(callback: () => void): void {
  accountModuleAccessStorage.run(
    { userId: null, moduleKey: null, granted: false, elevated: false },
    callback
  );
}

/**
 * Runs the complete Express request chain with the account/module decision
 * resolved by the global gate.
 *
 * Legacy policies still receive a role string in deep service and repository
 * calls. This context lets them stop using the role as an authorization source
 * without mutating the authenticated identity or weakening the superadmin guard.
 */
export function runWithAccountModuleAccess(
  context: Pick<AccountModuleAccessContext, "userId" | "moduleKey"> &
    Partial<Pick<AccountModuleAccessContext, "elevated">>,
  callback: () => void
): void {
  const elevated = context.elevated ?? true;
  const existing = accountModuleAccessStorage.getStore();
  if (existing) {
    existing.userId = context.userId;
    existing.moduleKey = context.moduleKey;
    existing.granted = true;
    existing.elevated = elevated;
    callback();
    return;
  }
  accountModuleAccessStorage.run({ ...context, granted: true, elevated }, callback);
}

export function grantAccountModuleAccessToRequest(
  req: Request,
  context: Pick<AccountModuleAccessContext, "userId" | "moduleKey"> &
    Partial<Pick<AccountModuleAccessContext, "elevated">>,
  callback: () => void
): void {
  req.accountModuleAccess = { ...context, granted: true, elevated: context.elevated ?? true };
  runWithAccountModuleAccess(context, callback);
}

export function requestHasGrantedAccountModuleAccess(req: Request): boolean {
  return req.accountModuleAccess?.granted === true;
}

export function requestHasElevatedAccountModuleAccess(req: Request): boolean {
  return req.accountModuleAccess?.granted === true && req.accountModuleAccess.elevated === true;
}

export function hasGrantedAccountModuleAccess(): boolean {
  return accountModuleAccessStorage.getStore()?.granted === true;
}

export function getAccountModuleAccessContext(): AccountModuleAccessContext | undefined {
  return accountModuleAccessStorage.getStore();
}
