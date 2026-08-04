import type {
  AuthRateLimitDimension,
  AuthRateLimitEndpoint,
  AuthRateLimitFailurePolicy,
} from "../../../config/auth-rate-limit";

export type AuthRateLimitSubject = {
  dimension: AuthRateLimitDimension;
  value: string | null;
};

export type AuthRateLimitStoreInput = {
  scope: string;
  subjectHash: string;
  windowMs: number;
};

export type AuthRateLimitStoreCounter = {
  scope: string;
  subjectHash: string;
  count: number;
  retryAfterSeconds: number;
};

export interface AuthRateLimitStore {
  consume(inputs: readonly AuthRateLimitStoreInput[]): Promise<AuthRateLimitStoreCounter[]>;
  deleteExpired(retentionAfterExpiryMs: number): Promise<number>;
}

export type AuthRateLimitDecision =
  | { status: "allowed"; endpoint: AuthRateLimitEndpoint; disabled: boolean }
  | { status: "blocked"; endpoint: AuthRateLimitEndpoint; retryAfterSeconds: number }
  | {
      status: "unavailable";
      endpoint: AuthRateLimitEndpoint;
      failurePolicy: AuthRateLimitFailurePolicy;
      retryAfterSeconds: number;
      errorName: string;
    };
