export function resolveTrustProxySetting(env: NodeJS.ProcessEnv = process.env): false | number {
  const raw = env.TRUST_PROXY_HOPS?.trim();
  if (!raw) return 1;
  if (!/^\d+$/.test(raw)) throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");

  const hops = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 5) {
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 5");
  }
  return hops === 0 ? false : hops;
}
