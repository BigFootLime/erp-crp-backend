import { describe, expect, it, vi } from "vitest";

import { PostgresAuthRateLimitStore } from "../module/auth/repository/auth-rate-limit.repository";

describe("PostgresAuthRateLimitStore", () => {
  it("increments every request subject in one atomic PostgreSQL statement", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          scope: "auth:login:ip",
          subject_hash: "a".repeat(64),
          request_count: 3,
          retry_after_seconds: 41,
        },
        {
          scope: "auth:login:username",
          subject_hash: "b".repeat(64),
          request_count: "11",
          retry_after_seconds: "42",
        },
      ],
      rowCount: 2,
    });
    const store = new PostgresAuthRateLimitStore({ query } as never);

    await expect(
      store.consume([
        { scope: "auth:login:ip", subjectHash: "a".repeat(64), windowMs: 900_000 },
        { scope: "auth:login:username", subjectHash: "b".repeat(64), windowMs: 900_000 },
      ])
    ).resolves.toEqual([
      { scope: "auth:login:ip", subjectHash: "a".repeat(64), count: 3, retryAfterSeconds: 41 },
      {
        scope: "auth:login:username",
        subjectHash: "b".repeat(64),
        count: 11,
        retryAfterSeconds: 42,
      },
    ]);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ON CONFLICT (scope, subject_hash) DO UPDATE");
    expect(sql).toContain("public.auth_rate_limit_buckets.request_count + 1");
    expect(sql).toContain("statement_timestamp()");
    expect(sql).toContain("retry_after_seconds");
    expect(values).toEqual([
      "auth:login:ip",
      "a".repeat(64),
      900_000,
      "auth:login:username",
      "b".repeat(64),
      900_000,
    ]);
  });

  it("removes expired pseudonymous buckets using an explicit cutoff", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 7 });
    const store = new PostgresAuthRateLimitStore({ query } as never);

    await expect(store.deleteExpired(3_600_000)).resolves.toBe(7);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM public.auth_rate_limit_buckets"),
      [3_600_000]
    );
    expect(query.mock.calls[0]?.[0]).toContain("statement_timestamp()");
  });
});
