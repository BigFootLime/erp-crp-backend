import type { QueryResult } from "pg";

import pool from "../../../config/database";
import type {
  AuthRateLimitStore,
  AuthRateLimitStoreCounter,
  AuthRateLimitStoreInput,
} from "../domain/auth-rate-limit";

type Queryable = {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<T>>;
};

type CounterRow = {
  scope: string;
  subject_hash: string;
  request_count: number | string;
  retry_after_seconds: number | string;
};

export class PostgresAuthRateLimitStore implements AuthRateLimitStore {
  constructor(private readonly queryable: Queryable = pool) {}

  async consume(inputs: readonly AuthRateLimitStoreInput[]): Promise<AuthRateLimitStoreCounter[]> {
    if (inputs.length === 0) return [];

    const values: unknown[] = [];
    const tuples = inputs.map((input) => {
      values.push(input.scope, input.subjectHash, input.windowMs);
      const offset = values.length - 2;
      return `($${offset}::text, $${offset + 1}::text, $${offset + 2}::bigint)`;
    });

    const result = await this.queryable.query<CounterRow>(
      `
        WITH input(scope, subject_hash, window_ms) AS (
          VALUES ${tuples.join(", ")}
        ), upserted AS (
          INSERT INTO public.auth_rate_limit_buckets (
            scope,
            subject_hash,
            request_count,
            window_started_at,
            expires_at,
            updated_at
          )
          SELECT
            input.scope,
            input.subject_hash,
            1,
            statement_timestamp(),
            statement_timestamp() + (input.window_ms * INTERVAL '1 millisecond'),
            statement_timestamp()
          FROM input
          ON CONFLICT (scope, subject_hash) DO UPDATE
          SET
            request_count = CASE
              WHEN public.auth_rate_limit_buckets.expires_at <= statement_timestamp() THEN 1
              ELSE public.auth_rate_limit_buckets.request_count + 1
            END,
            window_started_at = CASE
              WHEN public.auth_rate_limit_buckets.expires_at <= statement_timestamp()
                THEN EXCLUDED.window_started_at
              ELSE public.auth_rate_limit_buckets.window_started_at
            END,
            expires_at = CASE
              WHEN public.auth_rate_limit_buckets.expires_at <= statement_timestamp()
                THEN EXCLUDED.expires_at
              ELSE public.auth_rate_limit_buckets.expires_at
            END,
            updated_at = statement_timestamp()
          RETURNING scope, subject_hash, request_count, expires_at
        )
        SELECT
          scope,
          subject_hash,
          request_count,
          GREATEST(
            1,
            CEIL(EXTRACT(EPOCH FROM (expires_at - statement_timestamp())))::int
          ) AS retry_after_seconds
        FROM upserted
      `,
      values
    );

    if (result.rows.length !== inputs.length) {
      throw new Error("AUTH_RATE_LIMIT_STORE_INCOMPLETE_RESULT");
    }

    return result.rows.map((row) => ({
      scope: row.scope,
      subjectHash: row.subject_hash,
      count: Number(row.request_count),
      retryAfterSeconds: Number(row.retry_after_seconds),
    }));
  }

  async deleteExpired(retentionAfterExpiryMs: number): Promise<number> {
    const result = await this.queryable.query(
      `
        DELETE FROM public.auth_rate_limit_buckets
        WHERE expires_at < statement_timestamp() - ($1::bigint * INTERVAL '1 millisecond')
      `,
      [retentionAfterExpiryMs]
    );
    return result.rowCount ?? 0;
  }
}

export const authRateLimitStore = new PostgresAuthRateLimitStore();
