import { AsyncLocalStorage } from "node:async_hooks";

export type AccountModuleAccessContext = {
  userId: number;
  moduleKey: string;
};

const accountModuleAccessStorage = new AsyncLocalStorage<AccountModuleAccessContext>();

/**
 * Runs the complete Express request chain with the account/module decision
 * resolved by the global gate.
 *
 * Legacy policies still receive a role string in deep service and repository
 * calls. This context lets them stop using the role as an authorization source
 * without mutating the authenticated identity or weakening the superadmin guard.
 */
export function runWithAccountModuleAccess(
  context: AccountModuleAccessContext,
  callback: () => void
): void {
  accountModuleAccessStorage.run(context, callback);
}

export function hasGrantedAccountModuleAccess(): boolean {
  return accountModuleAccessStorage.getStore() !== undefined;
}

export function getAccountModuleAccessContext(): AccountModuleAccessContext | undefined {
  return accountModuleAccessStorage.getStore();
}
