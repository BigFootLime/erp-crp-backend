/**
 * A retired legacy account keeps its database identity for operational and
 * audit history.  Only this exact versioned marker is a retirement decision:
 * unrelated profile metadata must never hide an account.
 */
export function retiredAccountPredicate(tableAlias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableAlias)) {
    throw new Error("Invalid account retirement table alias");
  }
  // JSONB comparison deliberately distinguishes the number 1 from the string
  // "1". A missing marker is visible (`NULL IS DISTINCT FROM 1`).
  return `(to_jsonb(${tableAlias}) -> 'directory_profile_metadata' -> 'cerp_account_retirement' -> 'schema_version') IS DISTINCT FROM '1'::jsonb`;
}

export function isRetiredAccountMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = (value as Record<string, unknown>).cerp_account_retirement;
  return Boolean(
    marker
    && typeof marker === "object"
    && !Array.isArray(marker)
    && (marker as Record<string, unknown>).schema_version === 1,
  );
}
