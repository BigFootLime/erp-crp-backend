export type AuthIdentityType = "username" | "email";

/**
 * Usernames are stored and queried as uppercase ASCII after validation. NFKC
 * must run first so compatibility characters (for example ligatures) and
 * Unicode case variants resolve to the same stored account identity.
 */
export function canonicalizeAuthUsername(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

/** Email writes and lookups use the same NFKC, trim and lowercase contract. */
export function canonicalizeAuthEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * Reset tokens are opaque secrets. Do not trim, case-fold, normalize or
 * otherwise rewrite them before hashing, lookup or abuse-control bucketing.
 */
export function preserveOpaqueAuthToken(value: string): string {
  return value;
}

export function canonicalAuthIdentifierCandidates(value: string): ReadonlyArray<{
  type: AuthIdentityType;
  value: string;
}> {
  return [
    { type: "username", value: canonicalizeAuthUsername(value) },
    { type: "email", value: canonicalizeAuthEmail(value) },
  ];
}
