export function canValidateTechnicalDossier(user?: { role?: string; primary_role?: string; roles?: string[] }): boolean {
  // Authentication and OF access are enforced by the route. Completion is a
  // dossier check available to every reader, without a department-specific visa.
  return Boolean(user);
}
