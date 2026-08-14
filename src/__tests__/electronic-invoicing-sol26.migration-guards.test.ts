import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const patchPath = path.join(root, "db/patches/20260814_electronic_invoicing_sol26.sql");
const patch = fs.readFileSync(patchPath, "utf8");
const preflight = fs.readFileSync(
  path.join(root, "db/patches/support/20260814_electronic_invoicing_sol26.preflight.sql"),
  "utf8"
);
const verify = fs.readFileSync(
  path.join(root, "db/patches/support/20260814_electronic_invoicing_sol26.verify.sql"),
  "utf8"
);
const rollback = fs.readFileSync(
  path.join(root, "db/patches/support/20260814_electronic_invoicing_sol26.rollback.sql"),
  "utf8"
);
const runner = fs.readFileSync(path.join(root, "scripts/db-patches.js"), "utf8");
const patchSha256 = crypto.createHash("sha256").update(patch.replace(/\r\n?/g, "\n")).digest("hex");

describe("SOL-26 migration guards", () => {
  it("registers the exact immutable patch checksum in the production runner", () => {
    expect(patchSha256).toBe("03da2f92e7c99e1ffe437fb5443517585a9c20765322d85ab0cb83e378f7968e");
    expect(runner).toContain('"20260814_electronic_invoicing_sol26.sql"');
    expect(runner).toContain(patchSha256);
  });

  it("ships a preflight, post-migration verification and guarded rollback", () => {
    expect(preflight).toContain("SOL-26 missing prerequisites");
    expect(verify).toContain("SOL-26 verification failed");
    expect(rollback).toContain("allowed only on an isolated/test database");
    expect(rollback).toContain("rollback refused because electronic-invoice evidence exists");
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
  });
});
