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
        dimensions: { identifier: { limit: 2, windowMs }, ip: { limit: 50, windowMs } },
      },
      register: {
        failurePolicy: "closed-error",
        dimensions: { identifier: { limit: 2, windowMs }, ip: { limit: 2, windowMs } },
      },
      forgotPassword: {
        failurePolicy: "closed-generic",
        dimensions: { identifier: { limit: 2, windowMs }, ip: { limit: 2, windowMs } },
      },
      resetPassword: {
        failurePolicy: "closed-error",
        dimensions: { token: { limit: 2, windowMs }, ip: { limit: 2, windowMs } },
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
    const subject = [{ dimension: "identifier" as const, value: "operator@example.test" }];

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
      { dimension: "identifier", value: "Person@Example.Test" },
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
      limiter.check("login", [{ dimension: "identifier", value: "operator" }])
    ).resolves.toMatchObject({
      status: "unavailable",
      failurePolicy: "closed-error",
      retryAfterSeconds: 17,
    });
    await expect(
      limiter.check("forgotPassword", [{ dimension: "identifier", value: "operator" }])
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
      limiter.check("login", [{ dimension: "identifier", value: "operator" }])
    ).resolves.toEqual({ status: "allowed", endpoint: "login", disabled: true });
  });
});
