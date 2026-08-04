import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { repoRoot } from "./helpers/repo-paths";

const patch = readFileSync(resolve(repoRoot, "db/patches/20260804_auth_rate_limit_buckets.sql"), "utf8");
const preflight = readFileSync(
  resolve(repoRoot, "db/patches/support/20260804_auth_rate_limit_buckets.preflight.sql"),
  "utf8"
);
const verify = readFileSync(
  resolve(repoRoot, "db/patches/support/20260804_auth_rate_limit_buckets.verify.sql"),
  "utf8"
);
const rollback = readFileSync(
  resolve(repoRoot, "db/patches/support/20260804_auth_rate_limit_buckets.rollback.sql"),
  "utf8"
);
const repository = readFileSync(
  resolve(repoRoot, "src/module/auth/repository/auth-rate-limit.repository.ts"),
  "utf8"
);

describe("SEC-CERP-0005 migration guards", () => {
  it("stores only bounded HMAC pseudonyms with expiry", () => {
    expect(patch).toContain("subject_hash character(64)");
    expect(patch).toContain("subject_hash ~ '^[0-9a-f]{64}$'");
    expect(patch).toContain("PRIMARY KEY (scope, subject_hash)");
    expect(patch).toContain("auth_rate_limit_buckets_expires_at_idx");
    expect(patch).not.toMatch(/\b(email|username|ip_address|raw_ip|token)\s+(?:text|varchar|inet)/i);
  });

  it("uses an atomic upsert and the PostgreSQL clock", () => {
    expect(repository).toContain("ON CONFLICT (scope, subject_hash) DO UPDATE");
    expect(repository).toContain("auth_rate_limit_buckets.request_count + 1");
    expect(repository).toContain("statement_timestamp()");
    expect(repository).toContain("retry_after_seconds");
  });

  it("keeps verification read-only and destructive rollback test-only", () => {
    const mutatingSql = /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i;
    expect(preflight).not.toMatch(mutatingSql);
    expect(verify).not.toMatch(mutatingSql);
    expect(rollback).toContain("current_database() <> 'cerp_test'");
    expect(rollback).toContain("DROP TABLE IF EXISTS public.auth_rate_limit_buckets");
  });
});
