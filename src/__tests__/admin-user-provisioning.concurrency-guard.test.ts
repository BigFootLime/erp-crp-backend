import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("administrative provisioning concurrency guard", () => {
  it("claims the idempotency key and locks replays inside the user/audit transaction", () => {
    const repository = fs.readFileSync(
      path.join(process.cwd(), "src/module/admin/repository/admin.repository.ts"),
      "utf8",
    );
    const patch = fs.readFileSync(
      path.join(process.cwd(), "db/patches/20260803_admin_user_provisioning_boundary.sql"),
      "utf8",
    );

    expect(patch).toMatch(/idempotency_key UUID PRIMARY KEY/);
    expect(repository).toMatch(/withRealtimeOutboxTransaction/);
    expect(repository).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(repository).toMatch(/FOR UPDATE/);
    expect(repository).toMatch(/repoInsertAuditLog\(\{[\s\S]*tx,/);
  });
});
