import { describe, expect, it } from "vitest";

import { loadAuthRateLimitConfig } from "../config/auth-rate-limit";
import { resolveTrustProxySetting } from "../config/trust-proxy";
import { canonicalizeRateLimitClientAddress } from "../utils/requestMeta";

describe("auth rate limit configuration and client addressing", () => {
  it("requires a dedicated pseudonymization key in production", () => {
    expect(() => loadAuthRateLimitConfig({ NODE_ENV: "production" })).toThrow(
      "AUTH_RATE_LIMIT_HASH_KEY"
    );
    expect(
      loadAuthRateLimitConfig({
        NODE_ENV: "production",
        AUTH_RATE_LIMIT_HASH_KEY: "production-placeholder-with-at-least-32-chars",
      }).store
    ).toBe("postgres");
  });

  it("fails safe when NODE_ENV is absent outside the explicit test harness", () => {
    expect(() => loadAuthRateLimitConfig({})).toThrow("AUTH_RATE_LIMIT_HASH_KEY");
    expect(loadAuthRateLimitConfig({ NODE_ENV: "test" }).hashKey).toHaveLength(37);
  });

  it("rejects unsupported stores and invalid proxy hop counts", () => {
    expect(() => loadAuthRateLimitConfig({ AUTH_RATE_LIMIT_STORE: "redis" })).toThrow(
      "AUTH_RATE_LIMIT_STORE must be postgres"
    );
    expect(() => resolveTrustProxySetting({ TRUST_PROXY_HOPS: "all" })).toThrow();
    expect(resolveTrustProxySetting({ TRUST_PROXY_HOPS: "0" })).toBe(false);
    expect(resolveTrustProxySetting({ TRUST_PROXY_HOPS: "1" })).toBe(1);
  });

  it.each([
    ["192.0.2.8", "ipv4:192.0.2.8"],
    ["::ffff:192.0.2.8", "ipv4:192.0.2.8"],
    ["2001:0DB8:abcd:12:0:0:0:1", "ipv6:2001:db8:abcd:12::/64"],
    ["2001:db8:abcd:12::99", "ipv6:2001:db8:abcd:12::/64"],
    ["fe80::1%12", "ipv6:fe80:0:0:0::/64"],
  ])("canonicalizes %s as %s", (input, expected) => {
    expect(canonicalizeRateLimitClientAddress(input)).toBe(expected);
  });

  it("keeps different IPv6 /64 networks separate and rejects invalid input", () => {
    expect(canonicalizeRateLimitClientAddress("2001:db8:1:1::1")).not.toBe(
      canonicalizeRateLimitClientAddress("2001:db8:1:2::1")
    );
    expect(canonicalizeRateLimitClientAddress("not-an-ip")).toBeNull();
  });
});
