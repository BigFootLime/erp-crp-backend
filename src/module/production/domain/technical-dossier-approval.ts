export function canValidateTechnicalDossier(user?: { role?: string; primary_role?: string; roles?: string[] }): boolean {
  // Authentication and OF access are enforced by the route. Preparation does
  // not require a separate Quality visa; purchase and stock rights stay separate.
  return Boolean(user);
}
