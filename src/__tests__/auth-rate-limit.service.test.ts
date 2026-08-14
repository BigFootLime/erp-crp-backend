import { describe, expect, it } from "vitest";

import type { AuthRateLimitConfig } from "../config/auth-rate-limit";
import type {
  AuthRateLimitStore,
  AuthRateLimitStoreCounter,
  AuthRateLimitStoreInput,
} from "../module/auth/domain/auth-rate-limit";
import { AuthRateLimiter } from "../module/auth/services/auth-rate-limit.service";

type SharedCounter = { count: number; expiresAt: number };

class SharedDeterministicStore implements AuthRateLimitStore {
  readonly state: Map<string, SharedCounter>;
  lastInputs: readonly AuthRateLimitStoreInput[] = [];
  fail = false;

  constructor(
    private readonly now: () => number,
    state: Map<string, SharedCounter> = new Map()
  ) {
    this.state = state;
  }

  async consume(inputs: readonly AuthRateLimitStoreInput[]): Promise<AuthRateLimitStoreCounter[]> {
    if (this.fail) throw new Error("simulated-store-outage");
    this.lastInputs = inputs;

    return inputs.map((input) => {
      const key = `${input.scope}:${input.subjectHash}`;
      const existing = this.state.get(key);
      const current = !existing || existing.expiresAt <= this.now()
        ? { count: 1, expiresAt: this.now() + input.windowMs }
        : { count: existing.count + 1, expiresAt: existing.expiresAt };
      this.state.set(key, current);
      return {
        scope: input.scope,
        subjectHash: input.subjectHash,
        count: current.count,
        retryAfterSeconds: Math.max(1, Math.ceil((current.expiresAt - this.now()) / 1000)),
      };
    });
  }

