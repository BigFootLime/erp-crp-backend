/**
 * Strip the query string (and fragment) from a URL before it reaches any log sink.
 * Business searches put PII in query params (?q=jane@doe.fr, ?siret=...) : logging
 * originalUrl verbatim would persist that PII in server logs (GDPR minimisation,
 * CA-SEC-04 family). Route params stay: they are internal ids, not free-text PII.
 * NODE_ENV is "development" in prod (see errorHandler.ts), so this must not be
 * gated on environment.
 */
export function stripQueryFromUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const qIndex = url.indexOf("?");
  const hIndex = url.indexOf("#");
  const end = url.length;
  const cut = Math.min(qIndex === -1 ? end : qIndex, hIndex === -1 ? end : hIndex);
  return url.slice(0, cut);
}
