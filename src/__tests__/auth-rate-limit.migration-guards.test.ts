import { createHash } from "node:crypto";
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
const runner = readFileSync(resolve(repoRoot, "scripts/db-patches.js"), "utf8");
const expectedPatchSha256 = createHash("sha256")
  .update(patch.replace(/\r\n?/g, "\n"), "utf8")
  .digest("hex");

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

  it("keeps verification read-only and destructive rollback non-production-only", () => {
    const mutatingSql = /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\b/i;
    expect(preflight).not.toMatch(mutatingSql);
    expect(verify).not.toMatch(mutatingSql);
    expect(rollback).toContain("current_database() NOT IN ('cerp_dev', 'cerp_test')");
    expect(rollback).toContain("DROP TABLE public.auth_rate_limit_buckets");
    expect(rollback).not.toContain("cerp_prod");
  });

  it("fails preflight for either target relation when the ledger entry is absent", () => {
    expect(preflight).toContain(
      "IF (target_table_exists OR target_index_exists) AND NOT registry_entry_exists THEN"
    );
    expect(preflight).toContain(
      "target table or index exists without its migration registry entry"
    );
  });

  it("verifies exact runtime column, check and expiry-index contracts", () => {
    expect(verify).toMatch(
      /column_name = 'request_count'[\s\S]*data_type = 'integer'[\s\S]*is_nullable = 'NO'[\s\S]*column_default IS NULL/
    );
    expect(verify).toContain("THEN 'CHECK ((request_count > 0))'");
    expect(verify).toContain("total_constraint_count <> 5");
    expect(verify).toContain("total_index_count <> 2");
    expect(verify).toContain("pg_get_indexdef(index_metadata.indexrelid, 1, TRUE) = 'expires_at'");
    expect(verify).toContain("index_metadata.indpred IS NULL");
    expect(verify).toContain("access_method.amname = 'btree'");
  });

  it("neutralizes creator default ACLs and establishes the cerp_app owner contract", () => {
    const ownerTransfer = patch.indexOf(
      "ALTER TABLE public.auth_rate_limit_buckets OWNER TO cerp_app"
    );
    const publicRevoke = patch.indexOf(
      "REVOKE ALL ON public.auth_rate_limit_buckets FROM PUBLIC",
      ownerTransfer
    );
    const unexpectedGranteeCleanup = patch.indexOf("FOR unexpected_grantee IN", publicRevoke);
    const ownerRevoke = patch.indexOf(
      "REVOKE ALL ON public.auth_rate_limit_buckets FROM cerp_app",
      unexpectedGranteeCleanup
    );
    const exactGrant = patch.indexOf(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_rate_limit_buckets TO cerp_app",
      ownerRevoke
    );

    expect(patch).toContain("required owner/runtime role cerp_app is missing");
    expect(ownerTransfer).toBeGreaterThan(-1);
    expect(publicRevoke).toBeGreaterThan(ownerTransfer);
    expect(unexpectedGranteeCleanup).toBeGreaterThan(publicRevoke);
    expect(patch).toContain("aclexplode(");
    expect(patch).toContain("FROM %I CASCADE");
    expect(ownerRevoke).toBeGreaterThan(unexpectedGranteeCleanup);
    expect(exactGrant).toBeGreaterThan(ownerRevoke);
  });

  it("refuses rogue ownership, PUBLIC, extra grantees and any non-contract ACL", () => {
    for (const contractSql of [verify, rollback]) {
      expect(contractSql).toContain(
        "table_owner_oid IS DISTINCT FROM to_regrole('cerp_app')"
      );
      expect(contractSql).toContain("total_acl_entries <> 4 OR expected_acl_entries <> 4");
      expect(contractSql).toContain("acl_entry.grantor = to_regrole('cerp_app')");
      expect(contractSql).toContain("acl_entry.grantee = to_regrole('cerp_app')");
      expect(contractSql).toContain("ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']");
      expect(contractSql).toContain("AND NOT acl_entry.is_grantable");
      expect(contractSql).toContain("attacl IS NOT NULL");
      expect(contractSql).toContain("effective table privileges are not exact DML");
      expect(contractSql).toContain(
        "NOT has_table_privilege('cerp_app', 'public.auth_rate_limit_buckets', 'TRUNCATE')"
      );
    }
  });

  it("uses the runner-owned deterministic migration registry contract", () => {
    expect(expectedPatchSha256).toBe(
      "f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2"
    );
    expect(patch).not.toContain("cerp_schema_migrations");
    expect(runner).toContain("canonicalizeSqlForHash");
    expect(runner).toContain("SET LOCAL standard_conforming_strings = on");
    expect(runner).toContain("INSERT INTO ${MIGRATION_TABLE} (filename, sha256, applied_at)");
    expect(preflight).toContain(expectedPatchSha256);
    expect(verify).toContain(expectedPatchSha256);
    expect(verify).toContain("SELECT sha256, applied_at");
    expect(verify).toContain("migration registry entry is missing");
  });

  it("refuses to bless pre-existing artifacts while the patch is pending", () => {
    const guard = patch.indexOf("DO $preexisting_guard$");
    const tablePresenceCheck = patch.indexOf(
      "to_regclass('public.auth_rate_limit_buckets') IS NOT NULL",
      guard
    );
    const indexPresenceCheck = patch.indexOf(
      "to_regclass('public.auth_rate_limit_buckets_expires_at_idx') IS NOT NULL",
      guard
    );
    const createTable = patch.indexOf("CREATE TABLE public.auth_rate_limit_buckets", guard);

    expect(guard).toBeGreaterThan(-1);
    expect(tablePresenceCheck).toBeGreaterThan(guard);
    expect(indexPresenceCheck).toBeGreaterThan(tablePresenceCheck);
    expect(createTable).toBeGreaterThan(indexPresenceCheck);
    expect(patch).not.toMatch(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i);
  });

  it("validates exact provenance and structure before compensating the registry", () => {
    const presenceGuard = rollback.indexOf(
      "table_exists := to_regclass('public.auth_rate_limit_buckets') IS NOT NULL"
    );
    const registryLock = rollback.indexOf("FOR UPDATE", presenceGuard);
    const checksumGuard = rollback.indexOf(
      "registered_sha256 IS DISTINCT FROM expected_sha256",
      registryLock
    );
    const exactConstraintCount = rollback.indexOf("total_constraint_count <> 5", checksumGuard);
    const structureGuard = rollback.indexOf("expected_column_count <> 6", checksumGuard);
    const exactIndexCount = rollback.indexOf("total_index_count <> 2", structureGuard);
    const triggerPolicyGuard = rollback.indexOf(
      "user_trigger_count <> 0 OR policy_count <> 0",
      exactIndexCount
    );
    const drop = rollback.indexOf("DROP TABLE public.auth_rate_limit_buckets", presenceGuard);
    const registryDelete = rollback.indexOf("DELETE FROM public.cerp_schema_migrations", drop);

    expect(presenceGuard).toBeGreaterThan(-1);
    expect(registryLock).toBeGreaterThan(presenceGuard);
    expect(checksumGuard).toBeGreaterThan(registryLock);
    expect(exactConstraintCount).toBeGreaterThan(checksumGuard);
    expect(structureGuard).toBeGreaterThan(checksumGuard);
    expect(exactIndexCount).toBeGreaterThan(structureGuard);
    expect(triggerPolicyGuard).toBeGreaterThan(exactIndexCount);
    expect(drop).toBeGreaterThan(triggerPolicyGuard);
    expect(registryDelete).toBeGreaterThan(drop);
    expect(rollback).toContain("WHERE filename = '20260804_auth_rate_limit_buckets.sql'");
    expect(rollback).toContain("AND sha256 = expected_sha256");
    expect(rollback).toContain(expectedPatchSha256);
  });

  it("serializes rollback with the runner and rechecks state under an exclusive table lock", () => {
    const transactionStart = rollback.indexOf("BEGIN;");
    const readCommitted = rollback.indexOf(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
      transactionStart
    );
    const environmentGuard = rollback.indexOf("DO $environment_guard$", readCommitted);
    const advisoryLock = rollback.indexOf(
      "SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'))"
    );
    const firstLookup = rollback.indexOf(
      "to_regclass('public.auth_rate_limit_buckets')::oid AS target_oid",
      advisoryLock
    );
    const tableLock = rollback.indexOf(
      "LOCK TABLE public.auth_rate_limit_buckets IN ACCESS EXCLUSIVE MODE",
      firstLookup
    );
    const identityGuard = rollback.indexOf("DO $table_identity_guard$", tableLock);
    const registryRowLock = rollback.indexOf("DO $registry_lock$", tableLock);
    const lockedLookup = rollback.indexOf(
      "table_exists := to_regclass('public.auth_rate_limit_buckets') IS NOT NULL",
      registryRowLock
    );
    const ledgerInspection = rollback.indexOf("SELECT sha256, applied_at", lockedLookup);
    const structureInspection = rollback.indexOf("SELECT relkind = 'r'", lockedLookup);

    expect(runner).toContain("SELECT pg_advisory_xact_lock(hashtext($1))");
    expect(transactionStart).toBeGreaterThan(-1);
    expect(readCommitted).toBeGreaterThan(transactionStart);
    expect(environmentGuard).toBeGreaterThan(readCommitted);
    expect(advisoryLock).toBeGreaterThan(-1);
    expect(firstLookup).toBeGreaterThan(advisoryLock);
    expect(tableLock).toBeGreaterThan(firstLookup);
    expect(identityGuard).toBeGreaterThan(tableLock);
    expect(registryRowLock).toBeGreaterThan(identityGuard);
    expect(registryRowLock).toBeGreaterThan(tableLock);
    expect(lockedLookup).toBeGreaterThan(tableLock);
    expect(ledgerInspection).toBeGreaterThan(lockedLookup);
    expect(structureInspection).toBeGreaterThan(lockedLookup);
    expect(rollback).toContain("IF NOT initial_table_exists THEN");
    expect(rollback).toContain("current_table_oid IS DISTINCT FROM initial_table_oid");
    expect(rollback).toContain("relation = initial_table_oid");
    expect(rollback).toContain("initial table identity changed before the exclusive lock");
    expect(rollback).toContain("target table appeared concurrently before it could be locked");
  });

  it("allows a rollback no-op only when both the table and target ledger entry are absent", () => {
    const ledgerLookup = rollback.indexOf("SELECT sha256, applied_at");
    const absentTableGuard = rollback.indexOf("IF NOT initial_table_exists THEN", ledgerLookup);
    const inconsistentStateGuard = rollback.indexOf(
      "IF registry_entry_exists OR expiry_index_exists THEN",
      absentTableGuard
    );
    const inconsistencyError = rollback.indexOf(
      "table is missing but its registry entry or named index remains",
      inconsistentStateGuard
    );
    const noOpReturn = rollback.indexOf("RETURN;", inconsistencyError);

    expect(ledgerLookup).toBeGreaterThan(-1);
    expect(absentTableGuard).toBeGreaterThan(ledgerLookup);
    expect(inconsistentStateGuard).toBeGreaterThan(absentTableGuard);
    expect(inconsistencyError).toBeGreaterThan(inconsistentStateGuard);
    expect(noOpReturn).toBeGreaterThan(inconsistencyError);
  });
});
