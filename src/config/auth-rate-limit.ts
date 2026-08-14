export type AuthRateLimitEndpoint =
  | "login"
  | "register"
  | "forgotPassword"
  | "resetPassword"
  | "einvoiceWebhook";

export type AuthRateLimitDimension = "ip" | "username" | "email" | "token";
export type AuthRateLimitFailurePolicy = "closed-error" | "closed-generic";

export type AuthRateLimitDimensionConfig = {
  limit: number;
  windowMs: number;
};

export type AuthRateLimitEndpointConfig = {
  failurePolicy: AuthRateLimitFailurePolicy;
  dimensions: Partial<Record<AuthRateLimitDimension, AuthRateLimitDimensionConfig>>;
};

export type AuthRateLimitConfig = {
  enabled: boolean;
  store: "postgres";
  hashKey: string;
  storeUnavailableRetryAfterSeconds: number;
  cleanupIntervalMs: number;
  retentionAfterExpiryMs: number;
  endpoints: Record<AuthRateLimitEndpoint, AuthRateLimitEndpointConfig>;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const NON_PRODUCTION_HASH_KEY = "cerp-non-production-rate-limit-key-v1";

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean`);
}

function readBoundedInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

function readHashKey(env: NodeJS.ProcessEnv, enabled: boolean): string {
  if (!enabled) return "disabled";

  const configured = env.AUTH_RATE_LIMIT_HASH_KEY?.trim();
  if (configured && configured.length >= 32) return configured;

  if (env.NODE_ENV === "test") {
    return NON_PRODUCTION_HASH_KEY;
  }

  throw new Error(
    "AUTH_RATE_LIMIT_HASH_KEY must contain at least 32 characters when rate limiting is enabled outside tests"
  );
}

function endpointConfig(
  failurePolicy: AuthRateLimitFailurePolicy,
  dimensions: AuthRateLimitEndpointConfig["dimensions"]
): AuthRateLimitEndpointConfig {
  return { failurePolicy, dimensions };
}

export function loadAuthRateLimitConfig(env: NodeJS.ProcessEnv = process.env): AuthRateLimitConfig {
  const enabled = readBoolean(env, "AUTH_RATE_LIMIT_ENABLED", true);
  const store = (env.AUTH_RATE_LIMIT_STORE ?? "postgres").trim().toLowerCase();
  if (store !== "postgres") {
    throw new Error("AUTH_RATE_LIMIT_STORE must be postgres");
  }

  const loginWindowMs = readBoundedInteger(
    env,
    "AUTH_RATE_LIMIT_LOGIN_WINDOW_MS",
    15 * MINUTE_MS,
    MINUTE_MS,
    24 * HOUR_MS
  );
  const registerWindowMs = readBoundedInteger(
    env,
    "AUTH_RATE_LIMIT_REGISTER_WINDOW_MS",
    HOUR_MS,
    MINUTE_MS,
    24 * HOUR_MS
  );
  const forgotWindowMs = readBoundedInteger(
    env,
    "AUTH_RATE_LIMIT_FORGOT_WINDOW_MS",
    HOUR_MS,
    MINUTE_MS,
    24 * HOUR_MS
  );
  const resetWindowMs = readBoundedInteger(
    env,
    "AUTH_RATE_LIMIT_RESET_WINDOW_MS",
    15 * MINUTE_MS,
    MINUTE_MS,
    24 * HOUR_MS
  );
  const einvoiceWebhookWindowMs = readBoundedInteger(
    env,
    "EINVOICE_WEBHOOK_RATE_LIMIT_WINDOW_MS",
    MINUTE_MS,
    MINUTE_MS,
    24 * HOUR_MS
  );

  return {
    enabled,
    store: "postgres",
    hashKey: readHashKey(env, enabled),
    storeUnavailableRetryAfterSeconds: readBoundedInteger(
      env,
      "AUTH_RATE_LIMIT_STORE_RETRY_AFTER_SECONDS",
      30,
      1,
      300
    ),
    cleanupIntervalMs: readBoundedInteger(
      env,
      "AUTH_RATE_LIMIT_CLEANUP_INTERVAL_MS",
      15 * MINUTE_MS,
      MINUTE_MS,
      24 * HOUR_MS
    ),
    retentionAfterExpiryMs: readBoundedInteger(
      env,
      "AUTH_RATE_LIMIT_RETENTION_AFTER_EXPIRY_MS",
      HOUR_MS,
      0,
      7 * 24 * HOUR_MS
    ),
    endpoints: {
      login: endpointConfig("closed-error", {
        ip: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_LOGIN_IP_LIMIT", 50, 1, 10_000),
          windowMs: loginWindowMs,
        },
        username: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_LOGIN_IDENTIFIER_LIMIT", 10, 1, 10_000),
          windowMs: loginWindowMs,
        },
      }),
      register: endpointConfig("closed-error", {
        ip: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_REGISTER_IP_LIMIT", 10, 1, 10_000),
          windowMs: registerWindowMs,
        },
        username: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_REGISTER_IDENTIFIER_LIMIT", 3, 1, 10_000),
          windowMs: registerWindowMs,
        },
        email: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_REGISTER_IDENTIFIER_LIMIT", 3, 1, 10_000),
          windowMs: registerWindowMs,
        },
      }),
      forgotPassword: endpointConfig("closed-generic", {
        ip: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_FORGOT_IP_LIMIT", 20, 1, 10_000),
          windowMs: forgotWindowMs,
        },
        username: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_FORGOT_IDENTIFIER_LIMIT", 5, 1, 10_000),
          windowMs: forgotWindowMs,
        },
        email: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_FORGOT_IDENTIFIER_LIMIT", 5, 1, 10_000),
          windowMs: forgotWindowMs,
        },
      }),
      resetPassword: endpointConfig("closed-error", {
        ip: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_RESET_IP_LIMIT", 30, 1, 10_000),
          windowMs: resetWindowMs,
        },
        token: {
          limit: readBoundedInteger(env, "AUTH_RATE_LIMIT_RESET_TOKEN_LIMIT", 10, 1, 10_000),
          windowMs: resetWindowMs,
        },
      }),
      einvoiceWebhook: endpointConfig("closed-error", {
        ip: {
          limit: readBoundedInteger(env, "EINVOICE_WEBHOOK_RATE_LIMIT_IP_LIMIT", 240, 1, 100_000),
          windowMs: einvoiceWebhookWindowMs,
        },
      }),
    },
  };
}

export const authRateLimitConfig = loadAuthRateLimitConfig();
