/** Browser origin policy shared by the HTTP app and focused security tests. */
export function isCorsOriginAllowed(origin: string, allowedOrigins: ReadonlySet<string>, demoMode: boolean): boolean {
  return allowedOrigins.has(origin) || (!demoMode && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin));
}
