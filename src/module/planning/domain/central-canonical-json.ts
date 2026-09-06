/** JSONB changes object key order. Compare semantic JSON, preserving array order. */
export function centralCanonicalJson(value: unknown): string {
  function normalize(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, normalize(entry)]));
    return v;
  }
  return JSON.stringify(normalize(value));
}
