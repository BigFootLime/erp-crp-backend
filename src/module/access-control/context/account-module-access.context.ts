import { AsyncLocalStorage } from "node:async_hooks";

export type AccountModuleAccessContext = {
  userId: number | null;
  moduleKey: string | null;
  granted: boolean;
};

const accountModuleAccessStorage = new AsyncLocalStorage<AccountModuleAccessContext>();

/**
 * Installe le contexte dès l'entrée dans le routeur v1. La décision est
 * complétée ensuite par le gate. Ce cycle de vie englobe toute la chaîne
 * Express, y compris les routeurs imbriqués et leurs middlewares asynchrones.
 */
export function runWithAccountModuleAccessScope(callback: () => void): void {
  accountModuleAccessStorage.enterWith({
    userId: null,
    moduleKey: null,
    granted: false,
  });
  callback();
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
  context: Pick<AccountModuleAccessContext, "userId" | "moduleKey">,
  callback: () => void
): void {
  const existing = accountModuleAccessStorage.getStore();
  if (existing) {
    existing.userId = context.userId;
    existing.moduleKey = context.moduleKey;
    existing.granted = true;
    callback();
    return;
  }
  accountModuleAccessStorage.enterWith({ ...context, granted: true });
  callback();
}

export function hasGrantedAccountModuleAccess(): boolean {
  return accountModuleAccessStorage.getStore()?.granted === true;
}

export function getAccountModuleAccessContext(): AccountModuleAccessContext | undefined {
  return accountModuleAccessStorage.getStore();
}
