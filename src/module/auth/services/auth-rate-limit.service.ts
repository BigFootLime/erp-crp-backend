import crypto from "node:crypto";

import {
  authRateLimitConfig,
  type AuthRateLimitConfig,
  type AuthRateLimitEndpoint,
} from "../../../config/auth-rate-limit";
import type {
  AuthRateLimitDecision,
  AuthRateLimitStore,
  AuthRateLimitStoreInput,
  AuthRateLimitSubject,
} from "../domain/auth-rate-limit";
import { authRateLimitStore } from "../repository/auth-rate-limit.repository";
import {
  canonicalizeAuthEmail,
  canonicalizeAuthUsername,
  preserveOpaqueAuthToken,
} from "../domain/auth-identity";

function canonicalizeSubject(subject: AuthRateLimitSubject): string {
  if (subject.value === null) return "";
  switch (subject.dimension) {
    case "username":
      return canonicalizeAuthUsername(subject.value);
    case "email":
      return canonicalizeAuthEmail(subject.value);
    case "token":
      return preserveOpaqueAuthToken(subject.value);
    case "ip":
      return subject.value;
  }
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z0-9_.-]{1,80}$/.test(error.name) ? error.name : "Error";
}

function scopeEndpoint(endpoint: AuthRateLimitEndpoint): string {
  return endpoint.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export class AuthRateLimiter {
  constructor(
    private readonly store: AuthRateLimitStore,
    private readonly config: AuthRateLimitConfig
  ) {}

  async check(
    endpoint: AuthRateLimitEndpoint,
    subjects: readonly AuthRateLimitSubject[]
  ): Promise<AuthRateLimitDecision> {
    if (!this.config.enabled) return { status: "allowed", endpoint, disabled: true };

    const endpointConfig = this.config.endpoints[endpoint];
    const inputs: AuthRateLimitStoreInput[] = [];
    const limits: number[] = [];

    for (const subject of subjects) {
      const value = canonicalizeSubject(subject);
      const dimensionConfig = endpointConfig.dimensions[subject.dimension];
      if (!value || !dimensionConfig) continue;

      const scope = `auth:${scopeEndpoint(endpoint)}:${subject.dimension}`;
      const subjectHash = crypto
        .createHmac("sha256", this.config.hashKey)
        .update(`v1\0${scope}\0${value}`, "utf8")
        .digest("hex");

      if (!inputs.some((input) => input.scope === scope && input.subjectHash === subjectHash)) {
        inputs.push({ scope, subjectHash, windowMs: dimensionConfig.windowMs });
        limits.push(dimensionConfig.limit);
      }
    }

    if (inputs.length === 0) return { status: "allowed", endpoint, disabled: false };

    try {
      const counters = await this.store.consume(inputs);
      const completeResult = inputs.every((input) =>
        counters.some(
          (counter) => counter.scope === input.scope && counter.subjectHash === input.subjectHash
        )
      );
      if (!completeResult) throw new Error("AUTH_RATE_LIMIT_STORE_INCOMPLETE_RESULT");

      let retryAfterSeconds = 0;
      let blocked = false;

      for (const counter of counters) {
        const inputIndex = inputs.findIndex(
          (input) => input.scope === counter.scope && input.subjectHash === counter.subjectHash
        );
        const limit = inputIndex >= 0 ? limits[inputIndex] : undefined;
        if (counter && typeof limit === "number" && counter.count > limit) {
          blocked = true;
          retryAfterSeconds = Math.max(retryAfterSeconds, counter.retryAfterSeconds);
        }
      }

      return blocked
        ? { status: "blocked", endpoint, retryAfterSeconds: Math.max(1, retryAfterSeconds) }
        : { status: "allowed", endpoint, disabled: false };
    } catch (error) {
      return {
        status: "unavailable",
        endpoint,
        failurePolicy: endpointConfig.failurePolicy,
        retryAfterSeconds: this.config.storeUnavailableRetryAfterSeconds,
        errorName: safeErrorName(error),
      };
    }
  }
}

export const authRateLimiter = new AuthRateLimiter(authRateLimitStore, authRateLimitConfig);

export function startAuthRateLimitMaintenance(
  store: AuthRateLimitStore = authRateLimitStore,
  config: AuthRateLimitConfig = authRateLimitConfig
): () => void {
  if (!config.enabled) return () => undefined;

  const run = async () => {
    try {
      await store.deleteExpired(config.retentionAfterExpiryMs);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "auth_rate_limit_cleanup_failed",
          store: config.store,
          error: safeErrorName(error),
        })
      );
    }
  };

  const timer = setInterval(() => void run(), config.cleanupIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
