import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const name = "20260815_z_client_contact_idempotency_grants_sol43";
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");
const migration = read(`db/patches/${name}.sql`);
const preflight = read(`db/patches/support/${name}.preflight.sql`);
const verify = read(`db/patches/support/${name}.verify.sql`);
const rollback = read(`db/patches/support/${name}.rollback.sql`);
const runner = read("scripts/db-patches.js");

describe("SOL-43 contact idempotency privileges", () => {
  it("grants only the operations used by the repository", () => {
    expect(migration).toContain("GRANT SELECT, INSERT");
    expect(migration).not.toMatch(/GRANT\s+(ALL|UPDATE|DELETE|TRUNCATE)/i);
    expect(migration).toContain("TO cerp_app");
  });

  it("fails safely when the target, table, or role is unexpected", () => {
    expect(migration).toContain("current_database() NOT IN ('cerp_test', 'cerp_prod')");
    expect(migration).toContain("client_contact_create_idempotency");
    expect(migration).toContain("role cerp_app is missing");
    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
  });

  it("verifies both required privileges and keeps rollback evidence-safe", () => {
    expect(verify).toContain("'SELECT'");
    expect(verify).toContain("'INSERT'");
    expect(rollback).toContain("restoring the verified pre-migration backup");
    expect(rollback).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/im);
  });

  it("registers the immutable patch checksum", () => {
    const sha256 = createHash("sha256").update(migration.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
    expect(runner).toContain(`"${name}.sql":`);
    expect(runner).toContain(sha256);
  });
});