  async deleteExpired(retentionAfterExpiryMs: number): Promise<number> {
    const before = this.now() - retentionAfterExpiryMs;
    let deleted = 0;
    for (const [key, value] of this.state) {
      if (value.expiresAt < before) {
        this.state.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function testConfig(overrides: Partial<AuthRateLimitConfig> = {}): AuthRateLimitConfig {
  const windowMs = 60_000;
  return {
    enabled: true,
    store: "postgres",
    hashKey: "deterministic-test-key-with-at-least-32-characters",
    storeUnavailableRetryAfterSeconds: 17,
    cleanupIntervalMs: 60_000,
    retentionAfterExpiryMs: 0,
    endpoints: {
      login: {
        failurePolicy: "closed-error",
        dimensions: { username: { limit: 2, windowMs }, ip: { limit: 50, windowMs } },
      },
      register: {
        failurePolicy: "closed-error",
        dimensions: {
          username: { limit: 2, windowMs },
          email: { limit: 2, windowMs },
          ip: { limit: 2, windowMs },
        },
      },
      forgotPassword: {
        failurePolicy: "closed-generic",
        dimensions: {
          username: { limit: 2, windowMs },
          email: { limit: 2, windowMs },
          ip: { limit: 2, windowMs },
        },
      },
      resetPassword: {
        failurePolicy: "closed-error",
        dimensions: { token: { limit: 2, windowMs }, ip: { limit: 2, windowMs } },
      },
      einvoiceWebhook: {
        failurePolicy: "closed-error",
        dimensions: { ip: { limit: 240, windowMs } },
      },
    },
    ...overrides,
  };
}

describe("distributed auth rate limiter", () => {
  it("shares counters across instances and survives an application restart", async () => {
    let now = Date.parse("2026-08-04T10:00:00.000Z");
    const sharedState = new Map<string, SharedCounter>();
    const instanceAStore = new SharedDeterministicStore(() => now, sharedState);
    const instanceBStore = new SharedDeterministicStore(() => now, sharedState);
    const instanceA = new AuthRateLimiter(instanceAStore, testConfig());
    const instanceB = new AuthRateLimiter(instanceBStore, testConfig());
    const subject = [{ dimension: "username" as const, value: "operator" }];

    await expect(instanceA.check("login", subject)).resolves.toMatchObject({ status: "allowed" });
    await expect(instanceB.check("login", subject)).resolves.toMatchObject({ status: "allowed" });
    await expect(instanceA.check("login", subject)).resolves.toMatchObject({
      status: "blocked",
      retryAfterSeconds: 60,
    });

    const restartedInstance = new AuthRateLimiter(
      new SharedDeterministicStore(() => now, sharedState),
      testConfig()
    );
    await expect(restartedInstance.check("login", subject)).resolves.toMatchObject({ status: "blocked" });

    now += 60_001;
    await expect(restartedInstance.check("login", subject)).resolves.toMatchObject({ status: "allowed" });
  });

  it("sends only HMAC pseudonyms to the shared store", async () => {
    const store = new SharedDeterministicStore(() => 1_000);
    const limiter = new AuthRateLimiter(store, testConfig());

    await limiter.check("forgotPassword", [
      { dimension: "ip", value: "ipv4:198.51.100.42" },
      { dimension: "email", value: "Person@Example.Test" },
    ]);

    expect(store.lastInputs).toHaveLength(2);
    for (const input of store.lastInputs) {
      expect(input.scope).toMatch(/^[a-z][a-z0-9:_-]{2,63}$/);
      expect(input.subjectHash).toMatch(/^[0-9a-f]{64}$/);
      expect(input.subjectHash).not.toContain("198.51.100.42");
      expect(input.subjectHash).not.toContain("person@example.test");
    }
  });

  it("returns the endpoint-specific fail-closed policy on store outage", async () => {
    const store = new SharedDeterministicStore(() => 1_000);
    store.fail = true;
    const limiter = new AuthRateLimiter(store, testConfig());

    await expect(
      limiter.check("login", [{ dimension: "username", value: "operator" }])
    ).resolves.toMatchObject({
      status: "unavailable",
      failurePolicy: "closed-error",
      retryAfterSeconds: 17,
    });
    await expect(
      limiter.check("forgotPassword", [{ dimension: "username", value: "operator" }])
    ).resolves.toMatchObject({
      status: "unavailable",
      failurePolicy: "closed-generic",
      retryAfterSeconds: 17,
    });
  });

  it("supports the documented emergency disable switch without touching the store", async () => {
    const store = new SharedDeterministicStore(() => 1_000);
    store.fail = true;
    const limiter = new AuthRateLimiter(store, testConfig({ enabled: false, hashKey: "disabled" }));

    await expect(
      limiter.check("login", [{ dimension: "username", value: "operator" }])
    ).resolves.toEqual({ status: "allowed", endpoint: "login", disabled: true });
  });

  it.each([
    ["stra\u00dfe", "STRASSE"],
    ["u\u017fer", "USER"],
    ["adm\u0131n", "ADMIN"],
    ["o\ufb03ce", "OFFICE"],
  ])("shares the username bucket for Unicode variant %s and %s", async (variant, canonical) => {
    const store = new SharedDeterministicStore(() => 1_000);
    const limiter = new AuthRateLimiter(store, testConfig());

    await limiter.check("login", [{ dimension: "username", value: variant }]);
    const variantHash = store.lastInputs[0]?.subjectHash;
    await limiter.check("login", [{ dimension: "username", value: canonical }]);
    const canonicalHash = store.lastInputs[0]?.subjectHash;

    expect(variantHash).toMatch(/^[0-9a-f]{64}$/);
    expect(variantHash).toBe(canonicalHash);
  });

  it("shares the email bucket after NFKC, trim and lowercase", async () => {
    const store = new SharedDeterministicStore(() => 1_000);
    const limiter = new AuthRateLimiter(store, testConfig());

    await limiter.check("register", [{ dimension: "email", value: " O\ufb03CE@Example.Test " }]);
    const variantHash = store.lastInputs[0]?.subjectHash;
    await limiter.check("register", [{ dimension: "email", value: "office@example.test" }]);

    expect(store.lastInputs[0]?.subjectHash).toBe(variantHash);
  });

  it("keeps opaque reset-token case and whitespace in distinct buckets", async () => {
    const store = new SharedDeterministicStore(() => 1_000);
    const limiter = new AuthRateLimiter(store, testConfig());

    const hashFor = async (token: string) => {
      await limiter.check("resetPassword", [{ dimension: "token", value: token }]);
      return store.lastInputs[0]?.subjectHash;
    };

    const exact = await hashFor("AbC-opaque-token");
    expect(await hashFor("abc-opaque-token")).not.toBe(exact);
    expect(await hashFor(" AbC-opaque-token ")).not.toBe(exact);
  });
});
