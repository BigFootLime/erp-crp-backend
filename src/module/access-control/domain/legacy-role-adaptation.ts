/**
 * Compatibility bridge for routes that still describe a broad historical role
 * gate. Capability middleware remains authoritative where it is already used.
 */
export function hasLegacyRoleFragment(
  role: string | null | undefined,
  fragments: readonly string[]
): boolean {
  if (!role) return false;
  const normalizedRole = role.trim().toLowerCase();
  return fragments.some((fragment) => normalizedRole.includes(fragment));
}
